/**
 * Advisor draft edit-rate metric — surfaced in the daily ops digest.
 *
 * A cheap, deterministic signal of advisor-accuracy drift: of the advisor drafts
 * the operator actually SENT in the trailing window, what % did they edit at all
 * (draft_response !== sent_response after whitespace normalization)?
 *
 * This is NOT a precision accuracy measure (it counts any edit, including voice
 * tweaks). Its job is to be a trend tripwire: when the edit rate creeps up vs
 * baseline, it's the trigger to run a deeper draft↔sent accuracy sweep
 * (see domain_cs.md "Accuracy-sweep cadence"). Cheap enough to compute daily.
 *
 * Fail-soft: run() never throws into the daily pipeline.
 */
const { getSupabaseClient, fetchAllPaginated } = require('../shared/supabaseClient');

// Treat cosmetic whitespace/line-wrap differences as "not edited".
function normalize(s) {
  return (s || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

async function computeAdvisorEditRate({ days = 30 } = {}) {
  const sb = getSupabaseClient();
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const rows = await fetchAllPaginated(() => sb
    .from('cs_ai_drafts')
    .select('draft_response,sent_response')
    .eq('status', 'sent')
    .not('sent_response', 'is', null)
    .gte('created_at', since)
    .order('id', { ascending: true }));
  let identical = 0;
  for (const r of rows) {
    if (normalize(r.draft_response) === normalize(r.sent_response)) identical++;
  }
  const sent = rows.length;
  const edited = sent - identical;
  return {
    window_days: days,
    sent,
    identical,
    edited,
    edit_rate_pct: sent ? Math.round((edited / sent) * 1000) / 10 : null,
  };
}

// Daily-sync task-runner shape (mirrors lib/rollupAiCosts.run()).
async function run() {
  try {
    const m = await computeAdvisorEditRate({ days: 30 });
    return { sources: { advisor_edit_rate: m }, status: 'ok' };
  } catch (e) {
    // Non-critical reporting task — degrade to a warning, don't fail the sync.
    return { sources: { advisor_edit_rate: { skipped: true, error: e.message } }, status: 'warning' };
  }
}

module.exports = { computeAdvisorEditRate, run, normalize };
