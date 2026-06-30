/**
 * Unit tests for lib/tools/refundOrder.js — parent transaction lookup.
 *
 * Run: node --test customer-service/test/refundOrder.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// Stub shopify module before requiring refundOrder
// ---------------------------------------------------------------------------

const shopifyPath = require.resolve('../lib/shopify');

let mockGraphQLResponse = null;
let lastGraphQLCall = null;

function stubShopifyGraphQL(query, variables) {
  lastGraphQLCall = { query, variables };
  return Promise.resolve(mockGraphQLResponse);
}

require.cache[shopifyPath] = {
  id: shopifyPath,
  filename: shopifyPath,
  loaded: true,
  exports: {
    shopifyGraphQL: stubShopifyGraphQL,
    getOrderByNumber: async () => null,
    calculateRefund: async () => null,
    createRefund: async () => null,
    getAdminUrl: () => '',
    normalizeGid: (id, type) => {
      if (typeof id === 'string' && id.startsWith('gid://')) return id;
      return `gid://shopify/${type}/${id}`;
    },
  },
};

const { getOrderParentTransaction, allocateRefundLineItems } = require('../lib/tools/refundOrder');

function makeTxn(kind, status, { id = `gid://shopify/OrderTransaction/${kind}-${status}`, gateway = 'shopify_payments', currency = 'CAD', amount = '50.00' } = {}) {
  return {
    id,
    kind,
    status,
    gateway,
    amountSet: {
      shopMoney: { amount, currencyCode: currency },
      presentmentMoney: { amount, currencyCode: currency },
    },
  };
}

describe('getOrderParentTransaction', () => {
  beforeEach(() => {
    mockGraphQLResponse = null;
    lastGraphQLCall = null;
  });

  it('normalizes numeric order id to GID before querying', async () => {
    mockGraphQLResponse = { order: { transactions: [makeTxn('SALE', 'SUCCESS')] } };
    await getOrderParentTransaction('12345');
    assert.equal(lastGraphQLCall.variables.id, 'gid://shopify/Order/12345');
  });

  it('returns the successful SALE transaction when present', async () => {
    const sale = makeTxn('SALE', 'SUCCESS');
    mockGraphQLResponse = { order: { transactions: [sale] } };
    const result = await getOrderParentTransaction('gid://shopify/Order/1');
    assert.equal(result.id, sale.id);
    assert.equal(result.gateway, 'shopify_payments');
    assert.equal(result.presentmentCurrency, 'CAD');
  });

  it('returns the successful CAPTURE transaction when SALE is absent (Shopify Payments path)', async () => {
    // Regression for commit 9567246 — Shopify Payments uses CAPTURE, not SALE, for most orders.
    const capture = makeTxn('CAPTURE', 'SUCCESS', { gateway: 'shopify_payments' });
    mockGraphQLResponse = { order: { transactions: [capture] } };
    const result = await getOrderParentTransaction('gid://shopify/Order/2');
    assert.ok(result, 'expected CAPTURE to be accepted as parent transaction');
    assert.equal(result.id, capture.id);
    assert.equal(result.gateway, 'shopify_payments');
  });

  it('ignores FAILED SALE and FAILED CAPTURE transactions', async () => {
    mockGraphQLResponse = {
      order: {
        transactions: [
          makeTxn('SALE', 'FAILURE'),
          makeTxn('CAPTURE', 'FAILURE'),
        ],
      },
    };
    const result = await getOrderParentTransaction('gid://shopify/Order/3');
    assert.equal(result, null);
  });

  it('ignores AUTHORIZATION and REFUND kinds', async () => {
    mockGraphQLResponse = {
      order: {
        transactions: [
          makeTxn('AUTHORIZATION', 'SUCCESS'),
          makeTxn('REFUND', 'SUCCESS'),
        ],
      },
    };
    const result = await getOrderParentTransaction('gid://shopify/Order/4');
    assert.equal(result, null);
  });

  it('picks the first matching successful transaction when both SALE and CAPTURE exist', async () => {
    // Order doesn't matter much — just verify it picks one without crashing.
    const sale = makeTxn('SALE', 'SUCCESS', { id: 'gid://shopify/OrderTransaction/sale-1' });
    const capture = makeTxn('CAPTURE', 'SUCCESS', { id: 'gid://shopify/OrderTransaction/capture-1' });
    mockGraphQLResponse = { order: { transactions: [sale, capture] } };
    const result = await getOrderParentTransaction('gid://shopify/Order/5');
    assert.ok(result);
    assert.ok(result.id === sale.id || result.id === capture.id);
  });

  it('returns null when the order has no transactions', async () => {
    mockGraphQLResponse = { order: { transactions: [] } };
    const result = await getOrderParentTransaction('gid://shopify/Order/6');
    assert.equal(result, null);
  });

  it('surfaces presentment currency from the matched transaction', async () => {
    const usd = makeTxn('CAPTURE', 'SUCCESS', { currency: 'USD' });
    mockGraphQLResponse = { order: { transactions: [usd] } };
    const result = await getOrderParentTransaction('gid://shopify/Order/7');
    assert.equal(result.presentmentCurrency, 'USD');
  });
});

// ---------------------------------------------------------------------------
// allocateRefundLineItems — SKU→line-item resolution across duplicate lines
// ---------------------------------------------------------------------------

function li(id, sku, { quantity = 1, currentQuantity = null, title = 'Item', variantTitle = null } = {}) {
  return {
    id: `gid://shopify/LineItem/${id}`,
    sku,
    quantity,
    currentQuantity: currentQuantity == null ? quantity : currentQuantity,
    title,
    variantTitle,
  };
}

describe('allocateRefundLineItems', () => {
  it('spreads one SKU request across two separate line items (Simple Bundles)', () => {
    // Regression: order has the same SKU as two separate qty-1 line items.
    const order = [
      li(1, 'UNW-BLK-3XL', { title: 'Charlie', variantTitle: 'Black / 3X' }),
      li(2, 'UNW-BLK-3XL', { title: 'Charlie', variantTitle: 'Black / 3X' }),
    ];
    const { refundLineItems, error } = allocateRefundLineItems(order, [{ sku: 'UNW-BLK-3XL', quantity: 2 }]);
    assert.equal(error, undefined);
    assert.equal(refundLineItems.length, 2);
    assert.deepEqual(refundLineItems.map(r => r.quantity), [1, 1]);
    assert.deepEqual(
      refundLineItems.map(r => r.lineItemId).sort(),
      ['gid://shopify/LineItem/1', 'gid://shopify/LineItem/2'],
    );
  });

  it('does not double-count when the same SKU is passed as two separate items', () => {
    const order = [
      li(1, 'UNW-BLK-3XL'),
      li(2, 'UNW-BLK-3XL'),
    ];
    const { refundLineItems, error } = allocateRefundLineItems(order, [
      { sku: 'UNW-BLK-3XL', quantity: 1 },
      { sku: 'UNW-BLK-3XL', quantity: 1 },
    ]);
    assert.equal(error, undefined);
    // Two distinct line items, each qty 1 — not the same line twice.
    assert.equal(refundLineItems.length, 2);
    assert.deepEqual(
      refundLineItems.map(r => r.lineItemId).sort(),
      ['gid://shopify/LineItem/1', 'gid://shopify/LineItem/2'],
    );
    refundLineItems.forEach(r => assert.equal(r.quantity, 1));
  });

  it('refunds the full quantity from a single qty-N line item', () => {
    const order = [li(1, 'UNW-BLK-3XL', { quantity: 2 })];
    const { refundLineItems, error } = allocateRefundLineItems(order, [{ sku: 'UNW-BLK-3XL', quantity: 2 }]);
    assert.equal(error, undefined);
    assert.equal(refundLineItems.length, 1);
    assert.equal(refundLineItems[0].quantity, 2);
  });

  it('errors when requested quantity exceeds total refundable across matching lines', () => {
    const order = [li(1, 'UNW-BLK-3XL'), li(2, 'UNW-BLK-3XL')];
    const { error } = allocateRefundLineItems(order, [{ sku: 'UNW-BLK-3XL', quantity: 3 }]);
    assert.match(error, /only 2 refundable across 2 line item/);
  });

  it('respects currentQuantity (prior partial refund) as the cap', () => {
    // One unit already refunded → currentQuantity 1 of original quantity 2.
    const order = [li(1, 'UNW-BLK-3XL', { quantity: 2, currentQuantity: 1 })];
    const ok = allocateRefundLineItems(order, [{ sku: 'UNW-BLK-3XL', quantity: 1 }]);
    assert.equal(ok.error, undefined);
    assert.equal(ok.refundLineItems[0].quantity, 1);
    const over = allocateRefundLineItems(order, [{ sku: 'UNW-BLK-3XL', quantity: 2 }]);
    assert.match(over.error, /only 1 refundable/);
  });

  it('errors with the available SKU list when the SKU is not on the order', () => {
    const order = [li(1, 'BB-BLK-4XL')];
    const { error } = allocateRefundLineItems(order, [{ sku: 'NOPE-X', quantity: 1 }]);
    assert.match(error, /not found on order/);
    assert.match(error, /BB-BLK-4XL/);
  });

  it('handles mixed SKUs in one request', () => {
    const order = [
      li(1, 'UNW-BLK-3XL'),
      li(2, 'UNW-BLK-3XL'),
      li(3, 'BB-BLK-4XL'),
    ];
    const { refundLineItems, error } = allocateRefundLineItems(order, [
      { sku: 'UNW-BLK-3XL', quantity: 2 },
      { sku: 'BB-BLK-4XL', quantity: 1 },
    ]);
    assert.equal(error, undefined);
    assert.equal(refundLineItems.length, 3);
    const total = refundLineItems.reduce((s, r) => s + r.quantity, 0);
    assert.equal(total, 3);
  });

  it('resolves a direct line_item_id and validates its capacity', () => {
    const order = [li(1, 'UNW-BLK-3XL', { quantity: 2 })];
    const ok = allocateRefundLineItems(order, [{ line_item_id: 'gid://shopify/LineItem/1', quantity: 2 }]);
    assert.equal(ok.error, undefined);
    assert.equal(ok.refundLineItems[0].lineItemId, 'gid://shopify/LineItem/1');
    const over = allocateRefundLineItems(order, [{ line_item_id: '1', quantity: 5 }]);
    assert.match(over.error, /only 2 refundable/);
  });

  it('passes through a line_item_id that is not on the fetched order', () => {
    const order = [li(1, 'UNW-BLK-3XL')];
    const { refundLineItems, error } = allocateRefundLineItems(order, [
      { line_item_id: 'gid://shopify/LineItem/999', quantity: 1 },
    ]);
    assert.equal(error, undefined);
    assert.equal(refundLineItems[0].lineItemId, 'gid://shopify/LineItem/999');
  });

  it('errors when an item has neither sku nor line_item_id', () => {
    const { error } = allocateRefundLineItems([li(1, 'X')], [{ quantity: 1 }]);
    assert.match(error, /must have either sku or line_item_id/);
  });
});
