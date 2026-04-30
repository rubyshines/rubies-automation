/**
 * Unit tests for lib/tools/wholesaleOrder.js — focuses on shipping_speed
 * behaviour (default standard for US wholesale, default expedited for non-US,
 * Shopify shipping line title set to the zone-appropriate rate at $0).
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

// In-memory shipping title resolver — mirrors the real (zone, speed) → title map
// so the wholesale tool's preview / draft-input can be verified without Supabase.
const TITLES = {
  us:     { standard: 'Free US Standard Shipping',                                       expedited: 'US Expedited Shipping' },
  canada: { standard: 'Free Canada Standard Shipping',                                   expedited: 'Canada Expedited Shipping' },
  ddp:    { standard: 'Free International Shipping - All Duties and Import Fees Included', expedited: 'Expedited International Shipping - All Duties and Import Fees Included' },
  ddu:    { standard: 'Free Standard International Shipping',                             expedited: 'Expedited International Shipping' },
};
const FAKE_DDP = new Set(['AU', 'GB', 'DE', 'FR', 'NZ']);
async function fakeGetShippingMethodTitle(country, speed) {
  const s = speed === 'expedited' ? 'expedited' : 'standard';
  const c = (country || '').toUpperCase().trim();
  if (c === 'US') return TITLES.us[s];
  if (c === 'CA') return TITLES.canada[s];
  if (FAKE_DDP.has(c)) return TITLES.ddp[s];
  return TITLES.ddu[s];
}

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
    getShippingMethodTitle: fakeGetShippingMethodTitle,
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

describe('create_wholesale_order — shipping_speed defaults & title selection', () => {
  beforeEach(() => { lastCreateDraftOrderArgs = null; });

  it('US wholesale defaults to standard (Free US Standard Shipping at $0)', async () => {
    await runHandler({
      customer_id: 'gid://shopify/Customer/1',
      country_code: 'US',
      items: [{ sku: 'rub0001-S', quantity: 1 }],
    });
    assert.equal(lastCreateDraftOrderArgs.shippingLine.title, 'Free US Standard Shipping');
    assert.equal(lastCreateDraftOrderArgs.shippingLine.price, '0.00');
    assert.deepEqual(lastCreateDraftOrderArgs.tags, ['wholesale', 'cs-mcp']);
  });

  it('Canadian wholesale defaults to expedited (Canada Expedited Shipping)', async () => {
    const result = await runHandler({
      customer_id: 'gid://shopify/Customer/1',
      country_code: 'CA',
      items: [{ sku: 'rub0001-S', quantity: 1 }],
    });
    assert.equal(lastCreateDraftOrderArgs.shippingLine.title, 'Canada Expedited Shipping');
    assert.equal(lastCreateDraftOrderArgs.shippingLine.price, '0.00');
    assert.match(result.content[0].text, /Canada Expedited Shipping/);
    // No FedEx tag — routing is now driven entirely by Shopify shipping method.
    assert.ok(!lastCreateDraftOrderArgs.tags.some(t => t.startsWith('ship fedex')));
  });

  it('DDP-zone wholesale (GB) defaults to expedited International title', async () => {
    await runHandler({
      customer_id: 'gid://shopify/Customer/1',
      country_code: 'GB',
      items: [{ sku: 'rub0001-S', quantity: 1 }],
    });
    assert.equal(lastCreateDraftOrderArgs.shippingLine.title,
      'Expedited International Shipping - All Duties and Import Fees Included');
  });

  it('DDU-zone wholesale (AR) defaults to expedited International title', async () => {
    await runHandler({
      customer_id: 'gid://shopify/Customer/1',
      country_code: 'AR',
      items: [{ sku: 'rub0001-S', quantity: 1 }],
    });
    assert.equal(lastCreateDraftOrderArgs.shippingLine.title, 'Expedited International Shipping');
  });

  it('operator can override non-US wholesale to standard', async () => {
    await runHandler({
      customer_id: 'gid://shopify/Customer/1',
      country_code: 'CA',
      items: [{ sku: 'rub0001-S', quantity: 1 }],
      shipping_speed: 'standard',
    });
    assert.equal(lastCreateDraftOrderArgs.shippingLine.title, 'Free Canada Standard Shipping');
  });

  it('operator can override US wholesale to expedited', async () => {
    await runHandler({
      customer_id: 'gid://shopify/Customer/1',
      country_code: 'US',
      items: [{ sku: 'rub0001-S', quantity: 1 }],
      shipping_speed: 'expedited',
    });
    assert.equal(lastCreateDraftOrderArgs.shippingLine.title, 'US Expedited Shipping');
  });
});
