/**
 * Away-mode digest report.
 *
 * Two jobs. While away mode is ON it states so in the daily digest, with the
 * instant it switches itself off — the second line of defence behind the
 * dashboard banner, so a window that was set too long is visible every morning
 * rather than discovered from a customer. And on the day it ends it reports how
 * many customers were acknowledged, which is what the operator wants to know on
 * the way home.
 *
 * Renders nothing when away mode is off and nothing was acknowledged recently.
 * Fail-soft like every sync task.
 */
const { getSupabaseClient, fetchAllPaginated } = require('../shared/supabaseClient');
const { getFlag } = require('../shared/systemFlags');
const { AWAY_FLAG, formatEastern } = require('../customer-service/lib/awayMode');

async function computeAwayModeReport({ days = 7 } = {}) {
  const sb = getSupabaseClient();
  const since = new Date(Date.now() - days * 86400000).toISOString();

  const flag = await getFlag(AWAY_FLAG);

  const acked = await fetchAllPaginated(() =>
    sb.from('cs_tickets')
      .select('gorgias_ticket_id, away_ack_sent_at')
      .gte('away_ack_sent_at', since)
      .order('away_ack_sent_at', { ascending: false })
  );

  return {
    window_days: days,
    active: !!flag?.active,
    // `enabled && !active` is the already-expired case: worth nothing to report,
    // which is exactly the point of the expiry.
    until: flag?.active ? flag.expires_at : null,
    until_label: flag?.active ? formatEastern(flag.expires_at) : null,
    return_phrase: flag?.active ? (flag.note || null) : null,
    acked_count: acked.length,
  };
}

async function run() {
  try {
    const m = await computeAwayModeReport({ days: 7 });
    return { sources: { away_mode: m }, status: 'ok' };
  } catch (e) {
    // Non-critical reporting task — degrade to a warning, don't fail the sync.
    return { sources: { away_mode: { skipped: true, error: e.message } }, status: 'warning' };
  }
}

module.exports = { run, computeAwayModeReport };
