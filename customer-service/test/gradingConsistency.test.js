const { test } = require('node:test');
const assert = require('node:assert');
const { sizeRank, analyzePom, analyzeGrading } = require('../lib/merchandising/gradingConsistency');

test('sizeRank orders numeric before letter and resolves aliases', () => {
  assert.ok(sizeRank('4') < sizeRank('16'));
  assert.ok(sizeRank('16') < sizeRank('XXS'));
  assert.ok(sizeRank('S') < sizeRank('L'));
  assert.ok(sizeRank('L') < sizeRank('2X'));
  // combined alias "12 / XS" ranks on first parseable token (12)
  assert.strictEqual(sizeRank('12 / XS'), sizeRank('12'));
  assert.strictEqual(sizeRank('nonsense'), -1);
});

test('FIXED: constant step across sizes', () => {
  const r = analyzePom({ '8': 20, '10': 21.3, '12': 22.6, '14': 23.9 });
  assert.strictEqual(r.pattern, 'FIXED');
  assert.strictEqual(r.anomalies.length, 0);
});

test('PATTERNED: monotonic with an intentional youth->adult step change, no anomalies', () => {
  // steps: 1.3, 1.3, then a sustained doubling to 2.6 (intentional grade-rule change)
  const r = analyzePom({ '12': 30, '13': 31.3, '14': 32.6, '16': 35.2, 'L': 37.8 });
  assert.strictEqual(r.pattern, 'PATTERNED');
  assert.strictEqual(r.anomalies.length, 0);
});

test('ANOMALY: decimal slip (Mia CF 9.6 -> 96.0) flags non-monotonic + outlier', () => {
  const r = analyzePom({ '4': 9.5, '6': 9.5, '8': 96.0, '10': 9.6 });
  assert.strictEqual(r.pattern, 'ANOMALY');
  assert.ok(r.anomalies.some(a => a.kind === 'value_outlier'));
  // the offending size 8 is pinpointed
  assert.ok(r.anomalies.some(a => a.size === '8' || a.from === '8' || a.to === '8'));
});

test('ANOMALY: dropped digit (Stella front rise 34.70 -> 24.70) breaks monotonicity', () => {
  const r = analyzePom({ '9': 32.0, '11': 24.7, '12': 35.5, '13': 36.5 });
  assert.strictEqual(r.pattern, 'ANOMALY');
  assert.ok(r.anomalies.some(a => a.kind === 'non_monotonic'));
});

test('INSUFFICIENT: fewer than 3 valid sizes', () => {
  const r = analyzePom({ 'S': 30, 'M': 32 });
  assert.strictEqual(r.pattern, 'INSUFFICIENT');
});

test('unparseable cell values are dropped, not crashed', () => {
  // "50..8" and "33." can't parse -> excluded; remaining run still analyzed
  const r = analyzePom({ '8': 20, '10': 21.3, '12': '50..8', '14': 23.9, '16': 25.2 });
  assert.ok(['FIXED', 'PATTERNED', 'ANOMALY'].includes(r.pattern));
  assert.ok(r.points.every(p => typeof p.target === 'number'));
});

test('analyzeGrading rolls up products + flat anomaly list', () => {
  const specs = {
    aj: {
      '1': { pom_name: 'Waist', tolerance_cm: 0.75, sizes: { '8': 21.8, '10': 23.7, '12': 26.3, '14': 28.9 } },
    },
    mia: {
      'C': { pom_name: 'Center Front', tolerance_cm: 0.75, sizes: { '4': 9.5, '6': 9.5, '8': 96.0, '10': 9.6 } },
    },
  };
  const out = analyzeGrading(specs);
  assert.strictEqual(out.summary.products, 2);
  assert.strictEqual(out.summary.poms, 2);
  assert.ok(out.summary.anomalies >= 1);
  assert.ok(out.anomalies.every(a => a.product_handle && a.pom_code));
  assert.ok(out.anomalies.some(a => a.product_handle === 'mia'));
});
