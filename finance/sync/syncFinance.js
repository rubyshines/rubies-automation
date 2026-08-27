/**
 * RUBIES Finance Daily Sync — QuickBooks Online → Supabase
 *
 * Three sub-syncs:
 *   1. Chart of Accounts (full refresh)
 *   2. Transactions (incremental by LastUpdatedTime)
 *   3. Report snapshots (current + previous month P&L, BS, CF)
 *
 * Usage:
 *   node finance/sync/syncFinance.js
 *   npm run finance-sync
 */

const path = require('path');
if (!process.env.SUPABASE_URL) {
  require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
}

const { getQboClient } = require('../lib/qbo');
const { parseReport } = require('../lib/reportParser');
const { getSupabaseClient } = require('../../shared/supabaseClient');

const BATCH_SIZE = 100;

// ---------------------------------------------------------------------------
// Sub-sync: Accounts
// ---------------------------------------------------------------------------

async function syncAccounts(qbo, supabase) {
  console.log('  Syncing Chart of Accounts...');
  const accounts = await qbo.getAccounts();
  const now = new Date().toISOString();

  const rows = accounts.map(a => ({
    id: String(a.Id),
    name: a.Name,
    full_name: a.FullyQualifiedName || a.Name,
    account_type: a.AccountType,
    account_sub_type: a.AccountSubType || null,
    classification: a.Classification || null,
    current_balance: a.CurrentBalance != null ? parseFloat(a.CurrentBalance) : null,
    currency_ref: a.CurrencyRef?.value || 'USD',
    active: a.Active !== false,
    parent_id: a.ParentRef?.value ? String(a.ParentRef.value) : null,
    synced_at: now,
  }));

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const { error } = await supabase
      .from('qbo_accounts')
      .upsert(batch, { onConflict: 'id' });
    if (error) throw new Error(`Accounts upsert failed: ${error.message}`);
  }

  console.log(`  Synced ${rows.length} accounts`);
  return { success: true, rowsWritten: rows.length, error: null };
}

// ---------------------------------------------------------------------------
// Sub-sync: Transactions (incremental)
// ---------------------------------------------------------------------------

async function syncTransactions(qbo, supabase) {
  console.log('  Syncing transactions (incremental)...');

  // Read high-water mark
  const { data: progress } = await supabase
    .from('qbo_sync_progress')
    .select('last_txn_updated_at')
    .eq('sync_type', 'transactions')
    .single();

  const sinceDate = progress?.last_txn_updated_at || null;
  if (sinceDate) {
    console.log(`  Fetching transactions updated since ${sinceDate}`);
  } else {
    console.log('  No previous sync — fetching all transactions (this may take a while)...');
  }

  const txns = await qbo.getAllTransactionsSince(sinceDate);
  if (!txns.length) {
    console.log('  No new transactions');
    return { success: true, rowsWritten: 0, error: null };
  }

  const now = new Date().toISOString();
  let maxUpdated = sinceDate;

  const rows = txns.map(txn => {
    const meta = txn.MetaData || {};
    const updatedAt = meta.LastUpdatedTime || null;
    if (updatedAt && (!maxUpdated || updatedAt > maxUpdated)) {
      maxUpdated = updatedAt;
    }

    return {
      id: String(txn.Id),
      txn_type: txn._txnType,
      txn_date: txn.TxnDate || null,
      doc_number: txn.DocNumber || null,
      total_amount: extractTotalAmount(txn),
      currency_code: txn.CurrencyRef?.value || 'USD',
      account_id: extractAccountId(txn),
      entity_name: extractEntityName(txn),
      entity_id: extractEntityId(txn),
      memo: txn.PrivateNote || null,
      line_items: normalizeLines(txn),
      raw_json: txn,
      created_at: meta.CreateTime || null,
      updated_at: updatedAt,
      synced_at: now,
    };
  });

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const { error } = await supabase
      .from('qbo_transactions')
      .upsert(batch, { onConflict: 'id,txn_type' });
    if (error) throw new Error(`Transactions upsert failed: ${error.message}`);
  }

  // Update high-water mark
  await supabase.from('qbo_sync_progress').upsert({
    sync_type: 'transactions',
    last_sync_at: now,
    last_txn_updated_at: maxUpdated,
    rows_synced: rows.length,
    status: 'success',
    updated_at: now,
  }, { onConflict: 'sync_type' });

  console.log(`  Synced ${rows.length} transactions (latest: ${maxUpdated})`);
  return { success: true, rowsWritten: rows.length, error: null };
}

