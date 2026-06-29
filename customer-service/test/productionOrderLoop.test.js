const { test } = require('node:test');
const assert = require('node:assert');
const { buildOrderRows, orderDescriptor } = require('../lib/merchandising/productionOrderLoop');
const { computePricing } = require('../lib/merchandising/pricingEstimate');
const { parseProductionSheet } = require('../lib/merchandising/productionSheetParser');

const round = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const COSTS = new Map([['AJ', { unit_cost: 2.71, freight: 0.15, duties_amount: 0.61, total_landed_cost: 3.47 }]]);
const ITEMS = [
  { sku: 'AJ-BLK-M', product_name: 'THE AJ NO-TUCK SHAPING UNDERWEAR', color: 'BLK', qty: 670 },
  { sku: 'AJ-BLK-8', product_name: 'THE AJ NO-TUCK SHAPING UNDERWEAR', color: 'BLK', qty: 200 },
  { sku: 'AJ-SND-S', product_name: 'THE AJ NO-TUCK SHAPING UNDERWEAR', color: 'SND', qty: 300 },
];

test('buildOrderRows: combined qty+cost, mixed-case names, size-sorted, bold, resilient grand', () => {
  const { rows, boldRows } = buildOrderRows(computePricing(ITEMS, COSTS));
  assert.deepStrictEqual(rows[0], ['Product / SKU', 'Qty', 'COGS $', 'Shipping $', 'Taxes $', 'Landed $']);
  const blkHeader = rows.findIndex((r) => r[0] === 'The AJ No-Tuck Shaping Underwear - BLK');
  assert.ok(blkHeader >= 0);
  // size 8 sorts before M within BLK; lines carry qty + extended cost columns
  assert.strictEqual(rows[blkHeader + 1][0], 'AJ-BLK-8');
  assert.strictEqual(rows[blkHeader + 1][1], 200);
  assert.strictEqual(rows[blkHeader + 1][2], round(200 * 2.71)); // ext COGS
  assert.strictEqual(rows[blkHeader + 2][0], 'AJ-BLK-M');
  // resilient grand total formula on the landed column
  const grand = rows.find((r) => r[0] === 'TOTAL');
  assert.strictEqual(grand[5], '=SUMIFS(F:F,A:A,"<>",A:A,"<>TOTAL")');
  // bold: column header + product header
  assert.ok(boldRows.includes(0));
  assert.ok(boldRows.includes(blkHeader));
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

test('order tab A:B round-trips back to the same items (submit reads only A:B)', () => {
  const { rows } = buildOrderRows(computePricing(ITEMS, COSTS));
  const ab = rows.map((r) => [r[0], r[1]]); // submit_production_order reads A:B only
  const parsed = parseProductionSheet(ab);
  assert.strictEqual(parsed.items.length, 3);
  const byNumber = Object.fromEntries(parsed.items.map((i) => [i.sku, i.qty]));
  assert.strictEqual(byNumber['AJ-BLK-M'], 670);
  assert.strictEqual(byNumber['AJ-BLK-8'], 200);
  assert.strictEqual(byNumber['AJ-SND-S'], 300);
});
