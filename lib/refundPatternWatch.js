/**
 * Refund-pattern + routing-reason watch — daily digest visibility.
 *
 * Two trendlines from the advisor's structured output over the trailing week:
 *  - Refund-pattern flags (advisor-raised "Refund-pattern: …" strings): is the
 *    donate-instead-of-return honor system being probed more than usual?
 *    (Baseline from the 2026-07 assessment: ~2-3 suspect cases/month.)
 *  - route_to_human routing reasons: which triggers are sending tickets to
 *    Jamie — recurring bogus reasons are prompt gaps with evidence attached.
 *
 * Fail-soft like every sync reporting task.
 */
const { getSupabaseClient, fetchAllPaginated } = require('../shared/supabaseClient');

async function computeRefundPatternReport({ days = 7 } = {}) {
  const sb = getSupabaseClient();
  const since = new Date(Date.now() - days * 86400000).toISOString();

  const drafts = await fetchAllPaginated(() =>
    sb.from('cs_ai_drafts')
      .select("id, gorgias_ticket_id, message_type, created_at, sent_response, flags:structured_output->prescription->flags, adv_status:structured_output->>status, routing_reason:structured_output->>routing_reason")
      .gte('created_at', since)
      .order('created_at', { ascending: false })
  );

  // Sent-body exact match, same pattern as the advocacy P.S. tracker — the
  // SENT body is the source of truth (robust to operator edits/removals).
  const PROOF_ASK_MARKER = 'let the org know to expect the donation';

  const flagged = [];
  const routed = [];
  let proofAsksSent = 0;
  for (const d of drafts) {
    const flags = Array.isArray(d.flags) ? d.flags.filter((f) => typeof f === 'string') : [];
    const refundFlags = flags.filter((f) => /^refund-pattern/i.test(f.trim()));
    if (refundFlags.length) {
      flagged.push({ ticket: d.gorgias_ticket_id, flags: refundFlags, created_at: d.created_at });
    }
    if (d.adv_status === 'route_to_human' && d.routing_reason) {
      routed.push({ ticket: d.gorgias_ticket_id, reason: d.routing_reason, created_at: d.created_at });
    }
    if ((d.sent_response || '').includes(PROOF_ASK_MARKER)) proofAsksSent++;
  }

  return {
    window_days: days,
    refund_pattern_count: flagged.length,
    refund_pattern: flagged.slice(0, 10),
    routed_count: routed.length,
    routing_reasons: routed.slice(0, 10),
    proof_asks_sent: proofAsksSent,
  };
}

// Daily-sync task-runner shape (mirrors lib/autosendShadow.run()).
async function run() {
  try {
    const m = await computeRefundPatternReport({ days: 7 });
    return { sources: { refund_pattern_watch: m }, status: 'ok' };
  } catch (e) {
    // Non-critical reporting task — degrade to a warning, don't fail the sync.
    return { sources: { refund_pattern_watch: { skipped: true, error: e.message } }, status: 'warning' };
  }
}

module.exports = { run, computeRefundPatternReport };