// A Transfer carries neither TotalAmt nor Line: the amount is `Amount` and the
// two sides are ToAccountRef/FromAccountRef. Reading only TotalAmt/Line left
// every Transfer row with total_amount = null and line_items = null, so an
// entire transaction class was invisible to any query that walks line items.
// That silently hid years of related-party loan repayments from capital-flow
// analysis while the rows themselves looked present. Normalise a Transfer into
// the same debit/credit line shape a JournalEntry uses so one traversal works
// for every type; raw_json keeps the original either way.
function normalizeLines(txn, txnType = txn._txnType) {
  if (Array.isArray(txn.Line)) return txn.Line;
  if (txnType !== 'Transfer') return txn.Line || null;

  const amount = txn.Amount != null ? parseFloat(txn.Amount) : null;
  if (amount == null || !txn.ToAccountRef || !txn.FromAccountRef) return null;

  // Money moves FROM FromAccount TO ToAccount: debit the destination, credit the source.
  return [
    {
      Amount: amount,
      DetailType: 'JournalEntryLineDetail',
      Description: txn.PrivateNote || null,
      JournalEntryLineDetail: { PostingType: 'Debit', AccountRef: txn.ToAccountRef },
      _synthesized: 'Transfer',
    },
    {
      Amount: amount,
      DetailType: 'JournalEntryLineDetail',
      Description: txn.PrivateNote || null,
      JournalEntryLineDetail: { PostingType: 'Credit', AccountRef: txn.FromAccountRef },
      _synthesized: 'Transfer',
    },
  ];
}

function extractTotalAmount(txn) {
  if (txn.TotalAmt != null) return parseFloat(txn.TotalAmt);
  if (txn.Amount != null) return parseFloat(txn.Amount); // Transfer
  return null;
}

function extractAccountId(txn) {
  // Different transaction types store the primary account in different fields
  if (txn.AccountRef?.value) return String(txn.AccountRef.value);
  if (txn.DepositToAccountRef?.value) return String(txn.DepositToAccountRef.value);
  if (txn.ToAccountRef?.value) return String(txn.ToAccountRef.value); // Transfer destination
  // For invoices/bills, take from the first line item
  const firstLine = txn.Line?.[0];
  if (firstLine?.AccountBasedExpenseLineDetail?.AccountRef?.value) {
    return String(firstLine.AccountBasedExpenseLineDetail.AccountRef.value);
  }
  if (firstLine?.SalesItemLineDetail?.ItemAccountRef?.value) {
    return String(firstLine.SalesItemLineDetail.ItemAccountRef.value);
  }
  return null;
}

function extractEntityName(txn) {
  if (txn.CustomerRef?.name) return txn.CustomerRef.name;
  if (txn.VendorRef?.name) return txn.VendorRef.name;
  if (txn.EntityRef?.name) return txn.EntityRef.name;
  return null;
}

function extractEntityId(txn) {
  if (txn.CustomerRef?.value) return String(txn.CustomerRef.value);
  if (txn.VendorRef?.value) return String(txn.VendorRef.value);
  if (txn.EntityRef?.value) return String(txn.EntityRef.value);
  return null;
}

// ---------------------------------------------------------------------------
// Sub-sync: Report snapshots
// ---------------------------------------------------------------------------

