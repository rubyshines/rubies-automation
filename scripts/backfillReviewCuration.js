#!/usr/bin/env node
/**
 * Backfill audience classification and curation recommendations.
 *
 * Thin wrapper over the review_classify / review_assess MCP tools — the logic
 * lives there, this just drives them over the whole corpus once.
 *
 * Print-only by default. Pass --live to write.
 *
 *   node scripts/backfillReviewCuration.js                # what would happen
 *   node scripts/backfillReviewCuration.js --live         # both passes
 *   node scripts/backfillReviewCuration.js --live --audience-only
 *   node scripts/backfillReviewCuration.js --live --assess-only
 *
 * Cost: audience is Haiku over ~2k reviews in batches of 20 (cents). Assess is
 * Opus, one call per review, and runs ONLY over the unpublished queue (~150),
 * not the whole corpus — assessing 1,856 already-published reviews would be
 * paying Opus to answer a question nobody asked.
 */

require('dotenv').config();

const { getSupabaseClient } = require('../shared/supabaseClient');
const reviewTools = require('../customer-service/lib/tools/reviewCuration');

const toolMap = Object.fromEntries(reviewTools.map((t) => [t.name, t]));

async function counts() {
  const supabase = getSupabaseClient();
  const total = await supabase.from('judgeme_reviews').select('review_id', { count: 'exact', head: true });
  const unclassified = await supabase.from('judgeme_reviews').select('review_id', { count: 'exact', head: true }).is('audience', null);
  const unpublished = await supabase.from('judgeme_reviews').select('review_id', { count: 'exact', head: true }).eq('published', false);
  const unassessed = await supabase.from('judgeme_reviews').select('review_id', { count: 'exact', head: true })
    .eq('published', false).is('ai_recommendation', null);

  for (const [label, res] of [['total', total], ['unclassified', unclassified], ['unpublished', unpublished], ['unassessed', unassessed]]) {
    // PostgREST drops the response body when head:true, so a missing column
    // surfaces as an empty message. Say what it almost certainly means.
    if (res.error) {
      const detail = res.error.message || 'no detail (PostgREST omits the body on head requests)';
      throw new Error(
        `Counting "${label}" failed: ${detail}\n`
        + 'This usually means review-tracking/migrations-2026-08-judgeme-publish-state.sql '
        + 'has not been applied yet — run it in the Supabase SQL Editor.',
      );
    }
  }

  return {
    total: total.count,
    unclassified: unclassified.count,
    unpublished: unpublished.count,
    unassessed: unassessed.count,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const live = args.includes('--live');
  const audienceOnly = args.includes('--audience-only');
  const assessOnly = args.includes('--assess-only');

  const c = await counts();

  console.log(`Reviews:            ${c.total}`);
  console.log(`Without audience:   ${c.unclassified}`);
  console.log(`Unpublished:        ${c.unpublished}`);
  console.log(`Unpublished, unassessed: ${c.unassessed}`);
  console.log('');

  if (!live) {
    console.log('Print-only. Would run:');
    if (!assessOnly) console.log(`  review_classify  → Haiku over ${c.unclassified} review(s), batched 20 at a time`);
    if (!audienceOnly) console.log(`  review_assess    → Opus over ${c.unassessed} unpublished review(s), one call each`);
    console.log('');
    console.log('Re-run with --live to write.');
    return;
  }

  if (!assessOnly) {
    console.log(`Classifying ${c.unclassified} review(s) by audience…`);
    const res = await toolMap.review_classify.handler({ limit: 2000 });
    console.log(res.content[0].text);
    console.log('');
  }

  if (!audienceOnly) {
    console.log(`Assessing ${c.unassessed} unpublished review(s) against the rubric…`);
    // The tool caps at 100 per call; loop until the queue is drained.
    let remaining = c.unassessed;
    while (remaining > 0) {
      const res = await toolMap.review_assess.handler({ limit: 100 });
      const done = res._structured?.assessed || 0;
      console.log(res.content[0].text);
      if (!done) break;
      remaining -= done;
    }
  }

  console.log('');
  console.log('Done. Nothing was published — every decision is still yours in the Reviews tab.');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
