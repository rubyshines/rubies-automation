/**
 * Auto-send shadow report (#4) — daily digest visibility for the dry run.
 *
 * Counts drafts marked auto_close_path='autosend_shadow' (what WOULD have been
 * auto-sent had the category been live) over the trailing window, broken down
 * by message_type, and cross-references the closeness judge's verdicts on
 * those same drafts — the dry run's error rate IS the go/no-go evidence for
 * flipping a category live.
 *
 * Fail-soft like every sync task.
 */
const { getSupabaseClient, fetchAllPaginated } = require('../shared/supabaseClient');

async function computeShadowReport({ days = 7 } = {}) {
  const sb = getSupabaseClient();
  const since = new Date(Date.now() - days * 86400000).toISOString();

  const marked = await fetchAllPaginated(() =>
    sb.from('cs_ai_drafts')
      .select('id, message_type, status, created_at')
      .eq('auto_close_path', 'autosend_shadow')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
  );

  const byType = {};
  for (const d of marked) {
    byType[d.message_type || 'unknown'] = (byType[d.message_type || 'unknown'] || 0) + 1;
  }

  // Judge verdicts on the marked drafts that have since been sent — divergence
  // here means the shadow send would have been WRONG. The metric that matters.
  let wouldHaveErred = 0;
  if (marked.length) {
    const verdicts = await fetchAllPaginated(() =>
      sb.from('cs_draft_judgments')
        .select('draft_id, category')
        .in('draft_id', marked.map(m => m.id))
        .order('id', { ascending: true })
    );
    wouldHaveErred = verdicts.filter(v =>
      ['substantive', 'factual_correction', 'action_divergence'].includes(v.category)
    ).length;
  }

  return { window_days: days, marked: marked.length, by_type: byType, would_have_erred: wouldHaveErred };
}

// Daily-sync task-runner shape (mirrors lib/advisorEditRate.run()).
async function run() {
  try {
    const m = await computeShadowReport({ days: 7 });
    return { sources: { autosend_shadow: m }, status: 'ok' };
  } catch (e) {
    // Non-critical reporting task — degrade to a warning, don't fail the sync.
    return { sources: { autosend_shadow: { skipped: true, error: e.message } }, status: 'warning' };
  }
}

module.exports = { run, computeShadowReport };
