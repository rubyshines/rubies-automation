/**
 * readState.js — keep Gmail's unread badge honest against the outreach engine.
 *
 * The invariant: a thread is UNREAD in Gmail exactly when a person still needs
 * to look at it. Nothing in the engine touched read state before this, so an
 * org's reply that Jamie read and answered in the Outreach panel stayed bold in
 * the inbox for the rest of the day, machine mail (RSVPs, out-of-office, DSNs)
 * that the engine had already consumed sat unread beside it, and the inbox
 * became a second queue that disagreed with the real one.
 *
 * One decision function, three callers: the send tool (we just answered), the
 * inbound correlator (it just classified machine mail or closed a thank-you),
 * and a nightly sweep over whatever Gmail still shows unread (the catch-up the
 * two live paths need, since both are fire-and-forget). Same verdict whichever
 * path asks — the sweep is not allowed a different rule from the live hooks.
 *
 * Deliberately never marks UNREAD: a person's reply that has not been answered
 * is left exactly as Gmail delivered it, and this module has no opinion about
 * mail the engine has no record of.
 */

/**
 * Pure verdict for one company's view of a thread.
 *
 * `messages` are that thread row's b2b_messages ({direction, message_type,
 * sent_at}). Read when nobody is waiting on us: the thread is closed (by the
 * operator, by the thank-you closer, or born closed as machine mail), or every
 * inbound since our last outbound is machine mail. A human reply after our
 * last word keeps it unread. Manual Gmail sends count as outbound — Jamie has
 * necessarily read the thread to reply in it.
 */
function threadReadVerdict({ status, messages = [] } = {}) {
  if (status === 'closed') return { read: true, reason: 'thread closed' };
  const { NON_REPLY_INBOUND_TYPES } = require('./replyCorrelation');
  const sorted = [...messages].sort((a, b) => new Date(a.sent_at) - new Date(b.sent_at));
  if (!sorted.length) return { read: false, reason: 'no messages on record' };
  let lastOutbound = -1;
  sorted.forEach((m, i) => { if (m.direction === 'outbound') lastOutbound = i; });
  const since = sorted.slice(lastOutbound + 1).filter(m => m.direction === 'inbound');
  const human = since.filter(m => !NON_REPLY_INBOUND_TYPES.has(m.message_type));
  if (human.length) return { read: false, reason: 'a person wrote since our last reply' };
  if (lastOutbound === -1) return { read: true, reason: 'machine mail only' };
  return { read: true, reason: since.length ? 'only machine mail since our reply' : 'we answered last' };
}

/**
 * Verdict for a Gmail thread across every company that shares it. Gmail
 * threads on subject, so one conversation can be two relationships with two
 * rows; the thread is read only when EVERY owner's view says so — marking it
 * read because one org's half is settled would hide the other org's reply.
 */
async function gmailThreadReadVerdict(sb, gmail_thread_id) {
  const { data: threads, error: tErr } = await sb.from('b2b_threads')
    .select('id, company_id, status').eq('gmail_thread_id', gmail_thread_id);
  if (tErr) throw new Error(`threads: ${tErr.message}`);
  if (!threads || !threads.length) return { known: false, read: false, reason: 'no engine record', companies: [] };
  const { data: msgs, error: mErr } = await sb.from('b2b_messages')
    .select('thread_id, direction, message_type, sent_at').eq('gmail_thread_id', gmail_thread_id);
  if (mErr) throw new Error(`messages: ${mErr.message}`);
  const verdicts = threads.map(t => ({
    company_id: t.company_id,
    ...threadReadVerdict({ status: t.status, messages: (msgs || []).filter(m => m.thread_id === t.id) }),
  }));
  const holdout = verdicts.find(v => !v.read);
  return {
    known: true,
    read: !holdout,
    reason: holdout ? `${holdout.company_id}: ${holdout.reason}` : verdicts.map(v => v.reason)[0],
    companies: verdicts.map(v => v.company_id),
  };
}

/**
 * Compute the verdict for a Gmail thread and, when it is read, clear UNREAD.
 * Fail-soft by contract: every caller is a path where a Gmail hiccup must not
 * fail the real work (a send that went out, a message already correlated).
 * Returns what happened rather than throwing, so a caller that cares can log it.
 */
async function settleThreadReadState({ sb, gmail, gmail_thread_id } = {}) {
  if (!gmail_thread_id) return { marked: false, reason: 'no gmail thread id' };
  try {
    const client = sb || require('../../shared/supabaseClient').getSupabaseClient();
    const verdict = await gmailThreadReadVerdict(client, gmail_thread_id);
    if (!verdict.known || !verdict.read) return { marked: false, ...verdict };
    const { getGmail, markThreadRead } = require('../../gmail-management/lib/gmailClient');
    await markThreadRead(gmail || await getGmail(), gmail_thread_id);
    return { marked: true, ...verdict };
  } catch (err) {
    console.warn(`[read-state] could not settle ${gmail_thread_id}: ${err.message}`);
    return { marked: false, error: err.message };
  }
}

module.exports = { threadReadVerdict, gmailThreadReadVerdict, settleThreadReadState };
