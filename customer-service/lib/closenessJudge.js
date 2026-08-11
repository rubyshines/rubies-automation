/**
 * closenessJudge.js — the closeness-to-final judge (#3).
 *
 * Scores an advisor draft against what Jamie actually sent for the same
 * message. This is the master quality yardstick: continuous version of the
 * May 2026 baseline study's AI comparison.
 *
 * Categories (aligned with the May taxonomy):
 *   identical           — normalized-equal, decided deterministically (no AI call)
 *   cosmetic            — wording/punctuation differs, same meaning and same action
 *   substantive         — meaningfully different content, tone, or structure
 *   factual_correction  — the sent version fixed a factual claim in the draft
 *   action_divergence   — draft and sent commit to different actions
 *
 * Plus a flag, not a category: draft_may_be_right — the judge believes the
 * draft's substance was more correct/complete than what was sent. These rows
 * are surfaced as their own list (Jamie is calibration, not infallible).
 *
 * Judge model: Opus (don't cheap out on the yardstick). Component tag
 * 'closeness_judge' so spend is attributable in ai_calls.
 */
const { callClaude } = require('../../shared/aiClient');
const { MODELS } = require('../../shared/aiPricing');
const { normalizeForCompare } = require('./feedbackSignals');

const CATEGORIES = ['identical', 'cosmetic', 'substantive', 'factual_correction', 'action_divergence'];

const JUDGE_SYSTEM = `You compare two versions of a customer-service reply from RUBIES (gender-affirming underwear/swimwear): the AI advisor's DRAFT and what the human operator (Jamie, the founder) actually SENT.

Classify the difference into exactly one category:
- "cosmetic": wording, punctuation, greeting/sign-off tweaks. Same meaning, same commitments, same facts.
- "substantive": meaningfully different content, tone, structure, or scope (e.g. different sizing guidance, added/removed questions, different framing) — but no factual error corrected and the same action.
- "factual_correction": the SENT version fixes a factual claim the DRAFT got wrong (size availability, price, policy, shipping time, address, product detail).
- "action_divergence": DRAFT and SENT commit to different actions (e.g. draft offers an exchange, sent processes a refund; draft asks for info, sent creates an order).

Also set:
- "draft_may_be_right": true ONLY when the DRAFT's substance looks more correct or more complete than the SENT version (e.g. the draft caught a policy detail the sent version missed, or the sent version contains an apparent factual slip). Cosmetic preferences never qualify.
- "severity": "low" | "medium" | "high" — how much the difference would matter to the customer. Cosmetic is always low.
- "rationale": 1-2 plain sentences explaining the classification.
- "candidate_fact": propose one ONLY when the SENT version reveals a durable business or product truth that the DRAFT lacked or got wrong AND that no RUBIES system could have returned. That second test is the strict one: a fact earns its place only when there is no system of record that could hold it. When it passes, state it as ONE self-contained sentence a future draft could rely on, written generally (no customer names, no order numbers, no dates relative to "today"). Otherwise null.
  Null it when a system of record owns the truth — even when the draft got it wrong, because then the fix is the tool or the data, never a sentence: how two products compare in cut, leg opening, rise, coverage, available sizes or colours (the product catalog and compare_products own this); size-chart arithmetic, such as how much a size up adds at the waist or which size suits a given measurement (the size chart owns this); which donation partner or return address a customer should use (the partner registry and its geographic routing own this — a fact naming one partner would misroute every customer who lives somewhere else); shipping rates, delivery windows, duties coverage, stock levels, restock dates and pre-order state; and anything already stated on the product page or in the knowledge base.
  Also null, as before: one-off situation details (this customer's address, this order's contents), Jamie's one-time judgment calls (a colour suggestion or workaround offered to one customer), individual garment measurements, and transient states (carrier delays, stockists that may change).
  Calibration. Jamie's first review round rejected 14 of 36 proposals, nearly all one-off judgments or perishable logistics. A full audit on 2026-08-11 then retired 42 of the 58 facts then live: the largest group was product comparisons a tool already answered, followed by size arithmetic and duplicates of the donation policy. When in doubt between "durable truth" and "something a tool should have returned", emit null.
- "tool_gap": the companion to the rule above. Whenever you null a candidate_fact because a system of record owns the truth, say in ONE sentence which tool or data set should have returned it and what was missing (e.g. "compare_products returns no leg-opening comparison, so the advisor guessed which style is cut higher"). This is how a correction becomes a data fix instead of a prose patch. Null it when the correction was genuinely operator-only knowledge, or when there was no correction at all. A verdict can carry a candidate_fact or a tool_gap, but rarely both.

Judge the SUBSTANCE delivered to the customer. Do not reward verbosity or politeness padding. Respond with ONLY a JSON object: {"category": "...", "draft_may_be_right": false, "severity": "...", "rationale": "...", "candidate_fact": null, "tool_gap": null}`;

