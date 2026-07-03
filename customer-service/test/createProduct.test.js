'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const cp = require('../lib/tools/createProduct');

test('toBulkCreateInput moves sku under inventoryItem for the Admin API', () => {
  const api = cp.toBulkCreateInput([
    { optionValues: [{ name: '6', optionName: 'Youth Size' }, { name: 'Black', optionName: 'Color' }], sku: 'SPB-BLK-6', price: '39.00' },
  ]);
  assert.deepStrictEqual(api[0], {
    optionValues: [{ name: '6', optionName: 'Youth Size' }, { name: 'Black', optionName: 'Color' }],
    price: '39.00',
    inventoryItem: { sku: 'SPB-BLK-6' },
  });
  // must NOT carry a top-level sku (the API rejects it)
  assert.strictEqual('sku' in api[0], false);
});

test('deriveHandle strips leading "the" and hyphenates', () => {
  assert.strictEqual(cp.deriveHandle('THE EVEY SHAPING SPORTS BRA'), 'evey-shaping-sports-bra');
  assert.strictEqual(cp.deriveHandle('Evey Sports Bra'), 'evey-sports-bra');
  assert.strictEqual(cp.deriveHandle('The Brooke Bra'), 'brooke-bra');
});

test('normalizeTitle uppercases and drops leading THE', () => {
  assert.strictEqual(cp.normalizeTitle('the evey shaping sports bra'), 'EVEY SHAPING SPORTS BRA');
  assert.strictEqual(cp.normalizeTitle('Evey'), 'EVEY');
});

test('priceFor handles tiers and flat', () => {
  const pricing = { tiers: [{ sizes: ['6', '8', '10'], price: 39 }], default: 42 };
  assert.strictEqual(cp.priceFor('6', pricing), '39.00');
  assert.strictEqual(cp.priceFor('12', pricing), '42.00');
  assert.strictEqual(cp.priceFor('XS', pricing), '42.00');
  assert.strictEqual(cp.priceFor('M', { flat: 30 }), '30.00');
  assert.throws(() => cp.priceFor('M', { tiers: [] }));
});

test('buildVariants produces color x size with SKUs and tiered prices', () => {
  const variants = cp.buildVariants({
    sizes: ['6', '10', 'XS', '4X'],
    colors: [{ name: 'Black', code: 'BLK' }, { name: 'White', code: 'WHT' }],
    skuPrefix: 'SPB',
    pricing: { tiers: [{ sizes: ['6', '8', '10'], price: 39 }], default: 42 },
    sizeOptionName: 'Youth Size',
  });
  assert.strictEqual(variants.length, 8);
  const black6 = variants.find(v => v.sku === 'SPB-BLK-6');
  assert.strictEqual(black6.price, '39.00');
  assert.deepStrictEqual(black6.optionValues, [
    { name: '6', optionName: 'Youth Size' },
    { name: 'Black', optionName: 'Color' },
  ]);
  assert.strictEqual(variants.find(v => v.sku === 'SPB-WHT-4X').price, '42.00');
});

test('buildCustomMetafields uses the live keys', () => {
  const mf = cp.buildCustomMetafields({
    productCollection: ['Underwear', 'Activewear'],
    productCategory: ['Tops'],
    ageGroups: ['Kids', 'Adults'],
    adultSizes: ['XS', 'S'],
    kidSizes: ['6', '8'],
    colors: [{ name: 'Black', code: 'BLK' }],
    nickname: 'Evey',
    copy: { fit_description: 'Racerback sports crop', best_for: 'Active days', comparison_notes: 'Keyhole racerback', materials: { body: '95% cotton, 5% spandex' } },
  });
  const byKey = Object.fromEntries(mf.map(m => [m.key, m]));
  assert.strictEqual(byKey.product_collection.value, JSON.stringify(['Underwear', 'Activewear']));
  assert.strictEqual(byKey.product_category.value, JSON.stringify(['Tops']));
  assert.strictEqual(byKey.product_age.value, JSON.stringify(['Kids', 'Adults']));
  assert.strictEqual(byKey.kid_colors.value, JSON.stringify(['Black']));
  assert.strictEqual(byKey.fit_description.value, 'Racerback sports crop');
  assert.ok(byKey.materials_composition.value.includes('95% cotton'));
  // must NOT use the abandoned keys
  assert.ok(!byKey.collections && !byKey.categories && !byKey.age_groups);
});

test('buildPlan assembles a complete Evey-like plan', () => {
  const plan = cp.buildPlan({
    title: 'THE EVEY SHAPING SPORTS BRA',
    category: 'underwear_top',
    kidSizes: ['6', '8', '10', '12', '14', '16'],
    adultSizes: ['XS', 'S', 'M', 'L', '1X', '2X', '3X', '4X'],
    colors: [{ name: 'Black', code: 'BLK' }, { name: 'Sandstone', code: 'SND' }, { name: 'White', code: 'WHT' }],
    skuPrefix: 'SPB',
    pricing: { tiers: [{ sizes: ['6', '8', '10'], price: 39 }], default: 42 },
    nickname: 'Evey',
    keywords: ['evey', 'sports bra'],
    productCollection: ['Underwear', 'Activewear'],
    copy: { fit_description: 'Racerback sports crop', best_for: 'Active days', comparison_notes: 'Keyhole racerback', materials: { body: '95% cotton, 5% spandex' } },
    description: '<p>copy</p>',
    seo: { title: 'Evey Sports Bra', description: 'A sporty shaping bra.' },
    collections: ['adults-underwear', 'kids-underwear'],
  });
  assert.strictEqual(plan.product.title, 'EVEY SHAPING SPORTS BRA');
  assert.strictEqual(plan.product.handle, 'evey-shaping-sports-bra');
  assert.strictEqual(plan.variants.length, 42); // 3 colors x 14 sizes
  // combined youth+adult -> "Youth Size" option label
  assert.strictEqual(plan.variants[0].optionValues[0].optionName, 'Youth Size');
  assert.strictEqual(plan.csConfig.category, 'underwear_top');
  assert.strictEqual(plan.csConfig.delta_wording, 'bra'); // category default
  const priced = plan.variants.reduce((a, v) => { a[v.price] = (a[v.price] || 0) + 1; return a; }, {});
  assert.deepStrictEqual(priced, { '39.00': 9, '42.00': 33 });
});

test('checkCompleteness flags missing pieces', () => {
  const bare = cp.buildPlan({
    title: 'Test Thing', category: 'accessory',
    colors: [{ name: 'Black', code: 'BLK' }], skuPrefix: 'TST',
    pricing: { flat: 10 }, nickname: 'Test', adultSizes: ['S'],
  });
  const { ok, missing } = cp.checkCompleteness(bare);
  assert.strictEqual(ok, false);
  assert.ok(missing.includes('description'));
  assert.ok(missing.includes('seo'));
  assert.ok(missing.includes('collections'));
  assert.ok(missing.some(m => m.includes('fit_description')));
});
