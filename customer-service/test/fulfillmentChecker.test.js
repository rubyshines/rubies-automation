/**
 * Unit tests for lib/tracking/fulfillmentChecker.js — pre-order detection
 * from line item customAttributes (in addition to product tags).
 *
 * Run: node --test customer-service/test/fulfillmentChecker.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const shopifyPath = require.resolve('../lib/shopify');

// Stub shopifyGraphQL to return canned variant inventory + product tags.
// Keyed by variant gid; each entry mimics the productVariant payload shape.
const VARIANT_FIXTURE = {
  'gid://shopify/ProductVariant/100': {
    title: 'Black / M',
    inventoryQuantity: 0,
    product: { title: 'THE SASSY NO-TUCK SHAPING UNDERWEAR', tags: [] },
    inventoryItem: {
      inventoryLevels: { edges: [
        { node: { quantities: [{ name: 'available', quantity: 0 }], location: { name: 'Nitro' } } },
      ] },
    },
  },
  'gid://shopify/ProductVariant/200': {
    title: 'Black / M',
    inventoryQuantity: 41,
    product: { title: 'THE NAOMI GAFF EXTRA STRENGTH SHAPING UNDERWEAR', tags: [] },
    inventoryItem: {
      inventoryLevels: { edges: [
        { node: { quantities: [{ name: 'available', quantity: 41 }], location: { name: 'Nitro' } } },
      ] },
    },
  },
  'gid://shopify/ProductVariant/300': {
    title: 'Black / M',
    inventoryQuantity: 50,
    product: { title: 'THE TAGGED PRE-ORDER PRODUCT', tags: ['pre-order'] },
    inventoryItem: {
      inventoryLevels: { edges: [
        { node: { quantities: [{ name: 'available', quantity: 50 }], location: { name: 'Nitro' } } },
      ] },
    },
  },
};

function stubShopifyGraphQL(query) {
  const match = query.match(/productVariant\(id: "([^"]+)"\)/);
  if (!match) return Promise.resolve({});
  return Promise.resolve({ productVariant: VARIANT_FIXTURE[match[1]] || null });
}

require.cache[shopifyPath] = {
  id: shopifyPath,
  filename: shopifyPath,
  loaded: true,
  exports: { shopifyGraphQL: stubShopifyGraphQL },
};

// Stub the Warehance client so the hold/allocation checks in
// analyzeUnfulfilledOrder never hit the network.
//
// The fixture has to carry the open ORDER BOOK, not just SKU totals. "Is this
// item reserved for this order" is a per-order fact, and the SKU counters
// cannot express it — `on_hand: 1, allocated: 1, available: 0` is identical
// whether the unit is reserved for the order being asked about or for someone
// who ordered first. A fixture that states only the totals is a fixture that
// cannot state what the test is about.
const warehancePath = require.resolve('../../reports/lib/warehanceClient');
const WH_SKU_STOCK = {
  // One unit at the warehouse, and #40001 is first in line for it.
  'ALLOC-BLK-M': { sku: 'ALLOC-BLK-M', on_hand: 1, allocated: 1, available: 0, backordered: 2 },
  // Genuinely absent from the warehouse — awaiting inbound stock.
  'GONE-BLK-M': { sku: 'GONE-BLK-M', on_hand: 0, allocated: 0, available: 0, backordered: 12 },
  'GAF-BLK-M': { sku: 'GAF-BLK-M', on_hand: 40, allocated: 3, available: 37, backordered: 0 },
  // On hand, but every unit is spoken for by an order placed earlier. Reads
  // identically to ALLOC-BLK-M at SKU level; the opposite answer per order.
  'QUEUED-BLK-M': { sku: 'QUEUED-BLK-M', on_hand: 1, allocated: 1, available: 0, backordered: 1 },
};
const whOrder = (num, date, skus, extra = {}) => ({
  id: `wh-${num}`,
  order_number: `#${num}`,
  order_date: `${date}T00:00:00Z`,
  has_hold: false,
  order_items: skus.map(sku => ({ sku, quantity: 1, quantity_shipped: 0 })),
  ...extra,
});
const WH_ORDER_BOOK = new Map([
  ['31353', whOrder('31353', '2026-06-01', ['GAF-BLK-M'], { has_hold: true, warehouse_hold: true, address_hold: false })],
  ['40001', whOrder('40001', '2026-06-02', ['ALLOC-BLK-M', 'GONE-BLK-M', 'GAF-BLK-M'])],
  // Placed BEFORE 40002 and takes the only QUEUED-BLK-M unit.
  ['39000', whOrder('39000', '2026-05-01', ['QUEUED-BLK-M'])],
  ['40002', whOrder('40002', '2026-06-03', ['QUEUED-BLK-M', 'GAF-BLK-M'])],
]);
require.cache[warehancePath] = {
  id: warehancePath,
  filename: warehancePath,
  loaded: true,
  exports: {
    fetchUnfulfilledOrders: async () => WH_ORDER_BOOK,
    fetchSkuStockMany: async (skus) => {
      const map = new Map();
      for (const sku of skus || []) map.set(sku, WH_SKU_STOCK[sku] || null);
      return map;
    },
  },
};

const { analyzeUnfulfilledOrder } = require('../lib/tracking/fulfillmentChecker');

function buildOrder(lineItems) {
  return {
    name: '#TEST',
    createdAt: new Date(Date.now() - 30 * 86400000).toISOString(),
    fulfillments: [],
    lineItems,
  };
}

describe('analyzeUnfulfilledOrder — pre-order detection', () => {
  it('flags a line item with a "Pre-order" customAttribute as pre-order even when product has no pre-order tag', async () => {
    const order = buildOrder([
      {
        title: 'THE SASSY NO-TUCK SHAPING UNDERWEAR',
        sku: 'HLA-BLK-M',
        quantity: 2,
        variantId: 'gid://shopify/ProductVariant/100',
        customAttributes: [{ key: 'Pre-order', value: 'Target availability end of June, 2026.' }],
      },
    ]);
    const result = await analyzeUnfulfilledOrder(order);
    assert.equal(result.hasPreOrderItems, true);
    assert.equal(result.hasOutOfStockItems, false, 'pre-order takes precedence over OOS classification');
    const issue = result.issues.find(i => i.type === 'pre_order');
    assert.ok(issue, 'expected a pre_order issue');
    assert.equal(issue.preOrderTarget, 'Target availability end of June, 2026.');
    assert.match(issue.description, /end of June, 2026/);
  });

  it('still detects pre-order via product tag when no line item attribute is present', async () => {
    const order = buildOrder([
      {
        title: 'THE TAGGED PRE-ORDER PRODUCT',
        sku: 'TAG-BLK-M',
        quantity: 1,
        variantId: 'gid://shopify/ProductVariant/300',
        customAttributes: [],
      },
    ]);
    const result = await analyzeUnfulfilledOrder(order);
    assert.equal(result.hasPreOrderItems, true);
    const issue = result.issues.find(i => i.type === 'pre_order');
    assert.ok(issue);
    assert.equal(issue.preOrderTarget, null, 'tag-based pre-order has no target date');
  });

  it('flags both pre-order line items separately when an order has multiple', async () => {
    const order = buildOrder([
      {
        title: 'THE SASSY NO-TUCK SHAPING UNDERWEAR',
        sku: 'HLA-BLK-M',
        quantity: 2,
        variantId: 'gid://shopify/ProductVariant/100',
        customAttributes: [{ key: 'Pre-order', value: 'Target availability end of June, 2026.' }],
      },
      {
        title: 'THE NAOMI GAFF EXTRA STRENGTH SHAPING UNDERWEAR',
        sku: 'GAF-BLK-M',
        quantity: 1,
        variantId: 'gid://shopify/ProductVariant/200',
        customAttributes: [{ key: 'Pre-order', value: 'Target availability beginning of April, 2026.' }],
      },
    ]);
    const result = await analyzeUnfulfilledOrder(order);
    const preOrders = result.issues.filter(i => i.type === 'pre_order');
    assert.equal(preOrders.length, 2);
    const targets = preOrders.map(i => i.preOrderTarget).sort();
    assert.deepEqual(targets, [
      'Target availability beginning of April, 2026.',
      'Target availability end of June, 2026.',
    ]);
  });

  it('does not flag a regular line item with no pre-order signal', async () => {
    const order = buildOrder([
      {
        title: 'THE NAOMI GAFF EXTRA STRENGTH SHAPING UNDERWEAR',
        sku: 'GAF-BLK-M',
        quantity: 1,
        variantId: 'gid://shopify/ProductVariant/200',
        customAttributes: [{ key: 'gift_message', value: 'happy birthday' }],
      },
    ]);
    const result = await analyzeUnfulfilledOrder(order);
    assert.equal(result.hasPreOrderItems, false);
    assert.equal(result.issues.filter(i => i.type === 'pre_order').length, 0);
  });
});

describe('analyzeUnfulfilledOrder — warehouse hold detection', () => {
  function heldOrder() {
    return {
      name: '#31353', // matches WH_FIXTURE — warehouse_hold: true
      createdAt: new Date(Date.now() - 9 * 86400000).toISOString(),
      fulfillments: [],
      lineItems: [{
        title: 'THE NAOMI GAFF EXTRA STRENGTH SHAPING UNDERWEAR',
        sku: 'GAF-BLK-M', quantity: 1,
        variantId: 'gid://shopify/ProductVariant/200', // in stock
        customAttributes: [],
      }],
    };
  }

  it('reports an active warehouse hold as the cause and suppresses the stuck flag', async () => {
    const result = await analyzeUnfulfilledOrder(heldOrder());
    assert.equal(result.onHold, true);
    assert.deepEqual(result.holds, ['warehouse']);
    const holdIssue = result.issues.find(i => i.type === 'hold');
    assert.ok(holdIssue, 'expected a hold issue');
    assert.match(holdIssue.description, /hold/i);
    assert.equal(result.severity, 'attention');
    assert.equal(result.issues.some(i => i.type === 'stuck'), false, 'a held order is not "stuck"');
    assert.equal(result.issues.some(i => i.type === 'slow'), false);
  });

  it('the deterministic response reassures and explains the hold', async () => {
    const { buildUnfulfilledResponse } = require('../lib/tracking/fulfillmentChecker');
    const result = await analyzeUnfulfilledOrder(heldOrder());
    const { text, needsHumanFollowUp } = buildUnfulfilledResponse(result, { customerName: 'Alex' });
    assert.match(text, /didn't do anything wrong/i);
    assert.match(text, /hold/i);
    assert.equal(needsHumanFollowUp, true);
  });

  it('an in-stock order with no hold (and old) still flags stuck', async () => {
    const order = {
      name: '#NOHOLD', // not in WH_FIXTURE → not held
      createdAt: new Date(Date.now() - 9 * 86400000).toISOString(),
      fulfillments: [],
      lineItems: [{
        title: 'THE NAOMI GAFF EXTRA STRENGTH SHAPING UNDERWEAR',
        sku: 'GAF-BLK-M', quantity: 1,
        variantId: 'gid://shopify/ProductVariant/200',
        customAttributes: [],
      }],
    };
    const result = await analyzeUnfulfilledOrder(order);
    assert.equal(result.onHold, false);
    assert.equal(result.issues.some(i => i.type === 'stuck'), true, 'no hold → stuck heuristic still applies');
  });
});

describe('analyzeUnfulfilledOrder — warehouse allocation is the truth for what can ship', () => {
  function buildWhOrder(lineItems, name = '#40001') {
    return {
      name, // in the open order book, no hold → allocation path active
      createdAt: new Date(Date.now() - 5 * 86400000).toISOString(),
      fulfillments: [],
      lineItems,
    };
  }

  // The case the SKU counters cannot distinguish and the reply gets wrong.
  // QUEUED-BLK-M looks exactly like ALLOC-BLK-M at SKU level (one unit on hand,
  // allocated, zero available) but #39000 ordered first and holds it. Judging by
  // on_hand alone told this customer outright that the item "CAN ship with this
  // order and is NOT a blocker" — an affirmative false claim in text they read.
  it('an item on hand but reserved for an EARLIER order is out of stock, not shippable', async () => {
    const order = buildWhOrder([{
      title: 'THE SASSY NO-TUCK SHAPING UNDERWEAR',
      sku: 'QUEUED-BLK-M', quantity: 1,
      variantId: 'gid://shopify/ProductVariant/100', // Shopify available: 0
      customAttributes: [],
    }], '#40002');
    const result = await analyzeUnfulfilledOrder(order);
    assert.equal(result.hasOutOfStockItems, true, 'a unit someone else holds cannot ship with this order');
    assert.equal(result.issues.some(i => i.type === 'allocated'), false, 'must never claim it CAN ship');
    const oos = result.issues.find(i => i.type === 'out_of_stock');
    assert.ok(oos);
    assert.match(oos.description, /reserved for earlier orders/);
  });

  it('an item reserved for this order (site shows 0, warehouse holds it) is NOT out of stock', async () => {
    const order = buildWhOrder([{
      title: 'THE SASSY NO-TUCK SHAPING UNDERWEAR',
      sku: 'ALLOC-BLK-M', quantity: 1,
      variantId: 'gid://shopify/ProductVariant/100', // Shopify available: 0
      customAttributes: [],
    }]);
    const result = await analyzeUnfulfilledOrder(order);
    assert.equal(result.hasOutOfStockItems, false, 'allocated item must not be classified OOS');
    assert.equal(result.issues.some(i => i.type === 'out_of_stock'), false);
    const alloc = result.issues.find(i => i.type === 'allocated');
    assert.ok(alloc, 'expected an allocated issue');
    assert.match(alloc.description, /CAN ship/);
    assert.equal(result.inventory[0].warehouse.on_hand, 1);
  });

  it('an item the warehouse physically lacks is out of stock (awaiting stock)', async () => {
    const order = buildWhOrder([{
      title: 'THE SASSY NO-TUCK SHAPING UNDERWEAR',
      sku: 'GONE-BLK-M', quantity: 1,
      variantId: 'gid://shopify/ProductVariant/100',
      customAttributes: [],
    }]);
    const result = await analyzeUnfulfilledOrder(order);
    assert.equal(result.hasOutOfStockItems, true);
    const oos = result.issues.find(i => i.type === 'out_of_stock');
    assert.ok(oos);
    assert.match(oos.description, /awaiting stock/);
    assert.match(oos.description, /on hand: 0/);
    assert.equal(result.issues.some(i => i.type === 'allocated'), false);
  });

  it('warehouse shortage wins even when Shopify shows stock', async () => {
    const order = buildWhOrder([{
      title: 'THE NAOMI GAFF EXTRA STRENGTH SHAPING UNDERWEAR',
      sku: 'GONE-BLK-M', quantity: 1,
      variantId: 'gid://shopify/ProductVariant/200', // Shopify available: 41
      customAttributes: [],
    }]);
    const result = await analyzeUnfulfilledOrder(order);
    assert.equal(result.hasOutOfStockItems, true, 'warehouse (not Shopify) decides shippability');
  });

  it('falls back to Shopify availability when the order is not in Warehance', async () => {
    const order = { // '#TEST' is not in WH_FIXTURE
      name: '#TEST',
      createdAt: new Date(Date.now() - 5 * 86400000).toISOString(),
      fulfillments: [],
      lineItems: [{
        title: 'THE SASSY NO-TUCK SHAPING UNDERWEAR',
        sku: 'ALLOC-BLK-M', quantity: 1,
        variantId: 'gid://shopify/ProductVariant/100', // Shopify available: 0
        customAttributes: [],
      }],
    };
    const result = await analyzeUnfulfilledOrder(order);
    assert.equal(result.hasOutOfStockItems, true, 'no warehouse data → Shopify fallback');
    const oos = result.issues.find(i => i.type === 'out_of_stock');
    assert.match(oos.description, /out of sync/);
  });
});
