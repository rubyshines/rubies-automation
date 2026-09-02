/**
 * replyCc.js — who else belongs on a reply.
 *
 * An email is a conversation with everyone on it, not just the sender. When a
 * contact cc's a colleague and our reply goes only to the sender, the colleague
 * is silently dropped from a conversation they were deliberately included in —
 * and nothing anywhere surfaces that it happened. So every draft aimed at an
 * existing thread starts with the reply-all cc precomputed, visible in the
 * panel's Cc field where the operator can edit or clear it before sending.
 *
 * The anchor is the newest REAL message on the thread (machine mail — auto
 * replies, calendar notices, DSNs — never carries a conversation's audience):
 *   inbound anchor  → their cc + everyone else they addressed, minus us and
 *                     the sender (who becomes the To of the reply)
 *   outbound anchor → whoever we cc'd last time (its To already IS the
 *                     reply's To), so a follow-up chase keeps the audience
 */
const { NON_REPLY_INBOUND_TYPES } = require('./replyCorrelation');

/** Every address in a header-ish value ("a@b, Name <c@d>"). Lowercased. Pure. */
function splitAddresses(value) {
  return (String(value || '').match(/[\w.+-]+@[\w.-]+\.\w+/g) || []).map(a => a.toLowerCase());
}

/**
 * The newest message a reply would actually be answering: real correspondence
 * in either direction, never machine mail. `messages` in any order. Pure.
 */
function pickReplyAnchor(messages) {
  const real = (messages || []).filter(m => !NON_REPLY_INBOUND_TYPES.has(m.message_type));
  if (!real.length) return null;
  return real.reduce((newest, m) =>
    !newest || new Date(m.sent_at || 0) > new Date(newest.sent_at || 0) ? m : newest, null);
}

/**
 * Reply-all cc for a reply to `anchor`, as a comma-joined string, or null when
 * nobody beyond the To recipient is on the conversation. Pure.
 */
function computeReplyCc(anchor, ourEmail) {
  if (!anchor) return null;
  const exclude = new Set(splitAddresses(ourEmail));
  let pool = splitAddresses(anchor.cc_email);
  if (anchor.direction === 'inbound') {
    // Everyone they wrote to besides us stays on the reply; the sender is the To.
    pool = pool.concat(splitAddresses(anchor.to_email));
    for (const a of splitAddresses(anchor.from_email)) exclude.add(a);
  }
  const cc = [...new Set(pool)].filter(a => !exclude.has(a));
  return cc.length ? cc.join(', ') : null;
}

/**
 * Default cc for a new draft on `thread_id`, from the thread's stored messages.
 * Returns a comma-joined string or null. Fail-soft: a lookup error means no
 * default, never a blocked draft.
 */
async function defaultReplyCc(sb, { thread_id, our_email }) {
  if (!thread_id) return null;
  const { data, error } = await sb.from('b2b_messages')
    .select('direction, message_type, from_email, to_email, cc_email, sent_at')
    .eq('thread_id', thread_id)
    .order('sent_at', { ascending: false })
    .limit(20);
  if (error) {
    console.warn(`[replyCc] thread ${thread_id} lookup failed: ${error.message} — no cc default`);
    return null;
  }
  return computeReplyCc(pickReplyAnchor(data || []), our_email);
}

module.exports = { splitAddresses, pickReplyAnchor, computeReplyCc, defaultReplyCc };