/** Trim conversation history to the last few messages, bounded per message. */
function excerptConversation(history, maxMessages = 6, maxChars = 600) {
  const msgs = Array.isArray(history) ? history.slice(-maxMessages) : [];
  return msgs.map(m => {
    const who = m.sender === 'agent' ? 'JAMIE' : 'CUSTOMER';
    const body = (m.body || '').replace(/\s+/g, ' ').trim().slice(0, maxChars);
    return `${who}: ${body}`;
  }).join('\n');
}

function buildJudgeUserMessage({ conversationHistory, draftResponse, sentResponse, messageType }) {
  const convo = excerptConversation(conversationHistory);
  return [
    messageType ? `Ticket type: ${messageType}` : null,
    convo ? `--- CONVERSATION (most recent last) ---\n${convo}` : null,
    `--- AI DRAFT ---\n${draftResponse}`,
    `--- SENT (ground truth) ---\n${sentResponse}`,
  ].filter(Boolean).join('\n\n');
}

/** Parse the judge's reply into a verdict, tolerating code fences and chatter. */
function parseJudgeVerdict(text) {
  const raw = (text || '').trim();
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`closenessJudge: no JSON in judge reply: ${raw.slice(0, 120)}`);
  const parsed = JSON.parse(match[0]);
  if (!CATEGORIES.includes(parsed.category)) {
    throw new Error(`closenessJudge: invalid category "${parsed.category}"`);
  }
  return {
    category: parsed.category,
    draft_may_be_right: parsed.draft_may_be_right === true,
    severity: ['low', 'medium', 'high'].includes(parsed.severity) ? parsed.severity : 'low',
    rationale: typeof parsed.rationale === 'string' ? parsed.rationale.slice(0, 1000) : '',
    candidate_fact: (typeof parsed.candidate_fact === 'string' && parsed.candidate_fact.trim())
      ? parsed.candidate_fact.trim().slice(0, 500)
      : null,
    tool_gap: (typeof parsed.tool_gap === 'string' && parsed.tool_gap.trim())
      ? parsed.tool_gap.trim().slice(0, 500)
      : null,
  };
}

/**
 * Judge one draft. Returns a verdict object (see parseJudgeVerdict) with
 * judge_model attached. Deterministic identical-check happens first — free.
 *
 * @param {object} p { draftResponse, sentResponse, conversationHistory, messageType }
 */
async function judgeDraftVsSent({ draftResponse, sentResponse, conversationHistory, messageType }) {
  if (!draftResponse || !sentResponse) throw new Error('closenessJudge: draftResponse and sentResponse required');

  if (normalizeForCompare(draftResponse) === normalizeForCompare(sentResponse)) {
    return { category: 'identical', draft_may_be_right: false, severity: 'low', rationale: 'Draft and sent are identical after whitespace normalization.', judge_model: 'deterministic' };
  }

  const response = await callClaude({
    component: 'closeness_judge',
    model: MODELS.OPUS,
    max_tokens: 500,
    system: JUDGE_SYSTEM,
    messages: [{ role: 'user', content: buildJudgeUserMessage({ conversationHistory, draftResponse, sentResponse, messageType }) }],
  });

  const text = (response.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  return { ...parseJudgeVerdict(text), judge_model: MODELS.OPUS };
}

module.exports = { judgeDraftVsSent, buildJudgeUserMessage, parseJudgeVerdict, excerptConversation, CATEGORIES, JUDGE_SYSTEM };
