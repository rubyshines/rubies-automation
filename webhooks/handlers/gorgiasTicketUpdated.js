/**
 * Gorgias ticket-updated webhook handler
 *
 * Syncs ticket status changes from Gorgias → cs_tickets.
 * Catches tickets closed/reopened outside the dashboard.
 */

const { getSupabaseClient } = require('../../shared/supabaseClient');

async function handle(payload) {
  const supabase = getSupabaseClient();

  const ticket = payload?.ticket;
  if (!ticket?.id) {
    console.warn('[gorgias-ticket-updated] No ticket in payload — skipping');
    return;
  }

  const ticketId = ticket.id;
  const gorgiasStatus = ticket.status; // open | closed

  // Look up our ticket
  const { data: ourTicket } = await supabase
    .from('cs_tickets')
    .select('id, status')
    .eq('gorgias_ticket_id', ticketId)
    .maybeSingle();

  if (!ourTicket) {
    // We don't track this ticket — ignore
    return;
  }

  const now = new Date().toISOString();

  if (gorgiasStatus === 'closed' && ourTicket.status !== 'closed') {
    await supabase.from('cs_tickets').update({
      status: 'closed',
      closed_at: now,
      updated_at: now,
      active_draft_id: null,
    }).eq('id', ourTicket.id);
    console.log(`[gorgias-ticket-updated] ${ticketId} — ${ourTicket.status} → closed`);
  } else if (gorgiasStatus === 'open' && ourTicket.status === 'closed') {
    // Ticket reopened in Gorgias
    await supabase.from('cs_tickets').update({
      status: 'open',
      updated_at: now,
    }).eq('id', ourTicket.id);
    console.log(`[gorgias-ticket-updated] ${ticketId} — closed → open (reopened)`);
  }
}

module.exports = { handle };
