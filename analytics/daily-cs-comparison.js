/**
 * daily-cs-comparison.js
 * Runs Haiku to classify what changed between the AI's first draft and the
 * final sent version for edited/redirected tickets. Updates cs_ai_feedback_log
 * with haiku_category, haiku_summary, haiku_score, and haiku_score_post_steer.
 *
 * For steered tickets, scores twice:
 *   - haiku_score: original (pre-steer) draft vs final sent (measures AI's autonomous quality)
 *   - haiku_score_post_steer: post-steer draft vs final sent (measures AI's ability to follow directions)
 *
 * Schedule: 7:30am ET (11:30 UTC) — runs before daily-cs-stats email at 8am.
 */

require('dotenv').config();

const Anthropic = require('@anthropic-ai/sdk');
const { callClaude } = require('../shared/aiClient');
const { MODELS } = require('../shared/aiPricing');
const { getSupabaseClient } = require('../shared/supabaseClient');

const HAIKU_MODEL = MODELS.HAIKU;

const CATEGORIES = [
  'wrong_action',
  'wrong_tone',
  'missing_info',
  'wrong_product',
  'overcomplicated',
  'other',
];

function yesterdayBounds() {
  const now = new Date();
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  const dateStr = y.toISOString().slice(0, 10);
  return {
    start: `${dateStr}T00:00:00Z`,
    end: `${dateStr}T23:59:59.999Z`,
    date: dateStr,
  };
}

function parseHaikuResponse(text) {
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  try {
    const parsed = JSON.parse(text);
    const category = CATEGORIES.includes(parsed.category) ? parsed.category : 'other';
    const summary = (parsed.summary || '').slice(0, 500);
    const score = Number.isInteger(parsed.score) && parsed.score >= 1 && parsed.score <= 10 ? parsed.score : null;
    return { category, summary, score };
  } catch {
    return { category: 'other', summary: text.slice(0, 500), score: null };
  }
}

async function classifyDelta(client, original, final) {
  const response = await callClaude({
    component: 'daily_cs_comparison',
    metadata: { task: 'classify_delta' },
    model: HAIKU_MODEL,
    max_tokens: 256,
    messages: [{
      role: 'user',
      content: `Compare these two customer service email drafts. The ORIGINAL is what the AI generated first. The FINAL is what was actually sent after operator corrections.

Classify what the operator changed and rate the quality of the ORIGINAL draft. Return JSON only, no other text:
{"category": "<one of: ${CATEGORIES.join(', ')}>", "summary": "<one sentence explaining the key change>", "score": <1-10 integer, where 10 = perfect draft needing no changes, 7-9 = minor tweaks only, 4-6 = meaningful corrections needed, 1-3 = fundamentally wrong>}

ORIGINAL DRAFT:
${(original || '').slice(0, 2000)}

FINAL VERSION:
${(final || '').slice(0, 2000)}`,
    }],
  });
  return parseHaikuResponse(response.content[0]?.text || '');
}

async function scorePostSteer(client, steeredDraft, final) {
  const response = await callClaude({
    component: 'daily_cs_comparison',
    metadata: { task: 'score_post_steer' },
    model: HAIKU_MODEL,
    max_tokens: 128,
    messages: [{
      role: 'user',
      content: `Rate the quality of this AI-generated customer service draft compared to what was actually sent. The DRAFT was generated after the operator gave the AI specific instructions to correct it. Return JSON only:
{"score": <1-10 integer, where 10 = perfect execution of instructions, 7-9 = minor tweaks, 4-6 = meaningful corrections still needed, 1-3 = still got it wrong>}

POST-CORRECTION DRAFT:
${(steeredDraft || '').slice(0, 2000)}

FINAL SENT VERSION:
${(final || '').slice(0, 2000)}`,
    }],
  });
  let text = response.content[0]?.text || '';
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  try {
    const parsed = JSON.parse(text);
    return Number.isInteger(parsed.score) && parsed.score >= 1 && parsed.score <= 10 ? parsed.score : null;
  } catch {
    return null;
  }
}

async function main() {
  const supabase = getSupabaseClient();
  const { start, end, date } = yesterdayBounds();

  console.log(`[cs-comparison] Analyzing edits for ${date}`);

  // Get feedback rows that have original != final and no category yet
  const { data: rows, error } = await supabase
    .from('cs_ai_feedback_log')
    .select('id, draft_id, gorgias_ticket_id, original_response, final_response, action')
    .gte('created_at', start)
    .lte('created_at', end)
    .is('haiku_category', null)
    .not('original_response', 'is', null)
    .not('final_response', 'is', null);

  if (error) throw error;

  // Filter to rows where original and final actually differ
  const toCompare = (rows || []).filter(r => {
    if (!r.original_response || !r.final_response) return false;
    return r.original_response.trim() !== r.final_response.trim();
  });

  console.log(`[cs-comparison] Found ${toCompare.length} edited/redirected tickets to classify`);

  if (toCompare.length === 0) {
    console.log('[cs-comparison] Nothing to compare. Done.');
    return;
  }

  // For post-steer scoring: find the sent draft's response (the steered version)
  // The feedback_log.draft_id points to the draft that was actually sent.
  // If that draft has operator_steer set, the draft_response IS the post-steer version.
  const draftIds = toCompare.map(r => r.draft_id).filter(Boolean);
  let draftMap = {};
  if (draftIds.length > 0) {
    const { data: drafts } = await supabase
      .from('cs_ai_drafts')
      .select('id, ticket_id, draft_response, operator_steer')
      .in('id', draftIds);
    for (const d of (drafts || [])) draftMap[d.id] = d;
  }

  const client = new Anthropic();
  let classified = 0;
  let errors = 0;

  for (const row of toCompare) {
    try {
      // Score 1: original (pre-steer) vs final
      const { category, summary, score } = await classifyDelta(client, row.original_response, row.final_response);

      const update = { haiku_category: category, haiku_summary: summary };
      if (score != null) update.haiku_score = score;

      // Score 2: if the sent draft was steered, compare steered draft vs final
      const sentDraft = draftMap[row.draft_id];
      if (sentDraft?.operator_steer && sentDraft.draft_response) {
        const postSteerScore = await scorePostSteer(client, sentDraft.draft_response, row.final_response);
        if (postSteerScore != null) update.haiku_score_post_steer = postSteerScore;
        console.log(`  [${row.id}] ${score ?? '?'}/10 → ${postSteerScore ?? '?'}/10 (steered) ${category}: ${summary.slice(0, 60)}`);
      } else {
        console.log(`  [${row.id}] ${score ?? '?'}/10 ${category}: ${summary.slice(0, 70)}`);
      }

      await supabase
        .from('cs_ai_feedback_log')
        .update(update)
        .eq('id', row.id);

      classified++;
    } catch (err) {
      errors++;
      console.error(`  [${row.id}] Error: ${err.message}`);
    }
  }

  console.log(`[cs-comparison] Done. Classified: ${classified}, Errors: ${errors}`);
}

main().catch(err => {
  console.error('[cs-comparison] Fatal:', err);
  process.exit(1);
});
