const { test } = require('node:test');
const assert = require('node:assert');
const { evaluateSpendCap, startOfUtcMonth } = require('../../lib/aiSpendCap');

test('no cap configured → level no_cap, still reports MTD', () => {
  const r = evaluateSpendCap({ mtdUsd: 123.456, capUsd: null });
  assert.equal(r.level, 'no_cap');
  assert.equal(r.mtd_usd, 123.46);
  assert.equal(r.cap_usd, null);
});

test('spend well under cap → ok', () => {
  const r = evaluateSpendCap({ mtdUsd: 100, capUsd: 1000 });
  assert.equal(r.level, 'ok');
  assert.equal(r.pct, 0.1);
});

test('spend at/over warn threshold (80%) → warn', () => {
  assert.equal(evaluateSpendCap({ mtdUsd: 800, capUsd: 1000 }).level, 'warn');
  assert.equal(evaluateSpendCap({ mtdUsd: 850, capUsd: 1000 }).level, 'warn');
});

test('spend just below warn threshold → ok', () => {
  assert.equal(evaluateSpendCap({ mtdUsd: 799, capUsd: 1000 }).level, 'ok');
});

test('spend at/over cap → over', () => {
  assert.equal(evaluateSpendCap({ mtdUsd: 1000, capUsd: 1000 }).level, 'over');
  assert.equal(evaluateSpendCap({ mtdUsd: 1200, capUsd: 1000 }).level, 'over');
});

test('custom warn threshold respected', () => {
  assert.equal(evaluateSpendCap({ mtdUsd: 500, capUsd: 1000, warnPct: 0.5 }).level, 'warn');
  assert.equal(evaluateSpendCap({ mtdUsd: 490, capUsd: 1000, warnPct: 0.5 }).level, 'ok');
});

test('startOfUtcMonth returns first instant of the month in UTC', () => {
  const s = startOfUtcMonth(new Date('2026-05-27T06:01:00Z'));
  assert.equal(s, '2026-05-01T00:00:00.000Z');
});
