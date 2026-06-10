/**
 * Monthly bill reconciliation (#1) — the ledger-vs-bill truth check.
 *
 * Pulls ACTUAL billed costs from the Anthropic Admin API
 * (/v1/organizations/cost_report) for the previous calendar month and compares
 * against our computed ai_calls ledger for the same window. Replaces the old
 * pricing-page scrape as the drift detector: we retrieve the bill, we don't
 * recompute it (caching mechanics make token-math an approximation — verified
 * May 2026: billed $260.34 vs ledger $273.91, +5%, all of it cache accounting).
 *
 * ALARMS (never silent): runs on the 1st; if the admin key is missing or the
 * API fails, that IS the finding and it surfaces loudly in the digest.
 * Requires ANTHROPIC_ADMIN_API_KEY (or ANTHROPIC_ADMIN_KEY) in the env —
 * an org-admin key, distinct from the production API key.
 */
const { getSupabaseClient } = require('../shared/supabaseClient');

const DELTA_ALARM_PCT = 12; // |ledger - bill| beyond this → investigate

function adminKey() {
  return process.env.ANTHROPIC_ADMIN_API_KEY || process.env.ANTHROPIC_ADMIN_KEY || null;
}

/** Previous calendar month [start, end) in UTC ISO. */
function previousMonthWindow(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return { startISO: start.toISOString(), endISO: end.toISOString(), label: start.toISOString().slice(0, 7) };
}

async function fetchBilledCosts(startISO, endISO) {
  const key = adminKey();
  if (!key) throw new Error('ANTHROPIC_ADMIN_API_KEY not set');
  const byModel = {};
  let total = 0;
  let page = null;
  for (;;) {
    const url = new URL('https://api.anthropic.com/v1/organizations/cost_report');
    url.searchParams.set('starting_at', startISO);
    url.searchParams.set('ending_at', endISO);
    url.searchParams.append('group_by[]', 'description');
    if (page) url.searchParams.set('page', page);
    const res = await fetch(url, { headers: { 'anthropic-version': '2023-06-01', 'x-api-key': key } });
    if (!res.ok) throw new Error(`cost_report HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    for (const bucket of (data.data || [])) {
      for (const r of (bucket.results || [])) {
        const usd = parseFloat(r.amount || '0') / 100; // cents → USD
        total += usd;
        const model = r.model || r.description || 'other';
        byModel[model] = (byModel[model] || 0) + usd;
      }
    }
    if (!data.has_more) break;
    page = data.next_page;
  }
  return { total, byModel };
}

async function ledgerTotal(startISO, endISO) {
  const sb = getSupabaseClient();
  let total = 0;
  let from = 0;
  for (;;) {
    const { data, error } = await sb.from('ai_calls')
      .select('cost_usd')
      .gte('created_at', startISO)
      .lt('created_at', endISO)
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    for (const r of data) total += Number(r.cost_usd || 0);
    if (data.length < 1000) break;
    from += 1000;
  }
  return total;
}

/** Pure: build the comparison verdict from the two totals. */
function buildVerdict({ billed, ledger, label }) {
  const delta = ledger - billed;
  const deltaPct = billed > 0 ? (delta / billed) * 100 : null;
  return {
    month: label,
    billed_usd: Math.round(billed * 100) / 100,
    ledger_usd: Math.round(ledger * 100) / 100,
    delta_usd: Math.round(delta * 100) / 100,
    delta_pct: deltaPct == null ? null : Math.round(deltaPct * 10) / 10,
    alarm: deltaPct != null && Math.abs(deltaPct) > DELTA_ALARM_PCT,
  };
}

async function reconcilePreviousMonth(now = new Date()) {
  const { startISO, endISO, label } = previousMonthWindow(now);
  const [{ total: billed, byModel }, ledger] = await Promise.all([
    fetchBilledCosts(startISO, endISO),
    ledgerTotal(startISO, endISO),
  ]);
  return { ...buildVerdict({ billed, ledger, label }), by_model: byModel };
}

// Daily-sync task shape. Runs the comparison on the 1st of each month; other
// days it's a no-op. A missing key or API failure is REPORTED, not swallowed.
async function run() {
  if (new Date().getUTCDate() !== 1) {
    return { sources: { bill_reconcile: { skipped: true, detail: 'runs on the 1st of the month' } } };
  }
  try {
    const verdict = await reconcilePreviousMonth();
    return { sources: { bill_reconcile: verdict } };
  } catch (e) {
    return { sources: { bill_reconcile: { failed: true, error: e.message, alarm: true } } };
  }
}

module.exports = { run, reconcilePreviousMonth, fetchBilledCosts, buildVerdict, previousMonthWindow, DELTA_ALARM_PCT };
