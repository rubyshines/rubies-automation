/**
 * Gorgias ticket-message-created webhook handler
 *
 * Replaces the polling loop in pollGorgiasDrafts.js.
 * Quick-rejects non-qualifying tickets, then delegates to the
 * extracted processTicket() function from the poller module.
 */

const { getSupabaseClient } = require('../../shared/supabaseClient');
const { processTicket, getAiBotUserId } = require('../../customer-service/intake/processGorgiasTickets');
const { hasOrderHistory } = require('../../customer-service/lib/knownCustomer');
const gorgias = require('../../customer-service/import/gorgiasClient');

async function handle(payload) {
  const supabase = getSupabaseClient();

  // Gorgias webhook payload shape:
  // { ticket: { id, customer: { email }, status, ... }, message: { id, from_agent, body_text, ... } }
  const ticket = payload?.ticket;
  const message = payload?.message;

  if (!ticket?.id) {
    console.warn('[gorgias-webhook] No ticket in payload — skipping');
    return;
  }

  const ticketId = ticket.id;

  // Route status-change events to the ticket-updated handler
  // (Gorgias sends all triggers to the same URL for one integration)
  if (!message?.id) {
    console.log(`[gorgias-webhook] ticket-status-updated #${ticketId} status=${ticket.status}`);
    const { handle: handleStatusUpdate } = require('./gorgiasTicketUpdated');
    return handleStatusUpdate(payload);
  }

  console.log(`[gorgias-webhook] ticket-message-created #${ticketId}`);

  // --- Quick-reject filters (same logic as poller pre-filter) ---

  // Skip agent messages (Gorgias templates send "True"/"False" strings)
  const fromAgent = message?.from_agent === true || message?.from_agent === 'True' || message?.from_agent === 'true';
  if (fromAgent) {
    console.log(`[gorgias-webhook] Skip ${ticketId}: agent message`);
    return;
  }

  // Skip closed tickets (but allow pending/other statuses — new tickets may not
  // be 'open' yet when the webhook fires, especially from non-email channels)
  if (ticket.status === 'closed') {
    console.log(`[gorgias-webhook] Skip ${ticketId}: status=closed`);
    return;
  }

  // Skip if no customer email
  if (!ticket.customer?.email) {
    console.log(`[gorgias-webhook] Skip ${ticketId}: no customer email`);
    return;
  }

  // Spam-flagged tickets (flag may be boolean or string from Gorgias
  // templates; tags may arrive as a JSON string): a known customer overrides
  // the flag. Gorgias's spam detector mislabels real customers — a refund
  // request sat invisible for six weeks in 2026-07 because this handler
  // hard-skipped on the flag and the nightly sweep shared the blind spot.
  // Someone who has placed an order with us is never spam. Unknown senders
  // stay skipped here; the nightly sweep's vendor-spam triage decides them
  // (person → drafted, pitch → closed with a note) so nothing is dropped
  // silently anymore.
  const isSpamFlagged = ticket.spam === true || ticket.spam === 'True' || ticket.spam === 'true';
  let rawTags = ticket.tags || [];
  if (typeof rawTags === 'string') {
    try { rawTags = JSON.parse(rawTags); } catch { rawTags = []; }
  }
  const tags = (Array.isArray(rawTags) ? rawTags : []).map(tag => (tag.name || tag).toLowerCase());
  if (isSpamFlagged || tags.includes('spam')) {
    const known = await hasOrderHistory(supabase, ticket.customer.email);
    if (!known) {
      console.log(`[gorgias-webhook] Skip ${ticketId}: spam-flagged, sender unknown — deferred to nightly triage`);
      return;
    }
    console.log(`[gorgias-webhook] Ticket ${ticketId}: spam-flagged but ${ticket.customer.email} has order history — overriding spam flag`);
  }

  // Check assignee — skip if assigned to another agent
  // Gorgias templates may send assignee_user as a JSON string
  let assigneeUser = ticket.assignee_user;
  if (typeof assigneeUser === 'string') {
    try { assigneeUser = JSON.parse(assigneeUser); } catch { assigneeUser = null; }
  }
  const aiBotId = await getAiBotUserId();
  const assigneeId = assigneeUser?.id;
  if (assigneeId && assigneeId !== aiBotId) {
    console.log(`[gorgias-webhook] Skip ${ticketId}: assigned to another agent`);
    return;
  }

  // Check Supabase for existing drafts on this ticket
  const { data: existingDrafts } = await supabase
    .from('cs_ai_drafts')
    .select('gorgias_message_id, status')
    .eq('gorgias_ticket_id', ticketId);

  const existingMessageIds = new Set();
  let hasReleasedDraft = false;
  let isSpammed = false;

  for (const d of (existingDrafts || [])) {
    existingMessageIds.add(d.gorgias_message_id);
    if (d.status === 'released') hasReleasedDraft = true;
    if (d.status === 'spam') isSpammed = true;
  }

  // Only skip spammed tickets if the incoming message already has a draft.
  // If a new message arrived (e.g. outreach follow-up), reprocess so the
  // advisor can re-classify and re-close in Gorgias.
  if (isSpammed && message?.id && existingMessageIds.has(message.id)) {
    console.log(`[gorgias-webhook] Skip ${ticketId}: spammed in our system`);
    return;
  }

  // Released back to Gorgias and unassigned — don't re-draft
  if (hasReleasedDraft && !assigneeId) {
    console.log(`[gorgias-webhook] Skip ${ticketId}: released to Gorgias`);
    return;
  }

  // AI bot assigned + pending draft = already queued
  if (assigneeId === aiBotId && existingMessageIds.size > 0) {
    // Still process — the message might be new (existingMessageIds check is per-message)
  }

  // --- Delegate to processTicket ---
  // The ticket object from webhook may be minimal. Fetch full ticket if needed.
  // processTicket fetches messages itself, so we just need the ticket shape.
  const fullTicket = {
    id: ticketId,
    customer: ticket.customer,
    status: ticket.status,
    assignee_user: assigneeUser,
    tags: rawTags,
    spam: ticket.spam,
  };

  const result = await processTicket(supabase, fullTicket, aiBotId, existingMessageIds);

  if (result?.drafted) {
    console.log(`[gorgias-webhook] Draft created for ticket ${ticketId}`);
  } else {
    console.log(`[gorgias-webhook] Ticket ${ticketId} skipped by processTicket`);
  }

  // NOTE: Do NOT update cs_poller_state here. The webhook processes a single
  // ticket — advancing the high-water mark would cause the poller to skip
  // every other ticket in the window. Only the poller (which scans the full
  // window) should advance last_poll_at.
}

module.exports = { handle };
