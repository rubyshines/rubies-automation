#!/usr/bin/env node

/**
 * RUBIES Gorgias → CS Advisor Resync
 *
 * Finds all open tickets in Gorgias (via views) that are missing from,
 * or out of sync with, the CS Advisor — then runs each one through
 * processTicket() to fix conversation_history, status, and generate
 * a draft for the latest customer message.
 *
 * processTicket is idempotent — safe to run multiple times.
 *
 * Usage:
 *   node customer-service/sync/gorgiasAdvisorResync.js              # dry run (default)
 *   node customer-service/sync/gorgiasAdvisorResync.js --execute    # actually process
 */

const path = require('path');
if (!process.env.SUPABASE_URL) {
  require('dotenv').config({ path: path.resolve(__dirname, '../..', '.env') });
}

const { getSupabaseClient } = require('../../shared/supabaseClient');

const VIEW_ALL_OPEN = 28532;
const VIEW_UNASSIGNED = 28531;

async function run({ execute = false } = {}) {
  const dryRun = !execute;

  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log(`║   RUBIES — Gorgias → CS Advisor Resync  ${dryRun ? '(DRY RUN)' : '⚡ EXECUTING'}        ║`);
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  if (!process.env.GORGIAS_DOMAIN || !process.env.GORGIAS_API_KEY) {
    console.error('Missing Gorgias env vars.');
    process.exit(1);
  }

  const gorgias = require('../import/gorgiasClient');
  const { processTicket, getAiBotUserId, buildConversationHistorySnapshot } = require('../intake/processGorgiasTickets');
  const supabase = getSupabaseClient();

  // ── Step 1: Fetch all open tickets from Gorgias views ──

  console.log('Fetching open tickets from Gorgias views...');
  const openTickets = await gorgias.getViewItems(VIEW_ALL_OPEN);
  const unassignedTickets = await gorgias.getViewItems(VIEW_UNASSIGNED);

  const ticketMap = new Map();
  for (const t of [...openTickets, ...unassignedTickets]) {
    if (!t.spam) ticketMap.set(t.id, t);
  }
  const gorgiasTickets = [...ticketMap.values()];
  console.log(`  Found ${gorgiasTickets.length} open tickets in Gorgias\n`);

  // ── Step 2: Fetch matching Advisor tickets ──

  const gorgiasIds = gorgiasTickets.map(t => t.id);
  let advisorTickets = [];
  if (gorgiasIds.length) {
    const batchSize = 200;
    for (let i = 0; i < gorgiasIds.length; i += batchSize) {
      const { data } = await supabase
        .from('cs_tickets')
        .select('id, gorgias_ticket_id, status, customer_email, conversation_history')
        .in('gorgias_ticket_id', gorgiasIds.slice(i, i + batchSize));
      if (data) advisorTickets.push(...data);
    }
  }
  const advisorMap = new Map();
  for (const t of advisorTickets) advisorMap.set(t.gorgias_ticket_id, t);

  // Also find Advisor tickets that are still open but not in Gorgias open views
  const { data: advisorDrift } = await supabase
    .from('cs_tickets')
    .select('id, gorgias_ticket_id, status, customer_email, conversation_history')
    .in('status', ['open', 'snoozed', 'follow_up'])
    .not('gorgias_ticket_id', 'in', `(${gorgiasIds.length ? gorgiasIds.join(',') : '0'})`);

  // ── Step 3: Fetch existing draft message IDs per ticket ──

  const allTicketIds = [...gorgiasIds, ...(advisorDrift || []).map(t => t.gorgias_ticket_id).filter(Boolean)];
  const { data: existingDrafts } = await supabase
    .from('cs_ai_drafts')
    .select('gorgias_ticket_id, gorgias_message_id')
    .in('gorgias_ticket_id', allTicketIds.length ? allTicketIds : [0]);

  const draftsByTicket = new Map();
  for (const d of (existingDrafts || [])) {
    if (!draftsByTicket.has(d.gorgias_ticket_id)) draftsByTicket.set(d.gorgias_ticket_id, new Set());
    draftsByTicket.get(d.gorgias_ticket_id).add(d.gorgias_message_id);
  }

  // ── Step 4: Identify tickets that need reprocessing ──

  const aiBotId = await getAiBotUserId();
  const toProcess = [];

  for (const gTicket of gorgiasTickets) {
    const advisor = advisorMap.get(gTicket.id);
    const existingIds = draftsByTicket.get(gTicket.id) || new Set();

    if (!advisor) {
      toProcess.push({ ticket: gTicket, reason: 'missing from Advisor', existingIds });
      continue;
    }

    // Check status drift
    //  - Gorgias open: Advisor open/snoozed/parked are all fine (operator may have parked/snoozed on our side)
    //  - Gorgias snoozed: Advisor must also be snoozed
    const gStatus = gTicket.status;
    const aStatus = advisor.status;
    if (gStatus === 'open' && !['open', 'snoozed', 'parked', 'pending_operator'].includes(aStatus)) {
      toProcess.push({ ticket: gTicket, reason: `status drift (G:open → A:${aStatus})`, existingIds });
      continue;
    }
    if (gStatus === 'snoozed' && aStatus !== 'snoozed') {
      toProcess.push({ ticket: gTicket, reason: `status drift (G:snoozed → A:${aStatus})`, existingIds });
      continue;
    }

    // Check message count — fetch messages to compare
    const messages = await gorgias.getTicketMessages(gTicket.id);
    const gCustMsgs = messages.filter(m => !m.from_agent && m.channel !== 'internal-note');
    const aCustMsgs = (advisor.conversation_history || []).filter(m => m.sender === 'customer' && m.channel !== 'internal-note');
    if (gCustMsgs.length > aCustMsgs.length) {
      toProcess.push({ ticket: gTicket, reason: `missing messages (G:${gCustMsgs.length} vs A:${aCustMsgs.length} customer msgs)`, existingIds });
    }
    await gorgias.delay(300);
  }

  // Also check Advisor-drift tickets (open in Advisor, not in Gorgias views)
  for (const t of (advisorDrift || [])) {
    if (!t.gorgias_ticket_id) continue;
    try {
      const gTicket = await gorgias.getTicket(t.gorgias_ticket_id);
      const messages = await gorgias.getTicketMessages(t.gorgias_ticket_id);
      const gCustMsgs = messages.filter(m => !m.from_agent && m.channel !== 'internal-note');
      const aCustMsgs = (t.conversation_history || []).filter(m => m.sender === 'customer' && m.channel !== 'internal-note');
      const existingIds = draftsByTicket.get(t.gorgias_ticket_id) || new Set();

      if (gCustMsgs.length > aCustMsgs.length) {
        toProcess.push({ ticket: gTicket, reason: `missing messages — snoozed (G:${gCustMsgs.length} vs A:${aCustMsgs.length})`, existingIds });
      }
      await gorgias.delay(300);
    } catch (e) {
      console.warn(`  Could not fetch Gorgias ticket ${t.gorgias_ticket_id}: ${e.message}`);
    }
  }

  // ── Step 4b: Check for undelivered agent messages ──

  const undelivered = [];
  for (const gTicket of gorgiasTickets) {
    if (!gTicket.last_sent_message_not_delivered) continue;
    const messages = await gorgias.getTicketMessages(gTicket.id);
    const failedMsgs = messages.filter(m => m.from_agent && m.failed_datetime);
    if (failedMsgs.length) {
      undelivered.push({
        ticket: gTicket,
        failedMessages: failedMsgs.map(m => ({
          id: m.id,
          channel: m.channel,
          failed_datetime: m.failed_datetime,
          error: m.last_sending_error,
          is_retriable: m.is_retriable,
          body_preview: (m.body_text || m.stripped_text || '').substring(0, 80),
        })),
      });
    }
    await gorgias.delay(300);
  }

  // ── Step 4c: Process expired snoozes → auto follow-ups ──
  //    Only runs when called from runPipeline (daily sync), not CLI dry runs.

  const followUps = [];

  if (!dryRun) {
  const { executeStage1, executeStage2 } = require('../lib/followUp');

  // Find tickets we consider snoozed
  const { data: snoozedTickets } = await supabase
    .from('cs_tickets')
    .select('id, gorgias_ticket_id, status, customer_email, customer_name, follow_up_stage, snoozed_at, test_snooze')
    .eq('status', 'snoozed');

  for (const st of (snoozedTickets || [])) {
    try {
      const gTicket = await gorgias.getTicket(st.gorgias_ticket_id);

      // Check if Gorgias snooze has expired by looking at snooze_datetime.
      // Gorgias status stays 'open' even while snoozed — only snooze_datetime tells the truth.
      const snoozeDt = gTicket.snooze_datetime ? new Date(gTicket.snooze_datetime) : null;
      const snoozeExpired = !snoozeDt || snoozeDt < new Date();

      if (!snoozeExpired) continue; // still snoozed in Gorgias, nothing to do

      // Check for activity after snoozed_at
      const messages = await gorgias.getTicketMessages(st.gorgias_ticket_id);
      const snoozedAt = new Date(st.snoozed_at);

      // Agent messages after snooze that aren't from the AI bot (i.e. Jamie replied manually)
      const manualAgentReplies = messages.filter(m =>
        m.from_agent &&
        m.channel !== 'internal-note' &&
        new Date(m.created_datetime) > snoozedAt &&
        m.sender?.id !== aiBotId
      );

      // Customer messages after snooze
      const customerReplies = messages.filter(m =>
        !m.from_agent &&
        m.channel !== 'internal-note' &&
        new Date(m.created_datetime) > snoozedAt
      );

      if (customerReplies.length > 0) {
        console.log(`  [follow-up] Skip #${st.gorgias_ticket_id}: customer replied after snooze`);
        continue;
      }

      if (manualAgentReplies.length > 0) {
        // Jamie replied manually — reset snoozed_at to that reply time, start new cycle
        const latestReply = manualAgentReplies[manualAgentReplies.length - 1];
        const replyTime = new Date(latestReply.created_datetime);
        const daysSinceReply = (Date.now() - replyTime.getTime()) / (1000 * 60 * 60 * 24);

        if (daysSinceReply < 3) {
          // Manual reply is recent enough — re-snooze from that point
          await supabase.from('cs_tickets').update({
            snoozed_at: latestReply.created_datetime,
            updated_at: new Date().toISOString(),
          }).eq('id', st.id);
          await gorgias.snoozeTicket(st.gorgias_ticket_id, 3 - daysSinceReply);
          console.log(`  [follow-up] #${st.gorgias_ticket_id}: Jamie replied manually, re-snoozed (${(3 - daysSinceReply).toFixed(1)}d remaining)`);
          followUps.push({ ticketId: st.gorgias_ticket_id, email: st.customer_email, action: 're-snoozed (manual reply)' });
          continue;
        }
        // Manual reply was >3 days ago — fall through to follow-up
        await supabase.from('cs_tickets').update({
          snoozed_at: latestReply.created_datetime,
        }).eq('id', st.id);
      }

      // Run follow-up
      const stage = st.follow_up_stage || 0;
      if (stage === 0) {
        const snoozeDays = st.test_snooze ? 0.004 : undefined;
        const result = await executeStage1(gorgias, st, { snoozeDays, gorgiasTicket: gTicket });
        if (result.sent) {
          console.log(`  [follow-up] #${st.gorgias_ticket_id}: Stage 1 sent to ${st.customer_email}`);
          followUps.push({ ticketId: st.gorgias_ticket_id, email: st.customer_email, action: 'stage1_sent' });
        } else {
          console.log(`  [follow-up] #${st.gorgias_ticket_id}: Stage 1 skipped — ${result.reason}`);
          followUps.push({ ticketId: st.gorgias_ticket_id, email: st.customer_email, action: `stage1_skip: ${result.reason}` });
        }
      } else if (stage === 1) {
        const result = await executeStage2(gorgias, st);
        if (result.sent) {
          console.log(`  [follow-up] #${st.gorgias_ticket_id}: Stage 2 sent to ${st.customer_email}, ticket closed`);
          followUps.push({ ticketId: st.gorgias_ticket_id, email: st.customer_email, action: 'stage2_sent' });
        } else {
          console.log(`  [follow-up] #${st.gorgias_ticket_id}: Stage 2 skipped — ${result.reason}`);
          followUps.push({ ticketId: st.gorgias_ticket_id, email: st.customer_email, action: `stage2_skip: ${result.reason}` });
        }
      }

      await gorgias.delay(1000); // longer delay to avoid Gorgias rate limits
    } catch (e) {
      console.error(`  [follow-up] #${st.gorgias_ticket_id} error: ${e.message}`);
      followUps.push({ ticketId: st.gorgias_ticket_id, email: st.customer_email, action: `error: ${e.message}` });
    }
  }

  if (followUps.length) {
    console.log(`\n${'═'.repeat(65)}`);
    console.log(`  ${followUps.length} follow-up action(s) taken`);
    console.log(`${'═'.repeat(65)}\n`);
    for (const f of followUps) {
      console.log(`  #${f.ticketId}  ${f.email}  → ${f.action}`);
    }
  }
  } // end if (!dryRun)

  // ── Step 5: Report what we found ──

  if (undelivered.length) {
    console.log(`\n${'═'.repeat(65)}`);
    console.log(`  ⚠️  ${undelivered.length} ticket(s) have UNDELIVERED agent messages`);
    console.log(`${'═'.repeat(65)}\n`);

    for (const { ticket, failedMessages } of undelivered) {
      const name = ticket.customer?.name || '';
      const email = ticket.customer?.email || '';
      console.log(`  #${ticket.id}  ${name} (${email})`);
      for (const fm of failedMessages) {
        const err = fm.error ? JSON.stringify(fm.error) : 'unknown';
        console.log(`    → MSG #${fm.id} [${fm.channel}] failed ${fm.failed_datetime} — ${err}`);
        console.log(`      "${fm.body_preview}..."`);
      }
    }
  }

  console.log(`\n${'═'.repeat(65)}`);
  console.log(`  ${toProcess.length} ticket(s) need reprocessing`);
  console.log(`${'═'.repeat(65)}\n`);

  for (const { ticket, reason } of toProcess) {
    const name = ticket.customer?.name || '';
    const email = ticket.customer?.email || '';
    console.log(`  #${ticket.id}  ${name} (${email})`);
    console.log(`    → ${reason}`);
  }

  if (!toProcess.length && !undelivered.length) {
    console.log('  ✓ Everything in sync — nothing to do.\n');
  }

  return {
    openTickets: gorgiasTickets.length,
    driftIssues: toProcess.map(({ ticket, reason }) => ({
      ticketId: ticket.id,
      email: ticket.customer?.email || '?',
      reason,
    })),
    undelivered: undelivered.map(({ ticket, failedMessages }) => ({
      ticketId: ticket.id,
      email: ticket.customer?.email || '?',
      failedCount: failedMessages.length,
    })),
    followUps,
  };
}

