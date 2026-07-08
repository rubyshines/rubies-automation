/**
 * MCP Tool: account_detail
 *
 * Transaction-level drill into any account. Fuzzy matches account name.
 */

const { getSupabaseClient, fetchAllPaginated, readMany } = require('../../../shared/supabaseClient');
const { parsePeriod, fmtCurrency } = require('./helpers');

async function handleAccountDetail({ account_name, period }) {
  const { startDate, endDate, label } = parsePeriod(period);
  const supabase = getSupabaseClient();

  // Fuzzy match account name
  let accounts = await readMany(supabase
    .from('qbo_accounts')
    .select('id, name, full_name, account_type, classification')
    .ilike('name', `%${account_name}%`)
    .eq('active', true));

  if (!accounts.length) {
    // Try full_name
    accounts = await readMany(supabase
      .from('qbo_accounts')
      .select('id, name, full_name, account_type, classification')
      .ilike('full_name', `%${account_name}%`)
      .eq('active', true));

    if (!accounts.length) {
      return { content: [{ type: 'text', text: `No account matching "${account_name}". Try a broader search term.` }] };
    }
  }

  const accountIds = accounts.map(a => a.id);
  const accountNames = accounts.map(a => a.name);

  // Fetch transactions — paginated; a broad match over a long period easily
  // exceeds Supabase's 1000-row cap, and the totals below must be complete.
  const txns = await fetchAllPaginated(() => supabase
    .from('qbo_transactions')
    .select('txn_date, txn_type, doc_number, total_amount, entity_name, memo, currency_code')
    .in('account_id', accountIds)
    .gte('txn_date', startDate)
    .lte('txn_date', endDate)
    .order('txn_date', { ascending: true })
    .order('doc_number', { ascending: true }));

  let md = `## Account Detail: ${accountNames.join(', ')}\n`;
  md += `*${label} | Type: ${accounts[0].account_type} | Classification: ${accounts[0].classification}*\n\n`;

  if (!txns?.length) {
    md += 'No transactions found for this period.';
    return { content: [{ type: 'text', text: md }] };
  }

  // Summary
  const total = txns.reduce((s, t) => s + (t.total_amount || 0), 0);
  md += `**${txns.length} transactions** | **Total: ${fmtCurrency(total)}**\n\n`;

  // Transaction table
  md += '| Date | Type | # | Amount | Payee/Customer | Memo |\n';
  md += '|------|------|---|--------|---------------|------|\n';

  const maxRows = 50;
  const display = txns.slice(0, maxRows);

  let runningTotal = 0;
  for (const t of display) {
    runningTotal += t.total_amount || 0;
    const memo = (t.memo || '').slice(0, 50);
    md += `| ${t.txn_date} | ${t.txn_type} | ${t.doc_number || '—'} | ${fmtCurrency(t.total_amount)} | ${t.entity_name || '—'} | ${memo || '—'} |\n`;
  }

  if (txns.length > maxRows) {
    md += `\n*Showing first ${maxRows} of ${txns.length} transactions*`;
  }

  // Monthly subtotals if more than 1 month
  const months = {};
  for (const t of txns) {
    const month = t.txn_date?.slice(0, 7);
    if (month) {
      months[month] = (months[month] || 0) + (t.total_amount || 0);
    }
  }

  if (Object.keys(months).length > 1) {
    md += '\n\n### Monthly Subtotals\n\n';
    md += '| Month | Amount |\n';
    md += '|-------|--------|\n';
    for (const [month, amount] of Object.entries(months).sort()) {
      md += `| ${month} | ${fmtCurrency(amount)} |\n`;
    }
  }

  return { content: [{ type: 'text', text: md }] };
}

const tools = [
  {
    name: 'account_detail',
    description: 'Show all transactions for a specific account in a given period. Fuzzy matches account names (e.g., "travel", "advertising", "checking"). Includes transaction list and monthly subtotals.',
    inputSchema: {
      type: 'object',
      properties: {
        account_name: {
          type: 'string',
          description: 'Account name to search for (fuzzy match, e.g., "travel", "shipping", "checking")',
        },
        period: {
          type: 'string',
          description: 'Time period (e.g., "2025", "Q4 2025", "March 2026")',
        },
      },
      required: ['account_name', 'period'],
    },
    handler: handleAccountDetail,
  },
];

module.exports = tools;
