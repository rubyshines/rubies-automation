/**
 * MCP Tool: budget_vs_actual
 *
 * Compare actuals to budget from QBO. Always hits live API since
 * QBO budgets are report-only (not available via query API).
 */

const { getQboClient } = require('../qbo');
const { parseReport, flattenRows } = require('../reportParser');
const { parsePeriod, fmtCurrency, fmtPct } = require('./helpers');

async function handleBudgetVsActual({ period }) {
  const { startDate, endDate, label } = parsePeriod(period);
  const qbo = getQboClient();

  // Fetch budget summary
  let budgetReport;
  try {
    budgetReport = await qbo.getBudgetSummary(startDate, endDate);
  } catch (err) {
    if (err.message?.includes('400') || err.message?.includes('no budget')) {
      return { content: [{ type: 'text', text: `No budget configured in QuickBooks for ${label}. Set up a budget in QBO (Gear > Budgeting) and try again.` }] };
    }
    throw err;
  }

  // Fetch actual P&L
  const actualReport = await qbo.getProfitAndLoss(startDate, endDate);

  const budgetParsed = parseReport(budgetReport);
  const actualParsed = parseReport(actualReport);

  const budgetItems = flattenRows(budgetParsed.rows);
  const actualItems = flattenRows(actualParsed.rows);

  // Build lookup by name
  const actualLookup = {};
  for (const item of actualItems) {
    actualLookup[item.name.toLowerCase()] = item.values[0];
  }

  let md = `## Budget vs Actual: ${label}\n\n`;
  md += '| Account | Budget | Actual | Variance ($) | Variance (%) | Status |\n';
  md += '|---------|--------|--------|-------------|-------------|--------|\n';

  let totalBudget = 0;
  let totalActual = 0;
  let overBudgetCount = 0;

  for (const item of budgetItems) {
    if (item.isTotal) continue; // Skip total rows
    const budget = item.values[0];
    if (budget == null || budget === 0) continue;

    const actual = actualLookup[item.name.toLowerCase()] ?? 0;
    const variance = actual - budget;
    const variancePct = budget !== 0 ? variance / Math.abs(budget) : null;
    const isOverBudget = variance > 0 && item.fullName?.toLowerCase().includes('expense');

    if (isOverBudget) overBudgetCount++;
    totalBudget += budget;
    totalActual += actual;

    const status = isOverBudget ? 'Over' : Math.abs(variancePct || 0) < 0.05 ? 'On track' : variance < 0 ? 'Under' : '—';

    md += `| ${item.name} | ${fmtCurrency(budget)} | ${fmtCurrency(actual)} | ${fmtCurrency(variance)} | ${fmtPct(variancePct)} | ${status} |\n`;
  }

  md += `| **Total** | **${fmtCurrency(totalBudget)}** | **${fmtCurrency(totalActual)}** | **${fmtCurrency(totalActual - totalBudget)}** | **${fmtPct(totalBudget !== 0 ? (totalActual - totalBudget) / Math.abs(totalBudget) : null)}** | |\n`;

  if (overBudgetCount > 0) {
    md += `\n**${overBudgetCount} expense categor${overBudgetCount === 1 ? 'y is' : 'ies are'} over budget.**`;
  }

  return { content: [{ type: 'text', text: md }] };
}

const tools = [
  {
    name: 'budget_vs_actual',
    description: 'Compare actual P&L to your QuickBooks budget for a given period. Shows variance ($ and %) and flags over-budget categories. Requires a budget to be set up in QBO.',
    inputSchema: {
      type: 'object',
      properties: {
        period: {
          type: 'string',
          description: 'Time period (e.g., "Q1 2026", "2025", "March 2026")',
        },
      },
      required: ['period'],
    },
    handler: handleBudgetVsActual,
  },
];

module.exports = tools;
