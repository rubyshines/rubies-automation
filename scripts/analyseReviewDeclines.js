#!/usr/bin/env node
/**
 * Judge.me decline analysis — derive the curation rubric from history.
 *
 * Jamie moderates reviews by hand every few weeks: he opens Judge.me, scrolls
 * back to roughly the last unpublished review, and works forward publishing the
 * good ones. Reviews he considers unfair get left behind.
 *
 * That workflow is what lets us read intent out of the data. If a review is
 * still unpublished while NEWER reviews were published, he moved past it — a
 * decline. If it sits after the newest published review, he simply hasn't got
 * to it yet. We call the newest published review's date the WATERMARK.
 *
 * The catch, and the reason this script prints evidence rather than just an
 * answer: the same workflow guarantees accidental skips. Prior declines act as
 * anchors, so good reviews near them get passed over by mistake. Measured on
 * 2026-08 data, 54 of 100 passed-over reviews were 5-star with no plausible
 * objection ("Thee work perfectly, feel great, and are good quality!"). So the
 * passed-over set is a MIX, and a rubric learned from it naively would learn
 * noise.
 *
 * The trustworthy signal is narrower:
 *   - `hidden: true` reviews — Judge.me only reaches that state when a human
 *     hides a review and picks a reason from a list. High confidence.
 *   - low-star passed-over reviews — these match the stated rule (a fit
 *     complaint that should have been an exchange).
 *
 * Output is a PROPOSED rubric for Jamie to edit, not a policy. Nothing here
 * writes to Supabase or to Judge.me.
 *
 * Usage:  node scripts/analyseReviewDeclines.js [--json] [--no-ai]
 */

require('dotenv').config();

const { getJudgemeClient } = require('../shared/judgemeClient');
const { callClaude } = require('../shared/aiClient');
const { MODELS } = require('../shared/aiPricing');

// ---------------------------------------------------------------------------
// Partitioning — pure, so it can be unit tested without the API
// ---------------------------------------------------------------------------

/**
 * Split reviews into the four groups described above.
 *
 * @param {Array} reviews - raw Judge.me review objects
 * @returns {{watermark: string|null, hidden: Array, passedOver: Array,
 *            trailing: Array, published: Array}}
 *
 * `passedOver` excludes `hidden` reviews — they're reported separately because
 * their confidence level is different. `trailing` is everything unpublished at
 * or after the watermark: the live queue.
 */
function partitionReviews(reviews) {
  const published = reviews.filter((r) => r.published === true);
  const unpublished = reviews.filter((r) => r.published !== true);

  if (!published.length) {
    // No watermark to reason against — everything unprocessed by definition.
    return { watermark: null, hidden: [], passedOver: [], trailing: unpublished, published };
  }

  const watermark = published
    .map((r) => r.created_at)
    .filter(Boolean)
    .sort()
    .pop();

  const hidden = unpublished.filter((r) => r.hidden === true);
  const notHidden = unpublished.filter((r) => r.hidden !== true);

  return {
    watermark,
    hidden,
    passedOver: notHidden.filter((r) => r.created_at && r.created_at < watermark),
    trailing: notHidden.filter((r) => !r.created_at || r.created_at >= watermark),
    published,
  };
}

// ---------------------------------------------------------------------------
// Rubric derivation
// ---------------------------------------------------------------------------

const RUBRIC_PROMPT = `You are helping a founder write down the rule he has been applying by instinct when deciding which customer reviews to publish on his storefront.

RUBIES makes gender-affirming underwear and swimwear for trans girls and women. Reviews come from customers who are often writing about something personal.

The founder's own words on why he declines some reviews: "if I felt they were unfair — for example someone buys something and they give a bad review but it's because it doesn't fit. Well, I think they should have gone for an exchange, so that's an unfair review."

You are given three sets of reviews:

1. HIDDEN — the founder actively hid these. He had to pick a reason from a list to do it. This is your highest-confidence evidence of a deliberate decline.
2. PASSED OVER (LOW STAR) — left unpublished while newer reviews went live. Moderately confident these were deliberate.
3. PUBLISHED (COMPARISON SAMPLE) — reviews he did publish, including critical ones. Use these to find what separates a decline from a publish. If a critical review appears here, then being critical is NOT by itself grounds to decline.

IMPORTANT — the data is noisy. His process (scroll back to the last unpublished review, work forward) causes accidental skips as well as deliberate declines. Do not manufacture a criterion to explain every declined review. If a subset has no coherent explanation beyond "probably skipped by accident", say so explicitly. A short rubric that is actually right beats a comprehensive one that is invented.

Produce:

A. RUBRIC — the decision rules, as a numbered list. Each rule states the condition and what to do (publish / hold). Write them so another person could apply them consistently. Keep it under 8 rules.
B. UNEXPLAINED — roughly how many of the declines your rubric does NOT account for, and what you think happened to them.
C. EDGE CASES — cases where you would want the founder to decide rather than the rubric.

Write plainly. No preamble.`;

