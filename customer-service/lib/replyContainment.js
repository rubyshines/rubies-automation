/**
 * Reply containment — the last thing between the advisor's output and a
 * customer's inbox.
 *
 * The advisor occasionally emits more than one candidate reply inside a single
 * final text block: it writes an email, reconsiders in the first person, and
 * writes another. All of it lands in the draft, and it has reached customers
 * verbatim ("Wait, I need to reconsider. ... Per the rules, ... Let me rewrite
 * this properly as needs_info:").
 *
 * Measured over the unfiltered advisor population rather than the drafts
 * someone happened to complain about: 28 leaked drafts in 1,761, and in the
 * 116 drafts written since the last prefix fix shipped, 4 still leaked and ALL
 * FOUR were sent. An operator has never once caught one.
 *
 * Two deterministic strips already sat in this path (stripInternalThinking,
 * stripPreGreetingNarration) and neither could catch these, because the leak
 * has no fixed position:
 *
 *   draft 2959 — email first, narration trailing it, no second greeting and no
 *                sign-off at all. The reply to keep is the FIRST half.
 *   draft 3131 — a complete signed email, then narration, then a second
 *                complete email. The reply to keep is the SECOND half.
 *
 * No prefix rule can express "keep the half that is addressed to the customer",
 * which is why each previous fix was another special case. So a model reads it.
 *
 * What the model may NOT do is write. It returns verbatim anchors; the slicing
 * happens here, so whatever reaches the customer is always a contiguous
 * substring of what the advisor actually wrote — the guard cannot paraphrase
 * Jamie's voice, drop an em-dash rule, or invent a fact. Every failure mode
 * (no leak, bad JSON, anchor not found in the text, API error, implausible
 * slice) returns the original text untouched. This guard can flag a draft; it
 * can never quietly rewrite one.
 */

const { callClaude } = require('../../shared/aiClient');
const { MODELS } = require('../../shared/aiPricing');

// Anchor length the model is asked to copy. Long enough to be unique across
// two near-identical drafts, short enough that it copies without drifting.
const ANCHOR_CHARS = 40;

// A slice shorter than this isn't a plausible email, so something went wrong
// with the anchors — keep the original and let the operator read it.
const MIN_KEPT_CHARS = 60;

// Below this there's nothing worth the risk of cutting.
const MIN_REMOVED_CHARS = 40;

/**
 * How a reply to a customer opens. Matched at the start of a line so a
 * mid-sentence "hi" can't trigger it. Shared with stripPreGreetingNarration in
 * aiAdvisor.js — one list, because a greeting missing from it is a leak that
 * walks straight past both guards (a French draft opening "Bonjour," reached a
 * customer with its stock-check notes attached on 2026-08-02, for exactly that
 * reason).
 *
 * "Aloha" is the same lesson a second time (2026-08-13): the advisor mirrored a
 * Hawaiian customer's greeting, the model DID spot the two paragraphs of
 * planning above it, and the cut was thrown away by the opens-like-an-email
 * check because the list had never heard of the word. Mirroring the customer's
 * greeting is allowed (founder call — the Aloha reply read fine), so the list
 * is the only thing standing between a mirrored opener and a leaked draft. It
 * stays deliberately generous: a greeting it doesn't know costs a leak, an
 * extra greeting it does know costs nothing.
 */
const GREETING_RE = /^(Hi|Hey|Hello|Hola|Aloha|Bonjour|Bonsoir|Salut|Hallo|Ciao|Ol[áa]|Dear|Greetings|Good (morning|afternoon|evening))\b/m;

// Placeholders this pipeline writes itself when the model returns nothing
// usable. They are not emails, they are instructions to the operator, and a
// containment pass reading one will happily "remove the working note" and
// promote the quoted customer text into the draft slot — on draft 72 that
// meant keeping a phishing email's body as the reply.
const OPERATOR_PLACEHOLDER = '[AI could not draft a response';

const SYSTEM_PROMPT = `You are checking one customer support email before it is sent to a customer.

The writer sometimes leaves their own working notes in the text: a first attempt at the email, a first-person aside where they reconsider it ("Wait, I need to reconsider...", "Let me rewrite this as...", "The reply is fine"), a mention of internal machinery (status values like needs_info, action types, "per the rules"), or a second attempt at the same email. Only ONE contiguous email is meant to be sent.

Your job is to decide whether the text contains anything besides that single email, and if so, to point at the email that should go.

Return ONLY this JSON, no other text:
{"leak": true|false, "reason": "<8 words or fewer, empty when leak is false>", "start": "<first ${ANCHOR_CHARS} characters of the email to send, copied EXACTLY>", "end": "<last ${ANCHOR_CHARS} characters of that email, copied EXACTLY>"}

Rules:
- One clean email with no working notes: return {"leak": false, "reason": "", "start": "", "end": ""}.
- When there are two attempts, the one to send is the one the writer settled on. That is usually the later one, but read the aside to see which they chose: sometimes they reconsider and conclude the email they already wrote is fine, in which case the earlier one is the one to send and the aside is what gets cut.
- "start" and "end" must be copied character for character out of the text, including punctuation, markdown links and line breaks. Do not fix, shorten, translate or re-type them. They are used to locate the email, so an approximation is worse than useless.
- A P.S. after the sign-off is part of the email. Let "end" fall after it.
- Ordinary things a customer is meant to read are never a leak: apologies, explanations, size advice, lists of options, questions, return addresses, sign-offs.`;

