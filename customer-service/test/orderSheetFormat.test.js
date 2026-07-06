const { test } = require('node:test');
const assert = require('node:assert');

const { buildSheetRows } = require('../lib/merchandising/productionOrderLoop');

// The order-format contract every artifact relies on (order tab, incoming tab,
// supplier .xlsx, email attachment): PRODUCT - COLOR group headers, size-sorted
// SKUs within each group, a live =SUM subtotal per COLORWAY, and a grand total.
// Callers often feed bare {sku, qty} straight from production_order_items —
// grouping/sorting must not depend on product_name/color being present
// (regression: bare rows once all keyed to "undefined" and rendered as one
// jumbled group with no per-colorway subtotals).
test('buildSheetRows from bare {sku, qty}: colorway groups, size order, subtotal per colorway, grand total', () => {
  const items = [
    // deliberately shuffled input order
    { sku: 'AJ-PNK-M', qty: 30 },
    { sku: 'AJ-BLK-2XL', qty: 20 },
    { sku: 'CM-BLK-XS', qty: 40 },
    { sku: 'AJ-BLK-8', qty: 100 },
    { sku: 'AJ-PNK-S', qty: 10 },
    { sku: 'CM-BLK-XXS', qty: 20 },
    { sku: 'AJ-BLK-M', qty: 50 },
  ];
  const { rows, boldRows } = buildSheetRows(items, { formulas: true });

  const labels = rows.map((r) => String(r[0] ?? ''));

  // one header per colorway, product order alphabetical (titleCase display)
  const groupHeaders = labels.filter((l) => /- (BLK|PNK)$/.test(l));
  assert.deepEqual(groupHeaders.map((h) => h.toUpperCase()), ['AJ - BLK', 'AJ - PNK', 'CM - BLK']);

  // SKUs within a colorway are size-sorted (youth numerics before letters)
  const ajBlkStart = labels.findIndex((l) => l.toUpperCase() === 'AJ - BLK');
  assert.deepEqual(labels.slice(ajBlkStart + 1, ajBlkStart + 4), ['AJ-BLK-8', 'AJ-BLK-M', 'AJ-BLK-2XL']);
  const cmStart = labels.findIndex((l) => l.toUpperCase() === 'CM - BLK');
  assert.deepEqual(labels.slice(cmStart + 1, cmStart + 3), ['CM-BLK-XXS', 'CM-BLK-XS']);

  // every colorway group is followed by a live =SUM subtotal row
  const subtotals = rows.filter((r) => String(r[0] ?? '') === '' && /^=SUM\(/.test(String(r[1] ?? '')));
  assert.equal(subtotals.length, groupHeaders.length, 'one =SUM subtotal per colorway');

  // grand total row is a live formula, never a hardcoded number
  const totalRow = rows.find((r) => String(r[0]).toUpperCase() === 'TOTAL');
  assert.ok(totalRow, 'grand total row present');
  assert.match(String(totalRow[1]), /^=/, 'grand total is a formula');

  // headers/subtotals are bolded
  assert.ok(boldRows.length >= groupHeaders.length * 2);
});

test('buildSheetRows honors explicit product_name/color when provided', () => {
  const items = [
    { sku: 'AJ-BLK-M', qty: 50, product_name: 'THE AJ NO-TUCK SHAPING UNDERWEAR', color: 'BLK' },
    { sku: 'AJ-BLK-8', qty: 100, product_name: 'THE AJ NO-TUCK SHAPING UNDERWEAR', color: 'BLK' },
  ];
  const { rows } = buildSheetRows(items, { formulas: true });
  const labels = rows.map((r) => String(r[0] ?? ''));
  const start = labels.findIndex((l) => l.toUpperCase() === 'THE AJ NO-TUCK SHAPING UNDERWEAR - BLK');
  assert.ok(start !== -1, 'explicit product_name used for the group header');
  assert.deepEqual(labels.slice(start + 1, start + 3), ['AJ-BLK-8', 'AJ-BLK-M']);
});

// The .xlsx must render subtotals EVERYWHERE, including viewers that never
// recalculate formulas (Numbers, Quick Look, Google preview): every formula
// cell carries a cached result alongside the live formula. Regression: the
// workbook once wrote result-less formulas and every subtotal displayed blank.
test('buildOrderWorkbook: subtotal + grand total cells carry live formula AND cached result', async () => {
  const { buildOrderWorkbook, prependTitle } = require('../lib/merchandising/productionOrderLoop');
  const items = [
    { sku: 'AJ-BLK-8', qty: 100 },
    { sku: 'AJ-BLK-M', qty: 50 },
    { sku: 'CM-BLK-XS', qty: 40 },
  ];
  const { rows } = buildSheetRows(items, { formulas: true });
  const titled = prependTitle(rows, 'Production Order: TEST');
  const wb = await buildOrderWorkbook(titled, null);
  const ws = wb.worksheets[0];

  const formulaCells = [];
  ws.eachRow((row) => row.eachCell((cell) => {
    if (cell.value && typeof cell.value === 'object' && cell.value.formula) formulaCells.push(cell.value);
  }));
  assert.equal(formulaCells.length, 3, 'two colorway subtotals + one grand total');
  for (const v of formulaCells) {
    assert.equal(typeof v.result, 'number', `formula ${v.formula} must carry a cached numeric result`);
  }
  const results = formulaCells.map((v) => v.result).sort((a, b) => a - b);
  assert.deepEqual(results, [40, 150, 190], 'AJ subtotal 150, CM subtotal 40, grand 190');
});