// ---------------------------------------------------------------------------
// Execute mode — reprocess drifted tickets (CLI only, never scheduled)
// ---------------------------------------------------------------------------

async function executeResync(detection) {
  const gorgias = require('../import/gorgiasClient');
  const { processTicket, getAiBotUserId, buildConversationHistorySnapshot } = require('../intake/processGorgiasTickets');
  const supabase = getSupabaseClient();
  const aiBotId = await getAiBotUserId();

  // Re-fetch the tickets that need processing
  const gorgiasIds = detection.driftIssues.map(d => d.ticketId);
  if (!gorgiasIds.length) {
    console.log('  Nothing to execute.');
    return;
  }

  // Fetch existing draft message IDs
  const { data: existingDrafts } = await supabase
    .from('cs_ai_drafts')
    .select('gorgias_ticket_id, gorgias_message_id')
    .in('gorgias_ticket_id', gorgiasIds);

  const draftsByTicket = new Map();
  for (const d of (existingDrafts || [])) {
    if (!draftsByTicket.has(d.gorgias_ticket_id)) draftsByTicket.set(d.gorgias_ticket_id, new Set());
    draftsByTicket.get(d.gorgias_ticket_id).add(d.gorgias_message_id);
  }

  console.log(`\n  Processing ${gorgiasIds.length} tickets...\n`);

  let processed = 0, skipped = 0, errors = 0;

  for (let i = 0; i < gorgiasIds.length; i++) {
    const ticketId = gorgiasIds[i];
    const existingIds = draftsByTicket.get(ticketId) || new Set();
    try {
      const ticket = await gorgias.getTicket(ticketId);
      console.log(`  [${i + 1}/${gorgiasIds.length}] #${ticketId} ${ticket.customer?.name || ticket.customer?.email || ticketId}...`);
      const result = await processTicket(supabase, ticket, aiBotId, existingIds);
      if (result?.skipped) {
        const messages = await gorgias.getTicketMessages(ticketId);
        const conversationHistory = buildConversationHistorySnapshot(
          messages.filter(m => m.channel !== 'internal-note')
        );

        const { error: upsertErr } = await supabase
          .from('cs_tickets')
          .upsert({
            gorgias_ticket_id: ticketId,
            status: 'open',
            customer_email: ticket.customer?.email || null,
            customer_name: ticket.customer?.name || null,
            conversation_history: conversationHistory,
            message_count: conversationHistory.length,
            gorgias_status: ticket.status || 'open',
            gorgias_updated_at: ticket.updated_datetime || null,
            updated_at: new Date().toISOString(),
          }, { onConflict: 'gorgias_ticket_id', ignoreDuplicates: false });

        if (upsertErr) {
          console.log(`    → skipped by processTicket, upsert failed: ${upsertErr.message}`);
          errors++;
        } else {
          console.log(`    → skipped by processTicket, but synced ticket record (status + messages)`);
          processed++;
        }
      } else {
        console.log(`    → ✓ processed`);
        processed++;
      }
    } catch (err) {
      console.error(`    → ✗ error: ${err.message}`);
      errors++;
    }
    await gorgias.delay(500);
  }

  console.log(`\n${'═'.repeat(65)}`);
  console.log(`  Done: ${processed} processed, ${skipped} skipped, ${errors} errors`);
  console.log(`${'═'.repeat(65)}\n`);
}

