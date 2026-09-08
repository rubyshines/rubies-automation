/**
 * B2B thank-you closer.
 *
 * A partner replying "Thanks so much!" surfaces as Tier-1 "waiting on us" and
 * sits there until the operator reads it and closes the thread by hand. This
 * automates exactly that hand action — classify the reply, and when it is a
 * pure courtesy closer, mark the thread concluded. Nothing is ever SENT: B2B
 * sends are hard-gated and relationship-sensitive, and unlike the CS closer
 * (which replies inside a support ticket) a partner's sign-off needs no answer.
 *
 * The bar is deliberately higher than the CS version's: an org sharing an
 * outcome ("the boxes arrived, the kids love them!") is gratitude AND a
 * relationship moment worth a warm human reply — that must stay Tier-1 work.
 * Only contentless courtesy ("Thanks!", "Sounds good, appreciate it!") closes.
 *
 * Sonnet-class task per CLAUDE.md model policy: narrow binary classification
 * that fails closed — a false negative just leaves the thread open for the
 * operator, which is today's behavior.
 */

const { callClaude } = require('../../shared/aiClient');
const { MODELS } = require('../../shared/aiPricing');

// Mirrors replyCorrelation.NON_REPLY_INBOUND_TYPES — requiring it back from
// here would be circular (replyCorrelation requires this module).
const MACHINE_INBOUND_TYPES = new Set(['auto_reply', 'calendar_notice', 'bounce']);

const MODEL = MODELS.SONNET;
const MAX_TOKENS = 300;

const CLASSIFY_TOOL = {
  name: 'submit_classification',
  description: 'Submit the binary classification of whether the contact\'s latest reply is a pure courtesy closer that concludes the conversation.',
  input_schema: {
    type: 'object',
    properties: {
      close_thread: {
        type: 'boolean',
        description: 'true ONLY when the latest reply is contentless courtesy with nothing pending on either side.',
      },
      reason: {
        type: 'string',
        description: 'Short phrase (8 words or fewer) explaining the decision.',
      },
    },
    required: ['close_thread', 'reason'],
  },
};

const SYSTEM_PROMPT = `You decide whether a business contact's latest email reply concludes the conversation — pure courtesy with nothing left pending on either side. These are RUBIES' relationships with retail partners and LGBTQ+ community organizations.

Set close_thread=true ONLY when ALL of these are true:
- The LATEST reply is contentless courtesy: "Thanks!", "Thank you so much!", "Sounds good!", "Perfect, appreciate it", "Got it, have a great weekend".
- It contains NO question, no request, no new topic, however casual.
- Nothing is pending from either side: no call being scheduled, no meeting just agreed, no promised follow-up, no offer they are accepting, no email or action still owed by us. Something already set in motion that needs no further email (a box already shipped, a document already sent, a code already issued) does NOT count as pending — "pending" means we still owe them a message or an action, not that the mail is in transit.
- Our prior message needed no answer, or their reply fully closes what it asked.

Set close_thread=false in ANY of these cases:
- They ask ANYTHING, or accept an offer ("we'd love that!" — now we act).
- A call or meeting is being arranged or was just agreed — the conversation is live.
- They confirm a detail we still need to act on (an address to ship to, a survey to send, an intro to make).
- They share an outcome, a story, feedback, or anything personal ("the boxes arrived — the kids love them!"). That deserves a warm human reply, not silence.
- Any negative tone, hedging, or doubt.
- You are uncertain for any reason.

Fail closed: when in doubt, return false. A false positive silences a partner who was owed a reply; a false negative just leaves the thread for the operator, which is the status quo.

Keep the reason field to 8 words or fewer.`;

/**
 * Deterministic gate: is this inbound even a candidate for the classifier?
 * PURE — every condition here is a fact the caller already holds, so no
 * Sonnet call is spent on messages that could never close. Mirrors the
 * born-closed rule's shape: machine mail and brand-new threads never qualify.
 *
 * @param {object} opts
 * @param {string|null} opts.inboundType — classifyInbound's verdict for the message
 * @param {boolean} opts.threadWasNew — thread was created by this very message
 * @param {string} opts.threadStatus — b2b_threads.status
 * @param {Array} opts.messages — thread messages oldest-first, incl. the new inbound
 * @returns {{eligible: boolean, reason: string}}
 */
