const { test } = require('node:test');
const assert = require('node:assert');
const { buildVerdict, previousMonthWindow, DELTA_ALARM_PCT } = require('../../lib/billReconcile');

test('previousMonthWindow computes the prior calendar month in UTC', () => {
  const w = previousMonthWindow(new Date('2026-06-01T08:00:00Z'));
  assert.equal(w.startISO, '2026-05-01T00:00:00.000Z');
  assert.equal(w.endISO, '2026-06-01T00:00:00.000Z');
  assert.equal(w.label, '2026-05');
});

test('previousMonthWindow handles January → December rollover', () => {
  const w = previousMonthWindow(new Date('2026-01-01T08:00:00Z'));
  assert.equal(w.label, '2025-12');
});

test('buildVerdict: the verified May 2026 case sits inside tolerance', () => {
  const v = buildVerdict({ billed: 260.34, ledger: 273.91, label: '2026-05' });
  assert.equal(v.delta_usd, 13.57);
  assert.equal(v.delta_pct, 5.2);
  assert.equal(v.alarm, false);
});

test('buildVerdict alarms beyond the tolerance band', () => {
  const v = buildVerdict({ billed: 100, ledger: 100 * (1 + (DELTA_ALARM_PCT + 1) / 100), label: 'x' });
  assert.equal(v.alarm, true);
  const v2 = buildVerdict({ billed: 100, ledger: 50, label: 'x' }); // ledger missing half the spend
  assert.equal(v2.alarm, true);
});

test('buildVerdict handles zero bill without dividing by zero', () => {
  const v = buildVerdict({ billed: 0, ledger: 5, label: 'x' });
  assert.equal(v.delta_pct, null);
  assert.equal(v.alarm, false);
});
