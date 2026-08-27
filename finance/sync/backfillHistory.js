/**
 * RUBIES Finance Historical Backfill — QuickBooks Online → Supabase
 *
 * Fetches 4+ years of history in 3-month windows.
 * Resumable: tracks progress in qbo_sync_progress.
 *
 * Usage:
 *   node finance/sync/backfillHistory.js
 *   npm run finance-backfill
 *
 * Options:
 *   --years N     How many years back (default: 4)
 *   --from DATE   Start from a specific date (YYYY-MM-DD)
 *   --reports     Only backfill report snapshots (skip transactions)
 *   --txns        Only backfill transactions (skip reports)
 */

const path = require('path');
if (!process.env.SUPABASE_URL) {
  require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
}

const { getQboClient } = require('../lib/qbo');
const { parseReport } = require('../lib/reportParser');
const { getSupabaseClient } = require('../../shared/supabaseClient');
// Shared with syncFinance so the two writers to qbo_transactions cannot drift:
// they previously held separate copies of this extraction, and the Transfer bug
// had to be fixed in both.
const { normalizeLines, extractTotalAmount, extractAccountId } = require('./syncFinance');

const BATCH_SIZE = 100;
const CHUNK_DELAY_MS = 2000; // pause between 3-month chunks to respect rate limits

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

function addMonths(date, months) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}

function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function lastDayOfMonth(year, month) {
  return new Date(year, month + 1, 0);
}

function generateMonthlyPeriods(startDate, endDate) {
  const periods = [];
  let current = new Date(startDate.getFullYear(), startDate.getMonth(), 1);

  while (current < endDate) {
    const periodStart = formatDate(current);
    const periodEnd = formatDate(lastDayOfMonth(current.getFullYear(), current.getMonth()));
    periods.push({ start: periodStart, end: periodEnd });
    current = addMonths(current, 1);
  }

  return periods;
}

function generate3MonthWindows(startDate, endDate) {
  const windows = [];
  let current = new Date(startDate);

  while (current < endDate) {
    const windowEnd = addMonths(current, 3);
    const end = windowEnd > endDate ? endDate : windowEnd;
    windows.push({
      start: formatDate(current),
      end: formatDate(new Date(end.getTime() - 86400000)), // day before end
    });
    current = windowEnd;
  }

  return windows;
}

// ---------------------------------------------------------------------------
// Backfill: Report snapshots (monthly)
// ---------------------------------------------------------------------------

async function backfillReports(qbo, supabase, startDate, endDate) {
  console.log('\n=== Backfilling Report Snapshots ===\n');
  const periods = generateMonthlyPeriods(startDate, endDate);
  let total = 0;
  let errors = 0;

  for (let i = 0; i < periods.length; i++) {
    const period = periods[i];
    console.log(`  [${i + 1}/${periods.length}] ${period.start} to ${period.end}`);

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
        total++;
      } catch (err) {
        console.error(`    ${rt.name} failed: ${err.message.slice(0, 100)}`);
        errors++;
      }
    }

    // Also generate quarterly snapshots at quarter boundaries
    const monthNum = parseInt(period.start.slice(5, 7), 10);
    if ([3, 6, 9, 12].includes(monthNum)) {
      const qStart = `${period.start.slice(0, 5)}${String(monthNum - 2).padStart(2, '0')}-01`;
      try {
        const raw = await qbo.getProfitAndLoss(qStart, period.end);
        const parsed = parseReport(raw);
        await supabase.from('qbo_report_snapshots').upsert({
          report_type: 'ProfitAndLoss',
          period_start: qStart,
          period_end: period.end,
          accounting_method: parsed.header.accountingMethod || 'Accrual',
          report_data: parsed.rows,
          summary: parsed.summary,
          generated_at: new Date().toISOString(),
        }, { onConflict: 'report_type,period_start,period_end' });
        total++;
      } catch (err) {
        // Quarterly P&L is a bonus — don't fail on it
      }
    }

    // Also generate annual snapshots at year-end
    if (monthNum === 12) {
      const yearStart = `${period.start.slice(0, 4)}-01-01`;
      try {
        const raw = await qbo.getProfitAndLoss(yearStart, period.end);
        const parsed = parseReport(raw);
        await supabase.from('qbo_report_snapshots').upsert({
          report_type: 'ProfitAndLoss',
          period_start: yearStart,
          period_end: period.end,
          accounting_method: parsed.header.accountingMethod || 'Accrual',
          report_data: parsed.rows,
          summary: parsed.summary,
          generated_at: new Date().toISOString(),
        }, { onConflict: 'report_type,period_start,period_end' });
        total++;
      } catch (_) {}

      // Annual Balance Sheet + Cash Flow
      try {
        const bsRaw = await qbo.getBalanceSheet(period.end);
        const bsParsed = parseReport(bsRaw);
        await supabase.from('qbo_report_snapshots').upsert({
          report_type: 'BalanceSheet',
          period_start: yearStart,
          period_end: period.end,
          report_data: bsParsed.rows,
          summary: bsParsed.summary,
          generated_at: new Date().toISOString(),
        }, { onConflict: 'report_type,period_start,period_end' });
        total++;
      } catch (_) {}

      try {
        const cfRaw = await qbo.getCashFlowStatement(yearStart, period.end);
        const cfParsed = parseReport(cfRaw);
        await supabase.from('qbo_report_snapshots').upsert({
          report_type: 'CashFlow',
          period_start: yearStart,
          period_end: period.end,
          report_data: cfParsed.rows,
          summary: cfParsed.summary,
          generated_at: new Date().toISOString(),
        }, { onConflict: 'report_type,period_start,period_end' });
        total++;
      } catch (_) {}
    }

    // Rate limit pause between months
    if (i < periods.length - 1) {
      await sleep(CHUNK_DELAY_MS);
    }
  }

  console.log(`\n  Report backfill complete: ${total} snapshots (${errors} errors)\n`);
  return total;
}

