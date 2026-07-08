/**
 * Unit tests for split_shipment's allocateSplitLineItems.
 *
 * The Simple Bundles case: one SKU appears as MULTIPLE fulfillment-order line
 * items (one per unbundled component, each quantity 1). Allocation must spread
 * the requested quantity across them instead of targeting only matches[0].
 *
 * Run: node --test customer-service/test/allocateSplitLineItems.test.js
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { allocateSplitLineItems } = require('../lib/tools/splitShipment');

function foLine(id, foId, sku, remainingQuantity, { variantId = `gid://shopify/ProductVariant/${id}`, title = 'Underwear', variantTitle = 'Black / 3XL' } = {}) {
  return {
    id: `gid://shopify/FulfillmentOrderLineItem/${id}`,
    fulfillmentOrderId: `gid://shopify/FulfillmentOrder/${foId}`,
    remainingQuantity,
    lineItem: { sku, title, variantTitle, variant: variantId ? { id: variantId } : null },
  };
}

describe('allocateSplitLineItems', () => {
  it('allocates a simple single-line request', () => {
    const { byFo, newOrderLineItems, errors } = allocateSplitLineItems(
      [foLine(1, 10, 'UNW-BLK-3XL', 2)],
      [{ sku: 'UNW-BLK-3XL', quantity: 1 }],
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(byFo.get('gid://shopify/FulfillmentOrder/10'), [
      { id: 'gid://shopify/FulfillmentOrderLineItem/1', quantity: 1 },
    ]);
    assert.equal(newOrderLineItems.length, 1);
  });

  it('spreads one SKU across multiple line items (Simple Bundles)', () => {
    const { byFo, errors } = allocateSplitLineItems(
      [foLine(1, 10, 'UNW-BLK-3XL', 1), foLine(2, 10, 'UNW-BLK-3XL', 1)],
      [{ sku: 'UNW-BLK-3XL', quantity: 2 }],
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(byFo.get('gid://shopify/FulfillmentOrder/10'), [
      { id: 'gid://shopify/FulfillmentOrderLineItem/1', quantity: 1 },
      { id: 'gid://shopify/FulfillmentOrderLineItem/2', quantity: 1 },
    ]);
  });

  it('spreads across fulfillment orders when the SKU spans FOs', () => {
    const { byFo, errors } = allocateSplitLineItems(
      [foLine(1, 10, 'UNW-BLK-3XL', 1), foLine(2, 20, 'UNW-BLK-3XL', 1)],
      [{ sku: 'UNW-BLK-3XL', quantity: 2 }],
    );
    assert.deepEqual(errors, []);
    assert.equal(byFo.size, 2);
  });

  it('errors when the request exceeds TOTAL capacity across lines', () => {
    const { errors } = allocateSplitLineItems(
      [foLine(1, 10, 'UNW-BLK-3XL', 1), foLine(2, 10, 'UNW-BLK-3XL', 1)],
      [{ sku: 'UNW-BLK-3XL', quantity: 3 }],
    );
    assert.equal(errors.length, 1);
    assert.match(errors[0], /requested 3 but only 2 unfulfilled across 2 line item/);
  });

  it('defaults quantity to ALL unfulfilled units of the SKU', () => {
    const { byFo, errors } = allocateSplitLineItems(
      [foLine(1, 10, 'UNW-BLK-3XL', 1), foLine(2, 10, 'UNW-BLK-3XL', 2)],
      [{ sku: 'UNW-BLK-3XL' }],
    );
    assert.deepEqual(errors, []);
    const total = byFo.get('gid://shopify/FulfillmentOrder/10').reduce((s, e) => s + e.quantity, 0);
    assert.equal(total, 3);
  });

  it('the same SKU requested twice does not double-count capacity', () => {
    const { byFo, errors } = allocateSplitLineItems(
      [foLine(1, 10, 'UNW-BLK-3XL', 1)],
      [{ sku: 'UNW-BLK-3XL', quantity: 1 }, { sku: 'UNW-BLK-3XL', quantity: 1 }],
    );
    assert.equal(errors.length, 1); // second request finds no remaining capacity
    assert.deepEqual(byFo.get('gid://shopify/FulfillmentOrder/10'), [
      { id: 'gid://shopify/FulfillmentOrderLineItem/1', quantity: 1 },
    ]);
  });

  it('errors on unknown SKU and missing sku field', () => {
    const { errors } = allocateSplitLineItems(
      [foLine(1, 10, 'UNW-BLK-3XL', 1)],
      [{ sku: 'NOPE' }, { quantity: 1 }],
    );
    assert.equal(errors.length, 2);
  });

  it('errors when a matched line has no variant id', () => {
    const { errors } = allocateSplitLineItems(
      [foLine(1, 10, 'CUSTOM-ITEM', 1, { variantId: null })],
      [{ sku: 'CUSTOM-ITEM', quantity: 1 }],
    );
    assert.equal(errors.length, 1);
    assert.match(errors[0], /no variant id/);
  });
});
