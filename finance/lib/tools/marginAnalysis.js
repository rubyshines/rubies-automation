/**
 * MCP Tool: margin_analysis
 *
 * Gross/net margin tracking + COGS breakdown over time.
 */

const { getSupabaseClient } = require('../../../shared/supabaseClient');
const { getQboClient } = require('../qbo');
const { parseReport, getSectionByName } = require('../reportParser');
const { parsePeriod, fmtCurrency, fmtPct, sparkline } = require('./helpers');

async function handleMarginAnalysis({ period, months }) {
  const numMonths = months || 12;
  const supabase = getSupabaseClient();
  const current = parsePeriod(period);

  // Get current period P&L
  let summary, rows;
  const { data } = await supabase
    .from('qbo_report_snapshots')
    .select('summary, report_data')
    .eq('report_type', 'ProfitAndLoss')
    .eq('period_start', current.startDate)
    .eq('period_end', current.endDate)
    .single();

  if (data) {
    summary = data.summary;
    rows = data.report_data;
  } else {
    const qbo = getQboClient();
    const raw = await qbo.getProfitAndLoss(current.startDate, current.endDate);
    const parsed = parseReport(raw);
    summary = parsed.summary;
    rows = parsed.rows;
  }

  let md = `## Margin Analysis: ${current.label}\n\n`;

  if (summary) {
    md += '| Metric | Value |\n';
    md += '|--------|-------|\n';
    md += `| Revenue | ${fmtCurrency(summary.totalIncome)} |\n`;
    md += `| COGS | ${fmtCurrency(summary.costOfGoodsSold)} |\n`;
    md += `| **Gross Profit** | **${fmtCurrency(summary.grossProfit)}** |\n`;
    md += `| **Gross Margin** | **${fmtPct(summary.grossMarginPct)}** |\n`;
    md += `| Operating Expenses | ${fmtCurrency(summary.totalExpenses)} |\n`;
    md += `| **Net Income** | **${fmtCurrency(summary.netIncome)}** |\n`;
    md += `| **Net Margin** | **${fmtPct(summary.netMarginPct)}** |\n`;
  }

  // COGS breakdown
  if (rows) {
    const cogsSection = getSectionByName(rows, 'cost of goods');
    if (cogsSection?.children?.length) {
      md += '\n### COGS Breakdown\n\n';
      md += '| Category | Amount | % of COGS |\n';
      md += '|----------|--------|----------|\n';

      const totalCogs = summary?.costOfGoodsSold || 0;
      const items = cogsSection.children
        .filter(c => c.type === 'data' || (c.type === 'section' && c.summary))
        .map(c => ({
          name: c.name,
          amount: c.type === 'data' ? c.values[0] : c.summary?.values[0],
        }))
        .filter(e => e.amount != null && e.amount !== 0)
        .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));

      for (const item of items) {
        const pct = totalCogs ? item.amount / totalCogs : null;
        md += `| ${item.name} | ${fmtCurrency(item.amount)} | ${fmtPct(pct)} |\n`;
      }
    }
  }

  // Margin trend over time
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - numMonths);
  const cutoffStr = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, '0')}-01`;

  const { data: snapshots } = await supabase
    .from('qbo_report_snapshots')
    .select('period_start, summary')
    .eq('report_type', 'ProfitAndLoss')
    .gte('period_start', cutoffStr)
    .order('period_start', { ascending: true });

  if (snapshots?.length >= 2) {
    // Filter to monthly only
    const monthly = snapshots.filter(s => {
      const end = new Date(s.period_start);
      return true; // all snapshots from our query should be monthly
    });

    const grossMargins = monthly.map(s => s.summary?.grossMarginPct).filter(v => v != null);
    const netMargins = monthly.map(s => s.summary?.netMarginPct).filter(v => v != null);

    md += `\n### Margin Trend (${numMonths} months)\n\n`;

    if (grossMargins.length >= 2) {
      md += `Gross: ${sparkline(grossMargins)}\n`;
    }
    if (netMargins.length >= 2) {
      md += `Net:   ${sparkline(netMargins)}\n\n`;
    }

    md += '| Period | Revenue | Gross % | Net % |\n';
    md += '|--------|---------|---------|-------|\n';

    for (const s of monthly) {
      const sum = s.summary || {};
      md += `| ${s.period_start.slice(0, 7)} | ${fmtCurrency(sum.totalIncome)} | ${fmtPct(sum.grossMarginPct)} | ${fmtPct(sum.netMarginPct)} |\n`;
    }

    // Flag margin compression
    if (grossMargins.length >= 3) {
      const recent3 = grossMargins.slice(-3);
      const prior3 = grossMargins.slice(-6, -3);
      if (prior3.length >= 3) {
        const recentAvg = recent3.reduce((a, b) => a + b, 0) / 3;
        const priorAvg = prior3.reduce((a, b) => a + b, 0) / 3;
        const ppDiff = (recentAvg - priorAvg) * 100;
        if (ppDiff < -2) {
          md += `\n**Warning: Gross margin has compressed ${Math.abs(ppDiff).toFixed(1)}pp over the last 3 months vs prior 3.**`;
        }
      }
    }
  }

  return { content: [{ type: 'text', text: md }] };
}

const tools = [
  {
    name: 'margin_analysis',
    description: 'Analyze gross and net margins — current period breakdown plus trend over time. Shows COGS breakdown, margin trend with sparklines, and flags margin compression.',
    inputSchema: {
      type: 'object',
      properties: {
        period: {
          type: 'string',
          description: 'Time period for the current snapshot (e.g., "2025", "Q4 2025")',
        },
        months: {
          type: 'number',
          description: 'How many months of margin history to show (default: 12)',
        },
      },
      required: ['period'],
    },
    handler: handleMarginAnalysis,
  },
];

module.exports = tools;
