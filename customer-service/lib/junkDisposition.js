/**
 * Junk disposition — should intake auto-close a ticket the advisor classified
 * as junk (phishing/scam/mass mail), instead of queueing the draft?
 *
 * Context: the spam gate (2026-08-30, hardened 2026-09-02) only governs tickets
 * Gorgias's own detector flags. A phishing email that evades the detector
 * enters normal intake and lands in the operator queue as a pending draft —
 * observed 2026-09-02 with a SendGrid-impersonation campaign whose flagged
 * copy the gate caught and whose unflagged twin sailed through. The advisor
 * already recognizes these (its summary read "phishing email... do not click")
 * but had no disposition to act on that judgment. Now it does: message_type
 * "junk" closes the ticket with an audit note instead of drafting.
 *
 * The deterministic guards mirror the spam gate's philosophy:
 * - a known customer (has a Shopify order) is NEVER auto-closed — even a
 *   junk-looking message from a real customer stays for human eyes
 * - a thread we've already replied to on stays for human eyes too: auto-closing
 *   a conversation in progress is a worse failure than one stray junk draft
 * Both guards fail toward the queue, so the worst case of a wrong advisor
 * verdict is the status quo (a junk draft an operator dismisses), and a close
 * is always reversible (reopen in Gorgias — the audit note says what happened).
 */

/**
 * @param {object} args
 * @param {string} args.messageType  canonical message_type from the advisor
 * @param {boolean} args.known       sender email has Shopify order history
 * @param {boolean} args.hasAgentReply  a human agent has replied on this thread
 * @returns {boolean}
 */
function shouldAutoCloseJunk({ messageType, known, hasAgentReply }) {
  return messageType === 'junk' && !known && !hasAgentReply;
}

/**
 * Audit note left on the Gorgias ticket when intake closes it as junk.
 * @param {string|null} summary  the advisor's one-line summary of the message
 * @returns {string}
 */
function junkCloseNote(summary) {
  const what = (summary || '').trim() || 'no genuine customer inquiry';
  return `Auto-closed by intake: the CS advisor classified this as junk (${what}). Sender has no order history and no agent had replied. Reopen if this is wrong — reopening returns it to normal intake.`;
}

module.exports = { shouldAutoCloseJunk, junkCloseNote };
