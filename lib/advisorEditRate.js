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

const rate = rows => {
  let identical = 0;
  for (const r of rows) {
    if (normalize(r.draft_response) === normalize(r.sent_response)) identical++;
  }
  const sent = rows.length;
  return { sent, identical, edited: sent - identical, edit_rate_pct: sent ? Math.round(((sent - identical) / sent) * 1000) / 10 : null };
};

async function computeAdvisorEditRate({ days = 30 } = {}) {
  const sb = getSupabaseClient();
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const rows = await fetchAllPaginated(() => sb
    .from('cs_ai_drafts')
    .select('source,draft_response,sent_response')
    // cs_ai_drafts holds every outbound message. Only rows the ADVISOR wrote
    // belong in an advisor-quality metric: 'auto_follow_up' is a fixed
    // template (~97% byte-identical), 'operator_reply' and 'manual_send' are
    // Jamie composing from scratch — stored into BOTH draft_response and
    // sent_response, so each one scores as a flawless untouched draft — and
    // 'simulator' is test traffic. Including them understated the edit rate
    // by ~5 points (48.4% reported vs 53.3% true, 30d to 2026-08-04).
    .eq('draft_kind', 'advisor_draft')
    .in('source', ['poller', 'operator_outreach'])
    .eq('status', 'sent')
    .not('sent_response', 'is', null)
    .gte('created_at', since)
    .order('id', { ascending: true }));

  // Inbound replies are the headline: that's the surface the tripwire watches,
  // and outbound outreach is a different task with its own edit profile, so
  // blending them moves the number for reasons unrelated to advisor drift.
  const inbound = rows.filter(r => r.source === 'poller');
  const outreach = rows.filter(r => r.source === 'operator_outreach');

  return { window_days: days, ...rate(inbound), outreach: rate(outreach) };
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
