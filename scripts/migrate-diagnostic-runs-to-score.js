#!/usr/bin/env node
/**
 * Migrate cs_diagnostic_runs from the 3-bucket verdict scale to a 1-5 score.
 *
 * Mapping (lossy in the upper half — old judge had no B_BETTER signal,
 * so any historical row that would have rated 4/5 today gets capped at 3):
 *   EQUIVALENT                       -> 3
 *   B_ACCEPTABLE                     -> 3
 *   B_WORSE with 0 MAJOR_DIFFs       -> 2
 *   B_WORSE with 1 MAJOR_DIFF        -> 2
 *   B_WORSE with >=2 MAJOR_DIFFs     -> 1
 *
 * Writes the derived score onto judge_result.score (and judge_result.score_source = 'migrated').
 * Idempotent — rows already carrying score_source: 'migrated' are skipped.
 */
require('dotenv').config();
const { getSupabaseClient } = require('../shared/supabaseClient');

const ADVISOR_DIMENSIONS = ['tone', 'action', 'structured', 'length', 'rules'];
const OPERATOR_DIMENSIONS = ['tool_selection', 'response_quality'];

function deriveScore(row) {
  const j = row.judge_result;
  if (!j || !j.verdict) return null;
  const dims = row.source === 'operator' ? OPERATOR_DIMENSIONS : ADVISOR_DIMENSIONS;
  const majorDiffs = dims.reduce((n, d) => n + (j[d]?.rating === 'MAJOR_DIFF' ? 1 : 0), 0);
  switch (j.verdict) {
    case 'EQUIVALENT':
    case 'B_ACCEPTABLE':
      return 3;
    case 'B_WORSE':
      return majorDiffs >= 2 ? 1 : 2;
    default:
      return null;
  }
}

(async () => {
  const sb = getSupabaseClient();
  const PAGE = 200;
  let from = 0;
  let migrated = 0, skipped = 0, noVerdict = 0;
  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };

  for (;;) {
    const { data, error } = await sb
      .from('cs_diagnostic_runs')
      .select('id, source, judge_result')
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;

    for (const row of data) {
      const j = row.judge_result;
      if (!j) { noVerdict++; continue; }
      if (j.score_source === 'migrated' || typeof j.score === 'number') { skipped++; continue; }

      const score = deriveScore(row);
      if (score == null) { noVerdict++; continue; }

      const updated = { ...j, score, score_source: 'migrated' };
      const { error: upErr } = await sb
        .from('cs_diagnostic_runs')
        .update({ judge_result: updated })
        .eq('id', row.id);
      if (upErr) {
        console.error('row', row.id, 'failed:', upErr.message);
        continue;
      }
      migrated++;
      distribution[score]++;
    }
    if (data.length < PAGE) break;
    from += PAGE;
  }

  console.log('Migrated:', migrated);
  console.log('Skipped (already had score):', skipped);
  console.log('Skipped (no verdict):', noVerdict);
  console.log('Distribution after migration:');
  for (const k of [1, 2, 3, 4, 5]) {
    const pct = migrated > 0 ? (100 * distribution[k] / migrated).toFixed(1) : '0.0';
    console.log(`  ${k}: ${distribution[k]} (${pct}%)`);
  }
})().catch(e => { console.error(e); process.exit(1); });
