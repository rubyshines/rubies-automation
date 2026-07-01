'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { summarizeAnomalies, buildReconcileRows, groupLines } = require('../lib/merchandising/reconcileSheet');

const RECON = {
  order: { id: 36, production_code: 'KALI-2601', status: 'in_production' },
  totals: { ordered: 1000, produced: 900, received: 0, sku_count: 6 },
  lines: [
    { sku: 'AJ-BLK-S', ordered: 500, produced: 219, delta: -281, flag: 'short' },  // big short -> anomaly
    { sku: 'AJ-BLK-M', ordered: 200, produced: 199, delta: -1, flag: 'short' },     // 1-unit short -> NOT an anomaly
    { sku: 'AJ-BLK-L', ordered: 100, produced: 130, delta: 30, flag: 'over' },       // normal over
    { sku: 'AJ-BLK-XL', ordered: 20, produced: 60, delta: 40, flag: 'over' },        // 3x over -> anomaly
    { sku: 'AJ-BLK-2XL', ordered: 150, produced: 0, delta: -150, flag: 'missing' },  // missing -> anomaly
    { sku: 'SPB-BLK-M', ordered: 30, produced: 45, delta: 15, flag: 'over' },        // over but <2x; not in catalog -> pending only
  ],
};
const CATALOG = new Set(['AJ-BLK-S', 'AJ-BLK-M', 'AJ-BLK-L', 'AJ-BLK-XL', 'AJ-BLK-2XL']);

test('summarizeAnomalies keeps 1-2 unit shorts out, flags real ones', () => {
  const a = summarizeAnomalies(RECON, { catalog: CATALOG });
  assert.deepEqual(a.short.map((l) => l.sku), ['AJ-BLK-S']);       // not AJ-BLK-M
  assert.deepEqual(a.missing.map((l) => l.sku), ['AJ-BLK-2XL']);
  assert.deepEqual(a.big_over.map((l) => l.sku), ['AJ-BLK-XL']);   // 60 >= 20*2
  assert.deepEqual(a.pending_catalog, ['SPB-BLK-M']);
});

test('buildReconcileRows: header, Δ formula, live SUM total, flag colouring', () => {
  const resolve = (sku) => ({ product: sku.startsWith('SPB') ? 'EVEY SPORTS BRA' : 'AJ UNDERWEAR', color: sku.split('-')[1] });
  const { values, boldRows, flagCells, flagColors } = buildReconcileRows(RECON, resolve, '2026-06-30', { catalog: CATALOG });
  assert.ok(values[0][0].includes('Reconcile — KALI-2601'));
  assert.deepEqual(values[2], ['SKU', 'Ordered', 'Produced', 'Shipped', 'Received', 'Δ', 'Flag', 'Note']);
  // a data row's Δ is a formula referencing its own row (column F now)
  const dataRow = values.find((r) => r[0] === 'AJ-BLK-S');
  assert.match(String(dataRow[5]), /^=C\d+-B\d+$/);
  assert.equal(dataRow[6], 'SHORT');
  // grand total uses SUMIFS (live), never a hardcoded number
  const totalRow = values.find((r) => r[0] === 'TOTAL');
  assert.match(String(totalRow[1]), /^=SUMIFS/);
  // every flag cell maps to a known colour
  assert.ok(flagCells.length >= 6);
  assert.ok(flagCells.every((fc) => flagColors[fc.flag]));
  assert.ok(boldRows.length > 0);
});

test('lots: flagged line shows a Note; a FABRIC/QUALITY section is appended', () => {
  const recon = {
    order: { id: 36, production_code: 'KALI-2601', status: 'in_production' },
    totals: { ordered: 30, produced: 39, shipped: 29, received: 0, remake: 5, sku_count: 1 },
    lines: [{
      sku: 'RUBY-BLK-16', ordered: 30, produced: 39, shipped: 29, received: 0, delta: 9, flag: 'over',
      remake: 5, flagged: true, quality: 'thin_black_fabric', marker: 'pink_sticker',
      lots: [{ qty: 29, quality: 'thin_black_fabric', marker: 'pink_sticker', disposition: 'ship' }],
    }],
  };
  const { values } = buildReconcileRows(recon, () => ({ product: 'RUBY BIKINI', color: 'BLK' }), '2026-06-30', {});
  const dataRow = values.find((r) => r[0] === 'RUBY-BLK-16');
  assert.match(String(dataRow[7]), /pink_sticker/);       // Note column carries the marker
  assert.match(String(dataRow[7]), /10 held/);            // produced 39 - shipped 29
  assert.match(String(dataRow[7]), /5 remake/);
  assert.ok(values.some((r) => String(r[0]).includes('FABRIC / QUALITY')));
  assert.ok(values.some((r) => String(r[0]).includes('Flagged test batch')));
});

test('groupLines groups by product+color and size-sorts within a group', () => {
  const resolve = (sku) => ({ product: 'AJ UNDERWEAR', color: 'BLK' });
  const groups = groupLines(RECON.lines.filter((l) => l.sku.startsWith('AJ')), resolve);
  assert.equal(groups.length, 1);
  const sizes = groups[0].lines.map((l) => l.sku.split('-')[2]);
  assert.deepEqual(sizes, ['S', 'M', 'L', 'XL', '2XL']); // size order, not alphabetical
});
