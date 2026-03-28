/**
 * MCP Tool: financial_summary
 *
 * P&L overview for any period. "How did we do this quarter?"
 */

const { getSupabaseClient } = require('../../../shared/supabaseClient');
const { getQboClient } = require('../qbo');
const { parseReport, flattenRows, getSectionByName } = require('../reportParser');
const { parsePeriod, fmtCurrency, fmtPct } = require('./helpers');

async function handleFinancialSummary({ period, live }) {
  const { startDate, endDate, label } = parsePeriod(period);
  const supabase = getSupabaseClient();

  let summary, rows;

  if (!live) {
    // Try Supabase snapshot first
    const { data } = await supabase
      .from('qbo_report_snapshots')
      .select('summary, report_data')
      .eq('report_type', 'ProfitAndLoss')
      .eq('period_start', startDate)
      .eq('period_end', endDate)
      .single();

    if (data) {
      summary = data.summary;
      rows = data.report_data;
    }
  }

  if (!summary) {
    // Fetch live from QBO
    const qbo = getQboClient();
    const raw = await qbo.getProfitAndLoss(startDate, endDate);
    const parsed = parseReport(raw);
    summary = parsed.summary;
    rows = parsed.rows;
  }

  if (!summary || !Object.keys(summary).length) {
    return { content: [{ type: 'text', text: `No P&L data found for ${label}.` }] };
  }

  // Build output
  let md = `## Financial Summary: ${label}\n\n`;

  md += '| Metric | Amount |\n';
  md += '|--------|--------|\n';
  md += `| Revenue | ${fmtCurrency(summary.totalIncome)} |\n`;

  if (summary.costOfGoodsSold != null) {
    md += `| Cost of Goods Sold | ${fmtCurrency(summary.costOfGoodsSold)} |\n`;
    md += `| **Gross Profit** | **${fmtCurrency(summary.grossProfit)}** |\n`;
    md += `| Gross Margin | ${fmtPct(summary.grossMarginPct)} |\n`;
  }

  if (summary.totalExpenses != null) {
    md += `| Operating Expenses | ${fmtCurrency(summary.totalExpenses)} |\n`;
  }
  if (summary.netOperatingIncome != null) {
    md += `| Net Operating Income | ${fmtCurrency(summary.netOperatingIncome)} |\n`;
  }
  if (summary.otherIncome != null) {
    md += `| Other Income | ${fmtCurrency(summary.otherIncome)} |\n`;
  }
  if (summary.otherExpenses != null) {
    md += `| Other Expenses | ${fmtCurrency(summary.otherExpenses)} |\n`;
  }

  md += `| **Net Income** | **${fmtCurrency(summary.netIncome)}** |\n`;
  md += `| Net Margin | ${fmtPct(summary.netMarginPct)} |\n`;

  // Top expense categories
  if (rows) {
    const expenseSection = getSectionByName(rows, 'expense');
    if (expenseSection?.children?.length) {
      md += '\n### Top Expense Categories\n\n';
      md += '| Category | Amount | % of Revenue |\n';
      md += '|----------|--------|-------------|\n';

      const expenses = expenseSection.children
        .filter(c => c.type === 'data' || (c.type === 'section' && c.summary))
        .map(c => ({
          name: c.name,
          amount: c.type === 'data' ? c.values[0] : c.summary?.values[0],
        }))
        .filter(e => e.amount != null && e.amount !== 0)
        .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
        .slice(0, 10);

      for (const e of expenses) {
        const pctOfRev = summary.totalIncome ? e.amount / summary.totalIncome : null;
        md += `| ${e.name} | ${fmtCurrency(e.amount)} | ${fmtPct(pctOfRev)} |\n`;
      }
    }
  }

  const source = live || !rows ? 'Live QBO API' : 'Supabase snapshot';
  md += `\n*Source: ${source}*`;

  return { content: [{ type: 'text', text: md }] };
}

const tools = [
  {
    name: 'financial_summary',
    description: 'Get a P&L overview for any period — revenue, COGS, gross profit, expenses, net income, margins, and top expense categories. Use natural language periods like "2025", "Q4 2025", "March 2026", "last 90 days".',
    inputSchema: {
      type: 'object',
      properties: {
        period: {
          type: 'string',
          description: 'Time period (e.g., "2025", "Q1 2026", "March 2025", "last 90 days", "last quarter")',
        },
        live: {
          type: 'boolean',
          description: 'If true, fetch directly from QBO API instead of cached Supabase data (default: false)',
        },
      },
      required: ['period'],
    },
    handler: handleFinancialSummary,
  },
];

module.exports = tools;
