const { test } = require('node:test');
const assert = require('node:assert');
const XLSX = require('xlsx');

const {
  parseTolerance, splitSkuLabel, parseSizeLabel, parseSheet, resolveSku, flattenMeasurements,
} = require('../lib/merchandising/qcSheetParser');
const { validateAgainstSpecs } = require('../lib/merchandising/qcResults');

// --- helpers -----------------------------------------------------------------

// Build a sheet replicating the real QC Master geometry: two size blocks side
// by side (anchors E and Q), 3 colors × 3 samples on the left block, header
// rows offset exactly like the real files (size at H-3, SKU at H-2, colors at
// H-1). Numbers must be real numbers (raw cells), like XLSX.readFile returns.
function buildTestSheet() {
  const rows = [];
  rows[0] = ['', '', '', '', 'Note measurements are in cms'];
  rows[2] = ['', '', '', '', 'Size 12 / XS', '', '', '', '', '', '', '', '', '', '', '', 'Size 1X'];
  rows[3] = ['', '', '', '', 'AJ-BLK-12 / AJ-BLK-XS', '', '', '', '', '', '', '', '', '', '', '', 'AJ-BLK-1X'];
  rows[4] = ['', '', '', '', '', 'BLK', 'BLK', 'BLK', 'PNK', 'PNK', 'PNK', 'SND', 'SND', 'SND', '', '', '', 'BLK', 'BLK', 'BLK'];
  rows[5] = ['POM #', 'Garment Specification', 'Tolerance', '', 'Orig', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'Diff', '', 'Orig', '1', '2', '3', 'Diff'];
  rows[6] = ['1', 'Waist (1/2 of total)', '+/-0.75', '', 31.5, 31.2, 31.4, '', 33.0, '', '', '', '', '', -0.1, '', 44.5, 43.0, '', '', -1.5];
  rows[7] = ['2', 'Front Rise', '+/-0.75', '', 25.6, '', '', '', '', '', '', '', '', '', '', '', 31.6, 31.5, '', '', -0.1];
  return XLSX.utils.aoa_to_sheet(rows.map((r) => r || []));
}

const CATALOG = new Set(['AJ-BLK-12', 'AJ-PNK-12', 'AJ-BLK-XL', 'SPB-BLK-M', 'TNK-BLK-L']);

// --- unit pieces ---------------------------------------------------------------

test('parseTolerance handles +/- and ± forms', () => {
  assert.equal(parseTolerance('+/-0.75'), 0.75);
  assert.equal(parseTolerance('+/-1'), 1);
  assert.equal(parseTolerance('± 1.25'), 1.25);
  assert.equal(parseTolerance(''), null);
  assert.equal(parseTolerance(null), null);
});

test('splitSkuLabel parses single, slash and comma variants', () => {
  assert.deepEqual(splitSkuLabel('AJ-BLK-4'), [{ prefix: 'AJ', color: 'BLK', size: '4' }]);
  assert.deepEqual(splitSkuLabel('AJ-BLK-12 / AJ-BLK-XS'), [
    { prefix: 'AJ', color: 'BLK', size: '12' },
    { prefix: 'AJ', color: 'BLK', size: 'XS' },
  ]);
  assert.deepEqual(splitSkuLabel('AJ-BLK-14, AJ-BLK-M')[1], { prefix: 'AJ', color: 'BLK', size: 'M' });
  // Leading whitespace (seen on the real Sky tab: " SKY2-BLK-ST")
  assert.deepEqual(splitSkuLabel(' SKY2-BLK-ST'), [{ prefix: 'SKY2', color: 'BLK', size: 'ST' }]);
});

test('parseSizeLabel strips the Size prefix', () => {
  assert.equal(parseSizeLabel('Size 12 / XS'), '12 / XS');
  assert.equal(parseSizeLabel('Size  1X'), '1X');
});

// --- grid walk -----------------------------------------------------------------