function formatReviewsForPrompt(reviews, label) {
  const lines = reviews.map((r, i) => {
    const date = (r.created_at || '').slice(0, 10);
    const title = (r.title || '').trim();
    const body = (r.body || '').replace(/\s+/g, ' ').trim().slice(0, 400);
    return `${i + 1}. [${r.rating}★ ${date}] ${title ? `"${title}" — ` : ''}${body}`;
  });
  return `### ${label} (${reviews.length})\n${lines.join('\n')}`;
}

/**
 * Ask Opus to state the criteria separating declines from publishes.
 *
 * Opus rather than a cheaper model: this output becomes the standing policy for
 * what appears on the storefront, and a wrong rule here quietly suppresses real
 * customer voices or publishes something the founder would not have.
 */
async function deriveRubric({ hidden, passedOverLowStar, publishedSample }) {
  const content = [
    formatReviewsForPrompt(hidden, 'HIDDEN — actively hidden by the founder'),
    '',
    formatReviewsForPrompt(passedOverLowStar, 'PASSED OVER (LOW STAR) — left unpublished while newer reviews went live'),
    '',
    formatReviewsForPrompt(publishedSample, 'PUBLISHED (COMPARISON SAMPLE)'),
  ].join('\n');

  const res = await callClaude({
    component: 'review_rubric_analysis',
    model: MODELS.OPUS,
    max_tokens: 4000,
    system: RUBRIC_PROMPT,
    messages: [{ role: 'user', content }],
  });

  return res.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function tally(rows, key) {
  return rows.reduce((m, r) => {
    const k = typeof key === 'function' ? key(r) : r[key];
    m[k] = (m[k] || 0) + 1;
    return m;
  }, {});
}

function summarise(parts) {
  const { watermark, hidden, passedOver, trailing, published } = parts;
  const lines = [];
  lines.push(`Watermark (newest published review): ${watermark ? watermark.slice(0, 10) : 'none'}`);
  lines.push('');
  lines.push(`Published:      ${published.length}`);
  lines.push(`Hidden:         ${hidden.length}   (deliberate — a human picked a reason)`);
  lines.push(`Passed over:    ${passedOver.length}   (mixed: real declines + accidental skips)`);
  lines.push(`Trailing queue: ${trailing.length}   (never processed — the live backlog)`);
  lines.push('');
  lines.push(`Hidden by rating:      ${JSON.stringify(tally(hidden, 'rating'))}`);
  lines.push(`Passed over by rating: ${JSON.stringify(tally(passedOver, 'rating'))}`);
  lines.push(`Trailing by rating:    ${JSON.stringify(tally(trailing, 'rating'))}`);
  if (trailing.length) {
    const dates = trailing.map((r) => r.created_at).filter(Boolean).sort();
    lines.push(`Trailing date range:   ${dates[0].slice(0, 10)} .. ${dates[dates.length - 1].slice(0, 10)}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const noAi = args.includes('--no-ai');

  const client = getJudgemeClient();
  if (!client) {
    console.error('Judge.me client unavailable — check JUDGEME_API_TOKEN and JUDGEME_SHOP_DOMAIN/SHOPIFY_STORE_URL.');
    process.exit(1);
  }

  console.error('Fetching all reviews from Judge.me…');
  const reviews = await client.getAllReviews({ perPage: 100, maxPages: 200 });
  console.error(`  ${reviews.length} reviews.`);

  const parts = partitionReviews(reviews);

  if (asJson) {
    console.log(JSON.stringify({
      watermark: parts.watermark,
      counts: {
        published: parts.published.length,
        hidden: parts.hidden.length,
        passedOver: parts.passedOver.length,
        trailing: parts.trailing.length,
      },
      trailing: parts.trailing.map((r) => ({ id: r.id, rating: r.rating, created_at: r.created_at, title: r.title, body: r.body })),
    }, null, 2));
    return;
  }

  console.log(summarise(parts));

  if (noAi) return;

  // Feed only the trustworthy signal. Low-star = 1-3; a 4-5 star passed-over
  // review is far more likely an accidental skip than a judgement.
  const passedOverLowStar = parts.passedOver.filter((r) => r.rating <= 3);

  // Comparison sample: published reviews at the same ratings, so the model can
  // see that being critical is not itself disqualifying. Newest first, capped.
  const publishedSample = parts.published
    .filter((r) => r.rating <= 3)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, 40);

  console.log('');
  console.log(`Deriving rubric from ${parts.hidden.length} hidden + ${passedOverLowStar.length} low-star passed-over, against ${publishedSample.length} published critical reviews…`);
  console.log('');

  const rubric = await deriveRubric({ hidden: parts.hidden, passedOverLowStar, publishedSample });

  console.log('═'.repeat(70));
  console.log('PROPOSED RUBRIC — review before this becomes policy');
  console.log('═'.repeat(70));
  console.log(rubric);
}

module.exports = { partitionReviews, deriveRubric, formatReviewsForPrompt };

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
