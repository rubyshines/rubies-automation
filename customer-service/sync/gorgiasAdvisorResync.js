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
const {
  fetchOpenGorgiasTickets,
  fetchOpenSpamTickets,
  fetchAdvisorTicketsFor,
  findAdvisorOnlyOpen,
  countGorgiasMessages,
  countAdvisorCustomerMessages,
  isStatusInSync,
  failedAgentMessages,
  partitionBouncedDrift,
} = require('./lib/gorgiasDriftCore');

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
  const gorgiasTickets = await fetchOpenGorgiasTickets(gorgias);
  console.log(`  Found ${gorgiasTickets.length} open tickets in Gorgias\n`);

  // ── Step 2: Fetch matching Advisor tickets ──

  const gorgiasIds = gorgiasTickets.map(t => t.id);
  const COLS = 'id, gorgias_ticket_id, status, customer_email, conversation_history';
  const { byGorgiasId: advisorMap } = await fetchAdvisorTicketsFor(supabase, gorgiasIds, COLS);

  // Also find Advisor tickets that are still open but not in Gorgias open views
  const advisorDrift = await findAdvisorOnlyOpen(supabase, gorgiasIds, COLS);

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

    // Check status drift — canonical compatibility map in the shared drift core
    const gStatus = gTicket.status;
    const aStatus = advisor.status;
    if (!isStatusInSync(gStatus, aStatus)) {
      toProcess.push({ ticket: gTicket, reason: `status drift (G:${gStatus} → A:${aStatus})`, existingIds });
      continue;
    }

    // Check message count — fetch messages to compare
    const messages = await gorgias.getTicketMessages(gTicket.id);
    const gCust = countGorgiasMessages(messages).customer;
    const aCust = countAdvisorCustomerMessages(advisor.conversation_history);
    if (gCust > aCust) {
      toProcess.push({ ticket: gTicket, reason: `missing messages (G:${gCust} vs A:${aCust} customer msgs)`, existingIds });
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

  // ── Step 4a: Check for undelivered agent messages ──
  //    Runs BEFORE drift triage on purpose. Gorgias reopens a ticket when an
  //    agent message bounces, so a ticket we answered and closed flips back to
  //    open on their side seconds later and the status-drift check above reads
  //    it as a genuine miss. It isn't — the draft was written, sent, and closed.
  //    Detecting the bounce first lets triage skip those tickets, so one bounce
  //    is reported once (as undelivered) instead of also alarming as a real miss.
  //    If not a dry run, auto-close bounced tickets so they never reach the follow-up queue.

  const undelivered = [];
  const bouncedIds = new Set();
  for (const gTicket of gorgiasTickets) {
    if (!gTicket.last_sent_message_not_delivered) continue;
    const messages = await gorgias.getTicketMessages(gTicket.id);
    const failedMsgs = failedAgentMessages(messages);
    if (failedMsgs.length) {
      bouncedIds.add(gTicket.id);
      const entry = {
        ticket: gTicket,
        failedMessages: failedMsgs.map(m => ({
          id: m.id,
          channel: m.channel,
          failed_datetime: m.failed_datetime,
          error: m.last_sending_error,
          is_retriable: m.is_retriable,
          body_preview: (m.body_text || m.stripped_text || '').substring(0, 80),
        })),
        autoclosed: false,
      };
      if (!dryRun) {
        try {
          await gorgias.closeTicket(gTicket.id);
          await supabase
            .from('cs_tickets')
            .update({ status: 'closed', updated_at: new Date().toISOString() })
            .eq('gorgias_ticket_id', gTicket.id);
          entry.autoclosed = true;
          console.log(`  [undelivered] #${gTicket.id}: auto-closed (bounced email, ${failedMsgs.length} failed msg(s))`);
        } catch (e) {
          console.error(`  [undelivered] #${gTicket.id}: auto-close failed — ${e.message}`);
        }
      }
      undelivered.push(entry);
    }
    await gorgias.delay(300);
  }

  // ── Step 4b: Triage drift — auto-resolve noise, keep only real misses ──
  //    The reconciler flags any open-in-Gorgias ticket with no advisor draft (or
  //    a diverging status). Most are junk: vendor sales pitches, emoji-reaction
  //    reopens, duplicates. Left alone they recur in the digest every day. We
  //    close the junk here and report only genuine customer misses. Real misses
  //    are NOT auto-drafted — that keeps webhook/intake bugs visible.
  //    Only runs when executing (daily sync); dry runs stay pure detection.

  // Bounce-caused drift is filtered out in BOTH modes (the detection above is
  // read-only), so a CLI dry run reports the same thing the digest does.
  const { driftToTriage, bounceResolved } = partitionBouncedDrift(toProcess, bouncedIds);
  const autoResolved = [...bounceResolved];
  for (const b of bounceResolved) {
    console.log(`  [triage] #${b.ticketId}: skipped — drift caused by a bounce, reported as undelivered`);
  }

  let realMisses = driftToTriage;
  if (!dryRun && driftToTriage.length) {
    const { triageDriftTicket } = require('../lib/driftTriage');
    realMisses = [];
    for (const item of driftToTriage) {
      const gid = item.ticket.id;
      try {
        const messages = await gorgias.getTicketMessages(gid);
        const { disposition, reason } = await triageDriftTicket({
          supabase, gorgias, ticket: item.ticket, messages,
        });
        if (disposition === 'real_miss') {
          realMisses.push(item);
        } else {
          autoResolved.push({ ticketId: gid, email: item.ticket.customer?.email || '?', disposition, reason });
          console.log(`  [triage] #${gid}: auto-resolved (${disposition}) — ${reason}`);
        }
      } catch (e) {
        console.warn(`  [triage] #${gid}: triage failed (${e.message}) — keeping as real miss`);
        realMisses.push(item);
      }
      await gorgias.delay(300);
    }
  }

  // ── Step 4b¾: Spam-flagged open tickets — the population the views hide ──
  //    Gorgias's spam detector mislabels real customers, the views exclude
  //    spam upstream, and the webhook skips unknown spam-flagged senders on
  //    purpose (known customers override the flag there in real time). This
  //    step is the designed home for everyone else: a known customer or a
  //    triage-CUSTOMER verdict gets DRAFTED via normal intake — unlike a
  //    regular real miss, which is report-only, because a spam-flagged miss
  //    is a deferral by design, not an intake bug to keep visible. Pitches
  //    get closed with a note by triage, so the junk stops accumulating and
  //    nothing is dropped silently. Everything lands in the digest.

  const spamRecovered = [];
  {
    // Read-only in dry runs: list candidates, spend nothing, write nothing.
    const spamTickets = await fetchOpenSpamTickets(gorgias);
    // Cost cap, not a coverage cap: each unknown sender costs an Opus classify.
    // Steady state is a handful/day; a flood waits for the next night's run.
    const MAX_SPAM_GATE_PER_RUN = 30;
    const gated = spamTickets.slice(0, MAX_SPAM_GATE_PER_RUN);
    if (spamTickets.length > gated.length) {
      console.log(`  [spam-gate] ${spamTickets.length} open spam-flagged tickets; gating first ${gated.length}, rest deferred to next run`);
    }
    if (gated.length) {
      const { hasOrderHistory } = require('../lib/knownCustomer');
      const { triageDriftTicket } = require('../lib/driftTriage');
      const spamIds = gated.map(t => t.id);
      const { byGorgiasId: spamAdvisorMap } = await fetchAdvisorTicketsFor(supabase, spamIds, 'id, gorgias_ticket_id');
      const { data: spamDrafts } = await supabase
        .from('cs_ai_drafts')
        .select('gorgias_ticket_id, gorgias_message_id')
        .in('gorgias_ticket_id', spamIds);
      const spamDraftIds = new Map();
      for (const d of (spamDrafts || [])) {
        if (!spamDraftIds.has(d.gorgias_ticket_id)) spamDraftIds.set(d.gorgias_ticket_id, new Set());
        spamDraftIds.get(d.gorgias_ticket_id).add(d.gorgias_message_id);
      }

      for (const sTicket of gated) {
        const email = sTicket.customer?.email || null;
        try {
          const known = email ? await hasOrderHistory(supabase, email) : false;
          if (dryRun) {
            console.log(`  [spam-gate] #${sTicket.id} ${email || '?'} — would ${known ? 'draft (known customer)' : 'triage (unknown sender)'}`);
            continue;
          }
          if (!known) {
            if (spamAdvisorMap.get(sTicket.id)) continue; // already in our system — regular drift machinery owns it
            const messages = await gorgias.getTicketMessages(sTicket.id);
            const { disposition, reason } = await triageDriftTicket({
              supabase, gorgias, ticket: sTicket, messages,
            });
            if (disposition !== 'real_miss') {
              autoResolved.push({ ticketId: sTicket.id, email: email || '?', disposition, reason: `spam-flagged: ${reason}` });
              console.log(`  [spam-gate] #${sTicket.id}: auto-resolved (${disposition}) — ${reason}`);
              await gorgias.delay(300);
              continue;
            }
          }
          const existingIds = spamDraftIds.get(sTicket.id) || new Set();
          const result = await processTicket(supabase, sTicket, aiBotId, existingIds);
          if (result?.skipped) {
            console.log(`  [spam-gate] #${sTicket.id}: skipped by intake (${result.reason || 'no new message'})`);
          } else {
            spamRecovered.push({ ticketId: sTicket.id, email: email || '?', via: known ? 'known customer' : 'triage: customer' });
            console.log(`  [spam-gate] #${sTicket.id}: drafted (${known ? 'known customer' : 'triage said customer'})`);
          }
        } catch (e) {
          console.warn(`  [spam-gate] #${sTicket.id}: failed (${e.message}) — will retry next run`);
        }
        await gorgias.delay(300);
      }
    }
  }

  // ── Step 4c: Process expired snoozes → auto follow-ups ──
  //    Only runs when called from runPipeline (daily sync), not CLI dry runs.

  const followUps = [];

  if (!dryRun) {
  const { executeStage1, executeStage2 } = require('../lib/followUp');
  const { callClaude } = require('../../shared/aiClient');
  const { MODELS } = require('../../shared/aiPricing');

  const CLASSIFIER_SYSTEM = `You are reviewing a customer service conversation for RUBIES (gender-affirming underwear and swimwear for trans girls and women).

The conversation has been snoozed — meaning we sent a message and are waiting. Your job is to determine whether the customer still needs to reply, or whether the last agent message wrapped things up and a follow-up email would be unnecessary or annoying.

Answer YES if we are genuinely waiting for the customer:
- We asked a question (sizing info, measurements, preference)
- We made an offer and are waiting for their decision (hold/swap/cancel, which size, which product)
- We proposed an exchange/refund and are waiting for confirmation

Answer NO if the last agent message was a completion or closure:
- "I've created your exchange and it will go out to you shortly"
- "I've processed your refund"
- "Your order is on its way"
- A delivery of information (tracking, policy) with no open question

Reply with exactly one of: YES or NO
Then on the same line after a pipe character, give a brief reason (under 15 words).
Example: YES | asked for waist measurement to confirm exchange size
Example: NO | exchange confirmed and created, no reply needed`;

  async function classifyFollowupNecessity(gorgiasMessages) {
    const relevant = gorgiasMessages
      .filter(m => m.channel !== 'internal-note' && !m.is_bot)
      .slice(-8)
      .map(m => {
        const role = m.from_agent ? 'AGENT' : 'CUSTOMER';
        const body = (m.body_text || m.stripped_text || m.body || '').substring(0, 500);
        return `${role}: ${body}`;
      })
      .filter(line => line.length > 7);

    if (!relevant.length) return { needed: true, reason: 'no conversation to classify' };

    try {
      const response = await callClaude({
        // Deliberately Haiku: low-stakes junk-ticket triage, reconciled downstream.
        model: MODELS.HAIKU,
        component: 'followup_classifier',
        system: CLASSIFIER_SYSTEM,
        messages: [{ role: 'user', content: `Conversation:\n\n${relevant.join('\n\n')}` }],
        max_tokens: 60,
      });
      const text = (response.content?.[0]?.text || '').trim();
      const needed = text.toUpperCase().startsWith('YES');
      const reason = text.includes('|') ? text.split('|').slice(1).join('|').trim() : text;
      return { needed, reason };
    } catch (e) {
      // On classifier error, default to sending the follow-up (safe fallback)
      return { needed: true, reason: `classifier error: ${e.message}` };
    }
  }

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

      // Run follow-up — but first check with Haiku whether one is actually needed.
      // test_snooze tickets skip the classifier so the full flow can be exercised in tests.
      const stage = st.follow_up_stage || 0;

      if (!st.test_snooze) {
        const { needed, reason } = await classifyFollowupNecessity(messages);
        if (!needed) {
          console.log(`  [follow-up] #${st.gorgias_ticket_id}: classifier says resolved — closing (${reason})`);
          try {
            await gorgias.closeTicket(st.gorgias_ticket_id);
            await supabase
              .from('cs_tickets')
              .update({ status: 'closed', updated_at: new Date().toISOString() })
              .eq('id', st.id);
          } catch (e) {
            console.error(`  [follow-up] #${st.gorgias_ticket_id}: close failed — ${e.message}`);
          }
          followUps.push({ ticketId: st.gorgias_ticket_id, email: st.customer_email, action: `classifier_closed: ${reason}` });
          continue;
        }
        console.log(`  [follow-up] #${st.gorgias_ticket_id}: classifier says follow-up needed (${reason})`);
      }

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

    for (const { ticket, failedMessages, autoclosed } of undelivered) {
      const name = ticket.customer?.name || '';
      const email = ticket.customer?.email || '';
      console.log(`  #${ticket.id}  ${name} (${email})${autoclosed ? '  → AUTO-CLOSED' : ''}`);
      for (const fm of failedMessages) {
        const err = fm.error ? JSON.stringify(fm.error) : 'unknown';
        console.log(`    → MSG #${fm.id} [${fm.channel}] failed ${fm.failed_datetime} — ${err}`);
        console.log(`      "${fm.body_preview}..."`);
      }
    }
  }

  if (autoResolved.length) {
    console.log(`\n  ${autoResolved.length} drift ticket(s) auto-resolved as noise:`);
    for (const a of autoResolved) console.log(`    #${a.ticketId}  ${a.email}  → ${a.disposition}: ${a.reason}`);
  }

  console.log(`\n${'═'.repeat(65)}`);
  console.log(`  ${realMisses.length} real miss(es) need attention${autoResolved.length ? ` (${autoResolved.length} auto-resolved)` : ''}`);
  console.log(`${'═'.repeat(65)}\n`);

  for (const { ticket, reason } of realMisses) {
    const name = ticket.customer?.name || '';
    const email = ticket.customer?.email || '';
    console.log(`  #${ticket.id}  ${name} (${email})`);
    console.log(`    → ${reason}`);
  }

  if (!realMisses.length && !undelivered.length && !autoResolved.length) {
    console.log('  ✓ Everything in sync — nothing to do.\n');
  }

  if (spamRecovered.length) {
    console.log(`\n  ${spamRecovered.length} spam-flagged ticket(s) rescued and drafted:`);
    for (const s of spamRecovered) console.log(`    #${s.ticketId}  ${s.email}  → ${s.via}`);
  }

  return {
    openTickets: gorgiasTickets.length,
    driftIssues: realMisses.map(({ ticket, reason }) => ({
      ticketId: ticket.id,
      email: ticket.customer?.email || '?',
      reason,
    })),
    autoResolved,
    spamRecovered,
    undelivered: undelivered.map(({ ticket, failedMessages, autoclosed }) => ({
      ticketId: ticket.id,
      email: ticket.customer?.email || '?',
      failedCount: failedMessages.length,
      autoclosed,
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
    const autoResolvedCount = (detection.autoResolved || []).length;
    const spamRecoveredCount = (detection.spamRecovered || []).length;
    const undeliveredCount = detection.undelivered.length;
    const followUpCount = detection.followUps.length;
    const followUpErrorCount = detection.followUps.filter(f => typeof f.action === 'string' && f.action.startsWith('error:')).length;
    // Real misses are the only thing that ALARMS — auto-resolved noise is just
    // informational, and a spam rescue is a handled draft awaiting review.
    const hasIssues = driftCount > 0 || undeliveredCount > 0 || followUpErrorCount > 0;
    const detailParts = [`${detection.openTickets} open`];
    if (driftCount) detailParts.push(`${driftCount} real miss${driftCount === 1 ? '' : 'es'}`);
    if (spamRecoveredCount) detailParts.push(`${spamRecoveredCount} rescued from spam`);
    if (autoResolvedCount) detailParts.push(`${autoResolvedCount} auto-resolved`);
    if (undeliveredCount) detailParts.push(`${undeliveredCount} undelivered`);
    if (followUpCount) {
      detailParts.push(followUpErrorCount
        ? `${followUpCount} follow-ups (${followUpErrorCount} errored)`
        : `${followUpCount} follow-ups`);
    }
    if (!hasIssues && !followUpCount && !autoResolvedCount) detailParts.push('all in sync');

    return {
      sources: {
        ticket_reconciliation: {
          success: true,
          rowsWritten: driftCount + autoResolvedCount + spamRecoveredCount + undeliveredCount + followUpCount,
          detail: detailParts.join(', '),
          driftIssues: detection.driftIssues,
          autoResolved: detection.autoResolved || [],
          spamRecovered: detection.spamRecovered || [],
          undelivered: detection.undelivered,
          followUps: detection.followUps,
        },
      },
      status: hasIssues ? 'warning' : (followUpCount || autoResolvedCount || spamRecoveredCount) ? 'success' : 'ok',
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
