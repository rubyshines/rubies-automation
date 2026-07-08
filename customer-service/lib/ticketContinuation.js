/**
 * Continuation transplant — recover customer replies that arrive as new tickets.
 *
 * When a customer's reply fails to thread onto their existing Gorgias ticket
 * (masked addresses like duck.com, mangled subjects, or a fresh compose), it
 * lands as a brand-new one-message ticket. Closing that ticket as a
 * "duplicate" eats the reply: the surviving ticket stays snoozed thinking the
 * customer went silent, the auto follow-up engine nags them twice, then closes
 * the conversation (2026-07-07 incident — six customers' replies eaten since
 * late May).
 *
 * Instead, transplant the reply onto the surviving ticket as a real customer
 * message and close the stray ticket with a pointer note. The transplanted
 * message fires Gorgias's ticket-message-created webhook, so the normal intake
 * pipeline drafts a response and resets the follow-up cycle — the same
 * mechanics Gmail-import uses to assemble threads (processGmailCs.js).
 *
 * ORDERING IS LOAD-BEARING:
 * 1. Transplant BEFORE reopening the survivor. Reopening first fires a
 *    snoozed→open status webhook whose latest message is still our agent
 *    reply — gorgiasTicketUpdated reads that as pure snooze expiry and sends
 *    a Stage 1 "just following up" nudge. With the customer message already
 *    on the ticket, the same handler resets the follow-up cycle instead.
 * 2. All Gorgias writes before any Supabase write (split-brain rule —
 *    Gorgias is the source of truth; let Gorgias errors propagate).
 * 3. The final Supabase update duplicates what the webhook path will do —
 *    belt-and-braces in case webhook delivery fails.
 */

/**
 * Build the transplant payload from raw Gorgias messages: every customer
 * message on the stray ticket, cleaned, with original timestamps and
 * attachments preserved (Gorgias re-accepts its own attachment objects).
 *
 * @param {array} messages    Raw Gorgias messages of the stray ticket
 * @param {function} extractText  (message) => cleaned body text (pass the
 *                                caller's extractCleanBody to avoid a
 *                                circular require on processGorgiasTickets)
 */
function buildTransplantMessages(messages, extractText) {
  return (messages || [])
    .filter(m => m.from_agent === false && m.channel !== 'internal-note')
    .map(m => ({
      text: extractText(m),
      sentDatetime: m.created_datetime || m.sent_datetime || null,
      attachments: Array.isArray(m.attachments) ? m.attachments : [],
    }))
    .filter(m => m.text && m.text.trim());
}

/**
 * Move the stray ticket's customer message(s) onto the surviving ticket,
 * close the stray ticket, and reset the survivor's follow-up cycle.
 *
 * @param {object} args
 * @param {object} args.gorgias            Gorgias client
 * @param {object} args.supabase           Supabase client
 * @param {number} args.newTicketId        Gorgias id of the stray (new) ticket
 * @param {object} args.survivor           cs_tickets row of the surviving ticket
 *                                         (needs id + gorgias_ticket_id)
 * @param {string} args.customerEmail      Customer email (sender of transplanted messages)
 * @param {string} [args.customerName]     Customer display name
 * @param {array}  args.customerMessages   Output of buildTransplantMessages()
 */
async function transplantContinuation({
  gorgias, supabase, newTicketId, survivor, customerEmail, customerName, customerMessages,
}) {
  const survivorGorgiasId = survivor.gorgias_ticket_id;
  if (!customerMessages?.length) {
    throw new Error(`[continuation] No customer messages to transplant from #${newTicketId}`);
  }

  // 1) Transplant the reply — MUST precede the reopen (see header).
  for (const m of customerMessages) {
    await gorgias.addTicketMessage(survivorGorgiasId, {
      fromAddress: customerEmail,
      fromName: customerName || '',
      bodyText: m.text,
      fromAgent: false,
      sentDatetime: m.sentDatetime || undefined,
      attachments: m.attachments,
    });
  }

  // 2) Audit trail on both tickets, reopen survivor (clears snooze), close stray.
  await gorgias.addInternalNote(
    survivorGorgiasId,
    `Customer reply arrived as separate ticket #${newTicketId} (email failed to thread). ` +
    `Message moved here; #${newTicketId} closed.`,
  );
  await gorgias.reopenTicket(survivorGorgiasId);
  await gorgias.addInternalNote(
    newTicketId,
    `Auto-closed: continuation of existing ticket #${survivorGorgiasId} — customer reply moved there.`,
  );
  await gorgias.closeTicket(newTicketId);

  // 3) Supabase only after every Gorgias write succeeded.
  const nowIso = new Date().toISOString();
  await supabase
    .from('cs_tickets')
    .update({ status: 'open', follow_up_stage: 0, updated_at: nowIso })
    .eq('id', survivor.id);
}

module.exports = { transplantContinuation, buildTransplantMessages };
