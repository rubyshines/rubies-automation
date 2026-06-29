const { test } = require('node:test');
const assert = require('node:assert');
const { distributeWithFloor, matchesStyle, applyOrderRules, PER_SKU_FLOOR } = require('../lib/merchandising/orderSpread');

const sum = (a) => a.reduce((s, x) => s + x, 0);

test('distributeWithFloor rescales a spread to the target and sums exactly', () => {
  // Naomi GAF projection (2026-06-27): 6 sizes summing to 2170, override to 3000.
  const weights = [710, 480, 420, 270, 160, 130]; // M, L, XL, S, 2XL, XS
  const { alloc, infeasible } = distributeWithFloor(weights, 3000);
  assert.strictEqual(infeasible, false);
  assert.strictEqual(sum(alloc), 3000);
  // proportions preserved: order of sizes by units matches order of weights
  assert.deepStrictEqual([...alloc].sort((a, b) => b - a), alloc);
  // largest size (M) gets the most
  assert.strictEqual(Math.max(...alloc), alloc[0]);
  assert.ok(alloc.every((q) => q >= PER_SKU_FLOOR));
});

test('distributeWithFloor rounds thin sizes up to the floor, reclaiming from the largest', () => {
  // One tiny size that would proportionally get ~3 units must become 20.
  const weights = [1000, 1000, 3];
  const target = 2000;
  const { alloc, infeasible } = distributeWithFloor(weights, target, 20);
  assert.strictEqual(infeasible, false);
  assert.strictEqual(sum(alloc), target);
  assert.strictEqual(alloc[2], 20); // thin size floored up
  assert.ok(alloc[0] >= 20 && alloc[1] >= 20);
});

test('distributeWithFloor drops dead sizes (weight 0) rather than flooring them', () => {
  const weights = [500, 0, 500];
  const { alloc } = distributeWithFloor(weights, 1000, 20);
  assert.strictEqual(alloc[1], 0);
  assert.strictEqual(sum(alloc), 1000);
});

test('distributeWithFloor flags infeasible when the floor alone exceeds the target', () => {
  // 5 active sizes * 20 floor = 100 > target 60.
  const weights = [10, 10, 10, 10, 10];
  const { alloc, infeasible } = distributeWithFloor(weights, 60, 20);
  assert.strictEqual(infeasible, true);
  assert.ok(alloc.every((q) => q === 20));
});

test('matchesStyle matches by product-name substring or SKU prefix, case-insensitive', () => {
  const row = { sku: 'GAF-BLK-M', product_name: 'NAOMI GAFF EXTRA STRENGTH SHAPING UNDERWEAR' };
  assert.ok(matchesStyle(row, 'naomi'));
  assert.ok(matchesStyle(row, 'GAF'));
  assert.ok(matchesStyle(row, 'gaf'));
  assert.ok(!matchesStyle(row, 'ruby'));
  assert.ok(!matchesStyle(row, ''));
});

test('applyOrderRules overrides one style and floors the rest', () => {
  const rows = [
    { sku: 'GAF-BLK-M', product_name: 'NAOMI GAFF', color: 'BLK', size: 'M', qty_to_order: 710 },
    { sku: 'GAF-BLK-S', product_name: 'NAOMI GAFF', color: 'BLK', size: 'S', qty_to_order: 270 },
    { sku: 'GAF-BLK-XS', product_name: 'NAOMI GAFF', color: 'BLK', size: 'XS', qty_to_order: 130 },
    { sku: 'AJ-BLK-M', product_name: 'THE AJ', color: 'BLK', size: 'M', qty_to_order: 8 }, // thin -> floor
  ];
  const { rows: out, warnings } = applyOrderRules(rows, { overrides: { naomi: 3000 } });
  const gaf = out.filter((r) => r.sku.startsWith('GAF'));
  assert.strictEqual(sum(gaf.map((r) => r.qty_to_order)), 3000);
  const aj = out.find((r) => r.sku === 'AJ-BLK-M');
  assert.strictEqual(aj.qty_to_order, 20); // non-override thin line floored up
  assert.strictEqual(warnings.length, 0);
});

test('applyOrderRules warns when an override matches no rows', () => {
  const rows = [{ sku: 'AJ-BLK-M', product_name: 'THE AJ', color: 'BLK', size: 'M', qty_to_order: 100 }];
  const { warnings } = applyOrderRules(rows, { overrides: { naomi: 3000 } });
  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0], /no projection rows matched/);
});

test('applyOrderRules does not mutate the input rows', () => {
  const rows = [{ sku: 'AJ-BLK-M', product_name: 'THE AJ', color: 'BLK', size: 'M', qty_to_order: 5 }];
  applyOrderRules(rows, {});
  assert.strictEqual(rows[0].qty_to_order, 5);
});
