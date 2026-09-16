/**
 * "When did we last write to this customer, and what did we say?"
 *
 * Proactive outreach is the one CS action with no inbound message anchoring it,
 * so nothing in the flow forces anyone to look at what the customer has already
 * been told. On 2026-09-15 a pre-order delay wave went to a customer who was
 * three weeks into an open thread about the same two items, and to another who
 * had been told the same news twenty minutes earlier. In both cases the
 * evidence was one query away and simply was not read.
 *
 * cs_tickets is the record of everything said through care@ — Gorgias threads
 * and staged outreach both land there — so the conversation, not a per-feature
 * notification log, is the thing to check.
 */

const { getSupabaseClient } = require('../../shared/supabaseClient');

const DEFAULT_WINDOW_DAYS = 30;

function normalizeOrderNumber(value) {
  if (value === null || value === undefined) return null;
  const n = Number(String(value).replace(/^#/, '').trim());
  return Number.isNaN(n) ? null : n;
}

// conversation_history rows carry the author under `sender`; older rows have
// used `author`. Anything that is not the customer is ours.
function isAgentMessage(message) {
  const who = message?.sender ?? message?.author ?? null;
  return who === 'agent';
}

function messageTimestamp(message) {
  return message?.created_at || message?.date || null;
}

/**
 * Agent messages sent to `customerEmail` within the window, newest first.
 *
 * Returns { messages, error }. `error` is set (and `messages` empty) when the
 * lookup itself failed — the caller must distinguish "nothing was sent" from
 * "we could not tell", because a guard that cannot read its source looks
 * exactly like a clean record.
 */
async function recentAgentMessages(customerEmail, { windowDays = DEFAULT_WINDOW_DAYS, now = new Date(), supabase } = {}) {
  if (!customerEmail) return { messages: [], error: null };
  const sb = supabase || getSupabaseClient();

  const since = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const { data, error } = await sb
    .from('cs_tickets')
    .select('id, order_number, created_at, conversation_history')
    .eq('customer_email', customerEmail);

  if (error) return { messages: [], error: error.message };

  const out = [];
  for (const ticket of data || []) {
    const history = Array.isArray(ticket.conversation_history) ? ticket.conversation_history : [];
    for (const message of history) {
      if (!isAgentMessage(message)) continue;
      const ts = messageTimestamp(message);
      if (!ts) continue;
      const at = new Date(ts);
      // `now` is an upper bound as well as the window anchor, so a replay of
      // a past decision cannot see messages that had not been sent yet.
      if (Number.isNaN(at.getTime()) || at < since || at > now) continue;
      out.push({
        ticket_id: ticket.id,
        order_number: normalizeOrderNumber(ticket.order_number),
        sent_at: at.toISOString(),
        body: String(message.body || '').replace(/\s+/g, ' ').trim(),
      });
    }
  }

  out.sort((a, b) => b.sent_at.localeCompare(a.sent_at));
  return { messages: out, error: null };
}

/**
 * Same question for a whole wave, in one query rather than one per order.
 * Returns { byEmail: Map<email, messages[]>, error }.
 */
async function recentAgentMessagesForMany(emails, { windowDays = DEFAULT_WINDOW_DAYS, now = new Date(), supabase } = {}) {
  const unique = [...new Set((emails || []).filter(Boolean))];
  const byEmail = new Map(unique.map((e) => [e, []]));
  if (!unique.length) return { byEmail, error: null };

  const sb = supabase || getSupabaseClient();
  const since = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const { data, error } = await sb
    .from('cs_tickets')
    .select('id, order_number, customer_email, conversation_history')
    .in('customer_email', unique);

  if (error) return { byEmail, error: error.message };

  for (const ticket of data || []) {
    const bucket = byEmail.get(ticket.customer_email);
    if (!bucket) continue;
    const history = Array.isArray(ticket.conversation_history) ? ticket.conversation_history : [];
    for (const message of history) {
      if (!isAgentMessage(message)) continue;
      const ts = messageTimestamp(message);
      if (!ts) continue;
      const at = new Date(ts);
      // `now` is an upper bound as well as the window anchor, so a replay of
      // a past decision cannot see messages that had not been sent yet.
      if (Number.isNaN(at.getTime()) || at < since || at > now) continue;
      bucket.push({
        ticket_id: ticket.id,
        order_number: normalizeOrderNumber(ticket.order_number),
        sent_at: at.toISOString(),
        body: String(message.body || '').replace(/\s+/g, ' ').trim(),
      });
    }
  }
  for (const bucket of byEmail.values()) bucket.sort((a, b) => b.sent_at.localeCompare(a.sent_at));
  return { byEmail, error: null };
}

/** One line per prior message, for a refusal or a warning block. */
function describeRecentContact(messages, { limit = 5 } = {}) {
  return messages.slice(0, limit).map((m) => {
    const when = m.sent_at.slice(0, 16).replace('T', ' ');
    const where = m.order_number ? `#${m.order_number}` : 'no order';
    return `- ${when} UTC on ticket ${m.ticket_id} (${where}): "${m.body.slice(0, 160)}${m.body.length > 160 ? '…' : ''}"`;
  });
}

module.exports = {
  DEFAULT_WINDOW_DAYS,
  recentAgentMessages,
  recentAgentMessagesForMany,
  describeRecentContact,
  isAgentMessage,
  normalizeOrderNumber,
};
