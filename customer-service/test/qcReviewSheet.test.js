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
  findings: [
    {
      title: 'Sky One Piece strap lengths systematically wrong', verdict: 'real_deviation', severity: 'high',
      scope: 'Sky One Piece · POM K · sizes 9, 13', evidence: 'Size 13 measures ~44 vs 60; size 9 measures long', action: 'Confirm with Kali; possible swapped straps', group_ids: [1],
    },
    {
      title: 'Charlie QC Master hip targets outdated', verdict: 'stale_sheet_target', severity: 'medium',
      scope: 'Charlie Underwear · POM 6 · size 16', evidence: 'All samples cluster at spec target 37', action: 'Update the QC Master from tech_pack_specs', group_ids: [2],
    },
  ],
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

test('buildQcReviewRows puts findings first with the decision column, detail last', () => {
  const { values, boldRows, flagCells, ncol } = buildQcReviewRows(REVIEW, '2026-07-03');
  assert.equal(ncol, 7);

  const flat = values.map((r) => r.join(' | '));
  assert.ok(flat[0].includes('QC Review — KALI-2601 (as of 2026-07-03)'));
  assert.ok(flat[0].includes('1,878 measurements'));
  assert.ok(flat.some((l) => l.includes('🎯 KEY FINDINGS (2)')));
  assert.ok(flat.some((l) => l.includes('❌ FAILED  Sky One Piece')));
  assert.ok(flat.some((l) => l.includes('Packing: Unfinished')));
  assert.ok(flat.some((l) => l.includes('Ordered but NOT sampled: MIA')));

  // findings section: F-ids, verdict labels, empty Decision, colored verdict cells
  const fHeaderIdx = values.findIndex((r) => r[0] === '#');
  const f1 = values[fHeaderIdx + 1];
  assert.equal(f1[0], '❗ F1');
  assert.equal(f1[1], 'Sky One Piece strap lengths systematically wrong');
  assert.equal(f1[4], VERDICT_LABELS.real_deviation);
  assert.equal(f1[6], '');
  const f2 = values[fHeaderIdx + 2];
  assert.equal(f2[0], '⚠️ F2');
  assert.equal(f2[4], VERDICT_LABELS.stale_sheet_target);
  assert.ok(flagCells.some((f) => f.flag === 'real_deviation' && f.col === 4 && f.row === fHeaderIdx + 1));

  // findings come BEFORE the AQL block; detail comes after everything
  const aqlIdx = values.findIndex((r) => String(r[0]).includes('AQL INSPECTION'));
  const detailIdx = values.findIndex((r) => String(r[0]).includes('FULL DETAIL'));
  assert.ok(fHeaderIdx < aqlIdx && aqlIdx < detailIdx, 'findings → AQL → detail order');

  // detail rows trace back to their finding, no Decision column
  const dHeaderIdx = values.findIndex((r) => r[0] === 'Finding' && r[1] === 'Product');
  const d1 = values[dHeaderIdx + 1];
  assert.equal(d1[0], 'F1');
  assert.equal(d1[1], 'Sky One Piece');
  assert.equal(d1[3], 'K — Total Strap Length');
  assert.equal(d1[7], 'BLK: 43.5/44');
  assert.equal(d1[8], '-16.5');
  const d2 = values[dHeaderIdx + 2];
  assert.equal(d2[0], 'F2');
  assert.equal(d2[6], 37, 'spec target column shows the digitized spec');

  assert.ok(flagCells.some((f) => f.flag === 'real_deviation' && f.col === 0), 'failed AQL row highlighted');
  assert.ok(boldRows.includes(fHeaderIdx));
});

test('buildQcReviewRows handles a clean order (no groups)', () => {
  const { values } = buildQcReviewRows({ ...REVIEW, findings: [], groups: [], aql: REVIEW.aql.slice(1), coverage: {} }, '2026-07-03');
  const flat = values.map((r) => r.join(' '));
  assert.ok(flat.some((l) => l.includes('None — every measured sample within tolerance.')));
});

test('buildQcReviewRows untriaged run points at the detail section', () => {
  const { values } = buildQcReviewRows({ ...REVIEW, findings: [] }, '2026-07-03');
  const flat = values.map((r) => r.join(' '));
  assert.ok(flat.some((l) => l.includes('untriaged run — 2 out-of-tolerance groups')));
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