test('parseSheet detects blocks, tolerances, targets and samples from the grid', () => {
  const { blocks } = parseSheet(buildTestSheet(), 'AJ Underwear');
  assert.equal(blocks.length, 2);

  const [left, right] = blocks;
  assert.equal(left.size_label, '12 / XS');
  assert.equal(left.sku_variants.length, 2);
  assert.equal(left.pom_rows.length, 2);

  const waist = left.pom_rows[0];
  assert.equal(waist.pom_code, '1');
  assert.equal(waist.tolerance_cm, 0.75);
  assert.equal(waist.target_cm, 31.5);
  // 2 BLK samples + 1 PNK sample were filled
  assert.deepEqual(waist.samples.map((s) => [s.color, s.measured_cm]), [['BLK', 31.2], ['BLK', 31.4], ['PNK', 33.0]]);
  // sample numbers come from the header (global within the block)
  assert.deepEqual(waist.samples.map((s) => s.sample_number), [1, 2, 4]);

  // empty POM row yields no samples but keeps the target
  assert.equal(left.pom_rows[1].samples.length, 0);
  assert.equal(left.pom_rows[1].target_cm, 25.6);

  assert.equal(right.size_label, '1X');
  assert.equal(right.pom_rows[0].target_cm, 44.5);
  assert.deepEqual(right.pom_rows[0].samples, [{ sample_number: 1, color: 'BLK', measured_cm: 43.0 }]);
});

test('parseSheet detects the unit note (cm default, inches flagged)', () => {
  assert.equal(parseSheet(buildTestSheet(), 'AJ Underwear').unit, 'cm');
  const ws = XLSX.utils.aoa_to_sheet([
    ['', '', '', '', 'Note measurements are in inches'],
    [],
    ['', '', '', '', 'Size 4'],
    ['', '', '', '', 'TNK-BLK-4'],
    ['', '', '', '', '', 'BLK'],
    ['POM #', 'Garment Specification', 'Tolerance', '', 'Orig', '1', 'Diff'],
    ['A', 'Flat Chest', '+/-0.75', '', 25.9, 26.0, 0.1],
  ]);
  assert.equal(parseSheet(ws, 'Sunny Tankini').unit, 'inches');
});

// --- SKU resolution --------------------------------------------------------------

test('resolveSku picks the label variant that exists in the catalog', () => {
  const block = { size_label: '12 / XS', sku_variants: splitSkuLabel('AJ-BLK-12 / AJ-BLK-XS') };
  const res = resolveSku(block, 'BLK', { catalog: CATALOG });
  assert.equal(res.sku, 'AJ-BLK-12');
  assert.equal(res.matched, 'exact');
});

test('resolveSku substitutes the sample color into the label template', () => {
  const block = { size_label: '12 / XS', sku_variants: splitSkuLabel('AJ-BLK-12 / AJ-BLK-XS') };
  const res = resolveSku(block, 'PNK', { catalog: CATALOG });
  assert.equal(res.sku, 'AJ-PNK-12');
});

test('resolveSku applies the plus-size alias rule (1X -> XL)', () => {
  const block = { size_label: '1X', sku_variants: splitSkuLabel('AJ-BLK-1X') };
  const res = resolveSku(block, 'BLK', { catalog: CATALOG });
  assert.equal(res.sku, 'AJ-BLK-XL');
  assert.equal(res.matched, 'alias');
});

test('resolveSku remaps via tab-scoped expected prefix (AVA label -> SPB catalog)', () => {
  const block = { size_label: 'M', sku_variants: splitSkuLabel('AVA-BLK-M') };
  const res = resolveSku(block, 'BLK', { expectedPrefix: 'SPB', catalog: CATALOG });
  assert.equal(res.sku, 'SPB-BLK-M');
  assert.equal(res.original, 'AVA-BLK-M');
});

test('resolveSku falls back to the size label when the SKU label size is a typo', () => {
  // Real case: SKY2-BLK-11X label under a "Size 1X" block
  const catalog = new Set(['SKY2-BLK-XL']);
  const block = { size_label: '1X', sku_variants: splitSkuLabel('SKY2-BLK-11X') };
  const res = resolveSku(block, 'BLK', { catalog });
  assert.equal(res.sku, 'SKY2-BLK-XL');
});

test('resolveSku never invents a SKU — unknown kept and flagged', () => {
  const block = { size_label: 'M', sku_variants: splitSkuLabel('CT-BLK-M') };
  const res = resolveSku(block, 'BLK', { catalog: CATALOG });
  assert.equal(res.matched, 'unknown');
  assert.equal(res.sku, 'CT-BLK-M');
});

// --- flatten + tolerance flags -----------------------------------------------------

