const { test } = require('node:test');
const assert = require('node:assert');
const { buildSheetRows, orderDescriptor } = require('../lib/merchandising/productionOrderLoop');
const { parseProductionSheet } = require('../lib/merchandising/productionSheetParser');

const ITEMS = [
  { sku: 'AJ-BLK-M', product_name: 'THE AJ NO-TUCK SHAPING UNDERWEAR', color: 'BLK', qty: 670 },
  { sku: 'AJ-BLK-8', product_name: 'THE AJ NO-TUCK SHAPING UNDERWEAR', color: 'BLK', qty: 200 },
  { sku: 'AJ-SND-S', product_name: 'THE AJ NO-TUCK SHAPING UNDERWEAR', color: 'SND', qty: 300 },
];

test('buildSheetRows: clean SKU+Qty order tab, mixed-case names, size-sorted, resilient grand', () => {
  const { rows, grand, boldRows } = buildSheetRows(ITEMS);
  assert.strictEqual(grand, 1170);
  const blkHeader = rows.findIndex((r) => r[0] === 'The AJ No-Tuck Shaping Underwear - BLK');
  assert.ok(blkHeader >= 0);
  assert.deepStrictEqual(rows[blkHeader + 1], ['AJ-BLK-8', 200]); // size 8 before M
  assert.deepStrictEqual(rows[blkHeader + 2], ['AJ-BLK-M', 670]);
  assert.deepStrictEqual(rows[blkHeader + 3], ['', '=SUM(B2:B3)']); // subtotal
  assert.deepStrictEqual(rows[rows.length - 1], ['TOTAL', '=SUMIFS(B:B,A:A,"<>",A:A,"<>TOTAL")']);
  assert.ok(boldRows.includes(blkHeader) && boldRows.includes(rows.length - 1));
});

test('order tab parses back to the same items (GO read-back)', () => {
  const { rows } = buildSheetRows(ITEMS);
  const parsed = parseProductionSheet(rows);
  assert.strictEqual(parsed.items.length, 3);
  const byNumber = Object.fromEntries(parsed.items.map((i) => [i.sku, i.qty]));
  assert.strictEqual(byNumber['AJ-BLK-M'], 670);
  assert.strictEqual(byNumber['AJ-SND-S'], 300);
});

test('orderDescriptor: single product → its name; multiple → recognized categories (no "Other")', () => {
  assert.strictEqual(
    orderDescriptor([{ product_name: 'THE NAOMI GAFF EXTRA STRENGTH SHAPING UNDERWEAR' }]),
    'Naomi Gaff Extra Strength Shaping Underwear',
  );
  const mixed = orderDescriptor([
    { product_name: 'RUBY NO-TUCK SHAPING BIKINI BOTTOM' },
    { product_name: 'THE AJ NO-TUCK SHAPING UNDERWEAR' },
    { product_name: 'THE BROOKE SHAPING BRA' },
    { product_name: 'MAGICAL SHAPING GEL CHEST PADS' },
    { product_name: 'SOME RANDOM THING' }, // "Other" — must not appear
  ]);
  assert.strictEqual(mixed, 'Swim, Underwear, Bras and Accessories');
});
