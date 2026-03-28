/**
 * MCP Tool: trend_analysis
 *
 * Year-over-year or month-over-month trends for any metric or account.
 * "How have travel expenses tracked over 2 years?"
 */

const { getSupabaseClient } = require('../../../shared/supabaseClient');
const { fmtCurrency, fmtPct, fmtDelta, sparkline } = require('./helpers');

async function handleTrendAnalysis({ metric, months, granularity }) {
  const numMonths = months || 12;
  const gran = (granularity || 'monthly').toLowerCase();
  const supabase = getSupabaseClient();

  const metricLower = (metric || '').toLowerCase();
  let dataPoints = [];
  let metricLabel = metric;

  // Check if it's a standard P&L metric we can pull from report snapshots
  const standardMetrics = {
    'revenue': 'totalIncome',
    'income': 'totalIncome',
    'cogs': 'costOfGoodsSold',
    'cost of goods': 'costOfGoodsSold',
    'gross profit': 'grossProfit',
    'gross margin': 'grossMarginPct',
    'expenses': 'totalExpenses',
    'operating expenses': 'totalExpenses',
    'net income': 'netIncome',
    'net profit': 'netIncome',
    'net margin': 'netMarginPct',
    'operating income': 'netOperatingIncome',
  };

  const summaryKey = Object.entries(standardMetrics).find(([k]) => metricLower.includes(k))?.[1];
  const isPercentage = summaryKey?.includes('Pct');

  if (summaryKey) {
    // Pull from monthly P&L snapshots
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - numMonths);
    const cutoffStr = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, '0')}-01`;

    const { data: snapshots } = await supabase
      .from('qbo_report_snapshots')
      .select('period_start, period_end, summary')
      .eq('report_type', 'ProfitAndLoss')
      .gte('period_start', cutoffStr)
      .order('period_start', { ascending: true });

    if (snapshots?.length) {
      // Filter to monthly snapshots (start and end in same month)
      const monthly = snapshots.filter(s => {
        const start = new Date(s.period_start);
        const end = new Date(s.period_end);
        return start.getMonth() === end.getMonth() && start.getFullYear() === end.getFullYear();
      });

      dataPoints = monthly.map(s => ({
        period: s.period_start.slice(0, 7),
        value: s.summary?.[summaryKey] ?? null,
      }));
    }
  } else {
    // Try as an account name — use get_account_trend RPC
    const { data: trend } = await supabase
      .rpc('get_account_trend', {
        p_account_name: metric,
        p_months: numMonths,
      });

    if (trend?.length) {
      dataPoints = trend.map(t => ({
        period: String(t.month).slice(0, 7),
        value: parseFloat(t.total),
        txnCount: parseInt(t.txn_count, 10),
      }));
      metricLabel = metric;
    }
  }

  if (!dataPoints.length) {
    return { content: [{ type: 'text', text: `No trend data found for "${metric}" over ${numMonths} months. Try a P&L metric (revenue, expenses, net income, gross margin) or an account name (travel, advertising, etc.).` }] };
  }

  // Aggregate to quarterly if requested
  if (gran === 'quarterly') {
    const quarters = {};
    for (const dp of dataPoints) {
      const [y, m] = dp.period.split('-').map(Number);
      const q = Math.ceil(m / 3);
      const key = `${y}-Q${q}`;
      if (!quarters[key]) quarters[key] = { period: key, values: [] };
      quarters[key].values.push(dp.value);
    }
    dataPoints = Object.values(quarters).map(q => ({
      period: q.period,
      value: q.values.reduce((a, b) => (a || 0) + (b || 0), 0),
    }));
  }

  // Build output
  let md = `## Trend: ${metricLabel}\n`;
  md += `*${numMonths} months, ${gran}*\n\n`;

  // Sparkline
  const values = dataPoints.map(d => d.value).filter(v => v != null);
  if (values.length >= 3) {
    md += `${sparkline(values)}\n\n`;
  }

  md += `| Period | Value | Change |\n`;
  md += `|--------|-------|--------|\n`;

  let prevValue = null;
  for (const dp of dataPoints) {
    const formatted = isPercentage ? fmtPct(dp.value) : fmtCurrency(dp.value);
    let changeStr = '—';
    if (prevValue != null && dp.value != null) {
      if (isPercentage) {
        const ppChange = dp.value - prevValue;
        changeStr = `${ppChange >= 0 ? '+' : ''}${(ppChange * 100).toFixed(1)}pp`;
      } else {
        const delta = fmtDelta(dp.value, prevValue);
        changeStr = `${delta.dollar} (${delta.pct})`;
      }
    }
    md += `| ${dp.period} | ${formatted} | ${changeStr} |\n`;
    prevValue = dp.value;
  }

  // YoY comparison if we have 12+ months
  if (dataPoints.length >= 12 && !isPercentage) {
    const recent = dataPoints.slice(-6);
    const prior = dataPoints.slice(-12, -6);
    const recentSum = recent.reduce((s, d) => s + (d.value || 0), 0);
    const priorSum = prior.reduce((s, d) => s + (d.value || 0), 0);
    const yoyDelta = fmtDelta(recentSum, priorSum);
    md += `\n**6-month YoY**: ${fmtCurrency(priorSum)} → ${fmtCurrency(recentSum)} (${yoyDelta.pct})`;
  }

  // Summary stats
  const nonNull = values.filter(v => v != null);
  if (nonNull.length >= 2) {
    const avg = nonNull.reduce((a, b) => a + b, 0) / nonNull.length;
    const min = Math.min(...nonNull);
    const max = Math.max(...nonNull);
    md += `\n\n**Avg**: ${isPercentage ? fmtPct(avg) : fmtCurrency(avg)} | **Min**: ${isPercentage ? fmtPct(min) : fmtCurrency(min)} | **Max**: ${isPercentage ? fmtPct(max) : fmtCurrency(max)}`;
  }

  return { content: [{ type: 'text', text: md }] };
}

const tools = [
  {
    name: 'trend_analysis',
    description: 'Show trends over time for any financial metric or account. Supports P&L metrics (revenue, expenses, net income, gross margin, net margin) and specific accounts (travel, advertising, shipping, etc.).',
    inputSchema: {
      type: 'object',
      properties: {
        metric: {
          type: 'string',
          description: 'What to trend — a P&L metric (revenue, net income, gross margin) or account name (travel, advertising)',
        },
        months: {
          type: 'number',
          description: 'How many months of history (default: 12)',
        },
        granularity: {
          type: 'string',
          description: '"monthly" or "quarterly" (default: monthly)',
        },
      },
      required: ['metric'],
    },
    handler: handleTrendAnalysis,
  },
];

module.exports = tools;
