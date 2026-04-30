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
