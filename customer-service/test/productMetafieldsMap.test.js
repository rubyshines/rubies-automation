'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { mapMetafields } = require('../../webhooks/handlers/productMetafields');

// Metafield values arrive already JSON.parsed (see shopify.js fetchProductById),
// so list metafields are real arrays by the time mapMetafields sees them.
test('mapMetafields reads the live product_* metafield keys', () => {
  const row = mapMetafields({
    product_collection: ['Underwear', 'Activewear'],
    product_category: ['Tops'],
    product_age: ['Kids', 'Adults'],
    adult_sizes: ['XS', 'S', 'M'],
    fit_description: 'Racerback sports crop',
    materials_composition: {
      type: 'root',
      children: [{ type: 'paragraph', children: [{ type: 'text', value: 'Body: 95% cotton' }] }],
    },
  });

  assert.deepStrictEqual(row.collections, ['Underwear', 'Activewear']);
  assert.deepStrictEqual(row.categories, ['Tops']);
  assert.deepStrictEqual(row.age_groups, ['Kids', 'Adults']);
  assert.deepStrictEqual(row.adult_sizes, ['XS', 'S', 'M']);
  assert.strictEqual(row.fit_description, 'Racerback sports crop');
  assert.strictEqual(row.materials_composition, 'Body: 95% cotton');
});

test('mapMetafields does not read the abandoned collections/categories/age_groups keys', () => {
  // Legacy keys must be ignored — reading them is the bug this guards against.
  const row = mapMetafields({
    collections: ['ShouldBeIgnored'],
    categories: ['ShouldBeIgnored'],
    age_groups: ['ShouldBeIgnored'],
  });

  assert.deepStrictEqual(row.collections, []);
  assert.deepStrictEqual(row.categories, []);
  assert.deepStrictEqual(row.age_groups, []);
});
