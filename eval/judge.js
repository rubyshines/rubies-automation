/**
 * The content judge — Phase 1 of the accuracy rebuild.
 *
 * Why it exists: every quality number this project has produced was a proxy.
 * Edit rate over-reads (Jamie ships drafts he wouldn't have written — measured
 * at ~28% of unedited sends). Word count is worse than useless: on the eleven
 * drafts he actually flagged for padding, the advisor wrote 79-84 words
 * against his own 76 on the same cases. The padding is not extra words, it is
 * extra CONTENT — an invented feeling, a restated fact, a promise about a
 * system email — and only a content judge can see it.
 *
 * Design decisions worth keeping:
 *
 * 1. The judge only FINDS AND CITES. It never emits a pass/fail. The verdict
 *    is derived in code from the citations (see `verdict()`), so the bar can
 *    be re-tuned during calibration without spending another dollar of API,
 *    and so a disagreement with Jamie can be traced to a specific sentence
 *    rather than to a mood.
 *
 * 2. Every finding must quote the offending sentence VERBATIM. That is what
 *    makes the judge auditable: on the calibration set we can check not just
 *    that it flagged the right draft but that it flagged the right sentence,
 *    which is the difference between a judge that works and one that is right
 *    by luck. Findings whose quote is not in the draft are dropped.
 *
 * 3. Length is never a signal. The rubric says so explicitly, because the
 *    single most likely failure mode is a judge that quietly rediscovers word
 *    count and reports long drafts as padded.
 *
 * 4. Grounding is scoped to what the data can actually support. Tool RESULTS
 *    are not persisted anywhere (`audit_trail` holds names and truncated
 *    inputs only), so the judge is told which tools ran and instructed to
 *    treat any claim those tools could have returned as grounded. It flags
 *    only claims no called tool could have produced — an unprompted delivery
 *    promise, contact with a carrier, a fact contradicting the loaded order.
 *    Judging harder than the evidence allows would manufacture findings.
 */

const { callClaude } = require('../shared/aiClient');
const { MODELS } = require('../shared/aiPricing');

// ---------------------------------------------------------------------------
// Input assembly
// ---------------------------------------------------------------------------

// `sender_type` is 'agent' for everyone including customers (a documented
// trap), so identity comes from the sender name/email instead.
const US = /rubies customer care|care@rubyshines\.com|jamie@rubyshines\.com|support@rubyshines\.com/i;

function speaker(msg) {
  if (msg.is_bot) return 'BOT';
  const who = [msg.sender?.name, msg.sender?.email, msg.sender].filter(x => typeof x === 'string').join(' ');
  return US.test(who) ? 'US' : 'CUSTOMER';
}

