/**
 * Daily closeness-to-final judge task (#3) — surfaced in the daily ops digest.
 *
 * Two jobs, both fail-soft:
 *   1. Judge any recent sent advisor drafts that don't have a verdict yet
 *      (trailing 3-day window so a missed day self-heals; capped per run).
 *   2. Compute the trailing-30d quality metrics from cs_draft_judgments:
 *      substantive-divergence rate (the digest headline, replacing raw
 *      edit-rate as the quality signal) and the draft_may_be_right list.
 *
 * Substantive divergence = substantive + factual_correction + action_divergence.
 * identical + cosmetic count as "sent as good as drafted".
 */
const { getSupabaseClient } = require('../shared/supabaseClient');

const DAILY_CAP = 30; // ~6 tickets/day normally; cap is a runaway guard

async function fetchAll(buildQuery, pageSize = 1000) {
  const rows = [];
  let from = 0;
  for (;;) {
    const { data, error } = await buildQuery().range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    rows.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

async function judgeRecentDrafts({ days = 3, cap = DAILY_CAP } = {}) {
  const { judgeDraftVsSent } = require('../customer-service/lib/closenessJudge');
  const sb = getSupabaseClient();
  const since = new Date(Date.now() - days * 86400000).toISOString();

  const drafts = await fetchAll(() =>
    sb.from('cs_ai_drafts')
      .select('id, gorgias_ticket_id, draft_response, sent_response, message_type, conversation_history, sent_at')
      .eq('status', 'sent')
      .eq('draft_kind', 'advisor_draft')
      .gte('sent_at', since)
      .not('sent_response', 'is', null)
      .neq('draft_response', '')
      .order('sent_at', { ascending: false })
  );
  if (!drafts.length) return { judged: 0, failed: 0 };

  const existing = await fetchAll(() =>
    sb.from('cs_draft_judgments').select('draft_id').in('draft_id', drafts.map(d => d.id)).order('id')
  );
  const done = new Set(existing.map(r => r.draft_id));
  const pending = drafts.filter(d => !done.has(d.id)).slice(0, cap);

  let judged = 0, failed = 0;
  for (const d of pending) {
    try {
      const v = await judgeDraftVsSent({
        draftResponse: d.draft_response,
        sentResponse: d.sent_response,
        conversationHistory: d.conversation_history,
        messageType: d.message_type,
      });
      const { error } = await sb.from('cs_draft_judgments').insert({
        draft_id: d.id,
        gorgias_ticket_id: d.gorgias_ticket_id,
        category: v.category,
        draft_may_be_right: v.draft_may_be_right,
        severity: v.severity,
        rationale: v.rationale,
        message_type: d.message_type,
        judge_model: v.judge_model,
        source: 'daily',
      });
      if (error && error.code !== '23505') throw new Error(error.message);
      judged++;
    } catch (e) {
      failed++;
    }
  }
  return { judged, failed, pending_beyond_cap: Math.max(0, drafts.length - done.size - cap) };
}

function summarizeVerdicts(rows) {
  const counts = {};
  for (const r of rows) counts[r.category] = (counts[r.category] || 0) + 1;
  const total = rows.length;
  const divergent = (counts.substantive || 0) + (counts.factual_correction || 0) + (counts.action_divergence || 0);
  return {
    judged: total,
    counts,
    divergence_rate_pct: total ? Math.round((divergent / total) * 1000) / 10 : null,
  };
}

async function computeJudgeMetrics({ days = 30 } = {}) {
  const sb = getSupabaseClient();
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const rows = await fetchAll(() =>
    sb.from('cs_draft_judgments')
      .select('category, severity, draft_may_be_right, message_type, rationale, draft_id, created_at')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
  );
  const summary = summarizeVerdicts(rows);
  const flagged = rows.filter(r => r.draft_may_be_right).map(r => ({
    draft_id: r.draft_id, message_type: r.message_type, rationale: r.rationale,
  }));
  const highSeverity = rows.filter(r => r.severity === 'high').length;
  return { window_days: days, ...summary, draft_may_be_right: flagged.slice(0, 10), high_severity: highSeverity };
}

// Daily-sync task-runner shape (mirrors lib/advisorEditRate.run()).
async function run() {
  try {
    const judging = await judgeRecentDrafts({});
    const metrics = await computeJudgeMetrics({ days: 30 });
    return { sources: { closeness_judge: { ...metrics, today: judging } } };
  } catch (e) {
    return { sources: { closeness_judge: { skipped: true, error: e.message } } };
  }
}

module.exports = { run, judgeRecentDrafts, computeJudgeMetrics, summarizeVerdicts };
