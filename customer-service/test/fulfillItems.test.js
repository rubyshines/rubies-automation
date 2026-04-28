/**
 * Unit tests for lib/tools/fulfillItems.js
 *
 * Run: node --test customer-service/test/fulfillItems.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const shopifyPath = require.resolve('../lib/shopify');

let mockOrder = null;
let createFulfillmentCalls = [];
let addTagsCalls = [];
let appendNoteCalls = [];
let createFulfillmentResult = { id: 'gid://shopify/Fulfillment/abc', status: 'SUCCESS' };

require.cache[shopifyPath] = {
  id: shopifyPath,
  filename: shopifyPath,
  loaded: true,
  exports: {
    getOrderWithFulfillmentOrders: async () => mockOrder,
    createFulfillment: async (input) => {
      createFulfillmentCalls.push(input);
      return createFulfillmentResult;
    },
    addTags: async (id, tags) => { addTagsCalls.push({ id, tags }); return { id }; },
    appendOrderNote: async (id, note) => { appendNoteCalls.push({ id, note }); return { id, note }; },
    getAdminUrl: (gid) => `https://admin.shopify.com/store/test/orders/${(gid || '').split('/').pop()}`,
  },
};

const fulfillItemsTools = require('../lib/tools/fulfillItems');
const handler = fulfillItemsTools.find(t => t.name === 'fulfill_items').handler;

function makeOrder(overrides = {}) {
  return {
    id: 'gid://shopify/Order/12345',
    name: '#30267',
    displayFinancialStatus: 'PAID',
    displayFulfillmentStatus: 'UNFULFILLED',
    cancelledAt: null,
    tags: [],
    note: '',
    customer: { firstName: 'Damien', lastName: 'Burton', email: 'dami3n.burton@gmail.com' },
    fulfillmentOrders: [
      {
        id: 'gid://shopify/FulfillmentOrder/fo-1',
        status: 'OPEN',
        lineItems: [
          { id: 'gid://shopify/FulfillmentOrderLineItem/foli-charlie', remainingQuantity: 1, totalQuantity: 1, lineItem: { id: 'gid://shopify/LineItem/li-1', title: 'Charlie', variantTitle: 'Black / M', sku: 'UNW-BLK-M' } },
          { id: 'gid://shopify/FulfillmentOrderLineItem/foli-ava', remainingQuantity: 1, totalQuantity: 1, lineItem: { id: 'gid://shopify/LineItem/li-2', title: 'Ava Bra', variantTitle: 'Black / M', sku: 'SB-BLK-M' } },
          { id: 'gid://shopify/FulfillmentOrderLineItem/foli-sassy', remainingQuantity: 1, totalQuantity: 1, lineItem: { id: 'gid://shopify/LineItem/li-3', title: 'Sassy', variantTitle: 'Black / M', sku: 'HLA-BLK-M' } },
        ],
      },
    ],
    ...overrides,
  };
}

describe('fulfill_items — phase 1 (preview)', () => {
  beforeEach(() => {
    mockOrder = makeOrder();
    createFulfillmentCalls = [];
    addTagsCalls = [];
    appendNoteCalls = [];
  });

  it('returns a preview without calling Shopify mutations', async () => {
    const result = await handler({ order_number: '30267', items: [{ sku: 'HLA-BLK-M' }] });
    const text = result.content[0].text;
    assert.match(text, /Fulfill Items Preview — Awaiting Confirmation/);
    assert.match(text, /#30267/);
    assert.match(text, /Sassy.*Black \/ M.*HLA-BLK-M/);
    assert.match(text, /pre-order-pending/);
    assert.equal(createFulfillmentCalls.length, 0);
    assert.equal(addTagsCalls.length, 0);
    assert.equal(appendNoteCalls.length, 0);
  });

  it('lists what stays unfulfilled in the preview', async () => {
    const result = await handler({ order_number: '30267', items: [{ sku: 'HLA-BLK-M' }] });
    const text = result.content[0].text;
    assert.match(text, /Remaining unfulfilled.*Warehance.*\n.*Charlie.*UNW-BLK-M.*\n.*Ava Bra.*SB-BLK-M/s);
  });

  it('errors clearly when the requested SKU is not in unfulfilled items', async () => {
    const result = await handler({ order_number: '30267', items: [{ sku: 'NOT-A-REAL-SKU' }] });
    assert.match(result.content[0].text, /SKU not found in unfulfilled items: NOT-A-REAL-SKU/);
    assert.equal(createFulfillmentCalls.length, 0);
  });

  it('errors when requested quantity exceeds remaining', async () => {
    const result = await handler({ order_number: '30267', items: [{ sku: 'HLA-BLK-M', quantity: 5 }] });
    assert.match(result.content[0].text, /requested 5 but only 1 unfulfilled/);
  });

  it('rejects empty items array', async () => {
    const result = await handler({ order_number: '30267', items: [] });
    assert.match(result.content[0].text, /items array is required/);
  });
});

describe('fulfill_items — guards', () => {
  beforeEach(() => {
    createFulfillmentCalls = [];
    addTagsCalls = [];
    appendNoteCalls = [];
  });

  it('blocks cancelled orders', async () => {
    mockOrder = makeOrder({ cancelledAt: '2026-04-28T12:00:00Z' });
    const result = await handler({ order_number: '30267', items: [{ sku: 'HLA-BLK-M' }] });
    assert.match(result.content[0].text, /cancelled/i);
    assert.equal(createFulfillmentCalls.length, 0);
  });

  it('blocks already-fully-fulfilled orders', async () => {
    mockOrder = makeOrder({ displayFulfillmentStatus: 'FULFILLED' });
    const result = await handler({ order_number: '30267', items: [{ sku: 'HLA-BLK-M' }] });
    assert.match(result.content[0].text, /already fully fulfilled/i);
    assert.equal(createFulfillmentCalls.length, 0);
  });

  it('errors when no unfulfilled line items remain in any open fulfillment order', async () => {
    mockOrder = makeOrder({
      fulfillmentOrders: [{ id: 'gid://shopify/FulfillmentOrder/fo-1', status: 'CLOSED', lineItems: [
        { id: 'foli-x', remainingQuantity: 0, totalQuantity: 1, lineItem: { sku: 'HLA-BLK-M', title: 'Sassy' } },
      ] }],
    });
    const result = await handler({ order_number: '30267', items: [{ sku: 'HLA-BLK-M' }] });
    assert.match(result.content[0].text, /no unfulfilled line items/i);
  });
});

describe('fulfill_items — phase 2 (execute)', () => {
  beforeEach(() => {
    mockOrder = makeOrder();
    createFulfillmentCalls = [];
    addTagsCalls = [];
    appendNoteCalls = [];
    createFulfillmentResult = { id: 'gid://shopify/Fulfillment/abc', status: 'SUCCESS' };
  });

  it('calls fulfillmentCreate with notifyCustomer=false and no tracking', async () => {
    // Phase 1 to get _fulfill_data
    const preview = await handler({ order_number: '30267', items: [{ sku: 'HLA-BLK-M' }] });
    const fulfillData = JSON.parse(preview.content[0].text.match(/_fulfill_data=(\{.*\})/)[1]);

    const result = await handler({
      order_number: '30267',
      items: [{ sku: 'HLA-BLK-M' }],
      confirmed: true,
      _fulfill_data: fulfillData,
    });

    assert.equal(createFulfillmentCalls.length, 1);
    assert.equal(createFulfillmentCalls[0].notifyCustomer, false);
    assert.equal(createFulfillmentCalls[0].trackingInfo, undefined);
    assert.deepEqual(createFulfillmentCalls[0].lineItemsByFulfillmentOrder, [
      { fulfillmentOrderId: 'gid://shopify/FulfillmentOrder/fo-1', fulfillmentOrderLineItems: [{ id: 'gid://shopify/FulfillmentOrderLineItem/foli-sassy', quantity: 1 }] },
    ]);
    assert.match(result.content[0].text, /marked as fulfilled \(placeholder\)/i);
  });

  it('adds the pre-order-pending tag', async () => {
    const preview = await handler({ order_number: '30267', items: [{ sku: 'HLA-BLK-M' }] });
    const fulfillData = JSON.parse(preview.content[0].text.match(/_fulfill_data=(\{.*\})/)[1]);

    await handler({ order_number: '30267', items: [{ sku: 'HLA-BLK-M' }], confirmed: true, _fulfill_data: fulfillData });

    assert.equal(addTagsCalls.length, 1);
    assert.equal(addTagsCalls[0].id, 'gid://shopify/Order/12345');
    assert.deepEqual(addTagsCalls[0].tags, ['pre-order-pending']);
  });

  it('appends an explanatory note, including operator-supplied staff_note', async () => {
    const preview = await handler({ order_number: '30267', items: [{ sku: 'HLA-BLK-M' }] });
    const fulfillData = JSON.parse(preview.content[0].text.match(/_fulfill_data=(\{.*\})/)[1]);

    await handler({
      order_number: '30267',
      items: [{ sku: 'HLA-BLK-M' }],
      staff_note: 'ETA 2 weeks per supplier',
      confirmed: true,
      _fulfill_data: fulfillData,
    });

    assert.equal(appendNoteCalls.length, 1);
    assert.match(appendNoteCalls[0].note, /Pre-order: 1x Sassy.*HLA-BLK-M.*marked as fulfilled.*will ship as a new order/);
    assert.match(appendNoteCalls[0].note, /ETA 2 weeks per supplier/);
  });

  it('handles multiple SKUs at once', async () => {
    const preview = await handler({ order_number: '30267', items: [{ sku: 'HLA-BLK-M' }, { sku: 'SB-BLK-M' }] });
    const fulfillData = JSON.parse(preview.content[0].text.match(/_fulfill_data=(\{.*\})/)[1]);

    await handler({
      order_number: '30267',
      items: [{ sku: 'HLA-BLK-M' }, { sku: 'SB-BLK-M' }],
      confirmed: true,
      _fulfill_data: fulfillData,
    });

    assert.equal(createFulfillmentCalls[0].lineItemsByFulfillmentOrder[0].fulfillmentOrderLineItems.length, 2);
  });
});