const clean = t => String(t || '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();

function formatConversation(history, cap = 6000) {
  const msgs = (Array.isArray(history) ? history : [])
    .slice()
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    .map(m => `[${speaker(m)}]\n${clean(m.body).slice(0, 1500)}`);
  const joined = msgs.join('\n\n');
  return joined.length > cap ? `…(earlier messages trimmed)…\n\n${joined.slice(-cap)}` : joined;
}

function formatOrder(ctx) {
  if (!ctx) return 'No order was loaded for this conversation.';
  const items = (ctx.line_items || ctx.items || [])
    .map(li => `${li.quantity || 1}x ${li.title || li.name} ${li.sku_size || li.variant_title || ''}`.trim())
    .join(', ');
  return [
    ctx.name && `Order ${ctx.name}`,
    ctx.created_at && `placed ${String(ctx.created_at).split('T')[0]}`,
    ctx.days_since_order != null && `${ctx.days_since_order} days ago`,
    ctx.fulfillment_status && `fulfillment ${ctx.fulfillment_status}`,
    ctx.financial_status && `financial ${ctx.financial_status}`,
    items && `items: ${items}`,
  ].filter(Boolean).join(' · ');
}

function toolsCalled(auditTrail) {
  const names = (Array.isArray(auditTrail) ? auditTrail : [])
    .filter(a => typeof a === 'string' && /^Tool call:/.test(a))
    .map(a => a.replace(/^Tool call:\s*/, '').split('(')[0].trim());
  return names.length ? [...new Set(names)].join(', ') : 'none';
}

/** Everything the judge sees about one draft. */
function buildJudgeInput(row) {
  return {
    id: row.id,
    message_type: row.message_type || 'uncategorized',
    conversation: formatConversation(row.conversation_history),
    order: formatOrder(row.order_context),
    tools: toolsCalled(row.audit_trail),
    draft: clean(row.draft_response || row.draft || ''),
  };
}

// ---------------------------------------------------------------------------
// Rubric
// ---------------------------------------------------------------------------

const SYSTEM = `You are auditing customer-service drafts written for Jamie Alexander, founder of RUBIES, a gender-affirming underwear brand. Every draft goes out over his name, so the standard is simple: would Jamie have sent this as it stands, or would he have rewritten it?

Jamie writes short and does the thing. When a customer's message already tells him what they want, he does it and confirms it in a sentence. He answers the question that was asked and nothing adjacent. He does not narrate our internal steps, promise emails the system sends anyway, or manufacture warmth.

You do not give a verdict. You find and quote specific problems on three axes. Everything you report must quote the draft VERBATIM, so a human can check you against the text.

CRITICAL: length is never a problem in itself and you must never report one. A long reply that is all substance is fine. A short reply carrying one invented sentence is not. Never mention word count, brevity, conciseness or verbosity in any finding. Judge what the sentences DO.

## What RUBIES policy REQUIRES — none of this is ever a finding
Some content is mandatory. Flagging it would score the advisor down for obeying the rules, so read this list before you report anything.
- **Donation copy is written by a tool, not by the advisor.** When a refund or exchange is granted, the reply carries get_donation_partner's response_text verbatim: the partner name, the full address block, the description of what that org does, the offer to donate locally, and the wash-before-donating line. Never flag any of it, as warmth or as repetition. It is required and it is not the advisor's prose to answer for.
- **A refund or exchange the advisor grants carries donation instructions in the same message.** That attachment is required.
- **A defect reply asks for a photo to pass to the supplier and tells the customer to keep the faulty item.** Both are required, and the photo ask never gates the replacement.
- **A first refund or return request from someone who has not yet had real sizing help is answered by asking what went wrong, before granting it.** That ask IS the correct move, not a withheld action. Once real sizing help has been given in the thread and they still want the refund, granting it is the correct move.
- **A request to cancel or change an unshipped order places a warehouse hold, and the reply says so.** Telling the customer their order is on hold is reassurance and is required. Announcing that a hold has been LIFTED, removed or released is the opposite: that is internal plumbing and IS a finding.
- **An unshipped-order cancel with no reason given, or with a reason we could fix, is answered by holding and asking whether something could be swapped instead.** That ask is required, not an unnecessary question.
- **A shipping problem carries a pre-committed remedy** ("I'll send another package", a date to check back). That attachment is required.
- **Duties and customs boundaries** may be stated to an international customer asking about shipping.
- **A defect is acknowledged simply, with "That shouldn't happen" or similar.** One clause, required.
- **The greeting line, the valediction ("Talk soon,", "Take care,", "Thanks,") and the two-line signature block are mandated boilerplate.** They appear on every reply by rule. Ignore them completely — they are never a finding of any kind.
- **The sentence that IS the move is never a finding.** Confirming the action taken, answering the question asked, or asking the one question that unblocks the action is the reply's job. Only material BESIDE the move can be unrequested.

## AXIS 1 — act vs ask
Work out what the customer's most recent message licensed, then classify the draft with exactly one value:
- ACTED_CORRECTLY — it took (or reported) the action the customer's message licensed.
- ASKED_CORRECTLY — it asked a question because a fact genuinely needed to act was missing from the conversation, the order and the tool results, OR because the policy list above requires that ask.
- ASKED_UNNECESSARILY — it asked for, or asked the customer to confirm, something already present: stated plainly by the customer, visible in the loaded order, or returned by a tool that was called. Asking someone to repeat what they just said is this. THIS IS THE DEFECT WE ARE HUNTING.
- ACTED_PREMATURELY — it committed to an action while a fact genuinely needed to choose it was still missing.
- NOT_APPLICABLE — no action was ever in play (a pure information question, a thank-you closer, an unrelated inquiry).
Then quote the exact words in the customer's message that licensed the action or that left it blocked. If the classification is ASKED_UNNECESSARILY, quote both the draft's question and the customer's words that already answered it.

## AXIS 2 — unrequested material
The reply's job is ONE move (act, ask, or explain) plus that move's required attachments — donation instructions alongside a created order, one diagnostic question alongside a refund, the invoice line on an upcharge exchange, the pre-committed remedy on a shipping problem. List every sentence that is neither the move nor a required attachment. Tag each one:
- invented_warmth — warmth about something the customer never put in front of us. **Read this definition carefully; getting it wrong in either direction makes the whole audit worthless.**

  Jamie is a warm writer and ordinary human warmth is his voice, not clutter. The test is NOT whether a sentence is warm. It is whether the customer handed you the hook, and whether the sentence stays inside what we can actually know.

  NOT a finding — leave every one of these alone:
    · acknowledging a specific thing they told you ("Hope Paulie enjoys camp!", "Glad to hear it")
    · thanking them for something they genuinely did for us — a typo report, a photo, a correction, patience through our mistake ("Thanks so much for the heads up on that typo")
    · reciprocating good news or a compliment they offered first
    · saying you are available ("I'm here when you need me")
    · one short line of ordinary politeness attached to a real answer

  A finding — every one of these invents something:
    · asserting or promising how they, or a child, will FEEL ("We'll make sure she feels seen and special")
    · evaluating them or how they are handling their life ("you're doing great", "sounds like you have a lot on")
    · selling the product's benefit back to them unprompted ("so she has room to grow", "your comfort comes first")
    · manufacturing emotional stakes they never raised

  The discriminating question: **strike the sentence — does the reply stop responding to something the customer actually said?** If yes, the warmth is doing work and is not a finding. If all that is lost is a feeling we made up, it is.
- restated_fact — repeats what the customer just told us, itemizes back products and sizes they named themselves, or repeats something we already said earlier in this thread.
- redundant_procedure — describes our internal machinery or promises something the system does anyway: a hold being placed or lifted when the customer only needs to know the outcome, a tracking email, an order confirmation email, "at no cost" when nobody suggested a cost.
- unrequested_offer — colours, alternative products, extra options or next steps nobody asked about and no snag required.
- hedge_or_meta — narrating our own carefulness ("I want to make sure I get this right", "I'd hate to give you wrong info").
Quote each offending sentence exactly as it appears. If the reply contains none of these, return an empty list — that is the expected result for a good draft, and inventing a marginal finding to look thorough is a failure.

## AXIS 3 — grounding
Every factual claim about an order, a product, sizing, stock, delivery timing, money or a third party must trace to the loaded order shown to you, a tool that was called, or something the customer said.
You are told which tools ran but NOT what they returned, because tool results are not stored. So treat any claim a called tool could plausibly have returned as grounded — do not flag a size, a delta, a stock state or a partner address when the matching tool ran.
**The draft's own action is grounded by definition.** "I've created your exchange for the Charlie in M", "I've processed your refund", "I've put a hold on the order" describe what THIS draft is instructing the operator to do. They are never ungrounded, and the fact that no tool result proves them is expected — the action has not happened yet. Only a claim about something OUTSIDE the advisor's own staged action can be ungrounded.
Flag only claims nothing available could support: a delivery or ship date nobody looked up, contact with a carrier, warehouse or supplier that is not visible in the conversation, a statement contradicting the loaded order, or a sizing equivalence asserted without the lookup that establishes it.
One class to watch specifically: **a just-created order has not shipped.** Exchanges and replacements leave the next business day, so "it's on its way", "on its way shortly", "it's heading out now" on an order the draft itself just created is a false statement about the real world, however small. Flag it. Naming the actual ship day is fine.
Quote the claim.

Return your findings by calling the report_findings tool exactly once.`;

const TOOL = {
  name: 'report_findings',
  description: 'Report the audit findings for this draft.',
  input_schema: {
    type: 'object',
    properties: {
      act: {
        type: 'object',
        properties: {
          verdict: { type: 'string', enum: ['ACTED_CORRECTLY', 'ASKED_CORRECTLY', 'ASKED_UNNECESSARILY', 'ACTED_PREMATURELY', 'NOT_APPLICABLE'] },
          customer_words: { type: 'string', description: "Verbatim from the customer's message: what licensed the action, or what was missing." },
          why: { type: 'string', description: 'One sentence. For ASKED_UNNECESSARILY, name the question the draft asked.' },
        },
        required: ['verdict', 'why'],
      },
      unrequested: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            sentence: { type: 'string', description: 'Verbatim from the draft.' },
            tag: { type: 'string', enum: ['invented_warmth', 'restated_fact', 'redundant_procedure', 'unrequested_offer', 'hedge_or_meta'] },
            why: { type: 'string' },
          },
          required: ['sentence', 'tag', 'why'],
        },
      },
      ungrounded: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            claim: { type: 'string', description: 'Verbatim from the draft.' },
            why: { type: 'string', description: 'Why nothing available supports it.' },
          },
          required: ['claim', 'why'],
        },
      },
    },
    required: ['act', 'unrequested', 'ungrounded'],
  },
};

function userMessage(input) {
  return `## Conversation so far (oldest first)
${input.conversation || '(no stored conversation)'}

## Loaded order context
${input.order}

## Tools the advisor called on this draft
${input.tools}

## The draft under audit (category: ${input.message_type})
"""
${input.draft}
"""`;
}

// ---------------------------------------------------------------------------
// Verdict derivation (in code, deliberately — see header note 1)
// ---------------------------------------------------------------------------

const ACT_DEFECTS = new Set(['ASKED_UNNECESSARILY', 'ACTED_PREMATURELY']);

/**
 * Derive the pass/fail from the citations.
 *
 * `minUnrequested` is the tunable bar. Jamie flags a single invented sentence,
 * so it starts at 1; calibration decides whether it stays there.
 */
function verdict(findings, { minUnrequested = 1 } = {}) {
  const actDefect = ACT_DEFECTS.has(findings?.act?.verdict);
  const padding = (findings?.unrequested || []).length >= minUnrequested;
  const ungrounded = (findings?.ungrounded || []).length > 0;
  return {
    would_rewrite: actDefect || padding || ungrounded,
    reasons: [actDefect && 'act', padding && 'padding', ungrounded && 'grounding'].filter(Boolean),
  };
}

// ---------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------

// Findings that don't actually appear in the draft are hallucinated citations,
// which is the one failure mode that would make every downstream number a lie.
// Normalise smart quotes and whitespace before matching — the model reflows
// both — then drop anything that still isn't there.
const canon = s => String(s || '').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim().toLowerCase();

