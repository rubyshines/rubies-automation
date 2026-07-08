/**
 * Gorgias ticket-updated webhook handler
 *
 * Syncs ticket status changes from Gorgias -> cs_tickets.
 * Catches tickets closed/reopened outside the dashboard.
 * Triggers auto follow-ups when snoozed tickets expire.
 */

const { getSupabaseClient } = require('../../shared/supabaseClient');
const gorgias = require('../../customer-service/import/gorgiasClient');
const { executeStage1, executeStage2 } = require('../../customer-service/lib/followUp');

async function handle(payload) {
  const supabase = getSupabaseClient();

  const ticket = payload?.ticket;
  if (!ticket?.id) {
    console.warn('[gorgias-ticket-updated] No ticket in payload — skipping');
    return;
  }

  const ticketId = ticket.id;
  const gorgiasStatus = ticket.status; // open | closed

  // Look up our ticket (include fields needed for follow-up)
  const { data: ourTicket } = await supabase
    .from('cs_tickets')
    .select('id, status, follow_up_stage, gorgias_ticket_id, customer_email, customer_name')
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

  } else if (gorgiasStatus === 'open' && ourTicket.status === 'pending_operator') {
    // Gorgias opened while ticket is On Me. Two cases:
    // 1. Customer replied → move to open (intake will handle), reset follow-up stage
    // 2. Snooze expired with no reply → keep as pending_operator, no auto-follow-up
    const messages = await gorgias.getTicketMessages(ticketId);
    const latest = messages[messages.length - 1];
    if (latest && !latest.from_agent) {
      await supabase.from('cs_tickets').update({
        status: 'open',
        follow_up_stage: 0,
        updated_at: now,
      }).eq('id', ourTicket.id);
      console.log(`[gorgias-ticket-updated] ${ticketId} — pending_operator → open (customer replied)`);
    } else {
      console.log(`[gorgias-ticket-updated] ${ticketId} — pending_operator snooze expired, staying On Me, no auto-follow-up`);
    }

  } else if (gorgiasStatus === 'open' && ourTicket.status === 'snoozed') {
    // Snoozed ticket woke up — either snooze expired or customer replied.
    // Check Gorgias messages to distinguish.
    const messages = await gorgias.getTicketMessages(ticketId);
    const latest = messages[messages.length - 1];

    if (latest && !latest.from_agent) {
      // Customer replied during snooze — reset follow-up stage, let intake handle
      await supabase.from('cs_tickets').update({
        status: 'open',
        follow_up_stage: 0,
        updated_at: now,
      }).eq('id', ourTicket.id);
      console.log(`[gorgias-ticket-updated] ${ticketId} — snoozed → open (customer replied, follow-up reset)`);
      return;
    }

    // Pure snooze expiry — trigger follow-up based on stage
    const stage = ourTicket.follow_up_stage || 0;

    if (stage === 0) {
      // Atomically claim the 0→1 transition before sending. A duplicate
      // ticket-updated event (Gorgias retries / concurrent snooze-expiry) that
      // also reads stage 0 will fail this guarded update and bail, so the
      // customer gets exactly one Stage 1 follow-up instead of two.
      const { data: claimed } = await supabase.from('cs_tickets')
        .update({ follow_up_stage: 1, updated_at: now })
        .eq('id', ourTicket.id)
        .eq('follow_up_stage', 0)
        .eq('status', 'snoozed')
        .select('id');
      if (!claimed || claimed.length === 0) {
        console.log(`[gorgias-ticket-updated] ${ticketId} — Stage 1 already claimed by another event, skipping`);
        return;
      }
      try {
        await executeStage1(gorgias, ourTicket);
        console.log(`[gorgias-ticket-updated] ${ticketId} — Stage 1 follow-up sent, re-snoozed`);
      } catch (err) {
        console.error(`[gorgias-ticket-updated] ${ticketId} — Stage 1 error: ${err.message}`);
        // Roll the claim back so the next expiry retries.
        await supabase.from('cs_tickets').update({
          status: 'open',
          follow_up_stage: 0,
          updated_at: now,
        }).eq('id', ourTicket.id);
      }

    } else if (stage === 1) {
      // Same atomic claim for the 1→2 transition.
      const { data: claimed } = await supabase.from('cs_tickets')
        .update({ follow_up_stage: 2, updated_at: now })
        .eq('id', ourTicket.id)
        .eq('follow_up_stage', 1)
        .eq('status', 'snoozed')
        .select('id');
      if (!claimed || claimed.length === 0) {
        console.log(`[gorgias-ticket-updated] ${ticketId} — Stage 2 already claimed by another event, skipping`);
        return;
      }
      try {
        await executeStage2(gorgias, ourTicket);
        console.log(`[gorgias-ticket-updated] ${ticketId} — Stage 2 follow-up sent, ticket closed`);
      } catch (err) {
        console.error(`[gorgias-ticket-updated] ${ticketId} — Stage 2 error: ${err.message}`);
        await supabase.from('cs_tickets').update({
          status: 'open',
          follow_up_stage: 1,
          updated_at: now,
        }).eq('id', ourTicket.id);
      }

    } else {
      // Stage 2+ already done — just update status
      await supabase.from('cs_tickets').update({
        status: 'open',
        updated_at: now,
      }).eq('id', ourTicket.id);
      console.log(`[gorgias-ticket-updated] ${ticketId} — follow_up_stage=${stage}, no further action`);
    }

  } else if (gorgiasStatus === 'open' && ourTicket.status === 'closed') {
    // Ticket reopened in Gorgias (e.g. customer replied after close)
    await supabase.from('cs_tickets').update({
      status: 'open',
      updated_at: now,
    }).eq('id', ourTicket.id);
    console.log(`[gorgias-ticket-updated] ${ticketId} — closed → open (reopened)`);
  }
}

module.exports = { handle };
