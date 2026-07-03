const { test } = require('node:test');
const assert = require('node:assert');

const { buildSupplierLotSections, isSignificant } = require('../lib/merchandising/supplierLotList');

test('isSignificant: under needs >=10 units and >=10%; over needs 2x ordered', () => {
  assert.equal(isSignificant(100, -15), true);   // under: 15 units, 15%
  assert.equal(isSignificant(300, -15), false);  // under: 15 units but only 5%
  assert.equal(isSignificant(30, -5), false);    // under: 16% but only 5 units
  assert.equal(isSignificant(20, 12), false);    // over: +60% but below 2x
  assert.equal(isSignificant(20, 20), true);     // over: exactly 2x
  assert.equal(isSignificant(10, 19), true);     // over: 2.9x
  assert.equal(isSignificant(0, 25), true);      // not-ordered extras: units only
  assert.equal(isSignificant(0, 5), false);
});

test('buildSupplierLotSections splits by lot and highlights only significant diffs', () => {
  const items = [
    { sku: 'AJ-BLK-S', qty_ordered: 100 },   // shipped 80 -> under, significant
    { sku: 'AJ-BLK-M', qty_ordered: 100 },   // shipped 98 -> under, small (no highlight)
    { sku: 'AJ-BLK-L', qty_ordered: 50 },    // shipped 100 -> 2x over, significant
    { sku: 'AJ-BLK-XL', qty_ordered: 40 },   // shipped 40 -> exact, excluded
    { sku: 'UNW-BLK-M', qty_ordered: 40 },   // nothing anywhere -> missing
    { sku: 'RUBY-BLK-16', qty_ordered: 30 }, // pink lot
    { sku: 'RUBY-BLK-M', qty_ordered: 290 }, // held lot
  ];
  const lots = [
    { sku: 'AJ-BLK-S', qty: 80, quality: 'standard', marker: null, disposition: 'ship' },
    { sku: 'AJ-BLK-M', qty: 98, quality: 'standard', marker: null, disposition: 'ship' },
    { sku: 'AJ-BLK-L', qty: 100, quality: 'standard', marker: null, disposition: 'ship' },
    { sku: 'AJ-BLK-XL', qty: 40, quality: 'standard', marker: null, disposition: 'ship' },
    { sku: 'SPB-BLK-M', qty: 30, quality: 'standard', marker: null, disposition: 'ship' }, // not ordered
    { sku: 'RUBY-BLK-16', qty: 29, quality: 'thin_black_fabric', marker: 'pink_sticker', disposition: 'ship' },
    { sku: 'RUBY-BLK-M', qty: 290, quality: 'thin_black_fabric', marker: null, disposition: 'hold_storage' },
  ];
  const s = buildSupplierLotSections({ items, lots });

  const bySku = Object.fromEntries(s.shipped.map((r) => [r.sku, r]));
  assert.equal(bySku['AJ-BLK-S'].highlight, 'under');
  assert.equal(bySku['AJ-BLK-M'].highlight, null, 'small under-run not highlighted');
  assert.equal(bySku['AJ-BLK-L'].highlight, 'over');
  assert.equal(bySku['AJ-BLK-XL'], undefined, 'exact lines excluded');
  assert.equal(bySku['UNW-BLK-M'].highlight, 'under');
  assert.match(bySku['UNW-BLK-M'].note, /not in shipment/);
  assert.equal(bySku['SPB-BLK-M'].highlight, 'over');
  assert.match(bySku['SPB-BLK-M'].note, /not on the order/);

  // under-production sorts before over-production
  assert.ok(s.shipped.findIndex((r) => r.diff < 0) < s.shipped.findIndex((r) => r.diff > 0));

  assert.equal(s.marked.length, 1);
  assert.equal(s.marked[0].sku, 'RUBY-BLK-16');
  assert.equal(s.marked[0].highlight, null, 'small test-batch diff not highlighted');

  assert.equal(s.held.length, 1);
  assert.equal(s.held[0].sku, 'RUBY-BLK-M');
  assert.equal(s.held[0].produced, null, 'held produced left for the supplier to fill');
});
