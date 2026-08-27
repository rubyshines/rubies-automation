/**
 * Guards the two extraction bugs found 2026-08-27 while tracing related-party
 * capital flows:
 *   1. Transfer rows carry `Amount` + To/FromAccountRef, never `TotalAmt`/`Line`,
 *      so they landed with total_amount = null and line_items = null. Every
 *      query that walks line items silently skipped the whole class.
 *   2. BalanceSheet ignored its as-of date unless start_date was also sent.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const {
  normalizeLines,
  extractTotalAmount,
  extractAccountId,
} = require('../sync/syncFinance');

const TRANSFER = {
  Id: '8131',
  TxnDate: '2024-06-13',
  Amount: 30000,
  PrivateNote: 'payment to JATA loan',
  CurrencyRef: { value: 'CAD' },
  FromAccountRef: { name: 'Wise.com CAD', value: '190' },
  ToAccountRef: { name: 'Loans from affiliates:JATA', value: '211' },
  _txnType: 'Transfer',
};

test('Transfer amount is read from Amount, not TotalAmt', () => {
  assert.strictEqual(extractTotalAmount(TRANSFER), 30000);
});

test('Transfer normalises into debit/credit lines naming both accounts', () => {
  const lines = normalizeLines(TRANSFER);
  assert.strictEqual(lines.length, 2);

  const debit = lines.find(l => l.JournalEntryLineDetail.PostingType === 'Debit');
  const credit = lines.find(l => l.JournalEntryLineDetail.PostingType === 'Credit');

  // Money moves FROM source TO destination: debit destination, credit source.
  assert.strictEqual(debit.JournalEntryLineDetail.AccountRef.name, 'Loans from affiliates:JATA');
  assert.strictEqual(credit.JournalEntryLineDetail.AccountRef.name, 'Wise.com CAD');
  assert.strictEqual(debit.Amount, 30000);
  assert.strictEqual(credit.Amount, 30000);
});

test('a normalised Transfer is visible to an AccountRef traversal', () => {
  // This is the exact traversal shape used by capital-flow analysis, and the
  // one that returned nothing for Transfers before the fix.
  const names = [];
  for (const line of normalizeLines(TRANSFER) || []) {
    for (const key of Object.keys(line)) {
      const ref = line[key] && line[key].AccountRef;
      if (ref && ref.name) names.push(ref.name);
    }
  }
  assert.ok(names.includes('Loans from affiliates:JATA'));
});

test('accepts an explicit txnType, since backfillHistory has no _txnType', () => {
  const { _txnType, ...withoutType } = TRANSFER;
  assert.strictEqual(normalizeLines(withoutType, 'Transfer').length, 2);
  // Without the type it cannot be identified, and must not invent lines.
  assert.strictEqual(normalizeLines(withoutType, undefined), null);
});

test('non-Transfer types are passed through untouched', () => {
  const purchase = {
    TotalAmt: 17.06,
    Line: [{ Amount: 17.06, AccountBasedExpenseLineDetail: { AccountRef: { name: 'Travel' } } }],
    _txnType: 'Purchase',
  };
  assert.strictEqual(normalizeLines(purchase), purchase.Line);
  assert.strictEqual(extractTotalAmount(purchase), 17.06);
});

test('a Transfer missing either side yields null rather than a half entry', () => {
  assert.strictEqual(normalizeLines({ Amount: 100, ToAccountRef: { name: 'x' }, _txnType: 'Transfer' }), null);
  assert.strictEqual(normalizeLines({ ToAccountRef: { name: 'x' }, FromAccountRef: { name: 'y' }, _txnType: 'Transfer' }), null);
});

test('extractAccountId falls back to the Transfer destination', () => {
  assert.strictEqual(extractAccountId(TRANSFER), '211');
});

test('getBalanceSheet sends start_date, or QBO ignores the as-of date', () => {
  // Rebuilding the client needs live credentials, so assert on the source: the
  // failure mode is silent (correct-looking report for the wrong period), which
  // is precisely why it survived 354 snapshots unnoticed.
  const src = require('fs').readFileSync(require.resolve('../lib/qbo.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function getBalanceSheet'));
  const body = fn.slice(0, fn.indexOf('\n  }'));
  assert.ok(/start_date:\s*BALANCE_SHEET_EPOCH/.test(body), 'getBalanceSheet must pass start_date');
  assert.ok(!/start_date:\s*undefined/.test(body), 'start_date must not be undefined');
});
