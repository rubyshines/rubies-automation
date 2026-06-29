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

test('computePricing extends each line by current per-prefix cost', () => {
  const { groups, grand } = computePricing(ITEMS, COSTS);
  const aj = groups.find((g) => g.lines[0].sku.startsWith('AJ'));
  const m = aj.lines.find((l) => l.sku === 'AJ-BLK-M');
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

test('buildPricingRows: column header, formula subtotals, resilient grand, bold rows', () => {
  const pricing = computePricing(ITEMS, COSTS);
  const { rows, boldRows } = buildPricingRows(pricing);
  assert.deepStrictEqual(rows[0], ['Product / SKU', 'Qty', 'COGS $', 'Shipping $', 'Taxes $', 'Landed $']);
  assert.ok(boldRows.includes(0)); // column header bold
  const grandRow = rows.find((r) => r[0] === 'TOTAL');
  assert.strictEqual(grandRow[5], '=SUMIFS(F:F,A:A,"<>",A:A,"<>TOTAL")'); // resilient landed total
  // every group subtotal is a SUM formula across its column
  const subtotal = rows.find((r) => r[0] === '' && typeof r[2] === 'string' && r[2].startsWith('=SUM('));
  assert.ok(subtotal, 'has a formula subtotal row');
});

function round(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }
