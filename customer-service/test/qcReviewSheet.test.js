const { test } = require('node:test');
const assert = require('node:assert');

const { buildQcReviewRows, renderSamples, VERDICT_LABELS } = require('../lib/merchandising/qcReviewSheet');
const { parseAqlIssues } = require('../lib/merchandising/qcResults');

const REVIEW = {
  order: { production_code: 'KALI-2601' },
  totals: { measurements: 1878, skus_measured: 90, out_of_tolerance: 282 },
  inspector: 'Joyce',
  aql: [
    { product_name: 'Sky One Piece', findings: ['4pcs strap 5cm+ shorter'], majors: 4, minors: 0, passed: false },
    { product_name: 'AJ Underwear', findings: [], majors: 0, minors: 0, passed: true },
  ],
  packing_status: 'Unfinished',
  coverage: { not_sampled: ['MIA'], sampled_not_ordered: [] },
  groups: [
    {
      id: 1, product: 'Sky One Piece', tab: 'Sky One Piece', size: '13', pom_code: 'K', pom_name: 'Total Strap Length',
      tolerance_cm: 0.75, sheet_target: 60, spec_target: 60,
      samples: [{ color: 'BLK', measured_cm: 43.5, diff_cm: -16.5 }, { color: 'BLK', measured_cm: 44, diff_cm: -16 }],
      worst_diff: -16.5, verdict: 'real_deviation', why: 'Matches the inspector finding.',
    },
    {
      id: 2, product: 'Charlie Underwear', tab: 'Charlie Underwear', size: '16', pom_code: '6', pom_name: 'Hip',
      tolerance_cm: 1, sheet_target: 29.5, spec_target: 37,
      samples: [{ color: 'BLK', measured_cm: 38.5, diff_cm: 9 }, { color: 'SND', measured_cm: 39, diff_cm: 9.5 }],
      worst_diff: 9.5, verdict: 'stale_sheet_target', why: 'Measurements cluster at the spec target.',
    },
  ],
};

test('renderSamples groups values per color compactly', () => {
  assert.equal(
    renderSamples([
      { color: 'BLK', measured_cm: 43.5 }, { color: 'BLK', measured_cm: 44 }, { color: 'PNK', measured_cm: 45 },
    ]),
    'BLK: 43.5/44 · PNK: 45'
  );
});

test('buildQcReviewRows lays out header, AQL, coverage, groups and decision column', () => {
  const { values, boldRows, flagCells, ncol } = buildQcReviewRows(REVIEW, '2026-07-03');
  assert.equal(ncol, 11);

  const flat = values.map((r) => r.join(' | '));
  assert.ok(flat[0].includes('QC Review — KALI-2601 (as of 2026-07-03)'));
  assert.ok(flat[0].includes('1,878 measurements'));
  assert.ok(flat.some((l) => l.includes('❌ FAILED  Sky One Piece')));
  assert.ok(flat.some((l) => l.includes('✅ PASSED  AJ Underwear')));
  assert.ok(flat.some((l) => l.includes('Packing: Unfinished')));
  assert.ok(flat.some((l) => l.includes('Ordered but NOT sampled: MIA')));

  // group rows: worst first, verdict label rendered, decision cell empty
  const headerIdx = values.findIndex((r) => r[0] === 'Product');
  const g1 = values[headerIdx + 1];
  assert.equal(g1[0], 'Sky One Piece');
  assert.equal(g1[2], 'K — Total Strap Length');
  assert.equal(g1[3], '±0.75');
  assert.equal(g1[6], 'BLK: 43.5/44');
  assert.equal(g1[7], '-16.5');
  assert.equal(g1[8], VERDICT_LABELS.real_deviation);
  assert.equal(g1[10], '');
  const g2 = values[headerIdx + 2];
  assert.equal(g2[8], VERDICT_LABELS.stale_sheet_target);
  assert.equal(g2[5], 37, 'spec target column shows the digitized spec');

  // verdict cells get flag colors; AQL failed row flagged too
  assert.ok(flagCells.some((f) => f.flag === 'real_deviation' && f.col === 8));
  assert.ok(flagCells.some((f) => f.flag === 'stale_sheet_target' && f.col === 8));
  assert.ok(flagCells.some((f) => f.flag === 'real_deviation' && f.col === 0), 'failed AQL row highlighted');
  assert.ok(boldRows.includes(headerIdx));
});

test('buildQcReviewRows handles a clean order (no groups)', () => {
  const { values } = buildQcReviewRows({ ...REVIEW, groups: [], aql: REVIEW.aql.slice(1), coverage: {} }, '2026-07-03');
  const flat = values.map((r) => r.join(' '));
  assert.ok(flat.some((l) => l.includes('None — every measured sample within tolerance.')));
});

test('parseAqlIssues rebuilds structured AQL results from issue descriptions', () => {
  const issues = [
    { description: '[Brooke Bra] 7pcs underbust 2cm smaller — AQL 2.5 · sampled 50 · majors 7 / minors 4 · FAILED' },
    { description: '[Brooke Bra] 4pcs threads not trimmed well — AQL 2.5 · sampled 50 · majors 7 / minors 4 · FAILED' },
    { description: '[AJ Underwear] No defects found — AQL 2.5 · sampled 80 · majors 0 / minors 0 · PASSED' },
    { description: '[Packing] Unfinished' },
  ];
  const aql = parseAqlIssues(issues);
  assert.equal(aql.length, 2, 'packing row excluded');
  const brooke = aql.find((p) => p.product_name === 'Brooke Bra');
  assert.equal(brooke.passed, false);
  assert.equal(brooke.majors, 7);
  assert.equal(brooke.findings.length, 2);
  const aj = aql.find((p) => p.product_name === 'AJ Underwear');
  assert.equal(aj.passed, true);
  assert.deepEqual(aj.findings, []);
  assert.equal(aql[0].product_name, 'Brooke Bra', 'failed products sort first');
});
