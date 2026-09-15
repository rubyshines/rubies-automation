const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const XLSX = require('xlsx');
const ExcelJS = require('exceljs');

const { buildQcTab, writeQcWorkbook, colourOrder, specSizeKey, toleranceForSize } = require('../lib/merchandising/qcSheetWriter');
const { QC_PRODUCTS, TAB_HANDLES, qcProductForPrefix, findQcProducts } = require('../lib/merchandising/qcProducts');
const { parseSheet, flattenMeasurements } = require('../lib/merchandising/qcSheetParser');

// --- fixtures ------------------------------------------------------------------

// A gaff-shaped spec: letter sizes, two POMs, one tolerance, sort_order set.
function specs() {
  const targets = {
    A: { XS: 30.03, S: 32.53, M: 35.03, L: 37.53, '1X': 40.03 },
    B: { XS: 22.27, S: 23.57, M: 24.87, L: 26.17, '1X': 27.47 },
  };
  const rows = [];
  for (const [code, sizes] of Object.entries(targets)) {
    for (const [size, target_cm] of Object.entries(sizes)) {
      rows.push({ product_handle: 'naomi', size, pom_code: code, pom_name: code === 'A' ? 'Waist (1/2 of total)' : 'FRONT RISE', target_cm, tolerance_cm: 0.75, sort_order: code === 'A' ? 0 : 1 });
    }
  }
  return rows;
}

// Order SKUs in warehouse spelling (XL is the 1X), deliberately out of size order.
const SKUS = ['GAF-BLK-M', 'GAF-BLK-XS', 'GAF-BLK-XL', 'GAF-BLK-S', 'GAF-BLK-L'];

// --- pure layout -----------------------------------------------------------------

test('buildQcTab lays sizes out in chart order, bands break where the tolerance steps up, 1X label for the XL SKU', () => {
  const tab = buildQcTab({ tabName: 'Naomi Gaff', prefix: 'GAF', skus: SKUS, specs: specs(), samplesPerColor: 3 });
  assert.deepEqual(tab.sizes, ['XS', 'S', 'M', 'L', '1X']);
  assert.deepEqual(tab.colours, ['BLK']);
  assert.equal(tab.blocks.length, 5);
  assert.deepEqual(tab.poms, ['A', 'B']);
  assert.deepEqual(tab.sizesWithoutSpec, []);

  // Band 1 holds XS/S (±0.75); M/L/1X (±1) start a new band below it.
  const [xs, s, m, l, x1] = tab.blocks;
  assert.equal(xs.sizeRow, s.sizeRow);
  assert.ok(m.sizeRow > xs.headerRow);
  assert.equal(m.sizeRow, l.sizeRow);
  assert.equal(x1.sizeRow, m.sizeRow);
  assert.equal(m.anchor, xs.anchor);
  assert.equal(l.anchor, s.anchor);
  assert.deepEqual(tab.blocks.map((b) => b.tolerance), [0.75, 0.75, 1, 1, 1]);

  // Geometry the parser relies on: size at H-3, SKU at H-2, colours at H-1, header at H.
  assert.equal(tab.rows[xs.headerRow][0], 'POM #');
  assert.equal(tab.rows[xs.sizeRow][xs.anchor], 'Size XS');
  assert.equal(tab.rows[xs.skuRow][xs.anchor], 'GAF-BLK-XS');
  assert.equal(tab.rows[x1.sizeRow][x1.anchor], 'Size 1X');
  assert.equal(tab.rows[x1.skuRow][x1.anchor], 'GAF-BLK-1X');
  assert.equal(tab.rows[xs.headerRow][xs.anchor], 'Orig');
  assert.deepEqual(xs.sampleCols.map((c) => tab.rows[xs.headerRow][c.col]), ['1', '2', '3']);
  assert.deepEqual(xs.sampleCols.map((c) => tab.rows[xs.colourRow][c.col]), ['BLK', 'BLK', 'BLK']);
  assert.equal(tab.rows[xs.headerRow][xs.diffCol], 'Diff');
  assert.equal(xs.diffCol, xs.anchor + 4);
  assert.equal(s.anchor, xs.diffCol + 2); // one spacer column between blocks

  // POM rows: code / name / tolerance on the left, target at the anchor.
  const waist = xs.pomRows[0];
  assert.equal(tab.rows[waist.row][0], 'A');
  assert.equal(tab.rows[waist.row][1], 'Waist (1/2 of total)');
  assert.equal(tab.rows[waist.row][2], '+/-0.75');
  assert.equal(tab.rows[waist.row][xs.anchor], 30.03);
  assert.equal(tab.rows[x1.pomRows[0].row][x1.anchor], 40.03); // 1X sits in the second band, on its own waist row
  assert.equal(tab.rows[x1.pomRows[0].row][2], '+/-1');
  assert.equal(tab.rows[xs.pomRows[1].row][xs.anchor], 22.27);
  assert.equal(tab.rows[0][xs.anchor], 'Note measurements are in cms');
});

