const { test } = require('node:test');
const assert = require('node:assert');
const { evaluateShadowHealth } = require('../lib/shadowEvalGuard');

const advisorRow = (structured, score) => ({
  source: 'advisor',
  sonnet_structured: structured,
  judge_result: score == null ? null : { score },
});
const operatorRow = (score) => ({
  source: 'operator',
  sonnet_structured: null, // operator rows store null by design
  judge_result: score == null ? null : { score },
});

test('kills when advisor null-structured rate hits threshold at min runs', () => {
  const rows = Array.from({ length: 10 }, () => advisorRow(null, 1));
  const v = evaluateShadowHealth(rows);
  assert.strictEqual(v.kill, true);
  assert.match(v.reason, /structured output is null on 10\/10/);
});

test('does not kill below the minimum advisor run count', () => {
  const rows = Array.from({ length: 9 }, () => advisorRow(null, 1));
  assert.strictEqual(evaluateShadowHealth(rows).kill, false);
});

test('does not kill when null rate is below threshold', () => {
  const rows = [
    ...Array.from({ length: 7 }, () => advisorRow(null, 2)),
    ...Array.from({ length: 3 }, () => advisorRow({ status: 'ready' }, 3)),
  ];
  // 70% null < 80% threshold
  assert.strictEqual(evaluateShadowHealth(rows).kill, false);
});

test('kills at exactly the 80% null rate', () => {
  const rows = [
    ...Array.from({ length: 8 }, () => advisorRow(null, 1)),
    ...Array.from({ length: 2 }, () => advisorRow({ status: 'ready' }, 3)),
  ];
  const v = evaluateShadowHealth(rows);
  assert.strictEqual(v.kill, true);
});

test('operator null structured never triggers the null-rate rule', () => {
  // 30 operator rows, all null structured (by design), healthy scores
  const rows = Array.from({ length: 30 }, (_, i) => operatorRow((i % 5) + 1));
  assert.strictEqual(evaluateShadowHealth(rows).kill, false);
});

test('kills on degenerate score distribution: 20 scored rows, none >= 3', () => {
  const rows = Array.from({ length: 20 }, (_, i) => operatorRow(i % 2 === 0 ? 1 : 2));
  const v = evaluateShadowHealth(rows);
  assert.strictEqual(v.kill, true);
  assert.match(v.reason, /degenerate judge distribution on operator: 0 of 20/);
});

test('does not kill degenerate distribution below 20 scored rows', () => {
  const rows = Array.from({ length: 19 }, () => operatorRow(2));
  assert.strictEqual(evaluateShadowHealth(rows).kill, false);
});

test('a single score >= 3 defuses the degeneracy rule', () => {
  const rows = [...Array.from({ length: 24 }, () => operatorRow(2)), operatorRow(3)];
  assert.strictEqual(evaluateShadowHealth(rows).kill, false);
});

test('unscored rows (judge failed) do not count toward the degeneracy minimum', () => {
  const rows = [
    ...Array.from({ length: 15 }, () => operatorRow(2)),
    ...Array.from({ length: 10 }, () => operatorRow(null)),
  ];
  // only 15 scored rows < 20 minimum
  assert.strictEqual(evaluateShadowHealth(rows).kill, false);
});

test('degeneracy is evaluated per source, not pooled', () => {
  // advisor: 12 scored, all bad (below its own 20 minimum after the null rule
  // is defused by populated structured output); operator: 12 scored, healthy.
  // Pooled they'd be 24 scored rows — but neither source alone hits 20.
  const rows = [
    ...Array.from({ length: 12 }, () => advisorRow({ status: 'ready' }, 2)),
    ...Array.from({ length: 12 }, () => operatorRow(4)),
  ];
  assert.strictEqual(evaluateShadowHealth(rows).kill, false);
});

test('empty row set is healthy', () => {
  assert.strictEqual(evaluateShadowHealth([]).kill, false);
});

test('healthy mixed eval does not kill', () => {
  const rows = [
    ...Array.from({ length: 30 }, (_, i) => advisorRow({ status: 'ready' }, (i % 5) + 1)),
    ...Array.from({ length: 30 }, (_, i) => operatorRow((i % 5) + 1)),
  ];
  assert.strictEqual(evaluateShadowHealth(rows).kill, false);
});
