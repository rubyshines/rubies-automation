/**
 * colorsInStock — which colours of a size can actually ship.
 *
 * Pure. Pinned because the failure it prevents is silent and customer-facing: a
 * summed size total answers "can we send something?" and not "which colours?",
 * and a reply that names a colour we hold at zero offers a choice we cannot
 * honour. Live case 2026-08-24: the Sassy in 1X read 38 units, all Pink, and a
 * draft offered Black, Sandstone and Pink.
 */
const { test } = require('node:test');
const assert = require('node:assert');

const { colorsInStock } = require('../lib/productCache');

const v = (variantTitle, inventoryQuantity) => ({ variantTitle, inventoryQuantity });

test('reports only the colours actually held', () => {
  const colors = colorsInStock([v('Black / 1X', 0), v('Sandstone / 1X', 0), v('Pink / 1X', 38)]);
  assert.deepStrictEqual(colors, [{ color: 'Pink', inventory: 38 }]);
});

test('a healthy size total does not mean every colour is available', () => {
  // The whole point. 38 units in the size, one colour behind it.
  const matches = [v('Black / 1X', 0), v('Sandstone / 1X', 0), v('Pink / 1X', 38)];
  const total = matches.reduce((s, x) => s + x.inventoryQuantity, 0);
  assert.strictEqual(total, 38, 'size reads in stock');
  assert.strictEqual(colorsInStock(matches).length, 1, 'but only one colour can ship');
});

test('every colour in stock is listed, with its count', () => {
  const colors = colorsInStock([v('Black / M', 35), v('Sandstone / M', 82), v('Pink / M', 147)]);
  assert.deepStrictEqual(colors.map(c => c.color).sort(), ['Black', 'Pink', 'Sandstone']);
  assert.strictEqual(colors.find(c => c.color === 'Sandstone').inventory, 82);
});

test('a size-only product has no colour axis and reports none', () => {
  // Chest pads are titled "S" with no slash. The old inline version fell back to
  // "Unknown", and splitting on a missing slash would have named the SIZE as a
  // colour — a choice that reads as real to a customer.
  assert.deepStrictEqual(colorsInStock([v('S', 40), v('M', 25)]), []);
});

test('variants of the same colour are summed, not listed twice', () => {
  // Tall variants share a colour: "Sandstone / 2X" and "Sandstone / 2X Tall".
  const colors = colorsInStock([v('Sandstone / 2X', 5), v('Sandstone / 2X Tall', 7)]);
  assert.deepStrictEqual(colors, [{ color: 'Sandstone', inventory: 12 }]);
});

test('accepts either variantTitle or title, and survives junk', () => {
  assert.deepStrictEqual(colorsInStock([{ title: 'Black / M', inventoryQuantity: 3 }]), [{ color: 'Black', inventory: 3 }]);
  assert.deepStrictEqual(colorsInStock([]), []);
  assert.deepStrictEqual(colorsInStock(null), []);
  assert.deepStrictEqual(colorsInStock([{}, v('', 5), v('/ M', 5)]), []);
});

test('a negative count never presents as available', () => {
  // Shopify can report negative available on oversell.
  assert.deepStrictEqual(colorsInStock([v('Black / M', -4), v('Pink / M', 2)]), [{ color: 'Pink', inventory: 2 }]);
});