function dropUncitedFindings(findings, draft) {
  const hay = canon(draft);
  const present = q => hay.includes(canon(q).replace(/[.!?]+$/, ''));
  return {
    ...findings,
    unrequested: (findings.unrequested || []).filter(f => present(f.sentence)),
    ungrounded: (findings.ungrounded || []).filter(f => present(f.claim)),
    dropped: (findings.unrequested || []).filter(f => !present(f.sentence)).map(f => f.sentence)
      .concat((findings.ungrounded || []).filter(f => !present(f.claim)).map(f => f.claim)),
  };
}

async function judgeDraft(row, opts = {}) {
  const input = buildJudgeInput(row);
  const res = await callClaude({
    component: 'advisor_eval_judge',
    model: opts.model || MODELS.OPUS,
    max_tokens: 2000,
    system: SYSTEM,
    tools: [TOOL],
    tool_choice: { type: 'tool', name: TOOL.name },
    messages: [{ role: 'user', content: userMessage(input) }],
    metadata: { draft_id: row.id, arm: opts.arm || null },
  });

  const block = (res.content || []).find(b => b.type === 'tool_use' && b.name === TOOL.name);
  if (!block) throw new Error(`judge returned no findings for draft ${row.id}`);

  const findings = dropUncitedFindings(block.input, input.draft);
  return {
    id: row.id,
    arm: opts.arm || null,
    findings,
    ...verdict(findings, opts),
    _usage: res._usage,
  };
}

module.exports = {
  judgeDraft, buildJudgeInput, verdict, formatConversation, formatOrder, toolsCalled,
  dropUncitedFindings, SYSTEM, TOOL,
};
