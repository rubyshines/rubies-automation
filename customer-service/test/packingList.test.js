'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { parsePackingList, applySkuRemap } = require('../lib/merchandising/packingListParser');

// A miniature Kali shipping list: header band, two product/color groups (one with a
// SKU split across two cartons), subtotal rows, a grand-total banner.
const ROWS = [
  ['SKU', 'Shipping  QTY', 'CARTON NO.', 'N.W', 'G.W', 'MEANS', 'CBM'],
  ['THE AJ NO-TUCK SHAPING UNDERWEAR - SND'],
  ['    AJ-SND-12', 56, 1, 13.7, 14.7, '60*40*30', 0.07],
  ['    AJ-SND-M', 166, '', '', '', '', ''],
  ['    AJ-SND-M', 100, 2, 19.5, 20.5, '60*40*30', 0.07],
  ['', 322, 2, 33.2, 35.2, '', 0.14],
  [],
  ['SKU', 'Shipping  QTY', 'CARTON NO.', 'N.W', 'G.W', 'MEANS', 'CBM'],
  ['THE BROOKE SHAPING BRA - BLK  *** ASK SUPPLIER ***'],
  ['    BB-BLK-1X', 124, 3, 9, 10, '60*40*30', 0.07],
  ['', 124, 1, 9, 10, '', 0.07],
  ['GRAND TOTAL', 446],
];

test('sums quantities for a SKU split across carton rows', () => {
  const r = parsePackingList(ROWS);
  const aj = r.items.find((i) => i.sku === 'AJ-SND-M');
  assert.equal(aj.qty, 266); // 166 + 100
});

test('totals: units, sku count, cartons, cbm, weights', () => {
  const r = parsePackingList(ROWS);
  assert.equal(r.totals.units, 446);        // 56 + 266 + 124
  assert.equal(r.totals.sku_count, 3);      // AJ-SND-12, AJ-SND-M, BB-BLK-1X
  assert.equal(r.totals.cartons, 3);        // distinct carton numbers 1,2,3
  assert.equal(r.totals.cbm, 0.21);         // 0.07 * 3
  assert.equal(r.totals.gross_weight_kg, 45.2); // 14.7 + 20.5 + 10 (SKU rows only)
});

test('subtotal rows are a checksum, not double-counted as SKUs', () => {
  const r = parsePackingList(ROWS);
  assert.equal(r.subtotal_units, 446);      // 322 + 124
  assert.equal(r.warnings.length, 0);       // checksum matches
});

test('product/color headers are captured as sections, annotations stripped', () => {
  const r = parsePackingList(ROWS);
  assert.equal(r.sections.length, 2);
  assert.equal(r.sections[1].name, 'THE BROOKE SHAPING BRA - BLK');
  assert.equal(r.sections[0].units, 322);
});

test('warns when subtotal checksum disagrees with summed SKU rows', () => {
  const bad = [
    ['SKU', 'Shipping  QTY'],
    ['THE AJ - SND'],
    ['AJ-SND-12', 56],
    ['', 99], // wrong subtotal
  ];
  const r = parsePackingList(bad);
  assert.equal(r.totals.units, 56);
  assert.ok(r.warnings.some((w) => /checksum/i.test(w)));
});

test('each line carries the product/color section it appeared under', () => {
  const r = parsePackingList(ROWS);
  const bb = r.items.find((i) => i.sku === 'BB-BLK-1X');
  assert.equal(bb.section, 'THE BROOKE SHAPING BRA - BLK');
});

// The Evey sports bra shipped under SB (the Ava bra's prefix). Scoped remap fixes it
// without touching a genuine SB (Ava) line.
const REMAP = [{ from: 'SB', to: 'SPB', section: 'sports bra' }];

test('applySkuRemap rewrites prefix only for the matching section', () => {
  const items = [
    { sku: 'SB-BLK-M', qty: 218, section: 'THE EVEY SHAPING SPORTS BRA - BLK' },
    { sku: 'SB-BLK-L', qty: 229, section: 'AVA SEAMLESS SHAPING BRA - BLK' }, // genuine Ava
  ];
  const { items: out, rewritten } = applySkuRemap(items, REMAP);
  assert.equal(out[0].sku, 'SPB-BLK-M'); // sports bra corrected
  assert.equal(out[1].sku, 'SB-BLK-L');  // Ava untouched
  assert.equal(rewritten.length, 1);
  assert.deepEqual(rewritten[0], { from: 'SB-BLK-M', to: 'SPB-BLK-M', qty: 218 });
});

test('applySkuRemap with no rules is a no-op', () => {
  const items = [{ sku: 'SB-BLK-M', qty: 1, section: 'x' }];
  assert.deepEqual(applySkuRemap(items, []).items, items);
  assert.deepEqual(applySkuRemap(items).rewritten, []);
});
