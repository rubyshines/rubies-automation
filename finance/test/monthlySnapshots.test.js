/**
 * Unit tests for finance/lib/monthlySnapshots.js — the P&L trend-reader filter.
 *
 * Run: node --test finance/test/monthlySnapshots.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { filterMonthlySnapshots } = require('../lib/monthlySnapshots');

const row = (start, end, net) => ({ period_start: start, period_end: end, summary: { netIncome: net } });

describe('filterMonthlySnapshots', () => {
  it('keeps full calendar months, drops YTD/quarter/annual spans', () => {
    const out = filterMonthlySnapshots([
      row('2026-05-01', '2026-05-31', 5),   // month
      row('2026-06-01', '2026-06-30', 6),   // month
      row('2026-01-01', '2026-06-30', 99),  // YTD span
      row('2026-04-01', '2026-06-30', 88),  // quarter span
      row('2026-01-01', '2026-12-31', 77),  // annual span
    ]);
    assert.deepEqual(out.map(r => r.period_start), ['2026-05-01', '2026-06-01']);
  });

  it('dedupes daily current-month partials, keeping the latest period_end', () => {
    const out = filterMonthlySnapshots([
      row('2026-07-01', '2026-07-01', 1),
      row('2026-07-01', '2026-07-05', 3),
      row('2026-07-01', '2026-07-07', 7),   // most complete
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].period_end, '2026-07-07');
    assert.equal(out[0].summary.netIncome, 7);
  });

  it('returns rows ascending by period_start', () => {
    const out = filterMonthlySnapshots([
      row('2026-06-01', '2026-06-30', 6),
      row('2026-04-01', '2026-04-30', 4),
      row('2026-05-01', '2026-05-31', 5),
    ]);
    assert.deepEqual(out.map(r => r.period_start), ['2026-04-01', '2026-05-01', '2026-06-01']);
  });

  it('is timezone-proof — a Dec month is not misclassified across a year boundary', () => {
    const out = filterMonthlySnapshots([row('2025-12-01', '2025-12-31', 12)]);
    assert.equal(out.length, 1);
    assert.equal(out[0].period_start, '2025-12-01');
  });

  it('handles null/empty input and skips malformed rows', () => {
    assert.deepEqual(filterMonthlySnapshots(null), []);
    assert.deepEqual(filterMonthlySnapshots([]), []);
    assert.deepEqual(filterMonthlySnapshots([{ period_start: '2026-05-01' }, null]), []);
  });

  it('one full month plus its daily partials collapses to two rows (prev + current)', () => {
    const out = filterMonthlySnapshots([
      row('2026-06-01', '2026-06-30', 6),   // completed prior month
      row('2026-07-01', '2026-07-03', 2),   // current-month partials
      row('2026-07-01', '2026-07-07', 4),
      row('2026-01-01', '2026-07-07', 50),  // YTD noise
    ]);
    assert.deepEqual(out.map(r => [r.period_start, r.period_end]), [
      ['2026-06-01', '2026-06-30'],
      ['2026-07-01', '2026-07-07'],
    ]);
  });
});
