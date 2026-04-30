/**
 * Unit tests for lib/tools/wholesaleOrder.js — focuses on FedEx auto-tagging
 * behaviour (non-US wholesale always gets the "ship fedex" tag).
 *
 * Run: node --test customer-service/test/wholesaleOrder.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// Stub dependencies
// ---------------------------------------------------------------------------

const shopifyPath = require.resolve('../lib/shopify');
const productCachePath = require.resolve('../lib/productCache');
const resolveLineItemsPath = require.resolve('../lib/resolveLineItems');
const orderUtilsPath = require.resolve('../lib/orderUtils');
const addressUtilsPath = require.resolve('../lib/addressUtils');

let lastCreateDraftOrderArgs = null;
const baseDraftResponse = () => ({
  id: 'gid://shopify/DraftOrder/999',
  name: 'D999',
  totalPrice: '100.00',
  totalPriceSet: { presentmentMoney: { amount: '100.00', currencyCode: 'USD' } },
  presentmentCurrencyCode: 'USD',
  lineItems: {
    edges: [{
      node: {
        title: 'TEST PRODUCT',
        quantity: 1,
        originalUnitPrice: '100.00',
        discountedUnitPriceSet: { presentmentMoney: { amount: '50.00', currencyCode: 'USD' } },
        variant: { id: 'gid://shopify/ProductVariant/100', title: 'Black / M' },
      },
    }],
  },
});

require.cache[shopifyPath] = {
  id: shopifyPath, filename: shopifyPath, loaded: true,
  exports: {
    createDraftOrder: (args) => {
      lastCreateDraftOrderArgs = args;
      return Promise.resolve(baseDraftResponse());
    },
    deleteDraftOrder: () => Promise.resolve(),
    completeDraftOrder: () => Promise.resolve({ name: 'D999', order: { id: 'gid://shopify/Order/1', name: '#1001' } }),
    sendDraftOrderInvoice: () => Promise.resolve({ name: 'D999', invoiceUrl: 'https://example.com/inv' }),
    normalizeGid: (id, type) => (typeof id === 'string' && id.startsWith('gid://')) ? id : `gid://shopify/${type}/${id}`,
    getAdminUrl: (gid) => `https://admin.shopify.com/store/rubyshines/${gid}`,
  },
};

require.cache[productCachePath] = {
  id: productCachePath, filename: productCachePath, loaded: true,
  exports: { searchProducts: () => [], getVariantById: () => null, getVariantBySku: () => null, getSiblingVariant: () => null },
};

require.cache[resolveLineItemsPath] = {
  id: resolveLineItemsPath, filename: resolveLineItemsPath, loaded: true,
  exports: {
    resolveLineItems: async (items) => items.map((it, i) => ({
      variantId: it.variant_id || `gid://shopify/ProductVariant/${100 + i}`,
      productTitle: 'TEST PRODUCT',
      variantTitle: 'Black / M',
      sku: it.sku || `test-sku-${i}`,
      price: '100.00',
      inventoryQuantity: 10,
      quantity: it.quantity || 1,
    })),
  },
};

const realOrderUtils = require('../lib/orderUtils');
require.cache[orderUtilsPath] = {
  id: orderUtilsPath, filename: orderUtilsPath, loaded: true,
  exports: {
    resolveCustomerForDraft: async () => ({
      customerName: 'Test Wholesale',
      addressBlock: '1 Wholesale Way',
      shippingAddress: { firstName: 'Test', lastName: 'Wholesale', address1: '1 Wholesale Way', city: 'X', province: 'X', country: 'CA', zip: '00000' },
    }),
    buildShippingAddress: realOrderUtils.buildShippingAddress,
    isUSCountry: realOrderUtils.isUSCountry,
    shouldAddFedExTag: realOrderUtils.shouldAddFedExTag,
  },
};

require.cache[addressUtilsPath] = {
  id: addressUtilsPath, filename: addressUtilsPath, loaded: true,
  exports: { formatAddressBlock: () => '1 Wholesale Way', formatAddressLine: () => '1 Wholesale Way' },
};

const wholesaleTools = require('../lib/tools/wholesaleOrder');
const createWholesaleOrder = wholesaleTools.find(t => t.name === 'create_wholesale_order');

async function runHandler(args) {
  lastCreateDraftOrderArgs = null;
  return createWholesaleOrder.handler(args);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('create_wholesale_order — FedEx auto-tagging', () => {
  beforeEach(() => { lastCreateDraftOrderArgs = null; });

  it('US wholesale draft: tags only wholesale + cs-mcp (no ship fedex)', async () => {
    await runHandler({
      customer_id: 'gid://shopify/Customer/1',
      country_code: 'US',
      items: [{ sku: 'rub0001-S', quantity: 1 }],
    });
    assert.deepEqual(lastCreateDraftOrderArgs.tags, ['wholesale', 'cs-mcp']);
  });

  it('Canadian wholesale draft: auto-adds ship fedex tag', async () => {
    const result = await runHandler({
      customer_id: 'gid://shopify/Customer/1',
      country_code: 'CA',
      items: [{ sku: 'rub0001-S', quantity: 1 }],
    });
    assert.deepEqual(lastCreateDraftOrderArgs.tags, ['wholesale', 'cs-mcp', 'ship fedex']);
    assert.match(result.content[0].text, /FedEx — non-US wholesale/);
  });

  it('GB wholesale draft: auto-adds ship fedex tag (lowercase country also handled)', async () => {
    await runHandler({
      customer_id: 'gid://shopify/Customer/1',
      country_code: 'gb',
      items: [{ sku: 'rub0001-S', quantity: 1 }],
    });
    assert.ok(lastCreateDraftOrderArgs.tags.includes('ship fedex'));
  });
});
