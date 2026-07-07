/**
 * MCP Tool: runway_projection
 *
 * Cash runway projection based on burn rate trends.
 */

const { getSupabaseClient } = require('../../../shared/supabaseClient');
const { getQboClient } = require('../qbo');
const { parseReport } = require('../reportParser');
const { fmtCurrency, fmtPct, formatDate } = require('./helpers');
const { filterMonthlySnapshots } = require('../monthlySnapshots');

async function handleRunwayProjection({ months_forward, scenario }) {
  const projMonths = months_forward || 6;
  const scenarioName = (scenario || 'baseline').toLowerCase();
  const supabase = getSupabaseClient();
  const now = new Date();

  // Get current cash position from Balance Sheet
  let cashPosition = null;

  const bsEnd = formatDate(now);
  const { data: bsSnap } = await supabase
    .from('qbo_report_snapshots')
    .select('summary')
    .eq('report_type', 'BalanceSheet')
    .order('period_end', { ascending: false })
    .limit(1)
    .single();

  if (bsSnap?.summary?.currentAssets != null) {
    // Use current assets as a proxy; ideally we'd isolate cash accounts
    cashPosition = bsSnap.summary.currentAssets;
  }

  // Also check bank account balances directly
  const { data: bankAccounts } = await supabase
    .from('qbo_accounts')
    .select('name, current_balance')
    .eq('account_type', 'Bank')
    .eq('active', true);

  let bankTotal = null;
  if (bankAccounts?.length) {
    bankTotal = bankAccounts.reduce((s, a) => s + (a.current_balance || 0), 0);
    cashPosition = bankTotal; // Use bank balances as more accurate cash position
  }

  // Get recent monthly P&L data for burn rate calculation
  const sixMonthsAgo = new Date(now);
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
  const cutoff = `${sixMonthsAgo.getFullYear()}-${String(sixMonthsAgo.getMonth() + 1).padStart(2, '0')}-01`;

  const { data: snapshots } = await supabase
    .from('qbo_report_snapshots')
    .select('period_start, period_end, summary')
    .eq('report_type', 'ProfitAndLoss')
    .gte('period_start', cutoff)
    .order('period_start', { ascending: true });

  // One row per calendar month (drops YTD/quarter spans + daily current-month dups).
  const monthly = filterMonthlySnapshots(snapshots);

  if (!monthly.length) {
    return { content: [{ type: 'text', text: 'Not enough P&L data for runway projection. Run `npm run finance-backfill` first.' }] };
  }

  // Calculate revenue and expense trends
  const revenues = monthly.map(s => s.summary?.totalIncome || 0);
  const expenses = monthly.map(s => (s.summary?.totalExpenses || 0) + (s.summary?.costOfGoodsSold || 0));
  const netIncomes = monthly.map(s => s.summary?.netIncome || 0);

  const avgRevenue3m = avg(revenues.slice(-3));
  const avgRevenue6m = avg(revenues);
  const avgExpenses3m = avg(expenses.slice(-3));
  const avgExpenses6m = avg(expenses);
  const avgNet3m = avg(netIncomes.slice(-3));
  const avgNet6m = avg(netIncomes);

  // Scenario multipliers
  const scenarios = {
    optimistic: { revMult: 1.10, expMult: 1.00, label: 'Optimistic (revenue +10%, expenses flat)' },
    baseline: { revMult: 1.00, expMult: 1.00, label: 'Baseline (current trends)' },
    conservative: { revMult: 0.90, expMult: 1.05, label: 'Conservative (revenue -10%, expenses +5%)' },
  };

  let md = `## Runway Projection\n\n`;

  // Current position
  md += '### Current Position\n\n';
  md += '| Metric | Amount |\n';
  md += '|--------|--------|\n';

  if (bankAccounts?.length) {
    for (const ba of bankAccounts) {
      md += `| ${ba.name} | ${fmtCurrency(ba.current_balance)} |\n`;
    }
    md += `| **Total Cash** | **${fmtCurrency(bankTotal)}** |\n`;
  } else if (cashPosition != null) {
    md += `| Cash (estimated from current assets) | ${fmtCurrency(cashPosition)} |\n`;
  }

  md += `| Avg Monthly Revenue (3m) | ${fmtCurrency(avgRevenue3m)} |\n`;
  md += `| Avg Monthly Expenses (3m) | ${fmtCurrency(avgExpenses3m)} |\n`;
  md += `| Avg Monthly Net (3m) | ${fmtCurrency(avgNet3m)} |\n`;
  md += `| Avg Monthly Net (6m) | ${fmtCurrency(avgNet6m)} |\n`;

  // Monthly burn rate (negative net = burning cash)
  const burnRate = -avgNet3m; // positive = burning, negative = generating
  if (burnRate > 0) {
    md += `| **Monthly Burn Rate** | **${fmtCurrency(burnRate)}** |\n`;
    if (cashPosition != null && cashPosition > 0) {
      const months = cashPosition / burnRate;
      md += `| **Runway (at current rate)** | **${months.toFixed(1)} months** |\n`;
    }
  } else {
    md += `| **Monthly Cash Generation** | **${fmtCurrency(Math.abs(burnRate))}** |\n`;
    md += `| Runway | **Profitable** — generating cash |\n`;
  }

  // Project all three scenarios
  md += '\n### Projections\n\n';

  const scenarioKeys = scenarioName === 'all' ? ['optimistic', 'baseline', 'conservative'] : [scenarioName];

  for (const key of scenarioKeys) {
    const s = scenarios[key] || scenarios.baseline;
    md += `#### ${s.label}\n\n`;
    md += '| Month | Revenue | Expenses | Net | Cash Balance |\n';
    md += '|-------|---------|----------|-----|-------------|\n';

    let cash = cashPosition || 0;
    let criticalMonth = null;

    for (let m = 1; m <= projMonths; m++) {
      const projDate = new Date(now);
      projDate.setMonth(projDate.getMonth() + m);
      const monthLabel = `${projDate.getFullYear()}-${String(projDate.getMonth() + 1).padStart(2, '0')}`;

      const rev = avgRevenue3m * s.revMult;
      const exp = avgExpenses3m * s.expMult;
      const net = rev - exp;
      cash += net;

      md += `| ${monthLabel} | ${fmtCurrency(rev)} | ${fmtCurrency(exp)} | ${fmtCurrency(net)} | ${fmtCurrency(cash)} |\n`;

      if (cash <= 0 && !criticalMonth) {
        criticalMonth = monthLabel;
      }
    }

    if (criticalMonth) {
      md += `\n**Warning: Cash runs out by ${criticalMonth}**\n\n`;
    } else if (cashPosition != null && burnRate > 0) {
      md += `\nCash remains positive through projection period.\n\n`;
    }
  }

  return { content: [{ type: 'text', text: md }] };
}

function avg(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

const tools = [
  {
    name: 'runway_projection',
    description: 'Project cash runway based on recent burn rate trends. Shows current cash position, monthly burn rate, and forward projections under different scenarios (optimistic, baseline, conservative).',
    inputSchema: {
      type: 'object',
      properties: {
        months_forward: {
          type: 'number',
          description: 'How many months to project forward (default: 6)',
        },
        scenario: {
          type: 'string',
          description: '"optimistic", "baseline" (default), "conservative", or "all" to show all three',
        },
      },
      required: [],
    },
    handler: handleRunwayProjection,
  },
];

module.exports = tools;
