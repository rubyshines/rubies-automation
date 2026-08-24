const { test } = require('node:test');
const assert = require('node:assert');

const { deriveColorLists, splitVariantTitle, sameList } = require('../lib/tools/colourway');

test('splitVariantTitle — colour axis present', () => {
  assert.deepEqual(splitVariantTitle('Black / 1X'), { color: 'Black', size: '1X' });
  assert.deepEqual(splitVariantTitle('Sandstone / 14'), { color: 'Sandstone', size: '14' });
});

test('splitVariantTitle — size-only product has no colour, never a guessed one', () => {
  // Chest pads: variant title is bare "S". Reading that as a colour is how the
  // advisor would offer "size S" as a colour choice to a customer.
  assert.deepEqual(splitVariantTitle('S'), { color: null, size: 'S' });
  assert.deepEqual(splitVariantTitle('Default Title'), { color: null, size: 'Default Title' });
});

test('deriveColorLists splits by size system', () => {
  const variants = [
    { title: 'Black / 1X' }, { title: 'Pink / 1X' }, { title: 'Sandstone / 1X' },
    { title: 'Black / 14' }, { title: 'Pink / 14' },
  ];
  const out = deriveColorLists(variants);
  assert.deepEqual(out.adult_colors, ['Black', 'Pink', 'Sandstone']);
  assert.deepEqual(out.kid_colors, ['Black', 'Pink']);
});

test('deriveColorLists is availability-blind — a colour on the water is still a colour', () => {
  // The whole Sandstone case: 0 units in every size, container inbound. The
  // catalogue must still say the product is made in it. What can SHIP is a
  // different question, answered by colorsInStock from live inventory.
  const variants = [
    { title: 'Black / 1X', inventoryQuantity: 0 },
    { title: 'Sandstone / 1X', inventoryQuantity: 0 },
  ];
  assert.deepEqual(deriveColorLists(variants).adult_colors, ['Black', 'Sandstone']);
});

test('deriveColorLists returns null when there is no colour axis at all', () => {
  // Bundles and gift cards. Returning empty lists here would write an empty
  // list over whatever the product legitimately had.
  assert.equal(deriveColorLists([{ title: 'Default Title' }]), null);
  assert.equal(deriveColorLists([{ title: '$50.00' }, { title: '$100.00' }]), null);
});

test('deriveColorLists treats unknown size spellings as kid sizes', () => {
  // Numeric youth sizes are the open-ended set; the adult letters are closed.
  const out = deriveColorLists([{ title: 'Black / 7' }, { title: 'Black / XXS+' }]);
  assert.deepEqual(out.kid_colors, ['Black']);
  assert.deepEqual(out.adult_colors, ['Black']);
});

test('sameList is order-insensitive', () => {
  assert.ok(sameList(['Black', 'Pink'], ['Pink', 'Black']));
  assert.ok(!sameList(['Black', 'Pink'], ['Black', 'Pink', 'Sandstone']));
  assert.ok(sameList(null, []));
});

test('the Sassy case: derived list catches what the metafield missed', () => {
  const live = [
    { title: 'Black / 1X' }, { title: 'Pink / 1X' }, { title: 'Sandstone / 1X' },
    { title: 'Black / 2X' }, { title: 'Pink / 2X' }, { title: 'Sandstone / 2X' },
  ];
  const derived = deriveColorLists(live);
  const metafieldAsShipped = ['Black', 'Pink'];
  assert.ok(!sameList(metafieldAsShipped, derived.adult_colors));
  assert.deepEqual(derived.adult_colors, ['Black', 'Pink', 'Sandstone']);
});

// --- colorsOutOfStock: the other half of the colour question -----------------
const { colorsOutOfStock, colorsInStock } = require('../lib/productCache');

test('colorsOutOfStock returns zero colours with their SKUs', () => {
  const variants = [
    { variantTitle: 'Black / 1X', inventoryQuantity: 0, sku: 'HLA-BLK-XL' },
    { variantTitle: 'Sandstone / 1X', inventoryQuantity: 0, sku: 'HLA-SND-XL' },
    { variantTitle: 'Pink / 1X', inventoryQuantity: 38, sku: 'HLA-PNK-XL' },
  ];
  const out = colorsOutOfStock(variants);
  assert.deepEqual(out.map(c => c.color), ['Black', 'Sandstone']);
  assert.deepEqual(out[0].skus, ['HLA-BLK-XL']);
});

test('colorsInStock and colorsOutOfStock partition the colours exactly', () => {
  // The two must not overlap or drop a colour: a colour in neither is one the
  // advisor can neither offer nor say is coming, which is the silent case.
  const variants = [
    { variantTitle: 'Black / 1X', inventoryQuantity: 0, sku: 'A' },
    { variantTitle: 'Pink / 1X', inventoryQuantity: 38, sku: 'B' },
  ];
  const inNames = colorsInStock(variants).map(c => c.color);
  const outNames = colorsOutOfStock(variants).map(c => c.color);
  assert.deepEqual([...inNames, ...outNames].sort(), ['Black', 'Pink']);
  assert.equal(inNames.filter(n => outNames.includes(n)).length, 0);
});

test('colorsOutOfStock ignores size-only products', () => {
  // Chest pads again: no slash, so no colour axis. Must not report "S" at zero.
  assert.deepEqual(colorsOutOfStock([{ variantTitle: 'S', inventoryQuantity: 0, sku: 'PAD-S' }]), []);
});

test('colorsOutOfStock sums across variants of the same colour before judging', () => {
  // Two rows for one colour (e.g. a tall variant); only zero in TOTAL counts.
  const out = colorsOutOfStock([
    { variantTitle: 'Black / L', inventoryQuantity: 0, sku: 'X' },
    { variantTitle: 'Black / L Tall', inventoryQuantity: 5, sku: 'Y' },
  ]);
  assert.deepEqual(out, []);
});