test('buildQcTab: two colours give colour-grouped sample columns and a BLK SKU label', () => {
  const tab = buildQcTab({ tabName: 'AJ Underwear', prefix: 'AJ', skus: ['AJ-PNK-M', 'AJ-BLK-M'], specs: [{ size: 'M', pom_code: '1', pom_name: 'Waist', target_cm: 35, tolerance_cm: 1, sort_order: 0 }], samplesPerColor: 2 });
  const [m] = tab.blocks;
  assert.deepEqual(tab.colours, ['BLK', 'PNK']);
  assert.deepEqual(m.sampleCols.map((c) => c.colour), ['BLK', 'BLK', 'PNK', 'PNK']);
  assert.deepEqual(m.sampleCols.map((c) => c.sample_number), [1, 2, 3, 4]);
  assert.equal(tab.rows[m.skuRow][m.anchor], 'AJ-BLK-M');
  assert.equal(tab.rows[m.pomRows[0].row][2], '+/-1');
});

test('buildQcTab: sizes sharing one spec size ("12 / XS") share a block; sizes with no spec get blank targets and are reported', () => {
  const sp = [
    { size: '12 / XS', pom_code: '1', pom_name: 'Waist', target_cm: 31.5, tolerance_cm: 0.75, sort_order: 0 },
    { size: '14 / S', pom_code: '1', pom_name: 'Waist', target_cm: 34.1, tolerance_cm: 0.75, sort_order: 0 },
  ];
  const tab = buildQcTab({ tabName: 'AJ Underwear', prefix: 'AJ', skus: ['AJ-BLK-12', 'AJ-BLK-XS', 'AJ-BLK-14', 'AJ-BLK-4'], specs: sp, samplesPerColor: 1 });
  assert.equal(tab.blocks.length, 3);
  const [four, twelve, fourteen] = tab.blocks;
  assert.equal(tab.rows[four.sizeRow][four.anchor], 'Size 4');
  assert.equal(four.pomRows[0].target_cm, null);
  assert.deepEqual(tab.sizesWithoutSpec, ['4']);
  assert.equal(tab.rows[twelve.sizeRow][twelve.anchor], 'Size 12 / XS');
  assert.equal(tab.rows[twelve.skuRow][twelve.anchor], 'AJ-BLK-12 / AJ-BLK-XS');
  assert.equal(twelve.pomRows[0].target_cm, 31.5);
  assert.equal(tab.rows[fourteen.sizeRow][fourteen.anchor], 'Size 14');
  assert.equal(fourteen.pomRows[0].target_cm, 34.1);
});

test('toleranceForSize follows the house convention across youth, plus and tall sizes', () => {
  for (const s of ['4', '8', '10', '12', '14', 'XXS', 'XXS+', 'XS', 'XS+', 'S', 'S Tall', 'ST']) assert.equal(toleranceForSize(s), 0.75, s);
  for (const s of ['16', 'M', 'L', '1X', 'XL', 'M Tall', 'LT', 'XLT']) assert.equal(toleranceForSize(s), 1, s);
  for (const s of ['2X', '3X', '4X', '2XL', '4XL', '2X Tall']) assert.equal(toleranceForSize(s), 1.25, s);
});

test('a full adult run bands as XS/S | M/L/1X | 2X/3X/4X, never more than 3 across', () => {
  const skus = ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL'].map((s) => `GAF-BLK-${s}`);
  const tab = buildQcTab({ tabName: 'Naomi Gaff', prefix: 'GAF', skus, specs: [], samplesPerColor: 3 });
  const bands = [...new Set(tab.blocks.map((b) => b.sizeRow))].map((row) => tab.blocks.filter((b) => b.sizeRow === row).map((b) => b.sizes[0]));
  assert.deepEqual(bands, [['XS', 'S'], ['M', 'L', '1X'], ['2X', '3X', '4X']]);
  assert.deepEqual(tab.sizesWithoutSpec, ['XS', 'S', 'M', 'L', '1X', '2X', '3X', '4X']);
});

test('colourOrder puts BLK first and keeps the rest in order of appearance', () => {
  assert.deepEqual(colourOrder(['SND', 'PNK', 'BLK', 'PNK']), ['BLK', 'SND', 'PNK']);
  assert.deepEqual(colourOrder(['PNK']), ['PNK']);
});

test('specSizeKey matches a plain size or a token of a combined size', () => {
  assert.equal(specSizeKey(['12 / XS', '14 / S', '1X'], 'XS'), '12 / XS');
  assert.equal(specSizeKey(['12 / XS', '14 / S', '1X'], '1X'), '1X');
  assert.equal(specSizeKey(['12 / XS'], '4'), null);
});

// --- xlsx round trip -------------------------------------------------------------

