/**
 * MCP Tool: cash_flow_analysis
 *
 * Cash flow vs accrual reconciliation.
 * Answers: "Why did $78K profit not feel like $78K?"
 */

const { getSupabaseClient } = require('../../../shared/supabaseClient');
const { getQboClient } = require('../qbo');
const { parseReport, getSectionByName } = require('../reportParser');
const { parsePeriod, fmtCurrency, fmtPct } = require('./helpers');

async function handleCashFlowAnalysis({ period, live }) {
  const { startDate, endDate, label } = parsePeriod(period);
  const supabase = getSupabaseClient();

  // Get P&L, Cash Flow, and Balance Sheet
  let plSummary, cfSummary, cfRows, bsSummary;

  if (!live) {
    const [plSnap, cfSnap, bsSnap] = await Promise.all([
      supabase.from('qbo_report_snapshots').select('summary').eq('report_type', 'ProfitAndLoss').eq('period_start', startDate).eq('period_end', endDate).single(),
      supabase.from('qbo_report_snapshots').select('summary, report_data').eq('report_type', 'CashFlow').eq('period_start', startDate).eq('period_end', endDate).single(),
      supabase.from('qbo_report_snapshots').select('summary').eq('report_type', 'BalanceSheet').eq('period_start', startDate).eq('period_end', endDate).single(),
    ]);

    plSummary = plSnap.data?.summary;
    cfSummary = cfSnap.data?.summary;
    cfRows = cfSnap.data?.report_data;
    bsSummary = bsSnap.data?.summary;
  }

  // Fetch live if needed
  if (!plSummary || !cfSummary) {
    const qbo = getQboClient();
    if (!plSummary) {
      const raw = await qbo.getProfitAndLoss(startDate, endDate);
      plSummary = parseReport(raw).summary;
    }
    if (!cfSummary) {
      const raw = await qbo.getCashFlowStatement(startDate, endDate);
      const parsed = parseReport(raw);
      cfSummary = parsed.summary;
      cfRows = parsed.rows;
    }
    if (!bsSummary) {
      const raw = await qbo.getBalanceSheet(endDate);
      bsSummary = parseReport(raw).summary;
    }
  }

  let md = `## Cash Flow Analysis: ${label}\n\n`;

  // The key insight: net income vs operating cash flow
  md += '### Profit vs Cash\n\n';
  md += '| Metric | Amount |\n';
  md += '|--------|--------|\n';

  const netIncome = plSummary?.netIncome;
  const opsCash = cfSummary?.operatingCashFlow;

  md += `| Net Income (P&L) | ${fmtCurrency(netIncome)} |\n`;
  md += `| Operating Cash Flow | ${fmtCurrency(opsCash)} |\n`;

  if (netIncome != null && opsCash != null) {
    const gap = opsCash - netIncome;
    md += `| **Difference** | **${fmtCurrency(gap)}** |\n`;
    md += '\n';

    if (Math.abs(gap) > 100) {
      if (gap < 0) {
        md += `> Your P&L shows ${fmtCurrency(netIncome)} profit, but operating cash flow was only ${fmtCurrency(opsCash)}. `;
        md += `That's ${fmtCurrency(Math.abs(gap))} less cash than your profit suggests. `;
        md += `This is typically caused by: inventory purchases, accounts receivable (money owed to you), prepaid expenses, or capital investments.\n\n`;
      } else {
        md += `> Operating cash flow (${fmtCurrency(opsCash)}) exceeded net income (${fmtCurrency(netIncome)}) by ${fmtCurrency(gap)}. `;
        md += `This means you collected more cash than your P&L profits — possibly from collecting receivables, depreciation (non-cash expense), or deferred revenue.\n\n`;
      }
    }
  }

  // Cash Flow Statement breakdown
  md += '### Cash Flow Statement\n\n';
  md += '| Category | Amount |\n';
  md += '|----------|--------|\n';
  md += `| Operating Activities | ${fmtCurrency(cfSummary?.operatingCashFlow)} |\n`;
  md += `| Investing Activities | ${fmtCurrency(cfSummary?.investingCashFlow)} |\n`;
  md += `| Financing Activities | ${fmtCurrency(cfSummary?.financingCashFlow)} |\n`;
  md += `| **Net Cash Change** | **${fmtCurrency(cfSummary?.netCashChange)}** |\n`;

  // Detail operating cash flow items
  if (cfRows) {
    const opsSection = getSectionByName(cfRows, 'operating');
    if (opsSection?.children?.length) {
      md += '\n### Operating Cash Flow Detail\n\n';
      md += '| Item | Amount |\n';
      md += '|------|--------|\n';

      for (const item of opsSection.children) {
        if (item.type === 'data' && item.values[0] != null) {
          md += `| ${item.name} | ${fmtCurrency(item.values[0])} |\n`;
        }
      }
    }

    const invSection = getSectionByName(cfRows, 'investing');
    if (invSection?.children?.length) {
      md += '\n### Investing Activities Detail\n\n';
      md += '| Item | Amount |\n';
      md += '|------|--------|\n';
      for (const item of invSection.children) {
        if (item.type === 'data' && item.values[0] != null) {
          md += `| ${item.name} | ${fmtCurrency(item.values[0])} |\n`;
        }
      }
    }

    const finSection = getSectionByName(cfRows, 'financing');
    if (finSection?.children?.length) {
      md += '\n### Financing Activities Detail\n\n';
      md += '| Item | Amount |\n';
      md += '|------|--------|\n';
      for (const item of finSection.children) {
        if (item.type === 'data' && item.values[0] != null) {
          md += `| ${item.name} | ${fmtCurrency(item.values[0])} |\n`;
        }
      }
    }
  }

  // Balance Sheet cash position
  if (bsSummary) {
    md += '\n### Balance Sheet Snapshot\n\n';
    md += '| Metric | Amount |\n';
    md += '|--------|--------|\n';
    if (bsSummary.currentAssets != null) md += `| Current Assets | ${fmtCurrency(bsSummary.currentAssets)} |\n`;
    if (bsSummary.currentLiabilities != null) md += `| Current Liabilities | ${fmtCurrency(bsSummary.currentLiabilities)} |\n`;
    if (bsSummary.currentRatio != null) md += `| Current Ratio | ${bsSummary.currentRatio.toFixed(2)} |\n`;
    if (bsSummary.totalAssets != null) md += `| Total Assets | ${fmtCurrency(bsSummary.totalAssets)} |\n`;
    if (bsSummary.totalLiabilities != null) md += `| Total Liabilities | ${fmtCurrency(bsSummary.totalLiabilities)} |\n`;
    if (bsSummary.totalEquity != null) md += `| Total Equity | ${fmtCurrency(bsSummary.totalEquity)} |\n`;
  }

  return { content: [{ type: 'text', text: md }] };
}

const tools = [
  {
    name: 'cash_flow_analysis',
    description: 'Reconcile P&L profit with actual cash movements. Explains why profit on paper may not match cash in bank. Shows operating/investing/financing cash flows, the profit-to-cash gap, and balance sheet position.',
    inputSchema: {
      type: 'object',
      properties: {
        period: {
          type: 'string',
          description: 'Time period (e.g., "2025", "Q4 2025")',
        },
        live: {
          type: 'boolean',
          description: 'If true, fetch directly from QBO API (default: false)',
        },
      },
      required: ['period'],
    },
    handler: handleCashFlowAnalysis,
  },
];

module.exports = tools;
