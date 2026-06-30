'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { aliasCandidate, canonicalizeSku, canonicalizeItems } = require('../lib/merchandising/skuCanonical');

test('aliasCandidate maps supplier plus-size codes to catalog codes', () => {
  assert.equal(aliasCandidate('AJ-BLK-1X'), 'AJ-BLK-XL');   // 1X -> XL
  assert.equal(aliasCandidate('AJ-BLK-2X'), 'AJ-BLK-2XL');  // 2X -> 2XL
  assert.equal(aliasCandidate('BB-SND-4X'), 'BB-SND-4XL');
  assert.equal(aliasCandidate('SKY2-BLK-1XT'), 'SKY2-BLK-XLT'); // tall preserved
  assert.equal(aliasCandidate('SKY2-BLK-3XT'), 'SKY2-BLK-3XLT');
});

test('aliasCandidate returns null for non-plus-size codes', () => {
  assert.equal(aliasCandidate('AJ-BLK-12'), null);
  assert.equal(aliasCandidate('AJ-BLK-XL'), null);
  assert.equal(aliasCandidate('AJ-BLK-S'), null);
});

const catalog = new Set(['AJ-BLK-XL', 'AJ-BLK-2XL', 'AJ-BLK-M', 'SB-BLK-L']);

test('canonicalizeSku: exact match passes through', () => {
  assert.deepEqual(canonicalizeSku('AJ-BLK-M', catalog), { sku: 'AJ-BLK-M', matched: 'exact' });
});

test('canonicalizeSku: alias only when the transformed SKU exists in catalog', () => {
  assert.deepEqual(canonicalizeSku('AJ-BLK-1X', catalog), { sku: 'AJ-BLK-XL', original: 'AJ-BLK-1X', matched: 'alias' });
});

test('canonicalizeSku: never invents a SKU — unmatched stays unknown', () => {
  const r = canonicalizeSku('MIA-BLK-11', catalog); // not in catalog, no alias rule
  assert.equal(r.matched, 'unknown');
  assert.equal(r.candidate, null);
  // alias candidate exists but isn't in catalog -> still unknown, original returned
  const r2 = canonicalizeSku('AJ-BLK-3X', catalog);
  assert.equal(r2.matched, 'unknown');
  assert.equal(r2.candidate, 'AJ-BLK-3XL');
  assert.equal(r2.sku, 'AJ-BLK-3X');
});

test('canonicalizeItems merges lines that collapse to the same canonical SKU', () => {
  const { items, remapped, unknown } = canonicalizeItems(
    [{ sku: 'AJ-BLK-XL', qty: 10 }, { sku: 'AJ-BLK-1X', qty: 5 }, { sku: 'MIA-BLK-11', qty: 3 }],
    catalog,
  );
  const xl = items.find((i) => i.sku === 'AJ-BLK-XL');
  assert.equal(xl.qty, 15); // 10 exact + 5 aliased
  assert.equal(remapped.length, 1);
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0].sku, 'MIA-BLK-11');
});