async function syncReportSnapshots(qbo, supabase) {
  console.log('  Syncing report snapshots...');
  const now = new Date();
  let rowsWritten = 0;

  // Current month
  const curStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  const curEnd = formatDate(now);

  // Previous month
  const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const prevStart = `${prevMonth.getFullYear()}-${String(prevMonth.getMonth() + 1).padStart(2, '0')}-01`;
  const prevEnd = formatDate(new Date(now.getFullYear(), now.getMonth(), 0)); // last day of prev month

  const periods = [
    { start: prevStart, end: prevEnd, label: 'previous month' },
    { start: curStart, end: curEnd, label: 'current month' },
  ];

  // Also do current quarter if we're at a quarter boundary (months 3, 6, 9, 12)
  const curMonth = now.getMonth() + 1;
  if ([3, 6, 9, 12].includes(curMonth)) {
    const qStart = `${now.getFullYear()}-${String(curMonth - 2).padStart(2, '0')}-01`;
    periods.push({ start: qStart, end: curEnd, label: 'current quarter' });
  }

  // Also do YTD
  const ytdStart = `${now.getFullYear()}-01-01`;
  periods.push({ start: ytdStart, end: curEnd, label: 'YTD' });

  for (const period of periods) {
    const reportTypes = [
      { name: 'ProfitAndLoss', fetch: () => qbo.getProfitAndLoss(period.start, period.end) },
      { name: 'BalanceSheet', fetch: () => qbo.getBalanceSheet(period.end) },
      { name: 'CashFlow', fetch: () => qbo.getCashFlowStatement(period.start, period.end) },
    ];

    for (const rt of reportTypes) {
      try {
        const raw = await rt.fetch();
        const parsed = parseReport(raw);

        const { error } = await supabase
          .from('qbo_report_snapshots')
          .upsert({
            report_type: rt.name,
            period_start: period.start,
            period_end: period.end,
            accounting_method: parsed.header.accountingMethod || 'Accrual',
            report_data: parsed.rows,
            summary: parsed.summary,
            generated_at: new Date().toISOString(),
          }, { onConflict: 'report_type,period_start,period_end' });

        if (error) throw error;
        rowsWritten++;
      } catch (err) {
        console.error(`  Warning: ${rt.name} for ${period.label} failed: ${err.message}`);
      }
    }
  }

  // Update sync progress
  await supabase.from('qbo_sync_progress').upsert({
    sync_type: 'reports',
    last_sync_at: new Date().toISOString(),
    rows_synced: rowsWritten,
    status: 'success',
    updated_at: new Date().toISOString(),
  }, { onConflict: 'sync_type' });

  console.log(`  Synced ${rowsWritten} report snapshots`);
  return { success: true, rowsWritten, error: null };
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

async function run() {
  console.log('RUBIES Finance Sync — starting');
  const qbo = getQboClient();
  const supabase = getSupabaseClient();

  const sources = {};

  try {
    sources.accounts = await syncAccounts(qbo, supabase);
  } catch (err) {
    console.error(`  Accounts sync FAILED: ${err.message}`);
    sources.accounts = { success: false, rowsWritten: 0, error: err.message };
  }

  try {
    sources.transactions = await syncTransactions(qbo, supabase);
  } catch (err) {
    console.error(`  Transactions sync FAILED: ${err.message}`);
    sources.transactions = { success: false, rowsWritten: 0, error: err.message };
  }

  try {
    sources.reports = await syncReportSnapshots(qbo, supabase);
  } catch (err) {
    console.error(`  Reports sync FAILED: ${err.message}`);
    sources.reports = { success: false, rowsWritten: 0, error: err.message };
  }

  const allSuccess = Object.values(sources).every(s => s.success);
  const anySuccess = Object.values(sources).some(s => s.success);
  const status = allSuccess ? 'success' : anySuccess ? 'partial' : 'failure';

  console.log(`RUBIES Finance Sync — ${status}`);
  return { sources, status };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

module.exports = { run, normalizeLines, extractTotalAmount, extractAccountId };

if (require.main === module) {
  run().catch(err => {
    console.error('RUBIES Finance Sync — FAILED:', err.message);
    process.exit(1);
  });
}
