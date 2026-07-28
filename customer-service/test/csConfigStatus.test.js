const test = require('node:test');
const assert = require('node:assert');

const { computeCsConfigStatusChanges } = require('../lib/csConfigStatus');

test('activates config when the product is ACTIVE', () => {
  const changes = computeCsConfigStatusChanges(
    [{ handle: 'evey-shaping-sports-bra', status: 'ACTIVE' }],
    [{ product_handle: 'evey-shaping-sports-bra', status: 'draft' }],
  );
  assert.deepStrictEqual(changes, [{ product_handle: 'evey-shaping-sports-bra', status: 'active' }]);
});

test('keeps config draft while the product is DRAFT', () => {
  const changes = computeCsConfigStatusChanges(
    [{ handle: 'new-thing', status: 'DRAFT' }],
    [{ product_handle: 'new-thing', status: 'draft' }],
  );
  assert.deepStrictEqual(changes, []);
});

test('deactivates config when the product is missing from the mirror', () => {
  const changes = computeCsConfigStatusChanges(
    [],
    [{ product_handle: 'retired-thing', status: 'active' }],
  );
  assert.deepStrictEqual(changes, [{ product_handle: 'retired-thing', status: 'draft' }]);
});

test('deactivates config when the product reverts to DRAFT', () => {
  const changes = computeCsConfigStatusChanges(
    [{ handle: 'pulled-thing', status: 'DRAFT' }],
    [{ product_handle: 'pulled-thing', status: 'active' }],
  );
  assert.deepStrictEqual(changes, [{ product_handle: 'pulled-thing', status: 'draft' }]);
});

test('no-op when everything is already in sync', () => {
  const changes = computeCsConfigStatusChanges(
    [
      { handle: 'a', status: 'ACTIVE' },
      { handle: 'b', status: 'DRAFT' },
    ],
    [
      { product_handle: 'a', status: 'active' },
      { product_handle: 'b', status: 'draft' },
    ],
  );
  assert.deepStrictEqual(changes, []);
});
