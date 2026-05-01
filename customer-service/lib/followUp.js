/**
 * Auto follow-up engine (event-driven off Gorgias snooze expiry).
 *
 * Stage 1: Send static follow-up from care@ via Gorgias, re-snooze.
 * Stage 2: Send personal email from jamie@ via SendGrid, close ticket.
 *
 * Called from gorgiasTicketUpdated webhook handler when a snoozed ticket
 * transitions to open (snooze expired without customer reply).
 */

const { getSupabaseClient } = require('../../shared/supabaseClient');
const { getAiBotUserId } = require('../intake/processGorgiasTickets');

const DEFAULT_SNOOZE_DAYS = 3;

/**
 * Build the personal follow-up email (Stage 2) from jamie@rubyshines.com.
 */
function buildPersonalFollowUpEmail(customerName, originalResponse) {
  const greeting = customerName ? `Hi ${customerName}` : 'Hi there';

  const text = `${greeting},

I wanted to follow up on your inquiry in case my initial response and follow up ended up in your spam folder. This is what I wrote:

${originalResponse}

Talk soon,
Jamie Alexander
RUBIES Founder`;

  const escapedResponse = (originalResponse || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');

  const html = `<p>${greeting},</p>
<p>I wanted to follow up on your inquiry in case my initial response and follow up ended up in your spam folder. This is what I wrote:</p>
<blockquote style="border-left: 3px solid #ccc; padding-left: 12px; margin: 16px 0; color: #555;">
${escapedResponse}
</blockquote>
<p>Talk soon,<br>Jamie Alexander<br>RUBIES Founder</p>`;

  return { subject: 'Follow up from your RUBIES inquiry', text, html };
}

/**
 * Stage 1: Send "just checking in" from care@ via Gorgias, re-snooze.
 *
 * @param {object} gorgias - gorgiasClient module
 * @param {object} ticket - cs_tickets row (id, gorgias_ticket_id, customer_email, customer_name)
 * @param {object} [opts]
 * @param {number} [opts.snoozeDays] - days to re-snooze (default 3, override for testing)
 */
async function executeStage1(gorgias, ticket, { snoozeDays, gorgiasTicket } = {}) {
  const supabase = getSupabaseClient();
  const days = snoozeDays ?? DEFAULT_SNOOZE_DAYS;

  // Find most recent sent advisor draft for this ticket
  const { data: draft, error: draftErr } = await supabase
    .from('cs_ai_drafts')
    .select('id, gorgias_ticket_id, customer_email, customer_name, order_number, sent_at, sent_response, message_type')
    .eq('gorgias_ticket_id', ticket.gorgias_ticket_id)
    .eq('status', 'sent')
    .eq('draft_kind', 'advisor_draft')
    .order('sent_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (draftErr) throw draftErr;
  if (!draft?.sent_at) {
    console.log(`[follow-up] Stage 1 skip: no sent advisor draft for ticket ${ticket.gorgias_ticket_id}`);
    return { sent: false, reason: 'no_sent_draft' };
  }

  // Use customer_name from draft (dead-name-safe, inferred by advisor)
  const name = draft.customer_name;
  const greeting = name ? `Hi ${name},` : 'Hi,';
  const followUpText = `${greeting}\n\nI am following up on this.\n\nTalk soon,\nJamie`;
  const followUpHtml = `<p>${greeting}</p><p>I am following up on this.</p><p>Talk soon,<br>Jamie</p>`;

  // Send via Gorgias using AI bot user ID (so intake ignores it)
  const aiBotId = await getAiBotUserId();
  const replyResult = await gorgias.createTicketReply(ticket.gorgias_ticket_id, {
    body_text: followUpText,
    body_html: followUpHtml,
    senderId: aiBotId,
    ticket: gorgiasTicket,
  });

  // Create audit draft record
  const now = new Date().toISOString();
  const { data: newDraft } = await supabase
    .from('cs_ai_drafts')
    .insert({
      gorgias_ticket_id: ticket.gorgias_ticket_id,
      gorgias_message_id: 0,
      customer_email: draft.customer_email,
      customer_name: draft.customer_name,
      order_number: draft.order_number,
      draft_response: followUpText,
      sent_response: followUpText,
      structured_output: { status: 'follow_up', reason: 'auto follow-up stage 1 (snooze expiry)' },
      audit_trail: ['[Auto Follow-up Stage 1] Snooze expired, sent via Gorgias (care@)'],
      confidence: 'high',
      advisor_status: 'follow_up',
      draft_kind: 'follow_up_care',
      status: 'sent',
      sent_at: now,
      previous_draft_id: draft.id,
      gorgias_reply_message_id: replyResult?.id || null,
      source: 'auto_follow_up',
    })
    .select('id')
    .single();

  // Link original → follow-up
  if (newDraft) {
    await supabase.from('cs_ai_drafts').update({ follow_up_draft_id: newDraft.id }).eq('id', draft.id);
  }

  // Log feedback
  await supabase.from('cs_ai_feedback_log').insert({
    draft_id: draft.id,
    gorgias_ticket_id: ticket.gorgias_ticket_id,
    action: 'auto_follow_up_stage1',
    feedback_notes: 'Auto follow-up sent via Gorgias (care@) — snooze expiry',
  });

  // Re-snooze
  await gorgias.snoozeTicket(ticket.gorgias_ticket_id, days);

  // Update ticket
  await supabase.from('cs_tickets').update({
    status: 'snoozed',
    snoozed_at: now,
    updated_at: now,
    follow_up_stage: 1,
  }).eq('id', ticket.id);

  console.log(`[follow-up] Stage 1 sent: ${draft.customer_email} (ticket ${ticket.gorgias_ticket_id}), re-snoozed ${days}d`);
  return { sent: true, draftId: newDraft?.id };
}

/**
 * Stage 2: Send personal email from jamie@ via SendGrid, close ticket.
 *
 * @param {object} gorgias - gorgiasClient module
 * @param {object} ticket - cs_tickets row (id, gorgias_ticket_id, customer_email, customer_name)
 */
async function executeStage2(gorgias, ticket) {
  const supabase = getSupabaseClient();

  // Find the Stage 1 follow-up draft
  const { data: followUpDraft, error: fuErr } = await supabase
    .from('cs_ai_drafts')
    .select('id, gorgias_ticket_id, customer_email, customer_name, order_number, sent_at, previous_draft_id')
    .eq('gorgias_ticket_id', ticket.gorgias_ticket_id)
    .eq('status', 'sent')
    .eq('draft_kind', 'follow_up_care')
    .order('sent_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (fuErr) throw fuErr;
  if (!followUpDraft) {
    console.log(`[follow-up] Stage 2 skip: no follow_up_care draft for ticket ${ticket.gorgias_ticket_id}`);
    return { sent: false, reason: 'no_follow_up_care_draft' };
  }

  // Trace back to original draft for sent_response
  let originalResponse = null;
  if (followUpDraft.previous_draft_id) {
    const { data: origDraft } = await supabase
      .from('cs_ai_drafts')
      .select('sent_response, draft_response')
      .eq('id', followUpDraft.previous_draft_id)
      .single();
    originalResponse = origDraft?.sent_response || origDraft?.draft_response || null;
  }

  if (!originalResponse) {
    console.warn(`[follow-up] Stage 2 skip: no original response for ticket ${ticket.gorgias_ticket_id}`);
    return { sent: false, reason: 'no_original_response' };
  }

  // Send personal email via SendGrid
  const { getSendgridClient } = require('../../shared/sendgridClient');
  const sgMail = getSendgridClient();
  if (!sgMail) {
    console.error('[follow-up] SendGrid not configured — cannot send stage 2 personal email');
    return { sent: false, reason: 'sendgrid_not_configured' };
  }

  const email = buildPersonalFollowUpEmail(followUpDraft.customer_name, originalResponse);
  await sgMail.send({
    to: followUpDraft.customer_email,
    from: { name: 'Jamie Alexander', email: 'jamie@rubyshines.com' },
    cc: [{ email: 'jamie@rubyshines.com' }],
    subject: email.subject,
    text: email.text,
    html: email.html,
    trackingSettings: { clickTracking: { enable: false, enableText: false } },
  });

  // Create audit draft record
  const now = new Date().toISOString();
  const { data: newDraft } = await supabase
    .from('cs_ai_drafts')
    .insert({
      gorgias_ticket_id: ticket.gorgias_ticket_id,
      gorgias_message_id: 0,
      customer_email: followUpDraft.customer_email,
      customer_name: followUpDraft.customer_name,
      order_number: followUpDraft.order_number,
      draft_response: email.text,
      sent_response: email.text,
      structured_output: { status: 'personal_follow_up', reason: 'auto follow-up stage 2 (snooze expiry), personal email from jamie@' },
      audit_trail: ['[Auto Follow-up Stage 2] Snooze expired, personal email from jamie@rubyshines.com'],
      confidence: 'high',
      advisor_status: 'follow_up',
      draft_kind: 'follow_up_personal',
      status: 'sent',
      sent_at: now,
      previous_draft_id: followUpDraft.id,
      source: 'auto_follow_up',
    })
    .select('id')
    .single();

  // Link stage 1 → stage 2
  if (newDraft) {
    await supabase.from('cs_ai_drafts').update({ follow_up_draft_id: newDraft.id }).eq('id', followUpDraft.id);
  }

  // Log feedback
  await supabase.from('cs_ai_feedback_log').insert({
    draft_id: followUpDraft.id,
    gorgias_ticket_id: ticket.gorgias_ticket_id,
    action: 'auto_follow_up_stage2',
    feedback_notes: 'Personal follow-up sent via SendGrid (jamie@) — snooze expiry, ticket closed',
  });

  // Close ticket in Gorgias
  try {
    await gorgias.closeTicket(ticket.gorgias_ticket_id);
    await gorgias.assignTicket(ticket.gorgias_ticket_id, null);
    await gorgias.addTicketTag(ticket.gorgias_ticket_id, 'auto-follow-up-closed');
  } catch (e) {
    console.warn(`[follow-up] Could not close ticket ${ticket.gorgias_ticket_id} in Gorgias: ${e.message}`);
  }

  // Update ticket status to closed
  await supabase.from('cs_tickets').update({
    status: 'closed',
    closed_at: now,
    updated_at: now,
    active_draft_id: null,
    follow_up_stage: 2,
  }).eq('id', ticket.id);

  console.log(`[follow-up] Stage 2 sent: ${followUpDraft.customer_email} (ticket ${ticket.gorgias_ticket_id}) — closed`);
  return { sent: true, draftId: newDraft?.id };
}

module.exports = { executeStage1, executeStage2, buildPersonalFollowUpEmail };
