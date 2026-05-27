/**
 * aiSpendCap.js — month-to-date AI spend tracking + early-warning against a cap.
 *
 * Motivation: on 2026-05-22 the org's Anthropic monthly spend limit tripped
 * silently and halted ALL Claude calls (CS advisor, operator, intake, Gmail) —
 * discovered only after the fact via dropped messages. Now that every AI call
 * lands in `ai_calls` with a real cost, we can compute our own month-to-date
 * spend and warn in the daily summary BEFORE the cap is hit.
 *
 * Cap is configured via env `AI_MONTHLY_CAP_USD` (set it to match the Anthropic
 * org spend limit). With no cap set, we still surface MTD spend for visibility.
 *
 * Fail-soft: a missing `ai_calls` table or read error returns null MTD — the
 * daily sync must never fail because of this check.
 */

const { getSupabaseClient } = require('../shared/supabaseClient');

function startOfUtcMonth(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

// Pure: given month-to-date spend and an optional cap, classify the status.
// Returns { level, mtd_usd, cap_usd, pct, warn_pct }.
//   level: 'no_cap' | 'ok' | 'warn' | 'over'
function evaluateSpendCap({ mtdUsd, capUsd, warnPct = 0.8 }) {
  const mtd = Math.round((Number(mtdUsd) || 0) * 100) / 100;
  if (!capUsd || !(capUsd > 0)) {
    return { level: 'no_cap', mtd_usd: mtd, cap_usd: null, pct: null, warn_pct: warnPct };
  }
  const pct = mtd / capUsd;
  let level = 'ok';
  if (pct >= 1) level = 'over';
  else if (pct >= warnPct) level = 'warn';
  return { level, mtd_usd: mtd, cap_usd: capUsd, pct: Math.round(pct * 1000) / 1000, warn_pct: warnPct };
}

async function tableExists(supabase, table) {
  try {
    const { error } = await supabase.from(table).select('*').limit(0);
    return !error;
  } catch (_) {
    return false;
  }
}

// Sum cost_usd across ai_calls for the current UTC month. Returns null if the
// table is absent or unreadable (fail-soft).
async function monthToDateSpendUsd(supabase = getSupabaseClient(), now = new Date()) {
  if (!(await tableExists(supabase, 'ai_calls'))) return null;
  const since = startOfUtcMonth(now);
  let from = 0;
  const PAGE = 1000;
  let total = 0;
  try {
    for (;;) {
      const { data, error } = await supabase
        .from('ai_calls')
        .select('cost_usd')
        .gte('created_at', since)
        .order('id', { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) return null;
      for (const r of data) total += Number(r.cost_usd) || 0;
      if (data.length < PAGE) break;
      from += PAGE;
    }
  } catch (_) {
    return null;
  }
  return Math.round(total * 10000) / 10000;
}

// Read cap from env. Returns a positive number or null.
function configuredCapUsd(env = process.env) {
  const v = Number(env.AI_MONTHLY_CAP_USD);
  return v > 0 ? v : null;
}

// Full status for the daily summary. Fail-soft: returns { available:false } when
// MTD can't be computed (table absent), so the email simply omits the line.
async function getSpendCapStatus({ supabase = getSupabaseClient(), now = new Date(), env = process.env } = {}) {
  const mtd = await monthToDateSpendUsd(supabase, now);
  if (mtd === null) return { available: false };
  const status = evaluateSpendCap({ mtdUsd: mtd, capUsd: configuredCapUsd(env) });
  return { available: true, ...status };
}

module.exports = { evaluateSpendCap, monthToDateSpendUsd, configuredCapUsd, getSpendCapStatus, startOfUtcMonth };
