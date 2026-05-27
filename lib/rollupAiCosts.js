/**
 * rollupAiCosts.js — aggregate one day of ai_calls into ai_costs_daily.
 *
 * Run from daily-sync-all.js (rolls up yesterday). Idempotent: deletes the
 * target day's ai_costs_daily rows then re-inserts, so a re-run for the same
 * date produces the same result. Aggregation is keyed by (date, component,
 * model_id) — the ai_costs_daily primary key.
 *
 * Fail-soft: if ai_calls (or ai_costs_daily) doesn't exist yet, returns a
 * skipped result rather than throwing — the daily sync must not fail because
 * the observability tables haven't been created.
 *
 *   const { rollupAiCosts, run } = require('./lib/rollupAiCosts');
 *   await rollupAiCosts('2026-05-26');   // explicit date
 *   await run();                          // pipeline entry: rolls up yesterday
 *
 * Returns a daily-sync-style result:
 *   { sources: { ai_costs: { success, rowsWritten, detail, breakdown } }, status }
 * where breakdown is [{ component, calls, cost_usd, ... }] sorted by cost desc.
 */

const { getSupabaseClient } = require('../shared/supabaseClient');

function yesterdayDate() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

function percentile(sortedNums, p) {
  if (!sortedNums.length) return null;
  const idx = Math.min(sortedNums.length - 1, Math.ceil((p / 100) * sortedNums.length) - 1);
  return sortedNums[Math.max(0, idx)];
}

async function tableExists(supabase, table) {
  try {
    const { error } = await supabase.from(table).select('*').limit(0);
    return !error;
  } catch (_) {
    return false;
  }
}

async function pageAllForDay(supabase, date) {
  const start = `${date}T00:00:00.000Z`;
  const end = `${date}T23:59:59.999Z`;
  const out = [];
  let from = 0;
  const PAGE = 1000;
  for (;;) {
    const { data, error } = await supabase
      .from('ai_calls')
      .select('component, model_id, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, duration_ms, cost_usd, error')
      .gte('created_at', start)
      .lte('created_at', end)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    out.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

/**
 * Aggregate ai_calls for a given date into ai_costs_daily.
 * @param {string} date — YYYY-MM-DD (UTC day)
 */
async function rollupAiCosts(date) {
  const supabase = getSupabaseClient();

  if (!(await tableExists(supabase, 'ai_calls')) || !(await tableExists(supabase, 'ai_costs_daily'))) {
    return {
      sources: { ai_costs: { success: true, rowsWritten: 0, skipped: true, detail: 'ai_calls/ai_costs_daily not created yet', breakdown: [] } },
      status: 'ok',
    };
  }

  const calls = await pageAllForDay(supabase, date);

  // Group by (component, model_id).
  const groups = new Map();
  for (const c of calls) {
    const key = `${c.component} ${c.model_id}`;
    if (!groups.has(key)) {
      groups.set(key, {
        date,
        component: c.component,
        model_id: c.model_id,
        call_count: 0,
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_cache_read_tokens: 0,
        total_cache_create_tokens: 0,
        total_cost_usd: 0,
        _durations: [],
        error_count: 0,
      });
    }
    const g = groups.get(key);
    g.call_count += 1;
    g.total_input_tokens += c.input_tokens || 0;
    g.total_output_tokens += c.output_tokens || 0;
    g.total_cache_read_tokens += c.cache_read_tokens || 0;
    g.total_cache_create_tokens += c.cache_creation_tokens || 0;
    g.total_cost_usd += Number(c.cost_usd) || 0;
    if (typeof c.duration_ms === 'number') g._durations.push(c.duration_ms);
    if (c.error) g.error_count += 1;
  }

  const rows = [...groups.values()].map((g) => {
    const durs = g._durations.slice().sort((a, b) => a - b);
    const avg = durs.length ? Math.round(durs.reduce((s, d) => s + d, 0) / durs.length) : 0;
    return {
      date: g.date,
      component: g.component,
      model_id: g.model_id,
      call_count: g.call_count,
      total_input_tokens: g.total_input_tokens,
      total_output_tokens: g.total_output_tokens,
      total_cache_read_tokens: g.total_cache_read_tokens,
      total_cache_create_tokens: g.total_cache_create_tokens,
      total_cost_usd: Math.round(g.total_cost_usd * 10000) / 10000,
      avg_duration_ms: avg,
      p95_duration_ms: percentile(durs, 95),
      error_count: g.error_count,
    };
  });

  // Idempotent: delete the day's rows, then insert. ai_costs_daily has a
  // composite PK (date, component, model_id) and this rollup is a single
  // serial step in the daily sync, so delete+insert is safe here.
  const { error: delErr } = await supabase.from('ai_costs_daily').delete().eq('date', date);
  if (delErr) throw delErr;

  if (rows.length) {
    const { error: insErr } = await supabase.from('ai_costs_daily').insert(rows);
    if (insErr) throw insErr;
  }

  // Per-component breakdown for the email (collapse models within a component).
  const byComponent = new Map();
  for (const r of rows) {
    if (!byComponent.has(r.component)) byComponent.set(r.component, { component: r.component, calls: 0, cost_usd: 0, errors: 0 });
    const b = byComponent.get(r.component);
    b.calls += r.call_count;
    b.cost_usd += r.total_cost_usd;
    b.errors += r.error_count;
  }
  const breakdown = [...byComponent.values()]
    .map((b) => ({ ...b, cost_usd: Math.round(b.cost_usd * 10000) / 10000 }))
    .sort((a, b) => b.cost_usd - a.cost_usd);

  const totalCost = breakdown.reduce((s, b) => s + b.cost_usd, 0);
  const totalCalls = breakdown.reduce((s, b) => s + b.calls, 0);

  return {
    sources: {
      ai_costs: {
        success: true,
        rowsWritten: rows.length,
        detail: `${totalCalls} calls, $${totalCost.toFixed(4)} across ${breakdown.length} components`,
        breakdown,
        date,
        total_cost_usd: Math.round(totalCost * 10000) / 10000,
        total_calls: totalCalls,
      },
    },
    status: 'ok',
  };
}

// Pipeline entry point — rolls up yesterday, then attaches month-to-date
// spend-cap status for the early-warning line in the daily summary.
async function run() {
  const result = await rollupAiCosts(yesterdayDate());
  try {
    const { getSpendCapStatus } = require('./aiSpendCap');
    const cap = await getSpendCapStatus();
    if (result?.sources?.ai_costs) result.sources.ai_costs.spend_cap = cap;
  } catch (_) { /* fail-soft — the spend-cap line must never break the daily sync */ }
  return result;
}

module.exports = { rollupAiCosts, run, yesterdayDate };
