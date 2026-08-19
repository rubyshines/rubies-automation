/**
 * Review curation — audience classification + publish/hold recommendations.
 *
 * Two independent AI passes over Judge.me reviews, plus the write path that
 * executes an operator's decision against Judge.me and records it.
 *
 * Nothing here publishes on its own. `recommendCuration` produces a suggestion
 * and a rationale; a human clicks. That is deliberate — this is customer-facing
 * text on the storefront with no check downstream of the click.
 *
 * The rubric in CURATION_RUBRIC was derived from ~2k reviews of moderation
 * history (see scripts/analyseReviewDeclines.js) and then edited by Jamie. Do
 * not "improve" it from intuition — re-run the analysis and take it back to him.
 */

const { callClaude } = require('../../shared/aiClient');
const { MODELS } = require('../../shared/aiPricing');
const { getSupabaseClient } = require('../../shared/supabaseClient');
const { getJudgemeClient } = require('../../shared/judgemeClient');

const AUDIENCE_VALUES = ['kids', 'adults', 'both', 'unclear'];
const RECOMMENDATIONS = ['publish', 'hold', 'decide'];

// ---------------------------------------------------------------------------
// Audience classification
// ---------------------------------------------------------------------------

// Haiku, deliberately: this is narrow classification from short text, it fails
// closed to 'unclear', and nothing customer-facing depends on it without a
// human in between. Cost matters because this runs over the whole corpus.
const AUDIENCE_MODEL = MODELS.HAIKU;

const AUDIENCE_PROMPT = `You classify who a customer review is about.

RUBIES makes gender-affirming underwear and swimwear. Most products sell in both youth and adult sizes, so the product itself does not tell you who the wearer is — only the review text does.

For each review, decide who is WEARING the product:
- "kids"    — the wearer is a child or teenager. Usually a parent, grandparent, or carer writing ("my daughter", "my 11 year old", "my teen", "my granddaughter").
- "adults"  — the wearer is an adult. Usually the customer writing about herself ("I'm 39", "for myself", "as a trans woman", "my wife", "my partner").
- "both"    — the review genuinely covers both (e.g. "I bought a set for me and one for my daughter").
- "unclear" — the text does not say, or you would be guessing.

Rules:
- Judge by the WEARER, not the buyer. A parent writing about their daughter is "kids".
- An adult writing about themselves is "adults" even when they mention a child elsewhere.
- Do not infer from the product name or from tone. "unclear" is a correct and useful answer — prefer it over a guess.
- Never infer from the reviewer's name.

Respond with a JSON array, one object per review, in the same order:
[{"n": 1, "audience": "kids", "reason": "writes about her daughter"}, ...]

Keep each reason under 10 words. Output JSON only.`;

function reviewLine(r, n) {
  const title = (r.title || '').trim();
  const body = (r.body || '').replace(/\s+/g, ' ').trim().slice(0, 500);
  return `${n}. ${title ? `"${title}" — ` : ''}${body || '(no text)'}`;
}

function parseJsonBlock(text) {
  // Models occasionally wrap JSON in prose or a fence despite instructions.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.search(/[[{]/);
  if (start === -1) throw new Error(`No JSON found in model output: ${text.slice(0, 200)}`);
  const end = Math.max(raw.lastIndexOf(']'), raw.lastIndexOf('}'));
  return JSON.parse(raw.slice(start, end + 1));
}

/**
 * Classify a batch of reviews by audience.
 *
 * Batched because the corpus is ~2k reviews and one call per review would be
 * pointless overhead for a decision this small.
 *
 * @param {Array} reviews - rows with { review_id, title, body }
 * @returns {Promise<Array<{review_id, audience, reason}>>}
 */
async function classifyAudience(reviews) {
  if (!reviews.length) return [];

  const content = reviews.map((r, i) => reviewLine(r, i + 1)).join('\n');

  const res = await callClaude({
    component: 'review_audience',
    model: AUDIENCE_MODEL,
    max_tokens: 4000,
    system: AUDIENCE_PROMPT,
    messages: [{ role: 'user', content }],
  });

  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');

  let parsed;
  try {
    parsed = parseJsonBlock(text);
  } catch (err) {
    // Fail closed for the whole batch rather than half-writing it.
    return reviews.map((r) => ({
      review_id: r.review_id,
      audience: 'unclear',
      reason: `classification failed: ${err.message.slice(0, 80)}`,
    }));
  }

  const byIndex = new Map(parsed.map((p) => [Number(p.n), p]));
  return reviews.map((r, i) => {
    const p = byIndex.get(i + 1);
    const audience = AUDIENCE_VALUES.includes(p?.audience) ? p.audience : 'unclear';
    return {
      review_id: r.review_id,
      audience,
      reason: (p?.reason || '').slice(0, 200),
    };
  });
}

// ---------------------------------------------------------------------------
// Publish / hold recommendation
// ---------------------------------------------------------------------------

// Opus: this gates what a customer reads on the product page, and there is no
// check between the recommendation and Jamie's click other than his attention.
const CURATION_MODEL = MODELS.OPUS;

/**
 * The rubric. Derived from moderation history, then edited by Jamie 2026-08-19.
 *
 * Three outcomes, not two. "decide" exists because one category — the product
 * fit but did not conceal well enough for that person — is genuinely a founder
 * call rather than a rule, and forcing it into publish/hold would be a false
 * confidence.
 */