test('a written workbook round-trips through the parser and resolves to catalog SKUs', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-'));
  // 1×1 transparent PNG stands in for the points-of-measure sketch.
  const png = path.join(dir, 'naomi.png');
  fs.writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));
  const tab = buildQcTab({ tabName: 'Naomi Gaff', prefix: 'GAF', skus: SKUS, specs: specs(), samplesPerColor: 3, pomImage: png });
  const out = path.join(dir, 'KALI-TEST Underwear QC Master.xlsx');
  await writeQcWorkbook({ tabs: [tab], outPath: out });

  // Simulate the inspector filling two samples on the XS waist row.
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(out);
  const ws = wb.getWorksheet('Naomi Gaff');
  const xs = tab.blocks[0];
  const waistRow = xs.pomRows[0].row + 1;
  assert.equal(ws.getCell(waistRow, xs.diffCol + 1).value.formula.startsWith('IF(COUNTA('), true, 'Diff is a live formula');
  assert.ok(ws.conditionalFormattings.length >= 5, 'one conditional-fill range per block');
  // One continuous box per block: left edge on the anchor column and right edge
  // on the Diff column from the size row to the last POM row.
  const lastRow = xs.pomRows[xs.pomRows.length - 1].row + 1;
  for (const r of [xs.sizeRow + 1, xs.skuRow + 1, xs.colourRow + 1, xs.headerRow + 1, waistRow, lastRow]) {
    assert.equal(ws.getCell(r, xs.anchor + 1).border.left.style, 'thin', `left edge row ${r}`);
    assert.equal(ws.getCell(r, xs.diffCol + 1).border.right.style, 'thin', `right edge row ${r}`);
  }
  assert.equal(ws.getCell(xs.sizeRow + 1, xs.anchor + 1).border.top.style, 'thin');
  assert.equal(ws.getCell(lastRow, xs.anchor + 1).border.bottom.style, 'thin');
  assert.equal(ws.getImages().length, 1, 'POM sketch embedded');
  ws.getCell(waistRow, xs.sampleCols[0].col + 1).value = 30.5;
  ws.getCell(waistRow, xs.sampleCols[1].col + 1).value = 29.0;
  await wb.xlsx.writeFile(out);

  const parsedWb = XLSX.readFile(out);
  const parsed = parseSheet(parsedWb.Sheets['Naomi Gaff'], 'Naomi Gaff');
  assert.equal(parsed.unit, 'cm');
  assert.equal(parsed.blocks.length, 5);
  assert.deepEqual(parsed.blocks.map((b) => b.size_label), ['XS', 'S', 'M', 'L', '1X']);
  assert.deepEqual(parsed.blocks.map((b) => b.sku_label), ['GAF-BLK-XS', 'GAF-BLK-S', 'GAF-BLK-M', 'GAF-BLK-L', 'GAF-BLK-1X']);
  const first = parsed.blocks[0].pom_rows[0];
  assert.equal(first.pom_code, 'A');
  assert.equal(first.tolerance_cm, 0.75);
  assert.equal(first.target_cm, 30.03);
  assert.deepEqual(first.samples, [{ sample_number: 1, color: 'BLK', measured_cm: 30.5 }, { sample_number: 2, color: 'BLK', measured_cm: 29.0 }]);
  assert.equal(parsed.blocks[4].pom_rows[1].target_cm, 27.47);

  // The 1X label resolves to the catalog's XL SKU through the alias rule, and
  // the tolerance flags come out right.
  const catalog = new Set(['GAF-BLK-XS', 'GAF-BLK-S', 'GAF-BLK-M', 'GAF-BLK-L', 'GAF-BLK-XL']);
  const { rows, unknown } = flattenMeasurements({ tabs: [parsed] }, { catalog });
  assert.equal(unknown.length, 0);
  assert.deepEqual(rows.map((r) => [r.sku, r.measured_cm, r.in_tolerance]), [['GAF-BLK-XS', 30.5, true], ['GAF-BLK-XS', 29.0, false]]);
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- product list ------------------------------------------------------------------

test('QC product list: every ingest tab still maps, prefixes are unique, lookups work', () => {
  for (const t of ['AJ Underwear', 'Sassy Underwear', 'Charlie Underwear', 'Brooke Bra', 'Ava Seamless Bra', 'Evey Sports Bra', 'Cami Top', 'Quinn Boxers', 'Ruby Bikini Bottom', 'Cheeky Bikini Bottom', 'Mia Halter Bikini Top', 'Sunny Tankini', 'Serena Shorty Shorts', 'Sky One Piece']) {
    assert.ok(TAB_HANDLES[t], `tab ${t} lost its handle mapping`);
  }
  assert.deepEqual(TAB_HANDLES['Sky One Piece'], ['sky_youth', 'sky_reg']);
  assert.equal(new Set(QC_PRODUCTS.map((p) => p.prefix)).size, QC_PRODUCTS.length);
  assert.equal(qcProductForPrefix('gaf').tab, 'Naomi Gaff');
  assert.equal(qcProductForPrefix('PAD3'), null);
  assert.deepEqual(findQcProducts(['naomi']).map((p) => p.prefix), ['GAF']);
  assert.deepEqual(findQcProducts(['Naomi Gaff', 'AJ']).map((p) => p.prefix), ['AJ', 'GAF']);
  assert.throws(() => findQcProducts(['nope']), /no QC product matches/);
});
