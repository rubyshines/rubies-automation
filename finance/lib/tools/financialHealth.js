/**
 * MCP Tool: financial_health
 *
 * Dashboard-style KPIs + health grade.
 */

const { getSupabaseClient } = require('../../../shared/supabaseClient');
const { getQboClient } = require('../qbo');
const { parseReport } = require('../reportParser');
const { fmtCurrency, fmtPct, formatDate, sparkline } = require('./helpers');

async function handleFinancialHealth({ live }) {
  const supabase = getSupabaseClient();
  const now = new Date();
  const currentYear = now.getFullYear();
  const prevYear = currentYear - 1;

  // Fetch current YTD and prior year P&L + Balance Sheet
  const ytdEnd = formatDate(now);
  const ytdStart = `${currentYear}-01-01`;
  const prevStart = `${prevYear}-01-01`;
  const prevEnd = `${prevYear}-12-31`;

  let ytdPL, prevPL, bsSummary;

  if (!live) {
    const [ytdSnap, prevSnap, bsSnap] = await Promise.all([
      supabase.from('qbo_report_snapshots').select('summary').eq('report_type', 'ProfitAndLoss').eq('period_start', ytdStart).eq('period_end', ytdEnd).single(),
      supabase.from('qbo_report_snapshots').select('summary').eq('report_type', 'ProfitAndLoss').eq('period_start', prevStart).eq('period_end', prevEnd).single(),
      supabase.from('qbo_report_snapshots').select('summary').eq('report_type', 'BalanceSheet').order('period_end', { ascending: false }).limit(1).single(),
    ]);

    ytdPL = ytdSnap.data?.summary;
    prevPL = prevSnap.data?.summary;
    bsSummary = bsSnap.data?.summary;
  }

  if (!ytdPL) {
    const qbo = getQboClient();
    const raw = await qbo.getProfitAndLoss(ytdStart, ytdEnd);
    ytdPL = parseReport(raw).summary;
  }
  if (!bsSummary) {
    const qbo = getQboClient();
    const raw = await qbo.getBalanceSheet(ytdEnd);
    bsSummary = parseReport(raw).summary;
  }

  // Bank balances
  const { data: bankAccounts } = await supabase
    .from('qbo_accounts')
    .select('name, current_balance')
    .eq('account_type', 'Bank')
    .eq('active', true);

  const cashTotal = bankAccounts?.reduce((s, a) => s + (a.current_balance || 0), 0) || 0;

  // Monthly revenue trend (last 6 months)
  const sixMonthsAgo = new Date(now);
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
  const cutoff = `${sixMonthsAgo.getFullYear()}-${String(sixMonthsAgo.getMonth() + 1).padStart(2, '0')}-01`;

  const { data: monthlySnaps } = await supabase
    .from('qbo_report_snapshots')
    .select('period_start, summary')
    .eq('report_type', 'ProfitAndLoss')
    .gte('period_start', cutoff)
    .order('period_start', { ascending: true });

  const monthlyRevenues = (monthlySnaps || []).map(s => s.summary?.totalIncome).filter(v => v != null);
  const monthlyNetIncomes = (monthlySnaps || []).map(s => s.summary?.netIncome).filter(v => v != null);

  // Compute health score
  let healthScore = 0;
  const factors = [];

  // Gross margin (target: >50% for DTC ecommerce)
  const gm = ytdPL?.grossMarginPct;
  if (gm != null) {
    if (gm >= 0.60) { healthScore += 20; factors.push({ name: 'Gross Margin', score: 'A', detail: fmtPct(gm) }); }
    else if (gm >= 0.50) { healthScore += 15; factors.push({ name: 'Gross Margin', score: 'B', detail: fmtPct(gm) }); }
    else if (gm >= 0.40) { healthScore += 10; factors.push({ name: 'Gross Margin', score: 'C', detail: fmtPct(gm) }); }
    else { healthScore += 5; factors.push({ name: 'Gross Margin', score: 'D', detail: fmtPct(gm) }); }
  }

  // Net margin (target: >10% profitable)
  const nm = ytdPL?.netMarginPct;
  if (nm != null) {
    if (nm >= 0.15) { healthScore += 20; factors.push({ name: 'Net Margin', score: 'A', detail: fmtPct(nm) }); }
    else if (nm >= 0.05) { healthScore += 15; factors.push({ name: 'Net Margin', score: 'B', detail: fmtPct(nm) }); }
    else if (nm >= 0) { healthScore += 10; factors.push({ name: 'Net Margin', score: 'C', detail: fmtPct(nm) }); }
    else { healthScore += 5; factors.push({ name: 'Net Margin', score: 'D', detail: fmtPct(nm) }); }
  }

  // Current ratio (target: >1.5)
  const cr = bsSummary?.currentRatio;
  if (cr != null) {
    if (cr >= 2.0) { healthScore += 20; factors.push({ name: 'Current Ratio', score: 'A', detail: cr.toFixed(2) }); }
    else if (cr >= 1.5) { healthScore += 15; factors.push({ name: 'Current Ratio', score: 'B', detail: cr.toFixed(2) }); }
    else if (cr >= 1.0) { healthScore += 10; factors.push({ name: 'Current Ratio', score: 'C', detail: cr.toFixed(2) }); }
    else { healthScore += 5; factors.push({ name: 'Current Ratio', score: 'D', detail: cr.toFixed(2) }); }
  }

  // Revenue trend (growing MoM?)
  if (monthlyRevenues.length >= 3) {
    const recent = monthlyRevenues.slice(-3);
    const prior = monthlyRevenues.slice(-6, -3);
    if (prior.length >= 3) {
      const recentAvg = recent.reduce((a, b) => a + b, 0) / 3;
      const priorAvg = prior.reduce((a, b) => a + b, 0) / 3;
      const growth = priorAvg > 0 ? (recentAvg - priorAvg) / priorAvg : 0;
      if (growth >= 0.10) { healthScore += 20; factors.push({ name: 'Revenue Growth', score: 'A', detail: fmtPct(growth) + ' (3m vs prior 3m)' }); }
      else if (growth >= 0) { healthScore += 15; factors.push({ name: 'Revenue Growth', score: 'B', detail: fmtPct(growth) + ' (3m vs prior 3m)' }); }
      else if (growth >= -0.10) { healthScore += 10; factors.push({ name: 'Revenue Growth', score: 'C', detail: fmtPct(growth) + ' (3m vs prior 3m)' }); }
      else { healthScore += 5; factors.push({ name: 'Revenue Growth', score: 'D', detail: fmtPct(growth) + ' (3m vs prior 3m)' }); }
    }
  }

  // Cash position (is there >3 months of expenses?)
  if (cashTotal > 0 && monthlySnaps?.length) {
    const avgExpenses = (monthlySnaps || []).map(s => (s.summary?.totalExpenses || 0) + (s.summary?.costOfGoodsSold || 0));
    const avgExp = avgExpenses.length ? avgExpenses.reduce((a, b) => a + b, 0) / avgExpenses.length : 0;
    const cashMonths = avgExp > 0 ? cashTotal / avgExp : 99;
    if (cashMonths >= 6) { healthScore += 20; factors.push({ name: 'Cash Reserves', score: 'A', detail: `${cashMonths.toFixed(1)} months` }); }
    else if (cashMonths >= 3) { healthScore += 15; factors.push({ name: 'Cash Reserves', score: 'B', detail: `${cashMonths.toFixed(1)} months` }); }
    else if (cashMonths >= 1) { healthScore += 10; factors.push({ name: 'Cash Reserves', score: 'C', detail: `${cashMonths.toFixed(1)} months` }); }
    else { healthScore += 5; factors.push({ name: 'Cash Reserves', score: 'D', detail: `${cashMonths.toFixed(1)} months` }); }
  }

  const maxScore = factors.length * 20;
  const pct = maxScore > 0 ? healthScore / maxScore : 0;
  const grade = pct >= 0.85 ? 'A' : pct >= 0.70 ? 'B' : pct >= 0.55 ? 'C' : pct >= 0.40 ? 'D' : 'F';

  // Build output
  let md = `## Financial Health Dashboard\n`;
  md += `*As of ${formatDate(now)}*\n\n`;
  md += `### Overall Grade: **${grade}** (${healthScore}/${maxScore})\n\n`;

  md += '| Factor | Grade | Value |\n';
  md += '|--------|-------|-------|\n';
  for (const f of factors) {
    md += `| ${f.name} | ${f.score} | ${f.detail} |\n`;
  }

  // Key metrics
  md += '\n### Key Metrics\n\n';
  md += '| Metric | YTD | Prior Year |\n';
  md += '|--------|-----|------------|\n';
  md += `| Revenue | ${fmtCurrency(ytdPL?.totalIncome)} | ${fmtCurrency(prevPL?.totalIncome)} |\n`;
  md += `| Gross Profit | ${fmtCurrency(ytdPL?.grossProfit)} | ${fmtCurrency(prevPL?.grossProfit)} |\n`;
  md += `| Gross Margin | ${fmtPct(ytdPL?.grossMarginPct)} | ${fmtPct(prevPL?.grossMarginPct)} |\n`;
  md += `| Net Income | ${fmtCurrency(ytdPL?.netIncome)} | ${fmtCurrency(prevPL?.netIncome)} |\n`;
  md += `| Net Margin | ${fmtPct(ytdPL?.netMarginPct)} | ${fmtPct(prevPL?.netMarginPct)} |\n`;
  md += `| Cash Position | ${fmtCurrency(cashTotal)} | — |\n`;

  if (bsSummary) {
    md += `| Current Ratio | ${bsSummary.currentRatio?.toFixed(2) || 'N/A'} | — |\n`;
    md += `| Total Assets | ${fmtCurrency(bsSummary.totalAssets)} | — |\n`;
    md += `| Total Liabilities | ${fmtCurrency(bsSummary.totalLiabilities)} | — |\n`;
    md += `| Equity | ${fmtCurrency(bsSummary.totalEquity)} | — |\n`;
  }

  // Revenue sparkline
  if (monthlyRevenues.length >= 3) {
    md += `\n### 6-Month Revenue Trend\n${sparkline(monthlyRevenues)}\n`;
  }

  return { content: [{ type: 'text', text: md }] };
}

const tools = [
  {
    name: 'financial_health',
    description: 'Dashboard-style financial health assessment with letter grades. Scores gross margin, net margin, current ratio, revenue growth, and cash reserves. Shows YTD vs prior year comparison and revenue trend.',
    inputSchema: {
      type: 'object',
      properties: {
        live: {
          type: 'boolean',
          description: 'If true, fetch directly from QBO API (default: false)',
        },
      },
      required: [],
    },
    handler: handleFinancialHealth,
  },
];

module.exports = tools;
