/**
 * Unit tests for lib/tools/cancelOrder.js
 *
 * Run: node --test customer-service/test/cancelOrder.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// Stub shopify module before requiring cancelOrder
// ---------------------------------------------------------------------------

const shopifyPath = require.resolve('../lib/shopify');

let mockOrder = null;
let cancelOrderCalls = [];
let cancelOrderResult = { id: 'gid://shopify/Job/abc' };
let cancelOrderError = null;

require.cache[shopifyPath] = {
  id: shopifyPath,
  filename: shopifyPath,
  loaded: true,
  exports: {
    getOrderByNumber: async () => mockOrder,
    cancelOrder: async (orderId, opts) => {
      cancelOrderCalls.push({ orderId, opts });
      if (cancelOrderError) throw cancelOrderError;
      return cancelOrderResult;
    },
    getAdminUrl: (gid) => `https://admin.shopify.com/store/test/orders/${(gid || '').split('/').pop()}`,
  },
};

const cancelOrderTools = require('../lib/tools/cancelOrder');
const handler = cancelOrderTools.find(t => t.name === 'cancel_order').handler;

function makeOrder(overrides = {}) {
  return {
    id: 'gid://shopify/Order/12345',
    name: '#29338',
    displayFinancialStatus: 'PAID',
    displayFulfillmentStatus: 'UNFULFILLED',
    customer: { firstName: 'Sam', lastName: 'Doe', email: 'sam@example.com' },
    totalPriceSet: { shopMoney: { amount: '49.00', currencyCode: 'USD' } },
    lineItems: [
      { quantity: 1, title: 'Charlie', variantTitle: 'Black / 1X' },
    ],
    tags: [],
    ...overrides,
  };
}

describe('cancel_order — phase 1 (preview)', () => {
  beforeEach(() => {
    mockOrder = makeOrder();
    cancelOrderCalls = [];
    cancelOrderResult = { id: 'gid://shopify/Job/abc' };
    cancelOrderError = null;
  });

  it('returns a preview without calling cancelOrder', async () => {
    const result = await handler({ order_number: '29338' });
    const text = result.content[0].text;
    assert.match(text, /Cancellation Preview — Awaiting Confirmation/);
    assert.match(text, /#29338/);
    assert.match(text, /Charlie.*Black \/ 1X/);
    assert.match(text, /49\.00 USD/);
    assert.match(text, /Reason:\*\* CUSTOMER/);
    assert.match(text, /Refund:\*\* yes/);
    assert.match(text, /Restock:\*\* yes/);
    assert.match(text, /Notify customer:\*\* yes/);
    assert.equal(cancelOrderCalls.length, 0);
  });

  it('reflects opt-out flags in preview', async () => {
    const result = await handler({
      order_number: '29338',
      refund: false,
      restock: false,
      notify_customer: false,
      reason: 'INVENTORY',
      staff_note: 'OOS at warehouse',
    });
    const text = result.content[0].text;
    assert.match(text, /Reason:\*\* INVENTORY/);
    assert.match(text, /Refund:\*\* no/);
    assert.match(text, /Restock:\*\* no/);
    assert.match(text, /Notify customer:\*\* no/);
    assert.match(text, /Note:\*\* OOS at warehouse/);
    assert.equal(cancelOrderCalls.length, 0);
  });

  it('rejects an invalid reason without calling Shopify', async () => {
    const result = await handler({ order_number: '29338', reason: 'BECAUSE' });
    assert.match(result.content[0].text, /invalid reason/i);
    assert.equal(cancelOrderCalls.length, 0);
  });
});

describe('cancel_order — guards', () => {
  beforeEach(() => {
    cancelOrderCalls = [];
    cancelOrderResult = { id: 'gid://shopify/Job/abc' };
  });

  it('blocks fulfilled orders', async () => {
    mockOrder = makeOrder({ displayFulfillmentStatus: 'FULFILLED' });
    const result = await handler({ order_number: '29338', confirmed: true });
    assert.match(result.content[0].text, /cannot cancel/i);
    assert.equal(cancelOrderCalls.length, 0);
  });

  it('blocks partially fulfilled orders', async () => {
    mockOrder = makeOrder({ displayFulfillmentStatus: 'PARTIALLY_FULFILLED' });
    const result = await handler({ order_number: '29338', confirmed: true });
    assert.match(result.content[0].text, /cannot cancel/i);
    assert.equal(cancelOrderCalls.length, 0);
  });

  it('blocks in-transit orders', async () => {
    mockOrder = makeOrder({ displayFulfillmentStatus: 'IN_TRANSIT' });
    const result = await handler({ order_number: '29338', confirmed: true });
    assert.match(result.content[0].text, /cannot cancel/i);
    assert.equal(cancelOrderCalls.length, 0);
  });

  it('blocks already-fully-refunded orders', async () => {
    mockOrder = makeOrder({ displayFinancialStatus: 'REFUNDED' });
    const result = await handler({ order_number: '29338', confirmed: true });
    assert.match(result.content[0].text, /already fully refunded/i);
    assert.equal(cancelOrderCalls.length, 0);
  });

  it('blocks orders that look already cancelled (RESTOCKED)', async () => {
    mockOrder = makeOrder({ displayFulfillmentStatus: 'RESTOCKED' });
    const result = await handler({ order_number: '29338', confirmed: true });
    assert.match(result.content[0].text, /already be cancelled/i);
    assert.equal(cancelOrderCalls.length, 0);
  });
});

describe('cancel_order — phase 2 (execute)', () => {
  beforeEach(() => {
    mockOrder = makeOrder();
    cancelOrderCalls = [];
    cancelOrderResult = { id: 'gid://shopify/Job/abc' };
    cancelOrderError = null;
  });

  it('calls cancelOrder with default refund/restock/notify=true and reason CUSTOMER', async () => {
    const result = await handler({ order_number: '29338', confirmed: true });
    assert.equal(cancelOrderCalls.length, 1);
    assert.equal(cancelOrderCalls[0].orderId, 'gid://shopify/Order/12345');
    assert.deepEqual(cancelOrderCalls[0].opts, {
      reason: 'CUSTOMER',
      refund: true,
      restock: true,
      notifyCustomer: true,
      staffNote: undefined,
    });
    assert.match(result.content[0].text, /Order cancelled/);
    assert.match(result.content[0].text, /gid:\/\/shopify\/Job\/abc/);
  });

  it('passes through reason / refund / restock / notify_customer / staff_note', async () => {
    await handler({
      order_number: '29338',
      reason: 'STAFF',
      refund: false,
      restock: false,
      notify_customer: false,
      staff_note: 'Duplicate order',
      confirmed: true,
    });
    assert.deepEqual(cancelOrderCalls[0].opts, {
      reason: 'STAFF',
      refund: false,
      restock: false,
      notifyCustomer: false,
      staffNote: 'Duplicate order',
    });
  });

  it('propagates Shopify errors', async () => {
    cancelOrderError = new Error('orderCancel failed: orderId: Order has been archived');
    await assert.rejects(
      () => handler({ order_number: '29338', confirmed: true }),
      /orderCancel failed/,
    );
  });
});
