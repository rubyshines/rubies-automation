/**
 * Unit tests for lib/tools/invoiceOrder.js — draft-order creation behavior.
 *
 * Run: node --test customer-service/test/invoiceOrder.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// Stub shopify + productCache + resolveLineItems dependencies
// ---------------------------------------------------------------------------

const shopifyPath = require.resolve('../lib/shopify');
const productCachePath = require.resolve('../lib/productCache');
const resolveLineItemsPath = require.resolve('../lib/resolveLineItems');

let lastCreateDraftOrderArgs = null;
let createDraftOrderResponse = {
  id: 'gid://shopify/DraftOrder/999',
  name: 'D999',
  totalPrice: '0.00',
  invoiceUrl: 'https://rubyshines.com/draft/999',
};

function stubCreateDraftOrder(args) {
  lastCreateDraftOrderArgs = args;
  return Promise.resolve(createDraftOrderResponse);
}

function stubSendDraftOrderInvoice() {
  return Promise.resolve(createDraftOrderResponse);
}

require.cache[shopifyPath] = {
  id: shopifyPath,
  filename: shopifyPath,
  loaded: true,
  exports: {
    createDraftOrder: stubCreateDraftOrder,
    sendDraftOrderInvoice: stubSendDraftOrderInvoice,
    normalizeGid: (id, type) => {
      if (typeof id === 'string' && id.startsWith('gid://')) return id;
      return `gid://shopify/${type}/${id}`;
    },
    getAdminUrl: (gid) => `https://admin.shopify.com/store/rubyshines/${gid}`,
  },
};

// Stub orderUtils (resolveCustomerForDraft) — country is mutable so tests can switch destinations.
let stubCustomerCountry = 'US';
function setStubCustomerCountry(c) { stubCustomerCountry = c; }

// Pure in-memory shipping title stub — mirrors the real (zone, speed) → title
// map without touching Supabase.
const FAKE_DDP = new Set(['AU', 'GB', 'DE', 'FR', 'NZ']);
const TITLES = {
  us:     { standard: 'Free US Standard Shipping',                                       expedited: 'US Expedited Shipping' },
  canada: { standard: 'Free Canada Standard Shipping',                                   expedited: 'Canada Expedited Shipping' },
  ddp:    { standard: 'Free International Shipping - All Duties and Import Fees Included', expedited: 'Expedited International Shipping - All Duties and Import Fees Included' },
  ddu:    { standard: 'Free Standard International Shipping',                             expedited: 'Expedited International Shipping' },
};
async function fakeGetShippingMethodTitle(country, speed) {
  const s = speed === 'expedited' ? 'expedited' : 'standard';
  const c = (country || '').toUpperCase().trim();
  if (c === 'US') return TITLES.us[s];
  if (c === 'CA') return TITLES.canada[s];
  if (FAKE_DDP.has(c)) return TITLES.ddp[s];
  return TITLES.ddu[s];
}

const orderUtilsPath = require.resolve('../lib/orderUtils');
const realOrderUtils = require('../lib/orderUtils');
require.cache[orderUtilsPath] = {
  id: orderUtilsPath,
  filename: orderUtilsPath,
  loaded: true,
  exports: {
    resolveCustomerForDraft: async () => (stubCustomerCountry === null
      // Simulates a customer with no default address on file (e.g. never
      // completed a checkout) — the order #32333 scenario.
      ? { customerName: 'Test Customer', addressBlock: 'No address on file', shippingAddress: null }
      : {
        customerName: 'Test Customer',
        addressBlock: '123 Main St\nPortland, OR 97227',
        shippingAddress: { firstName: 'Test', lastName: 'Customer', address1: '123 Main St', city: 'Portland', province: 'OR', country: stubCustomerCountry, zip: '97227' },
      }),
    buildShippingAddress: (a, fn, ln) => ({
      firstName: fn || '', lastName: ln || '',
      address1: a.address1, address2: a.address2 || '',
      city: a.city, province: a.province, country: a.countryCodeV2 || a.country, zip: a.zip,
    }),
    applyShippingAddressOverride: realOrderUtils.applyShippingAddressOverride,
    SHIPPING_ADDRESS_OVERRIDE_SCHEMA: realOrderUtils.SHIPPING_ADDRESS_OVERRIDE_SCHEMA,
    getShippingMethodTitle: fakeGetShippingMethodTitle,
    normalizeCountryCode: realOrderUtils.normalizeCountryCode,
    unknownDestinationWarning: realOrderUtils.unknownDestinationWarning,
    normalizeShippingPrice: realOrderUtils.normalizeShippingPrice,
    shippingPreviewLine: realOrderUtils.shippingPreviewLine,
    shippingChargeError: realOrderUtils.shippingChargeError,
  },
};

// productCache stubs (referenced transitively by resolveLineItems in case it's not already cached)
require.cache[productCachePath] = {
  id: productCachePath,
  filename: productCachePath,
  loaded: true,
  exports: {
    searchProducts: () => [],
    getVariantById: () => null,
    getVariantBySku: () => null,
    getSiblingVariant: () => null,
  },
};

// Deterministic resolveLineItems stub — invoiceOrder doesn't care what's inside,
// only that it can pass the resolved items along to createDraftOrder.
require.cache[resolveLineItemsPath] = {
  id: resolveLineItemsPath,
  filename: resolveLineItemsPath,
  loaded: true,
  exports: {
    resolveLineItems: async (items) => items.map((it, i) => ({
      variantId: it.variant_id || `gid://shopify/ProductVariant/${100 + i}`,
      productTitle: 'TEST PRODUCT',
      variantTitle: 'Black / M',
      sku: it.sku || `test-sku-${i}`,
      price: '29.00',
      inventoryQuantity: 10,
      quantity: it.quantity || 1,
    })),
  },
};

const invoiceTools = require('../lib/tools/invoiceOrder');
const createInvoiceOrder = invoiceTools.find(t => t.name === 'create_invoice_order');

async function runHandler(args) {
  lastCreateDraftOrderArgs = null;
  return createInvoiceOrder.handler(args);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('create_invoice_order — validation', () => {
  it('rejects when no items are provided', async () => {
    const result = await runHandler({ customer_id: 'gid://shopify/Customer/1' });
    assert.match(result.content[0].text, /at least one exchange_item or paid_item/);
    assert.equal(lastCreateDraftOrderArgs, null);
  });
});

describe('create_invoice_order — phase 1 (creates draft + preview)', () => {
  beforeEach(() => {
    lastCreateDraftOrderArgs = null;
  });

  it('creates a draft order and returns a preview with admin link', async () => {
    const result = await runHandler({
      customer_id: 'gid://shopify/Customer/1',
      exchange_items: [{ sku: 'rub0001-S', quantity: 1 }],
    });
    assert.ok(lastCreateDraftOrderArgs, 'expected createDraftOrder to be called in phase 1');
    assert.match(result.content[0].text, /Invoice Draft Order Created/);
    assert.match(result.content[0].text, /admin\.shopify\.com/);
  });

  it('shows customer name and address in preview', async () => {
    const result = await runHandler({
      customer_id: 'gid://shopify/Customer/1',
      exchange_items: [{ sku: 'rub0001-S', quantity: 1 }],
    });
    assert.match(result.content[0].text, /Test Customer/);
    assert.match(result.content[0].text, /123 Main St/);
  });

  it('passes a $0 shipping line to createDraftOrder using the zone-appropriate title', async () => {
    setStubCustomerCountry('US');
    await runHandler({
      customer_id: 'gid://shopify/Customer/42',
      exchange_items: [{ sku: 'rub0001-S', quantity: 1 }],
    });
    assert.ok(lastCreateDraftOrderArgs, 'expected createDraftOrder to be called');
    assert.deepEqual(lastCreateDraftOrderArgs.shippingLine, {
      title: 'Free US Standard Shipping',
      price: '0.00',
    });
  });

  it('applies 100% exchange discount to exchange items', async () => {
    await runHandler({
      customer_id: 'gid://shopify/Customer/42',
      exchange_items: [{ sku: 'rub0001-S', quantity: 2 }],
    });
    const exchangeLine = lastCreateDraftOrderArgs.lineItems[0];
    assert.equal(exchangeLine.quantity, 2);
    assert.deepEqual(exchangeLine.appliedDiscount, {
      title: 'Exchange',
      value: 100,
      valueType: 'PERCENTAGE',
    });
  });

  it('does NOT apply a discount to paid items', async () => {
    await runHandler({
      customer_id: 'gid://shopify/Customer/42',
      paid_items: [{ sku: 'rub0002-M', quantity: 1 }],
    });
    const paidLine = lastCreateDraftOrderArgs.lineItems[0];
    assert.equal(paidLine.quantity, 1);
    assert.equal(paidLine.appliedDiscount, undefined);
  });

  it('orders exchange items before paid items in lineItems', async () => {
    await runHandler({
      customer_id: 'gid://shopify/Customer/42',
      exchange_items: [{ sku: 'rub0001-S', quantity: 1 }],
      paid_items: [{ sku: 'rub0002-M', quantity: 1 }],
    });
    const [first, second] = lastCreateDraftOrderArgs.lineItems;
    assert.ok(first.appliedDiscount, 'first line should be the discounted exchange item');
    assert.equal(second.appliedDiscount, undefined);
  });

  it('tags draft orders with invoice + cs-mcp', async () => {
    setStubCustomerCountry('US');
    await runHandler({
      customer_id: 'gid://shopify/Customer/42',
      exchange_items: [{ sku: 'rub0001-S', quantity: 1 }],
    });
    assert.deepEqual(lastCreateDraftOrderArgs.tags, ['invoice', 'cs-mcp']);
  });

  it('default shipping_speed=standard for Canada uses Free Canada Standard Shipping', async () => {
    setStubCustomerCountry('CA');
    await runHandler({
      customer_id: 'gid://shopify/Customer/42',
      exchange_items: [{ sku: 'rub0001-S', quantity: 1 }],
    });
    assert.equal(lastCreateDraftOrderArgs.shippingLine.title, 'Free Canada Standard Shipping');
    // No FedEx tags — routing is driven by Shopify shipping method title.
    assert.ok(!lastCreateDraftOrderArgs.tags.some(t => t.startsWith('ship fedex')));
  });

  it('shipping_speed=expedited for Canada uses Canada Expedited Shipping', async () => {
    setStubCustomerCountry('CA');
    const result = await runHandler({
      customer_id: 'gid://shopify/Customer/42',
      exchange_items: [{ sku: 'rub0001-S', quantity: 1 }],
      shipping_speed: 'expedited',
    });
    assert.equal(lastCreateDraftOrderArgs.shippingLine.title, 'Canada Expedited Shipping');
    assert.match(result.content[0].text, /Canada Expedited Shipping/);
  });

  it('shipping_speed=expedited for DDP zone (AU) uses Expedited International title', async () => {
    setStubCustomerCountry('AU');
    await runHandler({
      customer_id: 'gid://shopify/Customer/42',
      exchange_items: [{ sku: 'rub0001-S', quantity: 1 }],
      shipping_speed: 'expedited',
    });
    assert.equal(lastCreateDraftOrderArgs.shippingLine.title,
      'Expedited International Shipping - All Duties and Import Fees Included');
  });

  it('shipping_speed=expedited for DDU zone (AR) uses Expedited International Shipping', async () => {
    setStubCustomerCountry('AR');
    await runHandler({
      customer_id: 'gid://shopify/Customer/42',
      exchange_items: [{ sku: 'rub0001-S', quantity: 1 }],
      shipping_speed: 'expedited',
    });
    assert.equal(lastCreateDraftOrderArgs.shippingLine.title, 'Expedited International Shipping');
  });

  it('shipping_speed=expedited for US uses US Expedited Shipping', async () => {
    setStubCustomerCountry('US');
    await runHandler({
      customer_id: 'gid://shopify/Customer/42',
      exchange_items: [{ sku: 'rub0001-S', quantity: 1 }],
      shipping_speed: 'expedited',
    });
    assert.equal(lastCreateDraftOrderArgs.shippingLine.title, 'US Expedited Shipping');
  });

  // Regression for order #32333: customer had no default address (checkout
  // failed, never completed an order), so the shipping line silently defaulted
  // to international on a US order. The preview must flag it loudly.
  it('warns in preview when the customer has no address on file (shipping defaults to international)', async () => {
    setStubCustomerCountry(null);
    const result = await runHandler({
      customer_id: 'gid://shopify/Customer/42',
      paid_items: [{ sku: 'rub0001-S', quantity: 1 }],
    });
    setStubCustomerCountry('US');
    assert.equal(lastCreateDraftOrderArgs.shippingLine.title, 'Free Standard International Shipping');
    assert.equal(lastCreateDraftOrderArgs.shippingAddress, undefined);
    assert.match(result.content[0].text, /⚠️.*Shipping destination unknown/);
    assert.match(result.content[0].text, /update_shipping_speed/);
  });

  it('does NOT warn when a destination country is known', async () => {
    setStubCustomerCountry('US');
    const result = await runHandler({
      customer_id: 'gid://shopify/Customer/42',
      paid_items: [{ sku: 'rub0001-S', quantity: 1 }],
    });
    assert.doesNotMatch(result.content[0].text, /Shipping destination unknown/);
  });

  it('normalizes numeric customer_id to a Customer GID', async () => {
    await runHandler({
      customer_id: '42',
      exchange_items: [{ sku: 'rub0001-S', quantity: 1 }],
    });
    assert.equal(lastCreateDraftOrderArgs.customerId, 'gid://shopify/Customer/42');
  });

  it('sets shipping address on draft from customer lookup', async () => {
    await runHandler({
      customer_id: 'gid://shopify/Customer/42',
      paid_items: [{ sku: 'rub0001-S', quantity: 1 }],
    });
    assert.ok(lastCreateDraftOrderArgs.shippingAddress, 'expected shippingAddress on draft');
    assert.equal(lastCreateDraftOrderArgs.shippingAddress.address1, '123 Main St');
  });

  it('applies return_credit as order-level fixed discount', async () => {
    await runHandler({
      customer_id: 'gid://shopify/Customer/42',
      paid_items: [{ sku: 'rub0001-S', quantity: 1 }],
      return_credit: 42.77,
      return_credit_note: 'Stella return credit from order #20335',
    });
    assert.deepEqual(lastCreateDraftOrderArgs.appliedDiscount, {
      title: 'Stella return credit from order #20335',
      value: 42.77,
      valueType: 'FIXED_AMOUNT',
    });
  });

  it('shows return credit in preview output', async () => {
    const result = await runHandler({
      customer_id: 'gid://shopify/Customer/42',
      paid_items: [{ sku: 'rub0001-S', quantity: 1 }],
      return_credit: 42.77,
    });
    assert.match(result.content[0].text, /Return credit.*-\$42\.77/);
  });
});

describe('create_invoice_order — phase 2 (send invoice)', () => {
  it('sends invoice for existing draft when confirmed + draft_order_id', async () => {
    const result = await runHandler({
      customer_id: 'gid://shopify/Customer/42',
      confirmed: true,
      draft_order_id: 'gid://shopify/DraftOrder/999',
    });
    assert.match(result.content[0].text, /Invoice Sent/);
    assert.match(result.content[0].text, /admin\.shopify\.com/);
  });
});

describe('create_invoice_order — shipping_address operator override', () => {
  it('uses customer default address when no override is provided', async () => {
    setStubCustomerCountry('US');
    await runHandler({
      customer_id: 'gid://shopify/Customer/1',
      paid_items: [{ sku: 'rub0001-S', quantity: 1 }],
    });
    assert.equal(lastCreateDraftOrderArgs.shippingAddress.address1, '123 Main St');
    assert.equal(lastCreateDraftOrderArgs.billingAddress.address1, '123 Main St');
  });

  it('explicit shipping_address overrides the customer default', async () => {
    setStubCustomerCountry('US');
    await runHandler({
      customer_id: 'gid://shopify/Customer/1',
      paid_items: [{ sku: 'rub0001-S', quantity: 1 }],
      shipping_address: {
        first_name: 'Different',
        last_name: 'Person',
        address1: '999 New Address',
        city: 'Newcity',
        province: 'BC',
        country: 'CA',
        zip: 'V6B 1A1',
      },
    });
    assert.equal(lastCreateDraftOrderArgs.shippingAddress.address1, '999 New Address');
    assert.equal(lastCreateDraftOrderArgs.shippingAddress.country, 'CA');
    assert.equal(lastCreateDraftOrderArgs.shippingAddress.firstName, 'Different');
    assert.equal(lastCreateDraftOrderArgs.billingAddress.address1, '999 New Address');
  });
});
