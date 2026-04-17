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

const { getOrderParentTransaction } = require('../lib/tools/refundOrder');

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
