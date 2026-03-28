/**
 * MCP Tool: expense_breakdown
 *
 * Category-level expense drill-down with optional period comparison.
 */

const { getSupabaseClient } = require('../../../shared/supabaseClient');
const { getQboClient } = require('../qbo');
const { parseReport, getSectionByName } = require('../reportParser');
const { parsePeriod, fmtCurrency, fmtPct, fmtDelta } = require('./helpers');

async function getExpenseData(startDate, endDate) {
  const supabase = getSupabaseClient();
  const { data } = await supabase
    .from('qbo_report_snapshots')
    .select('summary, report_data')
    .eq('report_type', 'ProfitAndLoss')
    .eq('period_start', startDate)
    .eq('period_end', endDate)
    .single();

  if (data) return { summary: data.summary, rows: data.report_data };

  // Fallback to live
  const qbo = getQboClient();
  const raw = await qbo.getProfitAndLoss(startDate, endDate);
  const parsed = parseReport(raw);
  return { summary: parsed.summary, rows: parsed.rows };
}

function extractExpenses(rows) {
  const section = getSectionByName(rows, 'expense');
  if (!section?.children) return [];

  return section.children
    .filter(c => c.type === 'data' || (c.type === 'section' && c.summary))
    .map(c => ({
      name: c.name,
      amount: c.type === 'data' ? c.values[0] : c.summary?.values[0],
      children: c.type === 'section' ? (c.children || []).filter(ch => ch.type === 'data').map(ch => ({
        name: ch.name,
        amount: ch.values[0],
      })) : [],
    }))
    .filter(e => e.amount != null && e.amount !== 0)
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
}

async function handleExpenseBreakdown({ period, compare_period, category }) {
  const current = parsePeriod(period);
  const { summary, rows } = await getExpenseData(current.startDate, current.endDate);

  if (!rows) {
    return { content: [{ type: 'text', text: `No P&L data found for ${current.label}.` }] };
  }

  const expenses = extractExpenses(rows);
  const totalExpenses = summary?.totalExpenses || expenses.reduce((s, e) => s + (e.amount || 0), 0);
  const totalRevenue = summary?.totalIncome;

  // If drilling into a specific category
  if (category) {
    const cat = expenses.find(e => e.name.toLowerCase().includes(category.toLowerCase()));
    if (!cat) {
      return { content: [{ type: 'text', text: `No expense category matching "${category}" found.` }] };
    }

    let md = `## ${cat.name}: ${current.label}\n\n`;
    md += `**Total: ${fmtCurrency(cat.amount)}**\n\n`;

    if (cat.children.length) {
      md += '| Sub-category | Amount | % of Category |\n';
      md += '|-------------|--------|---------------|\n';
      for (const sub of cat.children.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))) {
        const pct = cat.amount ? sub.amount / cat.amount : null;
        md += `| ${sub.name} | ${fmtCurrency(sub.amount)} | ${fmtPct(pct)} |\n`;
      }
    }

    // Pull transactions for this category
    const supabase = getSupabaseClient();
    const { data: accts } = await supabase
      .from('qbo_accounts')
      .select('id, name')
      .ilike('name', `%${category}%`);

    if (accts?.length) {
      const accountIds = accts.map(a => a.id);
      const { data: txns } = await supabase
        .from('qbo_transactions')
        .select('txn_date, doc_number, total_amount, entity_name, memo')
        .in('account_id', accountIds)
        .gte('txn_date', current.startDate)
        .lte('txn_date', current.endDate)
        .order('txn_date', { ascending: false })
        .limit(20);

      if (txns?.length) {
        md += '\n### Recent Transactions\n\n';
        md += '| Date | # | Amount | Payee | Memo |\n';
        md += '|------|---|--------|-------|------|\n';
        for (const t of txns) {
          md += `| ${t.txn_date} | ${t.doc_number || '—'} | ${fmtCurrency(t.total_amount)} | ${t.entity_name || '—'} | ${(t.memo || '—').slice(0, 40)} |\n`;
        }
      }
    }

    return { content: [{ type: 'text', text: md }] };
  }

  // Full expense breakdown
  let md = `## Expense Breakdown: ${current.label}\n\n`;

  // Comparison period?
  let compareExpenses = null;
  let compareLabel = '';
  if (compare_period) {
    const comp = parsePeriod(compare_period);
    compareLabel = comp.label;
    const compData = await getExpenseData(comp.startDate, comp.endDate);
    if (compData.rows) {
      compareExpenses = {};
      for (const e of extractExpenses(compData.rows)) {
        compareExpenses[e.name] = e.amount;
      }
    }
  }

  if (compareExpenses) {
    md += `| Category | ${current.label} | ${compareLabel} | Change | Change % |\n`;
    md += '|----------|--------|--------|--------|----------|\n';
  } else {
    md += '| Category | Amount | % of Total | % of Revenue |\n';
    md += '|----------|--------|-----------|-------------|\n';
  }

  for (const e of expenses) {
    const pctTotal = totalExpenses ? e.amount / totalExpenses : null;
    const pctRev = totalRevenue ? e.amount / totalRevenue : null;

    if (compareExpenses) {
      const prev = compareExpenses[e.name];
      const delta = fmtDelta(e.amount, prev);
      const flag = delta.isIncrease && prev && Math.abs(e.amount - prev) / Math.abs(prev) > 0.2 ? ' ⚠' : '';
      md += `| ${e.name} | ${fmtCurrency(e.amount)} | ${fmtCurrency(prev)} | ${delta.dollar} | ${delta.pct}${flag} |\n`;
    } else {
      md += `| ${e.name} | ${fmtCurrency(e.amount)} | ${fmtPct(pctTotal)} | ${fmtPct(pctRev)} |\n`;
    }
  }

  md += `\n**Total Expenses: ${fmtCurrency(totalExpenses)}**`;
  if (totalRevenue) md += ` (${fmtPct(totalExpenses / totalRevenue)} of revenue)`;

  return { content: [{ type: 'text', text: md }] };
}

const tools = [
  {
    name: 'expense_breakdown',
    description: 'Break down expenses by category for a period. Optionally compare to another period (YoY, QoQ). Drill into a specific category for sub-categories and recent transactions.',
    inputSchema: {
      type: 'object',
      properties: {
        period: {
          type: 'string',
          description: 'Time period (e.g., "2025", "Q4 2025", "last 90 days")',
        },
        compare_period: {
          type: 'string',
          description: 'Optional comparison period (e.g., "2024" for YoY, "Q3 2025" for QoQ)',
        },
        category: {
          type: 'string',
          description: 'Optional: drill into a specific expense category (e.g., "travel", "advertising")',
        },
      },
      required: ['period'],
    },
    handler: handleExpenseBreakdown,
  },
];

module.exports = tools;
