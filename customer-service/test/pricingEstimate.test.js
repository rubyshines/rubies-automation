const { test } = require('node:test');
const assert = require('node:assert');
const { computePricing } = require('../lib/merchandising/pricingEstimate');
const { buildPricingRows } = require('../lib/merchandising/productionOrderLoop');

const COSTS = new Map([
  ['AJ', { unit_cost: 2.71, freight: 0.15, duties_amount: 0.61, total_landed_cost: 3.47 }],
  ['GAF', { unit_cost: 18, freight: 0.2, duties_amount: 3.5, total_landed_cost: 21.7 }],
]);

const ITEMS = [
  { sku: 'AJ-BLK-M', qty: 100, product_name: 'AJ NO-TUCK SHAPING UNDERWEAR', color: 'BLK' },
  { sku: 'AJ-BLK-L', qty: 50, product_name: 'AJ NO-TUCK SHAPING UNDERWEAR', color: 'BLK' },
  { sku: 'GAF-BLK-M', qty: 10, product_name: 'NAOMI GAFF', color: 'BLK' },
];

test('computePricing extends each line by current per-prefix cost (unit + extended)', () => {
  const { groups, grand } = computePricing(ITEMS, COSTS);
  const aj = groups.find((g) => g.lines[0].sku.startsWith('AJ'));
  const m = aj.lines.find((l) => l.sku === 'AJ-BLK-M');
  assert.strictEqual(m.unit_cogs, 2.71); // per-unit components carried through
  assert.strictEqual(m.unit_landed, 3.47);
  assert.strictEqual(m.cogs, 271);   // 100 * 2.71
  assert.strictEqual(m.freight, 15); // 100 * 0.15
  assert.strictEqual(m.duty, 61);    // 100 * 0.61
  assert.strictEqual(m.landed, 347); // 100 * 3.47
  // Grand: AJ 150 units + GAF 10
  assert.strictEqual(grand.qty, 160);
  assert.strictEqual(grand.cogs, round(150 * 2.71 + 10 * 18));
  assert.strictEqual(grand.landed, round(150 * 3.47 + 10 * 21.7));
});

test('computePricing flags prefixes with no cost on file (and treats them as 0)', () => {
  const items = [{ sku: 'NEW-BLK-M', qty: 5, product_name: 'NEW THING', color: 'BLK' }];
  const { grand, missing } = computePricing(items, COSTS);
  assert.deepStrictEqual(missing, ['NEW']);
  assert.strictEqual(grand.landed, 0);
});

test('buildPricingRows: unit + extended columns, formula subtotals, resilient landed grand', () => {
  const pricing = computePricing(ITEMS, COSTS);
  const { rows, boldRows } = buildPricingRows(pricing);
  assert.deepStrictEqual(rows[0], ['Product / SKU', 'Qty', 'Unit COGS', 'Unit Ship', 'Unit Tax', 'Unit Landed', 'COGS $', 'Shipping $', 'Taxes $', 'Landed $']);
  assert.ok(boldRows.includes(0));
  // a data line carries per-unit costs (cols C-F) and extended (G-J)
  const m = rows.find((r) => r[0] === 'AJ-BLK-M');
  assert.strictEqual(m[2], 2.71);  // unit COGS
  assert.strictEqual(m[9], 347);   // ext landed (100 * 3.47)
  // grand total: landed lives in column J, summed resiliently; unit cols blank
  const grandRow = rows.find((r) => r[0] === 'TOTAL');
  assert.strictEqual(grandRow[9], '=SUMIFS(J:J,A:A,"<>",A:A,"<>TOTAL")');
  assert.strictEqual(grandRow[2], ''); // unit column not summed
});

function round(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }
