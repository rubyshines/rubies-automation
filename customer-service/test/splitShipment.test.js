/**
 * Unit tests for lib/tools/splitShipment.js
 *
 * Run: node --test customer-service/test/splitShipment.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const shopifyPath = require.resolve('../lib/shopify');

let mockOrder = null;
let mockOrdersByNumber = {};
let createFulfillmentCalls = [];
let addTagsCalls = [];
let appendNoteCalls = [];
let createDraftOrderCalls = [];
let completeDraftOrderCalls = [];
let createFulfillmentResult = { id: 'gid://shopify/Fulfillment/abc', status: 'SUCCESS' };
let createDraftOrderResult = { id: 'gid://shopify/DraftOrder/draft-1' };
let completeDraftOrderResult = { order: { id: 'gid://shopify/Order/99999', name: '#30268' } };
let createDraftOrderError = null;

require.cache[shopifyPath] = {
  id: shopifyPath,
  filename: shopifyPath,
  loaded: true,
  exports: {
    getOrderWithFulfillmentOrders: async (orderNumber) => {
      const key = String(orderNumber).replace(/^#/, '');
      return mockOrdersByNumber[key] || mockOrder;
    },
    createFulfillment: async (input) => {
      createFulfillmentCalls.push(input);
      return createFulfillmentResult;
    },
    addTags: async (id, tags) => { addTagsCalls.push({ id, tags }); return { id }; },
    appendOrderNote: async (id, note) => { appendNoteCalls.push({ id, note }); return { id, note }; },
    createDraftOrder: async (input) => {
      createDraftOrderCalls.push(input);
      if (createDraftOrderError) throw createDraftOrderError;
      return createDraftOrderResult;
    },
    completeDraftOrder: async (id) => {
      completeDraftOrderCalls.push(id);
      return completeDraftOrderResult;
    },
    getAdminUrl: (gid) => `https://admin.shopify.com/store/test/orders/${(gid || '').split('/').pop()}`,
  },
};

// Warehance + the warehouse-hold handler are reached by lazy require inside the
// hold branch, so stubbing the cache here covers the handler path without
// making every other test in this file carry warehouse fixtures.
const warehancePath = require.resolve('../../reports/lib/warehanceClient');
const orderNotesPath = require.resolve('../lib/tools/orderNotes');

let warehanceLookups = [];
let warehanceFindsOrderAfter = 0; // attempts to fail before the order "appears"
let holdCalls = [];
let holdResult = { content: [{ type: 'text', text: '**Warehouse hold placed** on order #30268' }] };

require.cache[warehancePath] = {
  id: warehancePath,
  filename: warehancePath,
  loaded: true,
  exports: {
    fetchOrderByNumber: async (num) => {
      warehanceLookups.push(num);
      return warehanceLookups.length > warehanceFindsOrderAfter ? { id: 999, order_number: `#${num}` } : null;
    },
  },
};
require.cache[orderNotesPath] = {
  id: orderNotesPath,
  filename: orderNotesPath,
  loaded: true,
  exports: {
    handleWarehouseHold: async (args) => { holdCalls.push(args); return holdResult; },
  },
};

const splitShipmentTools = require('../lib/tools/splitShipment');
const handler = splitShipmentTools.find(t => t.name === 'split_shipment').handler;
const { holdNewOrder } = splitShipmentTools;

function makeOrder(overrides = {}) {
  return {
    id: 'gid://shopify/Order/12345',
    name: '#30267',
    displayFinancialStatus: 'PAID',
    displayFulfillmentStatus: 'UNFULFILLED',
    cancelledAt: null,
    tags: [],
    note: '',
    customer: { id: 'gid://shopify/Customer/77', firstName: 'Damien', lastName: 'Burton', email: 'dami3n.burton@gmail.com' },
    shippingAddress: { firstName: 'Damien', lastName: 'Burton', address1: '1 Main St', city: 'Brooklyn', province: 'NY', country: 'US', zip: '11201' },
    fulfillmentOrders: [
      {
        id: 'gid://shopify/FulfillmentOrder/fo-1',
        status: 'OPEN',
        lineItems: [
          { id: 'gid://shopify/FulfillmentOrderLineItem/foli-charlie', remainingQuantity: 1, totalQuantity: 1, lineItem: { id: 'gid://shopify/LineItem/li-1', title: 'Charlie', variantTitle: 'Black / M', sku: 'UNW-BLK-M', variant: { id: 'gid://shopify/ProductVariant/v-charlie' } } },
          { id: 'gid://shopify/FulfillmentOrderLineItem/foli-ava', remainingQuantity: 1, totalQuantity: 1, lineItem: { id: 'gid://shopify/LineItem/li-2', title: 'Ava Bra', variantTitle: 'Black / M', sku: 'SB-BLK-M', variant: { id: 'gid://shopify/ProductVariant/v-ava' } } },
          { id: 'gid://shopify/FulfillmentOrderLineItem/foli-sassy', remainingQuantity: 1, totalQuantity: 1, lineItem: { id: 'gid://shopify/LineItem/li-3', title: 'Sassy', variantTitle: 'Black / M', sku: 'HLA-BLK-M', variant: { id: 'gid://shopify/ProductVariant/v-sassy' } } },
        ],
      },
    ],
    ...overrides,
  };
}

function resetCalls() {
  warehanceLookups = [];
  warehanceFindsOrderAfter = 0;
  holdCalls = [];
  holdResult = { content: [{ type: 'text', text: '**Warehouse hold placed** on order #30268' }] };
  mockOrdersByNumber = {};
  createFulfillmentCalls = [];
  addTagsCalls = [];
  appendNoteCalls = [];
  createDraftOrderCalls = [];
  completeDraftOrderCalls = [];
  createDraftOrderError = null;
  createFulfillmentResult = { id: 'gid://shopify/Fulfillment/abc', status: 'SUCCESS' };
  createDraftOrderResult = { id: 'gid://shopify/DraftOrder/draft-1' };
  completeDraftOrderResult = { order: { id: 'gid://shopify/Order/99999', name: '#30268' } };
}

function previewFulfillData(previewText) {
  // Phase 1 preview embeds _fulfill_data=<JSON> on the last line. Extract it.
  const m = previewText.match(/_fulfill_data=(\{[\s\S]*\})\.?$/);
  return JSON.parse(m[1]);
}

describe('split_shipment — phase 1 (preview)', () => {
  beforeEach(() => { mockOrder = makeOrder(); resetCalls(); });

  it('returns a preview describing both the placeholder fulfillment and the new pre-order', async () => {
    const result = await handler({ order_number: '30267', split_kind: 'pre_order', items: [{ sku: 'HLA-BLK-M' }] });
    const text = result.content[0].text;
    assert.match(text, /Order Split Preview \(pre-order\) — Awaiting Confirmation/);
    assert.match(text, /On the original order — mark fulfilled \(placeholder/);
    assert.match(text, /On the original order — remaining \(Warehance will ship now\)/);
    assert.match(text, /Charlie.*UNW-BLK-M/);
    assert.match(text, /Ava Bra.*SB-BLK-M/);
    assert.match(text, /New pre-order to create:/);
    assert.match(text, /pre-order-from-30267/);
    assert.match(text, /Total: \$0/);
    // No mutations called
    assert.equal(createFulfillmentCalls.length, 0);
    assert.equal(createDraftOrderCalls.length, 0);
    assert.equal(addTagsCalls.length, 0);
  });

  it('errors clearly when the requested SKU is not in unfulfilled items', async () => {
    const result = await handler({ order_number: '30267', split_kind: 'pre_order', items: [{ sku: 'NOT-A-REAL-SKU' }] });
    assert.match(result.content[0].text, /SKU not found in unfulfilled items: NOT-A-REAL-SKU/);
  });

  it('errors when requested quantity exceeds remaining', async () => {
    const result = await handler({ order_number: '30267', split_kind: 'pre_order', items: [{ sku: 'HLA-BLK-M', quantity: 5 }] });
    assert.match(result.content[0].text, /requested 5 but only 1 unfulfilled/);
  });

  it('errors when the line item has no variant id (custom item)', async () => {
    mockOrder = makeOrder({
      fulfillmentOrders: [{ id: 'fo-1', status: 'OPEN', lineItems: [
        { id: 'foli-x', remainingQuantity: 1, totalQuantity: 1, lineItem: { title: 'Custom', sku: 'CUSTOM-X', variant: null } },
      ] }],
    });
    const result = await handler({ order_number: '30267', split_kind: 'pre_order', items: [{ sku: 'CUSTOM-X' }] });
    assert.match(result.content[0].text, /no variant id on original line item/);
  });

  it('rejects empty items array', async () => {
    const result = await handler({ order_number: '30267', split_kind: 'pre_order', items: [] });
    assert.match(result.content[0].text, /items array is required/);
  });
});

describe('split_shipment — guards', () => {
  beforeEach(() => { resetCalls(); });

  it('blocks cancelled orders', async () => {
    mockOrder = makeOrder({ cancelledAt: '2026-04-28T12:00:00Z' });
    const result = await handler({ order_number: '30267', split_kind: 'pre_order', items: [{ sku: 'HLA-BLK-M' }] });
    assert.match(result.content[0].text, /cancelled/i);
  });

  it('blocks already-fully-fulfilled orders', async () => {
    mockOrder = makeOrder({ displayFulfillmentStatus: 'FULFILLED' });
    const result = await handler({ order_number: '30267', split_kind: 'pre_order', items: [{ sku: 'HLA-BLK-M' }] });
    assert.match(result.content[0].text, /already fully fulfilled/i);
  });

  it('blocks orders without a customer (cannot create new pre-order)', async () => {
    mockOrder = makeOrder({ customer: null });
    const result = await handler({ order_number: '30267', split_kind: 'pre_order', items: [{ sku: 'HLA-BLK-M' }] });
    assert.match(result.content[0].text, /no associated customer/i);
  });

  it('errors when no unfulfilled line items remain', async () => {
    mockOrder = makeOrder({
      fulfillmentOrders: [{ id: 'fo-1', status: 'CLOSED', lineItems: [
        { id: 'foli-x', remainingQuantity: 0, totalQuantity: 1, lineItem: { sku: 'HLA-BLK-M', title: 'Sassy', variant: { id: 'gid://shopify/ProductVariant/v-sassy' } } },
      ] }],
    });
    const result = await handler({ order_number: '30267', split_kind: 'pre_order', items: [{ sku: 'HLA-BLK-M' }] });
    assert.match(result.content[0].text, /no unfulfilled line items/i);
  });
});

describe('split_shipment — phase 2 (execute)', () => {
  beforeEach(() => { mockOrder = makeOrder(); resetCalls(); });

  it('runs all four steps: placeholder fulfill, note, tag, and new pre-order', async () => {
    const preview = await handler({ order_number: '30267', split_kind: 'pre_order', items: [{ sku: 'HLA-BLK-M' }] });
    const fulfillData = previewFulfillData(preview.content[0].text);

    const result = await handler({
      order_number: '30267', split_kind: 'pre_order',
      items: [{ sku: 'HLA-BLK-M' }],
      confirmed: true,
      _fulfill_data: fulfillData,
    });

    // Step 1: placeholder fulfillment with notify=false, no tracking
    assert.equal(createFulfillmentCalls.length, 1);
    assert.equal(createFulfillmentCalls[0].notifyCustomer, false);
    assert.equal(createFulfillmentCalls[0].trackingInfo, undefined);

    // Step 2: tag + note (only one addTags call — the new pre-order's tags are
    // passed inline via the draftOrderCreate input, not a separate tagsAdd)
    assert.equal(addTagsCalls.length, 1);
    assert.deepEqual(addTagsCalls[0].tags, ['pre-order-pending']);
    assert.equal(appendNoteCalls.length, 1);
    assert.match(appendNoteCalls[0].note, /Pre-order split.*marked as fulfilled/);

    // Step 3: new pre-order
    assert.equal(createDraftOrderCalls.length, 1);
    assert.equal(createDraftOrderCalls[0].customerId, 'gid://shopify/Customer/77');
    assert.deepEqual(createDraftOrderCalls[0].lineItems, [{
      variantId: 'gid://shopify/ProductVariant/v-sassy',
      quantity: 1,
      customAttributes: [{ key: 'Pre-order', value: 'Will ship when in stock' }],
    }]);
    assert.deepEqual(createDraftOrderCalls[0].tags, ['pre-order', 'cs-mcp', 'pre-order-from-30267']);
    assert.equal(createDraftOrderCalls[0].appliedDiscount.value, 100);
    assert.equal(completeDraftOrderCalls.length, 1);
    assert.equal(completeDraftOrderCalls[0], 'gid://shopify/DraftOrder/draft-1');

    assert.match(result.content[0].text, /Order split for pre-order/);
    assert.match(result.content[0].text, /#30268/); // new order name
  });

  it('handles multiple SKUs at once', async () => {
    const preview = await handler({ order_number: '30267', split_kind: 'pre_order', items: [{ sku: 'HLA-BLK-M' }, { sku: 'SB-BLK-M' }] });
    const fulfillData = previewFulfillData(preview.content[0].text);

    await handler({
      order_number: '30267', split_kind: 'pre_order',
      items: [{ sku: 'HLA-BLK-M' }, { sku: 'SB-BLK-M' }],
      confirmed: true,
      _fulfill_data: fulfillData,
    });

    assert.equal(createFulfillmentCalls[0].lineItemsByFulfillmentOrder[0].fulfillmentOrderLineItems.length, 2);
    assert.equal(createDraftOrderCalls[0].lineItems.length, 2);
  });

  it('passes staff_note through to both notes', async () => {
    const preview = await handler({ order_number: '30267', split_kind: 'pre_order', items: [{ sku: 'HLA-BLK-M' }] });
    const fulfillData = previewFulfillData(preview.content[0].text);

    await handler({
      order_number: '30267', split_kind: 'pre_order',
      items: [{ sku: 'HLA-BLK-M' }],
      staff_note: 'ETA 2 weeks per supplier',
      confirmed: true,
      _fulfill_data: fulfillData,
    });

    assert.match(appendNoteCalls[0].note, /ETA 2 weeks per supplier/);
    assert.match(createDraftOrderCalls[0].note, /ETA 2 weeks per supplier/);
  });

  it('returns a recoverable error if the new pre-order step fails after the placeholder fulfillment succeeded', async () => {
    const preview = await handler({ order_number: '30267', split_kind: 'pre_order', items: [{ sku: 'HLA-BLK-M' }] });
    const fulfillData = previewFulfillData(preview.content[0].text);

    createDraftOrderError = new Error('draftOrderCreate failed: variant not found');

    const result = await handler({
      order_number: '30267', split_kind: 'pre_order',
      items: [{ sku: 'HLA-BLK-M' }],
      confirmed: true,
      _fulfill_data: fulfillData,
    });

    assert.equal(createFulfillmentCalls.length, 1); // step 1 succeeded
    assert.match(result.content[0].text, /Partial success/);
    assert.match(result.content[0].text, /New pre-order creation failed/);
    assert.match(result.content[0].text, /Recovery: manually create/);
  });
});

function makeDestOrder(overrides = {}) {
  return makeOrder({
    id: 'gid://shopify/Order/55555',
    name: '#31479',
    fulfillmentOrders: [
      {
        id: 'gid://shopify/FulfillmentOrder/fo-dest',
        status: 'OPEN',
        lineItems: [
          { id: 'gid://shopify/FulfillmentOrderLineItem/foli-dest-ava', remainingQuantity: 1, totalQuantity: 1, lineItem: { id: 'gid://shopify/LineItem/li-d1', title: 'Ava Bra', variantTitle: 'Black / M', sku: 'SB-BLK-M', variant: { id: 'gid://shopify/ProductVariant/v-ava' } } },
          { id: 'gid://shopify/FulfillmentOrderLineItem/foli-dest-cky', remainingQuantity: 1, totalQuantity: 1, lineItem: { id: 'gid://shopify/LineItem/li-d2', title: 'Cheeky', variantTitle: 'Black / M', sku: 'CKY-BLK-M', variant: { id: 'gid://shopify/ProductVariant/v-cky' } } },
        ],
      },
    ],
    ...overrides,
  });
}

describe('split_shipment — merge mode (ship_with_order)', () => {
  beforeEach(() => {
    mockOrder = makeOrder();
    resetCalls();
    mockOrdersByNumber = { 30267: makeOrder(), 31479: makeDestOrder() };
  });

  it('preview references the destination order and creates no pre-order', async () => {
    const result = await handler({ order_number: '30267', items: [{ sku: 'SB-BLK-M' }], ship_with_order: '31479' });
    const text = result.content[0].text;
    assert.match(text, /Shipment Merge Preview — Awaiting Confirmation/);
    assert.match(text, /Destination order \(ships the items\):.*#31479/);
    assert.match(text, /No new order will be created/);
    assert.match(text, /ships-with-31479/);
    assert.doesNotMatch(text, /New pre-order to create/);
    // remaining items framed as staying, not shipping now
    assert.match(text, /remaining \(unchanged, ships from this order when available\)/);
    // no mutations in phase 1
    assert.equal(createFulfillmentCalls.length, 0);
    assert.equal(createDraftOrderCalls.length, 0);
    assert.equal(addTagsCalls.length, 0);
    assert.equal(appendNoteCalls.length, 0);
  });

  it('warns when the destination lacks the merged SKU in sufficient quantity', async () => {
    const dest = makeDestOrder();
    dest.fulfillmentOrders[0].lineItems = dest.fulfillmentOrders[0].lineItems.filter(li => li.lineItem.sku !== 'SB-BLK-M');
    mockOrdersByNumber['31479'] = dest;
    const result = await handler({ order_number: '30267', items: [{ sku: 'SB-BLK-M' }], ship_with_order: '31479' });
    assert.match(result.content[0].text, /has 0x SB-BLK-M unfulfilled but 1x are being merged/);
  });

  it('rejects merging an order into itself', async () => {
    mockOrdersByNumber['31479'] = makeOrder(); // same id as original
    const result = await handler({ order_number: '30267', items: [{ sku: 'SB-BLK-M' }], ship_with_order: '31479' });
    assert.match(result.content[0].text, /same order/i);
  });

  it('rejects a cancelled destination order', async () => {
    mockOrdersByNumber['31479'] = makeDestOrder({ cancelledAt: '2026-07-01T00:00:00Z' });
    const result = await handler({ order_number: '30267', items: [{ sku: 'SB-BLK-M' }], ship_with_order: '31479' });
    assert.match(result.content[0].text, /destination order #31479 is cancelled/i);
  });

  it('rejects an already-fulfilled destination order', async () => {
    mockOrdersByNumber['31479'] = makeDestOrder({ displayFulfillmentStatus: 'FULFILLED' });
    const result = await handler({ order_number: '30267', items: [{ sku: 'SB-BLK-M' }], ship_with_order: '31479' });
    assert.match(result.content[0].text, /already fully fulfilled — too late to merge/i);
  });

  it('allows a customer-less original order (no pre-order needs creating)', async () => {
    const orig = makeOrder({ customer: null });
    mockOrder = orig;
    mockOrdersByNumber['30267'] = orig;
    const result = await handler({ order_number: '30267', items: [{ sku: 'SB-BLK-M' }], ship_with_order: '31479' });
    assert.match(result.content[0].text, /Shipment Merge Preview/);
  });

  it('phase 2 placeholder-fulfills, tags, cross-notes both orders, and never creates an order', async () => {
    const preview = await handler({ order_number: '30267', items: [{ sku: 'SB-BLK-M' }], ship_with_order: '31479' });
    const fulfillData = previewFulfillData(preview.content[0].text);
    assert.deepEqual(fulfillData.ship_with, { dest_order_id: 'gid://shopify/Order/55555', dest_order_name: '#31479' });

    const result = await handler({
      order_number: '30267',
      items: [{ sku: 'SB-BLK-M' }],
      ship_with_order: '31479',
      confirmed: true,
      _fulfill_data: fulfillData,
    });

    // placeholder fulfillment on the original, silent
    assert.equal(createFulfillmentCalls.length, 1);
    assert.equal(createFulfillmentCalls[0].notifyCustomer, false);

    // no new order of any kind
    assert.equal(createDraftOrderCalls.length, 0);
    assert.equal(completeDraftOrderCalls.length, 0);

    // ships-with tag on the original, NOT pre-order-pending
    assert.equal(addTagsCalls.length, 1);
    assert.equal(addTagsCalls[0].id, 'gid://shopify/Order/12345');
    assert.deepEqual(addTagsCalls[0].tags, ['ships-with-31479']);

    // cross-referencing notes on both orders
    assert.equal(appendNoteCalls.length, 2);
    assert.equal(appendNoteCalls[0].id, 'gid://shopify/Order/12345');
    assert.match(appendNoteCalls[0].note, /will ship with order #31479/);
    assert.equal(appendNoteCalls[1].id, 'gid://shopify/Order/55555');
    assert.match(appendNoteCalls[1].note, /Includes .*from order #30267 — paid there, shipping here/);

    assert.match(result.content[0].text, /Shipment merged into existing order/);
  });

  it('phase 2 passes staff_note through to both notes', async () => {
    const preview = await handler({ order_number: '30267', items: [{ sku: 'SB-BLK-M' }], ship_with_order: '31479' });
    const fulfillData = previewFulfillData(preview.content[0].text);

    await handler({
      order_number: '30267',
      items: [{ sku: 'SB-BLK-M' }],
      ship_with_order: '31479',
      staff_note: 'Lost-package replacement, ticket #2377',
      confirmed: true,
      _fulfill_data: fulfillData,
    });

    assert.match(appendNoteCalls[0].note, /Lost-package replacement, ticket #2377/);
    assert.match(appendNoteCalls[1].note, /Lost-package replacement, ticket #2377/);
  });
});

// ---------------------------------------------------------------------------
// split_kind — a split is only a pre-order when the items are really on
// pre-order. Live on ticket #3331 an in-stock hold-pending-sizing split was
// executed as a pre-order split, so the customer's new order carried a
// `Pre-order` property with a target-availability date for goods sitting on the
// shelf, and the order was filed into the pre-order population.
// ---------------------------------------------------------------------------

describe('split_shipment — split_kind is required', () => {
  beforeEach(() => { mockOrder = makeOrder(); resetCalls(); });

  it('refuses to preview without split_kind rather than defaulting to pre-order', async () => {
    const result = await handler({ order_number: '30267', items: [{ sku: 'HLA-BLK-M' }] });
    const text = result.content[0].text;
    assert.match(text, /split_kind is required/);
    assert.match(text, /"pre_order"/);
    assert.match(text, /"hold"/);
    // Nothing was read or written — the refusal comes before any Shopify call.
    assert.equal(createFulfillmentCalls.length, 0);
    assert.equal(createDraftOrderCalls.length, 0);
  });

  it('rejects an unknown split_kind', async () => {
    const result = await handler({ order_number: '30267', split_kind: 'preorder', items: [{ sku: 'HLA-BLK-M' }] });
    assert.match(result.content[0].text, /split_kind is required/);
  });

  it('requires hold_reason on a hold split', async () => {
    const result = await handler({ order_number: '30267', split_kind: 'hold', items: [{ sku: 'HLA-BLK-M' }] });
    assert.match(result.content[0].text, /hold_reason is required/);
    assert.equal(createDraftOrderCalls.length, 0);
  });

  it('does not require split_kind in merge mode — nothing is created to label', async () => {
    mockOrdersByNumber = { 30267: makeOrder(), 31479: makeDestOrder() };
    const result = await handler({ order_number: '30267', items: [{ sku: 'SB-BLK-M' }], ship_with_order: '31479' });
    assert.match(result.content[0].text, /Shipment Merge Preview/);
  });
});

describe('split_shipment — hold split (not a pre-order)', () => {
  beforeEach(() => { mockOrder = makeOrder(); resetCalls(); });

  const holdArgs = {
    order_number: '30267',
    split_kind: 'hold',
    hold_reason: 'waiting on customer to confirm the L fits',
    items: [{ sku: 'HLA-BLK-M' }],
  };

  it('preview states no Pre-order properties and names the hold', async () => {
    const text = (await handler(holdArgs)).content[0].text;
    assert.match(text, /Order Split Preview \(held, not a pre-order\)/);
    assert.match(text, /NO "Pre-order" line-item properties/);
    assert.match(text, /Warehouse hold: will be placed/);
    assert.match(text, /waiting on customer to confirm the L fits/);
    assert.match(text, /split-from-30267/);
    assert.doesNotMatch(text, /pre-order-from-30267/);
  });

  it('creates the new order with no Pre-order line properties and split-* tags', async () => {
    const fulfillData = previewFulfillData((await handler(holdArgs)).content[0].text);
    const result = await handler({ ...holdArgs, confirmed: true, _fulfill_data: fulfillData });

    assert.deepEqual(createDraftOrderCalls[0].lineItems, [{
      variantId: 'gid://shopify/ProductVariant/v-sassy',
      quantity: 1,
    }]);
    assert.equal('customAttributes' in createDraftOrderCalls[0].lineItems[0], false);
    assert.deepEqual(createDraftOrderCalls[0].tags, ['cs-mcp', 'split-from-30267']);
    assert.deepEqual(addTagsCalls[0].tags, ['split-pending']);
    assert.match(createDraftOrderCalls[0].note, /NOT a pre-order|not a pre-order/i);
    assert.match(appendNoteCalls[0].note, /NOT a pre-order/);
    assert.doesNotMatch(result.content[0].text, /Pre-order property/);
  });

  it('places the warehouse hold on the new order as part of the split', async () => {
    const fulfillData = previewFulfillData((await handler(holdArgs)).content[0].text);
    const result = await handler({ ...holdArgs, confirmed: true, _fulfill_data: fulfillData });

    assert.equal(holdCalls.length, 1);
    assert.equal(holdCalls[0].order_number, '30268'); // the NEW order, not the original
    assert.match(holdCalls[0].reason, /waiting on customer to confirm the L fits/);
    assert.match(result.content[0].text, /Warehouse hold: PLACED/);
  });

  it('flags loudly when the hold could not be placed — the new order would ship', async () => {
    holdResult = { isError: true, content: [{ type: 'text', text: 'Order #30268 not found in Warehance.' }] };
    const fulfillData = previewFulfillData((await handler(holdArgs)).content[0].text);
    const result = await handler({ ...holdArgs, confirmed: true, _fulfill_data: fulfillData });

    const text = result.content[0].text;
    assert.match(text, /NOT PLACED/);
    assert.match(text, /warehouse_hold/);
    // The split itself still committed — the operator must be told both halves.
    assert.equal(createFulfillmentCalls.length, 1);
    assert.match(text, /#30268/);
  });

  it('executes the previewed kind even when the confirm call re-types it wrong', async () => {
    const fulfillData = previewFulfillData((await handler(holdArgs)).content[0].text);
    await handler({
      ...holdArgs,
      split_kind: 'pre_order', // model drift on the confirm call
      confirmed: true,
      _fulfill_data: fulfillData,
    });
    assert.deepEqual(createDraftOrderCalls[0].tags, ['cs-mcp', 'split-from-30267']);
    assert.equal('customAttributes' in createDraftOrderCalls[0].lineItems[0], false);
  });

  it('pre_order splits are unaffected — still stamped and never held', async () => {
    const preview = await handler({ order_number: '30267', split_kind: 'pre_order', items: [{ sku: 'HLA-BLK-M' }] });
    await handler({
      order_number: '30267', split_kind: 'pre_order', items: [{ sku: 'HLA-BLK-M' }],
      confirmed: true, _fulfill_data: previewFulfillData(preview.content[0].text),
    });
    assert.deepEqual(createDraftOrderCalls[0].lineItems[0].customAttributes, [
      { key: 'Pre-order', value: 'Will ship when in stock' },
    ]);
    assert.equal(holdCalls.length, 0);
  });
});

describe('holdNewOrder — waits for Warehance to ingest the new order', () => {
  beforeEach(() => { resetCalls(); });

  it('retries the lookup until the order appears, then holds it', async () => {
    warehanceFindsOrderAfter = 2; // first two lookups miss
    const waits = [];
    const result = await holdNewOrder('#30268', 'because', { wait: async ms => { waits.push(ms); } });

    assert.equal(result.placed, true);
    assert.equal(warehanceLookups.length, 3);
    assert.deepEqual(warehanceLookups, ['30268', '30268', '30268']); // '#' stripped
    assert.equal(waits.length, 2);
    assert.equal(holdCalls.length, 1);
  });

  it('gives up with a reason rather than throwing when the order never appears', async () => {
    warehanceFindsOrderAfter = 99;
    const result = await holdNewOrder('30268', 'because', { wait: async () => {}, attempts: 3, delayMs: 1000 });

    assert.equal(result.placed, false);
    assert.match(result.detail, /had not reached Warehance/);
    assert.equal(holdCalls.length, 0);
  });

  it('reports a failed hold instead of swallowing it', async () => {
    holdResult = { isError: true, content: [{ type: 'text', text: 'already **shipped**' }] };
    const result = await holdNewOrder('30268', 'because', { wait: async () => {} });
    assert.equal(result.placed, false);
    assert.match(result.detail, /shipped/);
  });
});
