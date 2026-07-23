/**
 * Steer & Send shadow report — daily digest visibility for the dry run.
 *
 * Counts steered regens the gate would have sent unreviewed over the trailing
 * window, and cross-references the closeness judge's verdicts on those drafts:
 * a gate-passed draft later judged substantive/factual/action-divergent means
 * the unreviewed send would have been WRONG. That error rate is the go/no-go
 * evidence for ever taking Steer & Send live.
 *
 * Fail-soft like every sync task.
 */
const { getSupabaseClient, fetchAllPaginated } = require('../shared/supabaseClient');

async function computeSteerSendReport({ days = 7 } = {}) {
  const sb = getSupabaseClient();
  const since = new Date(Date.now() - days * 86400000).toISOString();

  const rows = await fetchAllPaginated(() =>
    sb.from('steer_send_shadow')
      .select('id, draft_id, would_send, pure_eligible, reason, created_at')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
  );

  const passed = rows.filter(r => r.would_send);
  const verifierRejected = rows.filter(r => !r.would_send && r.pure_eligible);
  const pureRejected = rows.filter(r => !r.pure_eligible);

  // Judge verdicts on gate-passed drafts that have since been sent.
  let wouldHaveErred = 0;
  if (passed.length) {
    const verdicts = await fetchAllPaginated(() =>
      sb.from('cs_draft_judgments')
        .select('draft_id, category')
        .in('draft_id', [...new Set(passed.map(r => r.draft_id).filter(Boolean))])
        .order('id', { ascending: true })
    );
    wouldHaveErred = verdicts.filter(v =>
      ['substantive', 'factual_correction', 'action_divergence'].includes(v.category)
    ).length;
  }

  return {
    window_days: days,
    steered: rows.length,
    gate_passed: passed.length,
    verifier_rejected: verifierRejected.length,
    pure_rejected: pureRejected.length,
    would_have_erred: wouldHaveErred,
  };
}

// Daily-sync task-runner shape (mirrors lib/autosendShadow.run()).
async function run() {
  try {
    const m = await computeSteerSendReport({ days: 7 });
    return { sources: { steersend_shadow: m }, status: 'ok' };
  } catch (e) {
    // Non-critical reporting task — degrade to a warning, don't fail the sync.
    return { sources: { steersend_shadow: { skipped: true, error: e.message } }, status: 'warning' };
  }
}

module.exports = { run, computeSteerSendReport };