function parseVerdict(raw) {
  if (!raw) return null;
  // Tolerate a fenced block or stray prose around the JSON.
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Locate the kept reply between two verbatim anchors.
 *
 * Both anchors are searched from the END backwards, which is what makes the
 * two-attempt case come out right: when an advisor writes the same email
 * twice, "start" matches both copies, and the one we want is the last copy
 * that still sits before "end". Searching forwards would splice the beginning
 * of the discarded attempt onto the end of the kept one and preserve the
 * narration between them — the exact bug this module exists to remove.
 *
 * @returns {{ text: string } | { error: string }}
 */
function sliceBetweenAnchors(text, startAnchor, endAnchor) {
  if (!startAnchor || !endAnchor) return { error: 'model returned an empty anchor' };

  const endIdx = text.lastIndexOf(endAnchor);
  if (endIdx === -1) return { error: 'end anchor not found verbatim in the draft' };

  const startIdx = text.lastIndexOf(startAnchor, endIdx);
  if (startIdx === -1) return { error: 'start anchor not found verbatim before the end anchor' };

  const kept = text.slice(startIdx, endIdx + endAnchor.length).trim();
  if (kept.length < MIN_KEPT_CHARS) return { error: `kept slice implausibly short (${kept.length} chars)` };
  if (text.trim().length - kept.length < MIN_REMOVED_CHARS) return { error: 'nothing substantial to remove' };

  // Structural sanity check on our own slice, and the thing that separates the
  // real leaks from the misfires. Cutting from the FRONT of a reply is only
  // safe if what remains opens like an email; when the model instead decides
  // that a paragraph the customer was meant to read is a "working note", the
  // leftover starts mid-thought. Replaying the whole corpus, every one of the
  // genuine catches left a greeting standing and all three false positives
  // left a fragment ("Since both the 16s and 14s are being donated...", "On
  // the sizing: our underwear follows..."). Removing a trailing block is
  // exempt — nothing was taken off the front, so the opening is untouched.
  const cutFromFront = startIdx > 0;
  if (cutFromFront && !GREETING_RE.test(kept)) {
    return { error: 'the remaining text does not open like an email, so the cut is probably in the wrong place' };
  }

  return { text: kept };
}

/**
 * @param {string} reply - the composed customer-facing reply
 * @param {Object} [ctx] - ticket_id / draft_id / customer_email for cost attribution
 * @returns {Promise<{ text: string, leaked: boolean, warning: string|null }>}
 *   `text` is either the original or a contiguous slice of it — never anything else.
 */
async function containReply(reply, ctx = {}) {
  const original = typeof reply === 'string' ? reply : '';
  const unchanged = { text: reply, leaked: false, warning: null };
  if (original.trim().length < MIN_KEPT_CHARS) return unchanged;
  if (original.trimStart().startsWith(OPERATOR_PLACEHOLDER)) return unchanged;

  let verdict;
  try {
    const response = await callClaude({
      // Haiku, deliberately, and measured rather than assumed: this is a
      // narrow fail-closed check that cannot author text (it returns anchors,
      // not prose) and whose every failure path keeps the original draft, so a
      // wrong answer costs a flag rather than a customer-visible error.
      // Against the 28 confirmed leaks in the corpus, Haiku caught 26 and
      // Sonnet 21 — the bigger model is MORE conservative about calling a
      // working note a leak, so it is both worse here and ~10x the price.
      // ~$0.0016 and ~1.2s per draft. Re-run the comparison with
      // scripts/evalReplyContainment.js before changing this line.
      model: MODELS.HAIKU,
      component: 'cs_reply_containment',
      max_tokens: 400,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `<email>\n${original}\n</email>` }],
      ticket_id: ctx.ticket_id ?? null,
      draft_id: ctx.draft_id ?? null,
      metadata: ctx.customer_email ? { customer_email: ctx.customer_email } : null,
    });
    verdict = parseVerdict(response?.content?.find(b => b.type === 'text')?.text);
  } catch (err) {
    // Never let the guard break a draft. A containment call that fails leaves
    // the advisor exactly where it was without one.
    return { ...unchanged, warning: `CONTAINMENT_SKIPPED: check failed (${err.message})` };
  }

  if (!verdict) return { ...unchanged, warning: 'CONTAINMENT_SKIPPED: check returned unparseable output' };
  if (verdict.leak !== true) return unchanged;

  const sliced = sliceBetweenAnchors(original, verdict.start, verdict.end);
  if (sliced.error) {
    // The model saw a leak but couldn't point at the reply cleanly. Say so
    // loudly rather than guessing — the operator is the fallback.
    return {
      text: reply,
      leaked: true,
      warning: `CONTAINMENT_FLAG: possible internal reasoning left in this draft (${verdict.reason || 'no reason given'}) but it could not be removed safely (${sliced.error}). Read the whole draft before sending.`,
    };
  }

  const removed = original.trim().length - sliced.text.length;
  return {
    text: sliced.text,
    leaked: true,
    warning: `CONTAINMENT_FIX: removed ${removed} chars of internal reasoning from the draft (${verdict.reason || 'no reason given'}). The reply was cut down to the email the advisor settled on, so check it reads right before sending.`,
  };
}

module.exports = { containReply, sliceBetweenAnchors, parseVerdict, GREETING_RE, SYSTEM_PROMPT };
