#!/usr/bin/env node

/**
 * RUBIES Ticket Reconciliation — syncs cs_tickets status with Gorgias
 *
 * Checks all open/snoozed tickets against Gorgias and updates any that
 * have drifted (e.g. closed in Gorgias but still snoozed in our DB).
 * Also refreshes conversation_history for active tickets.
 *
 * Designed for daily use from daily-sync-all.js or standalone.
 *
 * Usage:
 *   node customer-service/sync/reconcileTickets.js
 *   npm run cs-reconcile-tickets
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
  const supabase = getSupabaseClient();

  let statusUpdated = 0;
  let historyUpdated = 0;
  let errors = 0;

  // Fetch all non-closed tickets from our DB
  const { data: activeTickets, error: fetchErr } = await supabase
    .from('cs_tickets')
    .select('id, gorgias_ticket_id, status, customer_email, snoozed_at')
    .in('status', ['open', 'snoozed']);

  if (fetchErr) throw fetchErr;
  console.log(`[reconcile] ${activeTickets.length} active tickets to check`);

  const auth = 'Basic ' + Buffer.from(process.env.GORGIAS_EMAIL + ':' + process.env.GORGIAS_API_KEY).toString('base64');

  for (const ticket of activeTickets) {
    try {
      // Fetch current Gorgias status
      const res = await fetch(`https://${process.env.GORGIAS_DOMAIN}.gorgias.com/api/tickets/${ticket.gorgias_ticket_id}`, {
        headers: { Authorization: auth },
      });
      const gorgiasTicket = await res.json();

      if (!gorgiasTicket?.id) {
        console.warn(`[reconcile] Ticket ${ticket.gorgias_ticket_id} not found in Gorgias`);
        continue;
      }

      // Check status drift
      const gorgiasStatus = gorgiasTicket.status; // open | closed
      const now = new Date().toISOString();

      if (gorgiasStatus === 'closed' && ticket.status !== 'closed') {
        await supabase.from('cs_tickets').update({
          status: 'closed',
          closed_at: now,
          updated_at: now,
          active_draft_id: null,
        }).eq('id', ticket.id);
        console.log(`[reconcile] ${ticket.gorgias_ticket_id} — ${ticket.status} → closed`);
        statusUpdated++;
        continue; // No need to update history for closed tickets
      }

      // Refresh conversation history for open/snoozed tickets
      const messages = await gorgias.getTicketMessages(ticket.gorgias_ticket_id);
      if (messages?.length) {
        const conversationHistory = messages.map(m => ({
          id: m.id,
          sender: m.from_agent === false ? 'customer' : m.channel === 'internal-note' ? 'note' : 'agent',
          body_html: m.stripped_html || m.body_html || null,
          body: gorgias.stripHtml(m.stripped_html || m.stripped_text || m.body_html || m.body_text || ''),
          created_at: m.created_datetime,
          channel: m.channel,
        }));

        // Detect snoozed tickets with new customer replies — flip back to open
        // so the next intake poll picks them up and creates a fresh draft
        const updateFields = { conversation_history: conversationHistory, updated_at: now };

        if (ticket.status === 'snoozed' && ticket.snoozed_at) {
          const customerMessages = messages.filter(m => m.from_agent === false);
          const latestCustomerMsg = customerMessages[customerMessages.length - 1];
          if (latestCustomerMsg && new Date(latestCustomerMsg.created_datetime) > new Date(ticket.snoozed_at)) {
            updateFields.status = 'open';
            console.log(`[reconcile] ${ticket.gorgias_ticket_id} — snoozed → open (customer replied)`);
            statusUpdated++;
          }
        }

        await supabase.from('cs_tickets').update(updateFields).eq('id', ticket.id);
        historyUpdated++;
      }

      await new Promise(r => setTimeout(r, 300)); // Rate limit
    } catch (err) {
      console.error(`[reconcile] Error on ticket ${ticket.gorgias_ticket_id}: ${err.message}`);
      errors++;
    }
  }

  console.log(`[reconcile] Done — ${statusUpdated} status updates, ${historyUpdated} history refreshed, ${errors} errors`);

  return {
    sources: {
      tickets: {
        success: errors === 0,
        rowsWritten: statusUpdated + historyUpdated,
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
