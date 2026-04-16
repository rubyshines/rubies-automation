/**
 * daily-cs-comparison.js
 * Runs Haiku to classify what changed between the AI's first draft and the
 * final sent version for edited/redirected tickets. Updates cs_ai_feedback_log
 * with haiku_category and haiku_summary.
 *
 * Schedule: 7:30am ET (11:30 UTC) — runs before daily-cs-stats email at 8am.
 */

require('dotenv').config();

const Anthropic = require('@anthropic-ai/sdk');
const { getSupabaseClient } = require('../shared/supabaseClient');

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

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

async function classifyDelta(client, original, final) {
  const response = await client.messages.create({
    model: HAIKU_MODEL,
    max_tokens: 256,
    messages: [{
      role: 'user',
      content: `Compare these two customer service email drafts. The ORIGINAL is what the AI generated first. The FINAL is what was actually sent after operator corrections.

Classify what the operator changed. Return JSON only, no other text:
{"category": "<one of: ${CATEGORIES.join(', ')}>", "summary": "<one sentence explaining the key change>"}

ORIGINAL DRAFT:
${(original || '').slice(0, 2000)}

FINAL VERSION:
${(final || '').slice(0, 2000)}`,
    }],
  });

  const text = response.content[0]?.text || '';
  try {
    const parsed = JSON.parse(text);
    const category = CATEGORIES.includes(parsed.category) ? parsed.category : 'other';
    const summary = (parsed.summary || '').slice(0, 500);
    return { category, summary };
  } catch {
    return { category: 'other', summary: text.slice(0, 500) };
  }
}

async function main() {
  const supabase = getSupabaseClient();
  const { start, end, date } = yesterdayBounds();

  console.log(`[cs-comparison] Analyzing edits for ${date}`);

  // Get feedback rows from yesterday that have original != final and no category yet
  const { data: rows, error } = await supabase
    .from('cs_ai_feedback_log')
    .select('id, original_response, final_response, action')
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

  const client = new Anthropic();
  let classified = 0;
  let errors = 0;

  for (const row of toCompare) {
    try {
      const { category, summary } = await classifyDelta(client, row.original_response, row.final_response);

      await supabase
        .from('cs_ai_feedback_log')
        .update({ haiku_category: category, haiku_summary: summary })
        .eq('id', row.id);

      classified++;
      console.log(`  [${row.id}] ${category}: ${summary.slice(0, 80)}`);
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