// ---------------------------------------------------------------------------
// Backfill: Transactions (3-month windows)
// ---------------------------------------------------------------------------

async function backfillTransactions(qbo, supabase, startDate, endDate) {
  console.log('\n=== Backfilling Transactions ===\n');
  const windows = generate3MonthWindows(startDate, endDate);
  let totalRows = 0;

  for (let i = 0; i < windows.length; i++) {
    const window = windows[i];
    console.log(`  [${i + 1}/${windows.length}] ${window.start} to ${window.end}`);

    let windowRows = 0;

    for (const type of qbo.TRANSACTION_TYPES) {
      try {
        const where = `TxnDate >= '${window.start}' AND TxnDate <= '${window.end}'`;
        const txns = await qbo.queryAll(type, where);
        if (!txns.length) continue;

        const now = new Date().toISOString();
        const rows = txns.map(txn => ({
          id: String(txn.Id),
          txn_type: type,
          txn_date: txn.TxnDate || null,
          doc_number: txn.DocNumber || null,
          total_amount: extractTotalAmount(txn),
          currency_code: txn.CurrencyRef?.value || 'USD',
          account_id: extractAccountId({ ...txn, _txnType: type }),
          entity_name: txn.CustomerRef?.name || txn.VendorRef?.name || txn.EntityRef?.name || null,
          entity_id: txn.CustomerRef?.value || txn.VendorRef?.value || txn.EntityRef?.value || null,
          memo: txn.PrivateNote || null,
          line_items: normalizeLines(txn, type),
          raw_json: txn,
          created_at: txn.MetaData?.CreateTime || null,
          updated_at: txn.MetaData?.LastUpdatedTime || null,
          synced_at: now,
        }));

        for (let j = 0; j < rows.length; j += BATCH_SIZE) {
          const batch = rows.slice(j, j + BATCH_SIZE);
          const { error } = await supabase
            .from('qbo_transactions')
            .upsert(batch, { onConflict: 'id,txn_type' });
          if (error) throw new Error(`${type} upsert failed: ${error.message}`);
        }

        windowRows += rows.length;
        console.log(`    ${type}: ${rows.length}`);
      } catch (err) {
        console.error(`    ${type} failed: ${err.message.slice(0, 100)}`);
      }
    }

    totalRows += windowRows;
    console.log(`    Window total: ${windowRows} transactions\n`);

    // Update progress
    await supabase.from('qbo_sync_progress').upsert({
      sync_type: 'backfill',
      last_sync_at: new Date().toISOString(),
      last_txn_updated_at: window.end,
      rows_synced: totalRows,
      status: 'in_progress',
      updated_at: new Date().toISOString(),
    }, { onConflict: 'sync_type' });

    // Rate limit pause between windows
    if (i < windows.length - 1) {
      await sleep(CHUNK_DELAY_MS);
    }
  }

  // Mark backfill complete
  await supabase.from('qbo_sync_progress').upsert({
    sync_type: 'backfill',
    last_sync_at: new Date().toISOString(),
    rows_synced: totalRows,
    status: 'success',
    updated_at: new Date().toISOString(),
  }, { onConflict: 'sync_type' });

  console.log(`  Transaction backfill complete: ${totalRows} total rows\n`);
  return totalRows;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const yearsBack = parseInt(args.find((_, i, a) => a[i - 1] === '--years') || '4', 10);
  const fromDate = args.find((_, i, a) => a[i - 1] === '--from');
  const reportsOnly = args.includes('--reports');
  const txnsOnly = args.includes('--txns');

  const endDate = new Date();
  const startDate = fromDate
    ? new Date(fromDate)
    : new Date(endDate.getFullYear() - yearsBack, endDate.getMonth(), 1);

  console.log(`\n=== RUBIES Finance Backfill ===`);
  console.log(`  Period: ${formatDate(startDate)} to ${formatDate(endDate)}`);
  console.log(`  Mode: ${reportsOnly ? 'reports only' : txnsOnly ? 'transactions only' : 'full'}\n`);

  const qbo = getQboClient();
  const supabase = getSupabaseClient();

  // Always sync accounts first
  console.log('  Syncing accounts...');
  const accounts = await qbo.getAccounts();
  const now = new Date().toISOString();
  const accountRows = accounts.map(a => ({
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

  for (let i = 0; i < accountRows.length; i += BATCH_SIZE) {
    const batch = accountRows.slice(i, i + BATCH_SIZE);
    const { error } = await supabase
      .from('qbo_accounts')
      .upsert(batch, { onConflict: 'id' });
    if (error) throw new Error(`Accounts upsert failed: ${error.message}`);
  }
  console.log(`  Synced ${accountRows.length} accounts\n`);

  if (!txnsOnly) {
    await backfillReports(qbo, supabase, startDate, endDate);
  }

  if (!reportsOnly) {
    await backfillTransactions(qbo, supabase, startDate, endDate);
  }

  console.log('=== Backfill complete ===\n');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(err => {
  console.error('Backfill FAILED:', err.message);
  process.exit(1);
});