// ---------------------------------------------------------------------------
// Pipeline-compatible run() for daily-sync-all.js
// ---------------------------------------------------------------------------

async function runPipeline() {
  try {
    const detection = await run({ execute: true });
    const driftCount = detection.driftIssues.length;
    const undeliveredCount = detection.undelivered.length;
    const followUpCount = detection.followUps.length;
    const followUpErrorCount = detection.followUps.filter(f => typeof f.action === 'string' && f.action.startsWith('error:')).length;
    const hasIssues = driftCount > 0 || undeliveredCount > 0 || followUpErrorCount > 0;
    const detailParts = [`${detection.openTickets} open`];
    if (driftCount) detailParts.push(`${driftCount} drift`);
    if (undeliveredCount) detailParts.push(`${undeliveredCount} undelivered`);
    if (followUpCount) {
      detailParts.push(followUpErrorCount
        ? `${followUpCount} follow-ups (${followUpErrorCount} errored)`
        : `${followUpCount} follow-ups`);
    }
    if (!hasIssues && !followUpCount) detailParts.push('all in sync');

    return {
      sources: {
        ticket_reconciliation: {
          success: true,
          rowsWritten: driftCount + undeliveredCount + followUpCount,
          detail: detailParts.join(', '),
          driftIssues: detection.driftIssues,
          undelivered: detection.undelivered,
          followUps: detection.followUps,
        },
      },
      status: hasIssues ? 'warning' : followUpCount ? 'success' : 'ok',
    };
  } catch (e) {
    console.error('Ticket reconciliation error:', e.message);
    return {
      sources: {
        ticket_reconciliation: { success: false, rowsWritten: 0, error: e.message },
      },
      status: 'error',
    };
  }
}

module.exports = { run, runPipeline };

if (require.main === module) {
  const execute = process.argv.includes('--execute');

  run({ execute }).then(async (detection) => {
    if (execute && detection.driftIssues.length) {
      await executeResync(detection);
    } else if (execute) {
      console.log('  Nothing to execute — all in sync.');
    } else if (detection.driftIssues.length) {
      console.log(`\n  ⏸  Dry run — no changes made.`);
      console.log(`  Run with --execute to process these ${detection.driftIssues.length} tickets.\n`);
    }
  }).catch(err => {
    console.error('Resync failed:', err);
    process.exit(1);
  });
}
