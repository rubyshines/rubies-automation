/**
 * Gorgias ticket-message-created webhook handler
 *
 * Replaces the polling loop in pollGorgiasDrafts.js.
 * Quick-rejects non-qualifying tickets, then delegates to the
 * extracted processTicket() function from the poller module.
 */

const { getSupabaseClient } = require('../../shared/supabaseClient');
const { processTicket, getAiBotUserId } = require('../../customer-service/poller/pollGorgiasDrafts');
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
  console.log(`[gorgias-webhook] ticket-message-created #${ticketId}`);

  // --- Quick-reject filters (same logic as poller pre-filter) ---

  // Skip agent messages (Gorgias templates send "True"/"False" strings)
  const fromAgent = message?.from_agent === true || message?.from_agent === 'True' || message?.from_agent === 'true';
  if (fromAgent) {
    console.log(`[gorgias-webhook] Skip ${ticketId}: agent message`);
    return;
  }

  // Skip non-open tickets
  if (ticket.status && ticket.status !== 'open') {
    console.log(`[gorgias-webhook] Skip ${ticketId}: status=${ticket.status}`);
    return;
  }

  // Skip if no customer email
  if (!ticket.customer?.email) {
    console.log(`[gorgias-webhook] Skip ${ticketId}: no customer email`);
    return;
  }

  // Skip spam (may be boolean or string from Gorgias templates)
  if (ticket.spam === true || ticket.spam === 'True' || ticket.spam === 'true') {
    console.log(`[gorgias-webhook] Skip ${ticketId}: spam`);
    return;
  }

  // Gorgias templates may send tags as a JSON string
  let rawTags = ticket.tags || [];
  if (typeof rawTags === 'string') {
    try { rawTags = JSON.parse(rawTags); } catch { rawTags = []; }
  }
  const tags = (Array.isArray(rawTags) ? rawTags : []).map(tag => (tag.name || tag).toLowerCase());
  if (tags.includes('spam')) {
    console.log(`[gorgias-webhook] Skip ${ticketId}: spam tag`);
    return;
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

  if (isSpammed) {
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

  // Update high-water mark
  await supabase
    .from('cs_poller_state')
    .upsert({
      id: 'gorgias_drafter',
      last_poll_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
}

module.exports = { handle };
