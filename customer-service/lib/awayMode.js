/**
 * Away mode — first-contact out-of-office acknowledgment.
 *
 * While the operator is unreachable, nothing sends: intake still drafts a reply
 * and it waits on the dashboard, so a customer writing in hears silence for the
 * length of the trip. Away mode sends one short acknowledgment on FIRST CONTACT
 * so they know why, and otherwise leaves the pipeline completely alone — the
 * advisor still drafts, the draft still waits for review.
 *
 * Deliberately NOT the thank-you auto-close pattern: that path replaces the
 * draft and closes the ticket. This one is additive. The ticket stays open and
 * the draft stays pending, because the customer still needs a real answer.
 *
 * Reaching chat/help-center customers: gorgiasClient.createTicketReply forces
 * channel 'email' when a ticket isn't email-channel and the customer has an
 * address on file. Measured over the 619 tickets since 2026-05-01, 338 arrived
 * via the chat widget or help center and every one of them had an email — so
 * the ack lands in the inbox for bot users too, which is already how every
 * operator reply reaches them.
 */

const { isFlagEnabled, getFlag } = require('../../shared/systemFlags');
const { signOff, signOffHtml } = require('./signatures');

const AWAY_FLAG = 'cs_away_mode';

// Fallback when the flag carries no return phrase in its note. Vague on purpose:
// a wrong specific date is worse than an honest approximation.
const DEFAULT_RETURN_PHRASE = 'in a few days';

/**
 * Is away mode currently active? False on any read failure (fail-soft, and the
 * safe direction — a DB blip must never start mailing customers).
 */
async function isAwayModeActive() {
  return isFlagEnabled(AWAY_FLAG, false);
}

/**
 * The customer-facing return phrase, stored in the flag's note so a new trip is
 * a CLI invocation rather than a code change.
 */
async function getReturnPhrase() {
  const flag = await getFlag(AWAY_FLAG);
  const note = (flag?.note || '').trim();
  return note || DEFAULT_RETURN_PHRASE;
}

/**
 * First contact = the customer has sent exactly one message on this ticket.
 *
 * Chat and help-center tickets pack the whole bot transcript into a single
 * message (meta.origin === 'flow'), so a bot-guided conversation is still one
 * customer message and still counts as first contact.
 */
function isFirstContact(messages) {
  const customerMessages = (messages || []).filter(m => m.from_agent === false);
  return customerMessages.length === 1;
}

/**
 * Build the acknowledgment body. `returnPhrase` renders as "out of town until
 * <phrase>", so pass something that reads naturally there ("Sunday, August 9").
 *
 * No em dashes (brand guardrail). No customer name: the ack is automated and a
 * name pulled from a profile carries dead-name risk, so "Hi there" is both
 * safer and more honest about what this message is.
 */
function buildAwayAck(returnPhrase = DEFAULT_RETURN_PHRASE) {
  const lines = [
    'Hi there,',
    '',
    `Thanks so much for reaching out! I'm out of town until ${returnPhrase} with limited internet access, so I'm slower than usual to reply. I'll get back to you personally as soon as I'm home.`,
    '',
    'Orders are still going out from our warehouse as normal.',
    '',
    'Thanks for your patience!',
    '',
    signOff('Talk soon,'),
  ];
  const text = lines.join('\n');

  const html = [
    '<p>Hi there,</p>',
    `<p>Thanks so much for reaching out! I'm out of town until ${escapeHtml(returnPhrase)} with limited internet access, so I'm slower than usual to reply. I'll get back to you personally as soon as I'm home.</p>`,
    '<p>Orders are still going out from our warehouse as normal.</p>',
    '<p>Thanks for your patience!</p>',
    signOffHtml('Talk soon,'),
  ].join('');

  return { text, html };
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const ET = 'America/New_York';

/**
 * Parse "2026-08-10 08:00" (or an ISO string) as Eastern Time.
 *
 * A bare "YYYY-MM-DD HH:mm" carries no zone and Node would read it as the
 * HOST's local time — which on Railway is UTC and on the laptop is ET, so the
 * same command would set two different windows. Every operator-facing time in
 * this project is ET, so resolve the ET offset for that date explicitly.
 * Returns null on anything unparseable.
 */
function parseEastern(input) {
  const s = String(input ?? '').trim();
  if (!s) return null;
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(s)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?$/);
  if (!m) return null;
  const [, y, mo, d, h = '0', mi = '0'] = m;
  // Guess UTC, measure how that instant renders in ET, correct by the delta.
  const guess = Date.UTC(+y, +mo - 1, +d, +h, +mi);
  const asET = new Date(new Date(guess).toLocaleString('en-US', { timeZone: ET }));
  const asUTC = new Date(new Date(guess).toLocaleString('en-US', { timeZone: 'UTC' }));
  const result = new Date(guess + (asUTC.getTime() - asET.getTime()));
  return Number.isNaN(result.getTime()) ? null : result;
}

function formatEastern(iso) {
  if (!iso) return 'never';
  return new Date(iso).toLocaleString('en-US', {
    timeZone: ET, dateStyle: 'medium', timeStyle: 'short',
  }) + ' ET';
}

/**
 * Send the acknowledgment, at most once per ticket.
 *
 * The claim is a conditional UPDATE on cs_tickets.away_ack_sent_at: intake can
 * run concurrently (webhook, reconcileTickets, gorgiasAdvisorResync) and
 * check-then-act would mail the customer twice. Exactly one caller sees a row
 * come back from `WHERE away_ack_sent_at IS NULL`; the rest no-op.
 *
 * Claim BEFORE the Gorgias write, and release it if that write throws — the
 * inverse order can send an email whose record was never written, which is the
 * failure that produces a duplicate on the next pass.
 *
 * @returns {Promise<{sent: boolean, reason?: string}>}
 */
async function sendAwayAck({ supabase, gorgias, ticketId, ticketRowId, returnPhrase }) {
  const phrase = returnPhrase || await getReturnPhrase();
  const { text, html } = buildAwayAck(phrase);

  const claimQuery = supabase
    .from('cs_tickets')
    .update({ away_ack_sent_at: new Date().toISOString() })
    .is('away_ack_sent_at', null);

  const { data: claimed, error: claimErr } = await (
    ticketRowId
      ? claimQuery.eq('id', ticketRowId)
      : claimQuery.eq('gorgias_ticket_id', ticketId)
  ).select('id');

  if (claimErr) {
    // Can't establish ownership — never send a customer-facing email blind.
    console.warn(`[away] claim failed for ticket ${ticketId}: ${claimErr.message}`);
    return { sent: false, reason: 'claim_error' };
  }
  if (!claimed?.length) return { sent: false, reason: 'already_sent' };

  try {
    await gorgias.createTicketReply(ticketId, { body_text: text, body_html: html });
  } catch (err) {
    // Nothing reached the customer — release the claim so a later pass retries.
    await supabase
      .from('cs_tickets')
      .update({ away_ack_sent_at: null })
      .eq('id', claimed[0].id);
    throw err;
  }

  return { sent: true, body: text };
}

module.exports = {
  AWAY_FLAG,
  DEFAULT_RETURN_PHRASE,
  isAwayModeActive,
  getReturnPhrase,
  isFirstContact,
  buildAwayAck,
  sendAwayAck,
  parseEastern,
  formatEastern,
};