function thankYouGate({ inboundType, threadWasNew, threadStatus, messages } = {}) {
  if (inboundType && MACHINE_INBOUND_TYPES.has(inboundType)) {
    return { eligible: false, reason: 'machine_generated' };
  }
  if (threadWasNew) return { eligible: false, reason: 'thread_born_of_this_message' };
  if (threadStatus !== 'open') return { eligible: false, reason: 'thread_not_open' };
  const list = messages || [];
  const latest = list[list.length - 1];
  if (!latest || latest.direction !== 'inbound') {
    return { eligible: false, reason: 'latest_not_inbound' };
  }
  if (!String(latest.body_text || '').trim()) {
    return { eligible: false, reason: 'empty_body' };
  }
  // A thank-you answers something WE said. No prior outbound → nothing of ours
  // to be thanking us for, and closing would swallow an unanswered inquiry.
  const priorOutbound = list.slice(0, -1).some(m => m.direction === 'outbound' && !m.undelivered_at);
  if (!priorOutbound) return { eligible: false, reason: 'no_prior_outbound' };
  return { eligible: true, reason: 'candidate' };
}

/** Format the last N thread messages for the classifier. PURE. */
function formatThreadForCloser(messages, limit = 6) {
  return (messages || []).slice(-limit)
    .map(m => ({ tag: m.direction === 'outbound' ? 'US' : 'THEM', body: String(m.body_text || '').trim().slice(0, 600) }))
    .filter(m => m.body)
    .map(m => `[${m.tag}] ${m.body}`)
    .join('\n\n');
}

/**
 * @returns {Promise<{close_thread: boolean, reason: string|null}>} — fail-closed.
 */
async function classifyB2bThankYou({ recentMessages, priorOutbound }) {
  const userText =
    `[OUR PRIOR MESSAGE THEY ARE REPLYING TO]\n${priorOutbound || '(none)'}\n\n` +
    `[RECENT CONVERSATION — last message is their latest reply]\n${recentMessages || '(none)'}\n\n` +
    `Decide whether their LATEST reply is a pure courtesy closer per the rules.`;

  let response;
  try {
    response = await callClaude({
      component: 'b2b_thankyou_closer',
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      tools: [CLASSIFY_TOOL],
      tool_choice: { type: 'tool', name: 'submit_classification' },
      messages: [{ role: 'user', content: userText }],
    });
  } catch (err) {
    return { close_thread: false, reason: `classifier_api_error:${err.message?.slice(0, 60)}` };
  }

  const toolUse = response.content.find(b => b.type === 'tool_use' && b.name === 'submit_classification');
  if (!toolUse || !toolUse.input) return { close_thread: false, reason: 'classifier_no_tool_use' };
  return {
    close_thread: toolUse.input.close_thread === true,
    reason: typeof toolUse.input.reason === 'string' ? toolUse.input.reason.slice(0, 120) : null,
  };
}

/**
 * Run the gate + classifier for a thread whose newest message is a just-inserted
 * human inbound, and close the thread on a positive. Fail-soft by design: any
 * error leaves the thread open, which is the status quo the operator already
 * handles. The caller's idempotent message insert is the claim — this only runs
 * for the one worker that actually inserted the message, so the Sonnet call
 * cannot be duplicated by Pub/Sub redelivery.
 *
 * @returns {Promise<{closed: boolean, reason: string}>}
 */
async function maybeCloseThankYou(sb, { thread_id, inboundType = null, threadWasNew = false } = {}) {
  const { data: thread } = await sb.from('b2b_threads')
    .select('id, status').eq('id', thread_id).maybeSingle();
  if (!thread) return { closed: false, reason: 'thread_not_found' };

  const { data: messages } = await sb.from('b2b_messages')
    .select('direction, body_text, sent_at, undelivered_at')
    .eq('thread_id', thread_id)
    .order('sent_at', { ascending: true })
    .limit(50);

  const gate = thankYouGate({ inboundType, threadWasNew, threadStatus: thread.status, messages });
  if (!gate.eligible) return { closed: false, reason: gate.reason };

  const list = messages || [];
  const priorOutbound = [...list.slice(0, -1)].reverse()
    .find(m => m.direction === 'outbound' && !m.undelivered_at);
  const cls = await classifyB2bThankYou({
    recentMessages: formatThreadForCloser(list),
    priorOutbound: String(priorOutbound?.body_text || '').trim().slice(0, 1500),
  });
  if (!cls.close_thread) return { closed: false, reason: cls.reason || 'classifier_negative' };

  // `.eq('status','open')` makes the close race-safe: an operator (or a second
  // worker) closing concurrently leaves nothing for this update to match.
  const { data: updated, error } = await sb.from('b2b_threads')
    .update({ status: 'closed' })
    .eq('id', thread_id).eq('status', 'open')
    .select('id');
  if (error) return { closed: false, reason: `close_failed:${error.message}` };
  if (!updated?.length) return { closed: false, reason: 'already_closed' };
  console.log(`[thankyou-closer] thread ${thread_id} closed: ${cls.reason}`);
  return { closed: true, reason: cls.reason || 'courtesy_closer' };
}

module.exports = {
  thankYouGate,
  formatThreadForCloser,
  classifyB2bThankYou,
  maybeCloseThankYou,
  MODEL,
};
