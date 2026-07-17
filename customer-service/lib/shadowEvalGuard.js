// Self-guard for the shadow model eval (cs_diagnostics flag).
//
// Why this exists: the 2026-07 Sonnet 5 eval collected invalid advisor data for
// 7 days (~$34) before anyone looked — a harness bug left the candidate with no
// instructed output shape, so sonnet_structured was null on every row and the
// judge scored ~90% of drafts a 1. Both tells were detectable within the first
// hour. This guard runs after every shadow-run insert and auto-kills the flag
// (plus emails Jamie) when the accumulating data is degenerate, so a broken
// harness costs one day at most, not a week.
//
// Kill rules (checked against rows inserted since the flag was last enabled):
//   1. Advisor rows only: sonnet_structured null on ≥80% of ≥10 runs.
//      Occasional parse failures are normal; a near-total null rate means the
//      candidate was never told what shape to emit (harness bug, not model
//      signal). Operator rows are exempt — they store sonnet_structured: null
//      by design.
//   2. Either source: ≥20 judge-scored runs with zero scores ≥3. Even the
//      plain-Sonnet-4.6 baseline (mean 2.37) scored 3 on 61% of runs — a
//      candidate losing 100% of 20+ comparisons means either the harness is
//      rigged or the model is so unviable that continuing to pay is pointless.
//      Both conclusions mean: stop now.
//
// Fail-soft everywhere — a guard error must never affect the production draft.

const FLAG_KEY = 'cs_diagnostics';
const NULL_STRUCTURED_MIN_RUNS = 10;
const NULL_STRUCTURED_KILL_RATE = 0.8;
const DEGENERATE_MIN_SCORED_RUNS = 20;
const ALERT_EMAIL = 'jamie@rubyshines.com';

// Pure decision function — rows: [{ source, sonnet_structured, judge_result }].
function evaluateShadowHealth(rows) {
  const stats = { total: rows.length, advisor: 0, advisorNullStructured: 0, scoredBySource: {} };

  for (const r of rows) {
    if (r.source === 'advisor') {
      stats.advisor++;
      if (r.sonnet_structured == null) stats.advisorNullStructured++;
    }
    const score = r.judge_result?.score;
    if (typeof score === 'number') {
      const s = (stats.scoredBySource[r.source] = stats.scoredBySource[r.source] || { scored: 0, atOrAboveBaseline: 0 });
      s.scored++;
      if (score >= 3) s.atOrAboveBaseline++;
    }
  }

  if (stats.advisor >= NULL_STRUCTURED_MIN_RUNS) {
    const nullRate = stats.advisorNullStructured / stats.advisor;
    if (nullRate >= NULL_STRUCTURED_KILL_RATE) {
      return {
        kill: true,
        stats,
        reason: `candidate structured output is null on ${stats.advisorNullStructured}/${stats.advisor} advisor runs (${Math.round(nullRate * 100)}%) — harness bug, not model signal`,
      };
    }
  }

  for (const [source, s] of Object.entries(stats.scoredBySource)) {
    if (s.scored >= DEGENERATE_MIN_SCORED_RUNS && s.atOrAboveBaseline === 0) {
      return {
        kill: true,
        stats,
        reason: `degenerate judge distribution on ${source}: 0 of ${s.scored} scored runs rated ≥3 (tied with production) — harness bug or decisively non-viable candidate`,
      };
    }
  }

  return { kill: false, stats, reason: null };
}

// Impure wrapper: reads rows since the flag was last enabled, kills + alerts on
// a degenerate verdict. Called after each shadow-run insert (~30/day — the
// extra reads are negligible next to the eval's own API cost).
async function checkShadowEvalHealth() {
  const { getSupabaseClient } = require('../../shared/supabaseClient');
  const { setFlag } = require('../../shared/systemFlags');
  const sb = getSupabaseClient();

  const { data: flagRow, error: flagErr } = await sb
    .from('system_flags')
    .select('enabled, updated_at')
    .eq('key', FLAG_KEY)
    .maybeSingle();
  if (flagErr || !flagRow?.enabled || !flagRow.updated_at) return { kill: false, skipped: true };

  const rows = [];
  let from = 0;
  while (true) {
    const { data, error } = await sb
      .from('cs_diagnostic_runs')
      .select('source, sonnet_structured, judge_result')
      .gte('created_at', flagRow.updated_at)
      .order('created_at', { ascending: true })
      .range(from, from + 999);
    if (error) return { kill: false, skipped: true };
    rows.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }

  const verdict = evaluateShadowHealth(rows);
  if (!verdict.kill) return verdict;

  await setFlag(FLAG_KEY, false, `AUTO-KILLED ${new Date().toISOString().slice(0, 10)} by shadowEvalGuard: ${verdict.reason}`);

  try {
    const { sendEmail } = require('../../shared/sendgridClient');
    await sendEmail({
      to: ALERT_EMAIL,
      fromName: 'RUBIES Ops',
      subject: 'Shadow eval auto-killed — degenerate data detected',
      text:
        `The ${FLAG_KEY} shadow eval was automatically disabled.\n\n` +
        `Reason: ${verdict.reason}\n\n` +
        `Rows since flag enable (${flagRow.updated_at}): ${verdict.stats.total}\n\n` +
        `The eval data collected in this window is suspect — inspect cs_diagnostic_runs ` +
        `(node scripts/analyze-shadow-runs.js --since ${flagRow.updated_at}) and fix the ` +
        `harness before re-enabling. See project_cs_efficiency.md for the 2026-07 incident this guard exists for.`,
    });
  } catch (err) {
    console.warn('[shadow-guard] kill alert email failed:', err.message);
  }

  console.warn(`[shadow-guard] AUTO-KILLED ${FLAG_KEY}: ${verdict.reason}`);
  return verdict;
}

module.exports = { evaluateShadowHealth, checkShadowEvalHealth };
