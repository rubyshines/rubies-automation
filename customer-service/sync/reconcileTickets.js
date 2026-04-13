#!/usr/bin/env node

/**
 * RUBIES Ticket Reconciliation — ensures every open Gorgias ticket has been
 * processed by intake.
 *
 * This is the same logic as the intake poller, but without a date filter —
 * it scans ALL open Gorgias tickets. Catches anything webhooks or the poller
 * missed.
 *
 * Also syncs Gorgias→DB for tickets that were closed outside our system
 * (e.g. manually closed in Gorgias).
 *
 * Usage:
 *   node customer-service/sync/reconcileTickets.js
 */

const path = require('path');
if (!process.env.SUPABASE_URL) {
  require('dotenv').config({ path: path.resolve(__dirname, '../..', '.env') });
}

const { getSupabaseClient } = require('../../shared/supabaseClient');

async function run() {
  console.log('RUBIES Ticket Reconciliation — starting');

  if (!process.env.GORGIAS_DOMAIN || !process.env.GORGIAS_API_KEY) {
    console.log('Gorgias env vars not configured — skipping');
    return { sources: { tickets: { success: true, rowsWritten: 0, error: null } }, status: 'skipped' };
  }

  const gorgias = require('../import/gorgiasClient');
  const { processTicket, getAiBotUserId } = require('../intake/processGorgiasTickets');
  const supabase = getSupabaseClient();

  let ticketsProcessed = 0;
  let ticketsSkipped = 0;
  let statusSynced = 0;
  let errors = 0;

  // --- Phase 1: Fetch ALL open tickets from Gorgias ---
  console.log('[reconcile] Fetching all open tickets from Gorgias...');
  const allTickets = [];
  let cursor = null;
  let pageCount = 0;
  do {
    const { data: tickets, nextCursor } = await gorgias.getTickets({
      cursor,
      limit: 30,
      order_by: 'updated_datetime:desc',
    });
    for (const t of tickets) {
      if (t.status === 'open' && !t.spam) allTickets.push(t);
    }
    cursor = nextCursor;
    pageCount++;
    if (cursor) await gorgias.delay(500);
    if (pageCount > 100) break; // safety limit
  } while (cursor);

  console.log(`[reconcile] Found ${allTickets.length} open non-spam tickets in Gorgias`);

  // --- Phase 2: Apply the same filters as intake ---
  const aiBotId = await getAiBotUserId();
  const ticketIds = allTickets.map(t => t.id);

  // Batch-check existing drafts
  const { data: existingDrafts } = await supabase
    .from('cs_ai_drafts')
    .select('gorgias_ticket_id, gorgias_message_id, status')
    .in('gorgias_ticket_id', ticketIds.length ? ticketIds : [0]);

  const draftedMessages = {};
  const spammedTickets = new Set();
  const releasedTickets = new Set();
  for (const d of (existingDrafts || [])) {
    if (d.status === 'spam') spammedTickets.add(d.gorgias_ticket_id);
    if (d.status === 'released') releasedTickets.add(d.gorgias_ticket_id);
    if (d.status === 'pending') {
      if (!draftedMessages[d.gorgias_ticket_id]) draftedMessages[d.gorgias_ticket_id] = new Set();
      draftedMessages[d.gorgias_ticket_id].add(d.gorgias_message_id);
    }
  }

  const ticketsToProcess = allTickets.filter(t => {
    const assigneeId = t.assignee_user?.id;
    if (assigneeId === aiBotId && draftedMessages[t.id]?.size > 0) return false;
    if (releasedTickets.has(t.id) && !assigneeId) return false;
    if (spammedTickets.has(t.id)) return false;
    const tags = (t.tags || []).map(tag => (tag.name || tag).toLowerCase());
    if (tags.includes('spam')) return false;
    if (!t.customer?.email) return false;
    // Skip tickets assigned to a human agent (not AI bot)
    if (assigneeId && assigneeId !== aiBotId) return false;
    return true;
  });

  console.log(`[reconcile] ${ticketsToProcess.length} tickets need processing (${allTickets.length - ticketsToProcess.length} skipped)`);

  // --- Phase 3: Process through normal intake pipeline ---
  for (const ticket of ticketsToProcess) {
    try {
      const existingIds = draftedMessages[ticket.id] || new Set();
      const result = await processTicket(supabase, ticket, aiBotId, existingIds);
      if (result?.skipped) {
        ticketsSkipped++;
      } else {
        ticketsProcessed++;
        console.log(`[reconcile] Processed ticket ${ticket.id} (${ticket.customer?.email})`);
      }
    } catch (err) {
      console.error(`[reconcile] Error processing ticket ${ticket.id}: ${err.message}`);
      errors++;
    }
    await gorgias.delay(300);
  }

  // --- Phase 4: Sync Gorgias→DB for tickets closed outside our system ---
  // Check tickets that are open/snoozed in our DB — if Gorgias says closed, update DB
  const { data: activeDbTickets } = await supabase
    .from('cs_tickets')
    .select('id, gorgias_ticket_id, status')
    .in('status', ['open', 'snoozed']);

  const gorgiasOpenIds = new Set(allTickets.map(t => t.id));
  let closedInGorgias = 0;

  for (const dbTicket of (activeDbTickets || [])) {
    // If our DB says open/snoozed but it's NOT in the Gorgias open list, check it
    if (!gorgiasOpenIds.has(dbTicket.gorgias_ticket_id)) {
      try {
        const gorgiasTicket = await gorgias.getTicket(dbTicket.gorgias_ticket_id);
        if (gorgiasTicket.status === 'closed') {
          const now = new Date().toISOString();
          await supabase.from('cs_tickets').update({
            status: 'closed',
            closed_at: now,
            updated_at: now,
            active_draft_id: null,
          }).eq('id', dbTicket.id);
          console.log(`[reconcile] ${dbTicket.gorgias_ticket_id} — ${dbTicket.status} → closed (closed in Gorgias)`);
          closedInGorgias++;
        }
        await gorgias.delay(300);
      } catch (err) {
        console.error(`[reconcile] Error checking ${dbTicket.gorgias_ticket_id}: ${err.message}`);
        errors++;
      }
    }
  }

  console.log(`[reconcile] Done — ${ticketsProcessed} processed, ${ticketsSkipped} skipped, ${closedInGorgias} synced closed, ${errors} errors`);

  return {
    sources: {
      tickets: {
        success: errors === 0,
        rowsWritten: ticketsProcessed + closedInGorgias,
        error: errors > 0 ? `${errors} errors` : null,
      },
    },
    status: errors > 0 ? 'partial' : 'ok',
  };
}

if (require.main === module) {
  run()
    .then(r => { console.log(JSON.stringify(r, null, 2)); process.exit(0); })
    .catch(err => { console.error('Fatal:', err); process.exit(1); });
}

module.exports = { run };
