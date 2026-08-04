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
const { getSupabaseClient, fetchAllPaginated } = require('../shared/supabaseClient');

const DAILY_CAP = 30; // ~6 tickets/day normally; cap is a runaway guard

/**
 * Dedupe threshold: share of meaningful words two facts must have in common
 * before the newer one is treated as already queued. 0.45 was picked against
 * the real backlog — it collapses the nine variants of "returns are donated
 * rather than shipped back" while keeping genuinely distinct facts apart.
 */
// Calibrated against the real backlog. This is deliberately a PARTIAL fix:
// word overlap cannot fully separate these, because two of the duplicate
// donation facts share almost no vocabulary ("all returns are donated" vs
// "does not require customers to physically return items") and score the same
// as genuinely distinct pairs. So the threshold is set where it never merges
// two different facts, accepting that it catches most duplicates rather than
// all — collapsing nine donation variants to about three instead of one.
// Wrongly merging a real fact loses information permanently; leaving a
// duplicate in the queue only costs the reviewer a second's read. If the
// queue still drowns, the next step is embedding similarity (the Voyage
// pipeline already exists for the KB), not a higher threshold here.
const FACT_DUPE_THRESHOLD = 0.35;

// Only true function words. An earlier version also stripped 'returns',
// 'items' and 'customers' as noise — which deleted precisely the words that
// made the duplicate donation facts recognisable as duplicates.
const STOP = new Set(['that', 'this', 'with', 'from', 'they', 'their', 'them', 'have', 'been',
  'will', 'when', 'than', 'rather', 'into', 'onto', 'over', 'such', 'were', 'where', 'which',
  'while', 'would', 'could', 'should', 'also', 'other', 'some', 'each', 'both', 'more', 'most']);

/**
 * Crude suffix stripping so returns/returned/return and donate/donated/donating
 * count as the same word. A real stemmer is overkill for one-sentence facts,
 * and the failure mode we care about is missing a duplicate, not merging two
 * distinct ones — the reviewer sees both either way.
 */
function stem(w) {
  return w.replace(/(ations?|ing|ed|es|s)$/, '');
}

/** Meaningful words of a fact, for similarity comparison. */
function factTokens(s) {
  return new Set(
    normalizeFact(s).split(' ')
      .filter(w => w.length > 3 && !STOP.has(w))
      .map(stem)
      .filter(w => w.length > 2)
  );
}

/** Jaccard overlap of two facts' meaningful words. */
function factSimilarity(a, b) {
  const A = factTokens(a), B = factTokens(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / (A.size + B.size - shared);
}

/** Normalize a fact for dedupe: lowercase, alphanumerics + spaces only. */
function normalizeFact(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Queue a judge-proposed fact as a pending advisor_facts row, unless a
 * similar fact already exists in ANY status (rejected facts must not
 * re-queue every day). Fail-soft: fact capture never breaks judging.
 */
async function queueCandidateFact(sb, verdict, draft, existingNormalized) {
  try {
    const norm = normalizeFact(verdict.candidate_fact);
    if (!norm || norm.length < 10) return false;
    // Substring matching only caught verbatim repeats, so the judge queued the
    // same fact once per rephrasing: nine variants of "returns are donated
    // rather than shipped back" reached the pending queue between July and
    // August. That noise is why the queue stopped being reviewed — and a fact
    // queue nobody reviews is the same as not having one, on the defect
    // cluster (operator-only knowledge) that is the largest we have.
    for (const existing of existingNormalized) {
      if (existing === norm || existing.includes(norm) || norm.includes(existing)) return false;
      if (factSimilarity(existing, norm) >= FACT_DUPE_THRESHOLD) return false;
    }
    const { error } = await sb.from('advisor_facts').insert({
      fact: verdict.candidate_fact,
      status: 'pending',
      source: 'judge',
      source_draft_id: draft.id,
      source_rationale: verdict.rationale,
    });
    if (error) throw new Error(error.message);
    existingNormalized.push(norm);
    return true;
  } catch (e) {
    console.warn('[judgeDaily] candidate fact queue failed:', e.message);
    return false;
  }
}

async function judgeRecentDrafts({ days = 3, cap = DAILY_CAP } = {}) {
  const { judgeDraftVsSent } = require('../customer-service/lib/closenessJudge');
  const sb = getSupabaseClient();
  const since = new Date(Date.now() - days * 86400000).toISOString();

  const drafts = await fetchAllPaginated(() =>
    sb.from('cs_ai_drafts')
      .select('id, gorgias_ticket_id, draft_response, sent_response, message_type, conversation_history, sent_at')
      .eq('status', 'sent')
      .eq('draft_kind', 'advisor_draft')
      // draft_kind alone lets through rows the advisor never wrote:
      // 'operator_reply' (Jamie composing from scratch, stored into BOTH
      // draft_response and sent_response so it always judges IDENTICAL) and
      // 'simulator' test traffic. 43 of 1462 judged verdicts were affected.
      .in('source', ['poller', 'operator_outreach'])
      .gte('sent_at', since)
      .not('sent_response', 'is', null)
      .neq('draft_response', '')
      .order('sent_at', { ascending: false })
  );
  if (!drafts.length) return { judged: 0, failed: 0 };

  const existing = await fetchAllPaginated(() =>
    sb.from('cs_draft_judgments').select('draft_id').in('draft_id', drafts.map(d => d.id)).order('id')
  );
  const done = new Set(existing.map(r => r.draft_id));
  const pending = drafts.filter(d => !done.has(d.id)).slice(0, cap);

  // Existing facts (any status) for dedupe — fail-soft if the table is absent.
  let existingNormalized = [];
  try {
    const factRows = await fetchAllPaginated(() =>
      sb.from('advisor_facts').select('fact').order('id')
    );
    existingNormalized = factRows.map(r => normalizeFact(r.fact));
  } catch (e) { /* table may not exist yet — facts just won't queue */ }

  let judged = 0, failed = 0, factsQueued = 0;
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
      if (v.candidate_fact) {
        const queued = await queueCandidateFact(sb, v, d, existingNormalized);
        if (queued) factsQueued++;
      }
    } catch (e) {
      failed++;
    }
  }
  return { judged, failed, facts_queued: factsQueued, pending_beyond_cap: Math.max(0, drafts.length - done.size - cap) };
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
  const rows = await fetchAllPaginated(() =>
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
    return { sources: { closeness_judge: { ...metrics, today: judging } }, status: 'ok' };
  } catch (e) {
    // Non-critical reporting task — degrade to a warning, don't fail the sync.
    return { sources: { closeness_judge: { skipped: true, error: e.message } }, status: 'warning' };
  }
}

module.exports = { run, judgeRecentDrafts, computeJudgeMetrics, summarizeVerdicts, normalizeFact, factSimilarity, FACT_DUPE_THRESHOLD };