test('flattenMeasurements computes diff and in_tolerance per sample', () => {
  const parsed = { tabs: [parseSheet(buildTestSheet(), 'AJ Underwear')] };
  const { rows } = flattenMeasurements(parsed, { catalog: CATALOG });

  const blk1 = rows.find((r) => r.sku === 'AJ-BLK-12' && r.sample_number === 1);
  assert.equal(blk1.diff_cm, -0.3);
  assert.equal(blk1.in_tolerance, true);

  const pnk = rows.find((r) => r.sku === 'AJ-PNK-12');
  assert.equal(pnk.diff_cm, 1.5);
  assert.equal(pnk.in_tolerance, false);

  // right block: 43.0 vs 44.5 = -1.5 vs ±0.75 -> out, via the 1X->XL alias
  const xl = rows.find((r) => r.sku === 'AJ-BLK-XL');
  assert.equal(xl.in_tolerance, false);
  assert.equal(xl.size, 'XL');
});

test('flattenMeasurements boundary: |diff| exactly at tolerance is in-tolerance', () => {
  const ws = XLSX.utils.aoa_to_sheet([
    [], [],
    ['', '', '', '', 'Size M'],
    ['', '', '', '', 'SPB-BLK-M'],
    ['', '', '', '', '', 'BLK'],
    ['POM #', 'Garment Specification', 'Tolerance', '', 'Orig', '1', 'Diff'],
    ['A', 'Flat Chest', '+/-0.75', '', 40.0, 40.75, 0.75],
  ]);
  const parsed = { tabs: [parseSheet(ws, 'Evey Sports Bra')] };
  const { rows } = flattenMeasurements(parsed, { catalog: CATALOG });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].in_tolerance, true);
});

test('flattenMeasurements reports remapped and unknown SKUs without dropping rows', () => {
  const ws = XLSX.utils.aoa_to_sheet([
    [], [],
    ['', '', '', '', 'Size M'],
    ['', '', '', '', 'AVA-BLK-M'],
    ['', '', '', '', '', 'BLK'],
    ['POM #', 'Garment Specification', 'Tolerance', '', 'Orig', '1', 'Diff'],
    ['A', 'Flat Chest', '+/-0.75', '', 40.0, 41.0, 1.0],
  ]);
  const parsed = { tabs: [parseSheet(ws, 'Evey Sports Bra')] };
  const { rows, remapped } = flattenMeasurements(parsed, { catalog: CATALOG, expectedPrefixByTab: { 'Evey Sports Bra': 'SPB' } });
  assert.equal(rows[0].sku, 'SPB-BLK-M');
  assert.deepEqual(remapped, [{ tab: 'Evey Sports Bra', from: 'AVA-BLK-M', to: 'SPB-BLK-M' }]);

  const unk = flattenMeasurements(parsed, { catalog: new Set() });
  assert.equal(unk.unknown.length, 1);
  assert.equal(unk.rows.length, 1, 'unknown SKU rows are kept, not dropped');
});

// --- spec validation -----------------------------------------------------------------

test('validateAgainstSpecs matches by pom_code, falls back to name, flags target drift', () => {
  const rows = [
    { tab: 'AJ Underwear', size: '12', pom_code: '1', pom_name: 'Waist (1/2 of total)', target_cm: 31.5 },
    { tab: 'AJ Underwear', size: '12', pom_code: '2', pom_name: 'Front Rise', target_cm: 26.0 }, // spec says 25.6
    { tab: 'Sassy Underwear', size: 'M', pom_code: '1', pom_name: 'Waist (1/2 of total)', target_cm: 36.0 }, // sassy specs use letters -> name match
  ];
  const specs = [
    { product_handle: 'aj', size: '12', pom_code: '1', pom_name: 'Waist (1/2 of total)', target_cm: 31.5 },
    { product_handle: 'aj', size: '12', pom_code: '2', pom_name: 'frontRise (Waist to Crotch seam)', target_cm: 25.6 },
    { product_handle: 'sassy', size: 'M', pom_code: 'A', pom_name: 'Waist (1/2 of total)', target_cm: 36.0 },
  ];
  const { mismatches, unmatched } = validateAgainstSpecs(rows, specs);
  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0].pom_code, '2');
  assert.equal(mismatches[0].delta, 0.4);
  assert.equal(unmatched.length, 0, 'sassy letter-code spec matched via normalized name');
});

test('validateAgainstSpecs handles combined size aliases (16 / M vs stored 16)', () => {
  const rows = [{ tab: 'AJ Underwear', size: '16 / M', pom_code: '1', pom_name: 'Waist', target_cm: 36.7 }];
  const specs = [{ product_handle: 'aj', size: '16', pom_code: '1', pom_name: 'Waist (1/2 of total)', target_cm: 36.7 }];
  const { mismatches, unmatched } = validateAgainstSpecs(rows, specs);
  assert.equal(mismatches.length + unmatched.length, 0);
});