const CURATION_RUBRIC = `1. HOLD hate, harassment, or anti-trans/political attacks. These are not customer feedback whatever the star rating. This is the clearest case.

2. HOLD attacks on the concept of the product or on the customers, rather than on the product itself.

3. HOLD a complaint whose substance is a fixable size or fit problem the customer could have exchanged. Buying the wrong size and keeping it is not a product fault. This is the founder's own long-standing rule.

4. HOLD complaints about shipping, delivery, lost orders, wrong item sent, or packaging. These are logistics, not product feedback, and they mislead the next shopper about the product itself.

5. HOLD durability complaints (elastic pulling out, straps breaking, wear after a few washes). These are a replacement conversation to have directly with the customer.

6. HOLD test entries, junk, empty submissions, and anything that is not a review.

7. PUBLISH critical reviews that give specific, good-faith product feedback about a genuine design limitation, even at 2-3 stars. Seams that poke, fabric that traps sand, cups that gape, straps that slip. A wall of nothing but 5 stars is less credible than one with honest criticism in it. Being critical is NOT grounds to hold.

8. DECIDE — do not recommend either way — when the product fit correctly but did not conceal or shape well enough for that person's body, with no sizing error involved. This is the most sensitive category and it is the founder's call every time.

9. PUBLISH anything positive that is a real review. The default for a genuine customer voice is to publish it.`;

const CURATION_PROMPT = `You are triaging customer reviews for RUBIES, which makes gender-affirming underwear and swimwear for trans girls and women. You recommend whether each review should go live on the storefront. A human makes the final call.

Apply this rubric exactly. It was written by the founder from his own moderation history — it is policy, not a starting point:

${CURATION_RUBRIC}

Judge the review on its substance, not its star rating. A 5-star review carrying a real complaint (about price, shipping, or durability) is judged on the complaint. A 2-star review giving fair product feedback is published.

Respond with JSON only:
{"recommendation": "publish" | "hold" | "decide", "rationale": "one sentence, under 20 words, naming the rule that applied"}

Write the rationale so a person skimming a queue can agree or disagree at a glance.`;

/**
 * Recommend publish / hold / decide for a single review.
 *
 * One call per review rather than batched: the rationale is read by a human per
 * row, batching degrades it, and the queue is small (tens, not thousands).
 *
 * @param {object} review - { review_id, rating, title, body, product_title }
 * @returns {Promise<{recommendation: string, rationale: string}>}
 */
async function recommendCuration(review) {
  const content = [
    `Product: ${review.product_title || review.product_handle || 'unknown'}`,
    `Rating: ${review.rating} star${review.rating === 1 ? '' : 's'}`,
    review.title ? `Title: ${review.title}` : null,
    `Review: ${(review.body || '').replace(/\s+/g, ' ').trim() || '(no text)'}`,
  ].filter(Boolean).join('\n');

  const res = await callClaude({
    component: 'review_curation',
    model: CURATION_MODEL,
    max_tokens: 500,
    system: CURATION_PROMPT,
    messages: [{ role: 'user', content }],
  });

  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');

  try {
    const parsed = parseJsonBlock(text);
    const recommendation = RECOMMENDATIONS.includes(parsed.recommendation) ? parsed.recommendation : 'decide';
    return {
      recommendation,
      rationale: String(parsed.rationale || '').slice(0, 300),
    };
  } catch {
    // Fail to 'decide', never to 'publish' — an unparseable response must not
    // become a nudge to put something on the storefront.
    return { recommendation: 'decide', rationale: 'could not parse recommendation, needs a human look' };
  }
}

// ---------------------------------------------------------------------------
// Execute a decision
// ---------------------------------------------------------------------------

/**
 * Publish or hold a review: write to Judge.me, then record what happened.
 *
 * Judge.me first. If it fails we throw and write nothing, so our record never
 * claims a storefront change that did not happen. The reverse order would let a
 * failed API call leave the queue looking handled.
 *
 * @param {number} reviewId
 * @param {'publish'|'hold'} action
 * @param {object} opts - { reason, operator }
 */
async function applyDecision(reviewId, action, { reason = null, operator = null } = {}) {
  if (action !== 'publish' && action !== 'hold') {
    throw new Error(`applyDecision: action must be 'publish' or 'hold', got ${JSON.stringify(action)}`);
  }

  const judgeme = getJudgemeClient();
  if (!judgeme) throw new Error('Judge.me client unavailable — check JUDGEME_API_TOKEN and shop domain.');

  const curated = action === 'publish' ? 'ok' : 'spam';
  await judgeme.setCurated(reviewId, curated);

  const supabase = getSupabaseClient();
  const { error } = await supabase
    .from('judgeme_reviews')
    .update({
      curated,
      published: action === 'publish',
      hidden: action === 'hold',
      decision: action === 'publish' ? 'published' : 'held',
      decision_reason: reason,
      decision_by: operator,
      decision_at: new Date().toISOString(),
    })
    .eq('review_id', reviewId);

  // The storefront change already succeeded, so surface the bookkeeping failure
  // without pretending the publish didn't happen.
  if (error) {
    throw new Error(`Review ${reviewId} was ${action}ed on Judge.me, but recording it failed: ${error.message}`);
  }

  return { review_id: reviewId, action, curated };
}

module.exports = {
  classifyAudience,
  recommendCuration,
  applyDecision,
  AUDIENCE_VALUES,
  RECOMMENDATIONS,
  CURATION_RUBRIC,
  // exported for tests
  parseJsonBlock,
  reviewLine,
};
