/**
 * Thank-you closer classifier.
 *
 * Single binary decision: given the customer's latest message and our prior
 * reply, is this purely gratitude/acknowledgment with no new question or
 * unresolved concern? Used by the intake auto-close fast path to skip the
 * full advisor draft + dashboard review when a ticket is clearly done.
 *
 * Sonnet-class task: narrow scope, no tools, no structured output beyond a
 * JSON object. Fail-closed on any uncertainty or parse error.
 */

const Anthropic = require('@anthropic-ai/sdk');
const { callClaude } = require('../../shared/aiClient');

const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 300;

// Force structured output by exposing a single tool the model must call.
// This is bulletproof against malformed JSON / code fences / extra prose.
const CLASSIFY_TOOL = {
  name: 'submit_classification',
  description: 'Submit the binary classification of whether the customer\'s latest message is a pure thank-you closer.',
  input_schema: {
    type: 'object',
    properties: {
      auto_close: {
        type: 'boolean',
        description: 'true ONLY when the customer\'s latest message is purely gratitude with no new ask.',
      },
      reason: {
        type: 'string',
        description: 'Short phrase (8 words or fewer) explaining the decision.',
      },
    },
    required: ['auto_close', 'reason'],
  },
};

let _client = null;
function getClient() {
  if (!_client) _client = new Anthropic();
  return _client;
}

const SYSTEM_PROMPT = `You decide whether a customer's latest message is a pure thank-you closer with no new ask.

Return ONLY a JSON object: {"auto_close": boolean, "reason": "<short phrase>"}.

Set auto_close=true ONLY when ALL of these are true:
- The customer's LATEST message is purely gratitude, acknowledgment, or a friendly sign-off ("thanks!", "thank you so much", "perfect, appreciate it", "great, all good", "you're the best").
- It contains NO new question, no new request, no new concern.
- It contains NO complaint, frustration, or negative tone.
- It does NOT contain "but", "however", "actually", "one more thing", "also", "quick question", "btw", or any phrase that introduces a new topic.
- It does NOT contain order numbers, sizes, products, addresses, dates, or any operational detail beyond a generic thank-you.
- Our prior reply clearly resolved or addressed what the customer needed (answered the question, confirmed an action, gave them the info they asked for).

Set auto_close=false in ANY of these cases:
- Customer is asking ANYTHING new, even casually ("oh and...", "one more...", "by the way...").
- Customer is confirming a detail we still need to act on ("yes use that address" — we still need to do something).
- Our prior reply asked the customer for information they haven't fully provided yet.
- Customer expresses any doubt, follow-up curiosity, or hedging ("thanks, I think that works?", "ok thanks I'll see").
- The message could plausibly be read as expecting a substantive reply.
- You are uncertain for any reason.

Fail closed: when in doubt, return false. The cost of a false positive (closing a ticket that needed a real reply) is much higher than a false negative.

Keep the reason field to 8 words or fewer.`;

/**
 * @param {object} opts
 * @param {string} opts.recentMessages — formatted recent conversation (last few turns)
 * @param {string} opts.priorAgentReply — text of our most recent reply that the customer is responding to
 * @returns {Promise<{auto_close: boolean, reason: string|null, _usage: object|null, _raw: string|null}>}
 */
async function classifyThankYou({ recentMessages, priorAgentReply }) {
  const userText =
    `[OUR PRIOR REPLY THE CUSTOMER IS RESPONDING TO]\n${priorAgentReply || '(none)'}\n\n` +
    `[RECENT CONVERSATION — last message is the customer's latest]\n${recentMessages || '(none)'}\n\n` +
    `Decide whether the customer's LATEST message is a pure thank-you closer per the rules. Reply with the JSON object only.`;

  let response;
  try {
    response = await callClaude({
      component: 'thankyou_classifier',
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      tools: [CLASSIFY_TOOL],
      tool_choice: { type: 'tool', name: 'submit_classification' },
      messages: [{ role: 'user', content: userText }],
    });
  } catch (err) {
    return { auto_close: false, reason: `classifier_api_error:${err.message?.slice(0, 60)}`, _usage: null, _raw: null };
  }

  const usage = {
    input_tokens: response.usage?.input_tokens,
    output_tokens: response.usage?.output_tokens,
    model: MODEL,
  };

  const toolUse = response.content.find(b => b.type === 'tool_use' && b.name === 'submit_classification');
  if (!toolUse || !toolUse.input) {
    const fallbackText = response.content.find(b => b.type === 'text')?.text || null;
    return { auto_close: false, reason: 'classifier_no_tool_use', _usage: usage, _raw: fallbackText };
  }

  const input = toolUse.input;
  return {
    auto_close: input.auto_close === true,
    reason: typeof input.reason === 'string' ? input.reason.slice(0, 120) : null,
    _usage: usage,
    _raw: null,
  };
}

/**
 * Format the last N messages for the classifier input.
 * Each message gets a [CUSTOMER]/[AGENT] tag and is trimmed for length.
 */
function formatMessagesForClassifier(messages, limit = 6) {
  const recent = (messages || []).slice(-limit);
  return recent
    .map(m => {
      const sender = m.from_agent === false ? 'CUSTOMER' : 'AGENT';
      const body = String(m.stripped_text || m.body_text || m.body || '').trim().slice(0, 600);
      return `[${sender}] ${body}`;
    })
    .filter(line => !line.endsWith('] '))
    .join('\n\n');
}

module.exports = {
  classifyThankYou,
  formatMessagesForClassifier,
  MODEL,
};
