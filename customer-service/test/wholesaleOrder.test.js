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
const supabaseClientPath = require.resolve('../../shared/supabaseClient');

// Stub Supabase: in-memory price_history rows keyed by variant_id, returned
// from a fluent query builder that mirrors the chain used in fetchPreIncreasePrices.
let stubPriceHistoryRows = [];
function makeQueryBuilder(rows) {
  let filtered = rows.slice();
  const builder = {
    select: () => builder,
    in: (col, vals) => { filtered = filtered.filter(r => vals.includes(r[col])); return builder; },
    gte: (col, v) => { filtered = filtered.filter(r => r[col] >= v); return builder; },
    lt: (col, v) => { filtered = filtered.filter(r => r[col] < v); return builder; },
    not: (col, _op, v) => { filtered = filtered.filter(r => r[col] !== v); return builder; },
    order: (col, opts) => {
      const asc = !opts || opts.ascending !== false;
      filtered.sort((a, b) => asc ? (a[col] > b[col] ? 1 : -1) : (a[col] < b[col] ? 1 : -1));
      return builder;
    },
    then: (resolve) => resolve({ data: filtered, error: null }),
  };
  return builder;
}
require.cache[supabaseClientPath] = {
  id: supabaseClientPath, filename: supabaseClientPath, loaded: true,
  exports: {
    getSupabaseClient: () => ({
      from: () => makeQueryBuilder(stubPriceHistoryRows),
    }),
  },
};

let lastCreateDraftOrderArgs = null;
// Build a draft response that mirrors the input line items so the preview
// renderer sees one rendered line per requested variant. Discounted unit
// price is computed from input appliedDiscount + stubVariantPrices.
function buildDraftResponseFromInput(input) {
  const edges = (input.lineItems || []).map(li => {
    const retail = parseFloat(stubVariantPrices[li.variantId] || '100.00');
    let discounted = retail;
    if (li.appliedDiscount) {
      if (li.appliedDiscount.valueType === 'PERCENTAGE') {
        discounted = retail * (1 - li.appliedDiscount.value / 100);
      } else if (li.appliedDiscount.valueType === 'FIXED_AMOUNT') {
        discounted = Math.max(0, retail - li.appliedDiscount.value);
      }
    }
    return {
      node: {
        title: 'TEST PRODUCT',
        quantity: li.quantity,
        originalUnitPrice: retail.toFixed(2),
        discountedUnitPriceSet: { presentmentMoney: { amount: discounted.toFixed(2), currencyCode: 'USD' } },
        variant: { id: li.variantId, title: 'Black / M' },
      },
    };
  });
  const total = edges.reduce((s, e) => s + parseFloat(e.node.discountedUnitPriceSet.presentmentMoney.amount) * e.node.quantity, 0);
  return {
    id: 'gid://shopify/DraftOrder/999',
    name: 'D999',
    totalPrice: total.toFixed(2),
    totalPriceSet: { presentmentMoney: { amount: total.toFixed(2), currencyCode: 'USD' } },
    presentmentCurrencyCode: 'USD',
    lineItems: { edges },
  };
}

require.cache[shopifyPath] = {
  id: shopifyPath, filename: shopifyPath, loaded: true,
  exports: {
    createDraftOrder: (args) => {
      lastCreateDraftOrderArgs = args;
      return Promise.resolve(buildDraftResponseFromInput(args));
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

// Per-variant current retail price stub. Tests can override entries before
// calling the handler to simulate specific pricing scenarios.
let stubVariantPrices = {};
require.cache[resolveLineItemsPath] = {
  id: resolveLineItemsPath, filename: resolveLineItemsPath, loaded: true,
  exports: {
    resolveLineItems: async (items) => items.map((it, i) => {
      const variantId = it.variant_id || `gid://shopify/ProductVariant/${100 + i}`;
      return {
        variantId,
        productTitle: 'TEST PRODUCT',
        variantTitle: 'Black / M',
        sku: it.sku || `test-sku-${i}`,
        price: stubVariantPrices[variantId] || '100.00',
        inventoryQuantity: 10,
        quantity: it.quantity || 1,
      };
    }),
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

describe('create_wholesale_order — pre_increase_pricing flag', () => {
  beforeEach(() => {
    lastCreateDraftOrderArgs = null;
    stubPriceHistoryRows = [];
    stubVariantPrices = {
      'gid://shopify/ProductVariant/100': '32.00', // adult AJ-style: bumped Apr 16
      'gid://shopify/ProductVariant/101': '24.00', // youth-style: unchanged
    };
  });

  it('without flag, line items use PERCENTAGE discount (existing behavior unchanged)', async () => {
    await runHandler({
      customer_id: 'gid://shopify/Customer/1',
      country_code: 'US',
      items: [{ variant_id: 'gid://shopify/ProductVariant/100', quantity: 1 }],
    });
    const li = lastCreateDraftOrderArgs.lineItems[0];
    assert.equal(li.appliedDiscount.valueType, 'PERCENTAGE');
    assert.equal(li.appliedDiscount.value, 50);
  });

  it('with flag, snapshot variant gets FIXED_AMOUNT discount = currentRetail - oldRetail*(1-discount)', async () => {
    // AJ-style: current $32, previous $28. US 50% wholesale → target $14.
    // FIXED_AMOUNT = 32 - 14 = 18.
    stubPriceHistoryRows = [
      { variant_id: 'gid://shopify/ProductVariant/100', previous_price: 28, changed_at: '2026-04-16T12:00:00Z' },
    ];
    await runHandler({
      customer_id: 'gid://shopify/Customer/1',
      country_code: 'US',
      items: [{ variant_id: 'gid://shopify/ProductVariant/100', quantity: 1 }],
      pre_increase_pricing: true,
    });
    const li = lastCreateDraftOrderArgs.lineItems[0];
    assert.equal(li.appliedDiscount.valueType, 'FIXED_AMOUNT');
    assert.equal(li.appliedDiscount.value, 18);
    assert.match(li.appliedDiscount.title, /pre-Apr-16 retail \$28\.00/);
  });

  it('with flag, non-snapshot variant falls back to PERCENTAGE (silent — no Apr 16 change)', async () => {
    stubPriceHistoryRows = []; // no rows for this variant
    await runHandler({
      customer_id: 'gid://shopify/Customer/1',
      country_code: 'US',
      items: [{ variant_id: 'gid://shopify/ProductVariant/100', quantity: 1 }],
      pre_increase_pricing: true,
    });
    const li = lastCreateDraftOrderArgs.lineItems[0];
    assert.equal(li.appliedDiscount.valueType, 'PERCENTAGE');
    assert.equal(li.appliedDiscount.value, 50);
  });

  it('with flag, mixed order applies FIXED_AMOUNT to snapshot lines and PERCENTAGE to others', async () => {
    stubPriceHistoryRows = [
      { variant_id: 'gid://shopify/ProductVariant/100', previous_price: 28, changed_at: '2026-04-16T12:00:00Z' },
      // ProductVariant/101 deliberately absent — youth size unchanged
    ];
    await runHandler({
      customer_id: 'gid://shopify/Customer/1',
      country_code: 'US',
      items: [
        { variant_id: 'gid://shopify/ProductVariant/100', quantity: 2 },
        { variant_id: 'gid://shopify/ProductVariant/101', quantity: 1 },
      ],
      pre_increase_pricing: true,
    });
    const [adult, youth] = lastCreateDraftOrderArgs.lineItems;
    assert.equal(adult.appliedDiscount.valueType, 'FIXED_AMOUNT');
    assert.equal(adult.appliedDiscount.value, 18);
    assert.equal(youth.appliedDiscount.valueType, 'PERCENTAGE');
    assert.equal(youth.appliedDiscount.value, 50);
  });

  it('with flag, multiple Apr-16 rows for one variant uses earliest previous_price', async () => {
    // Edge case: variant changed twice on Apr 16. Earliest row has the truly pre-rollout value.
    stubPriceHistoryRows = [
      { variant_id: 'gid://shopify/ProductVariant/100', previous_price: 28, changed_at: '2026-04-16T08:00:00Z' },
      { variant_id: 'gid://shopify/ProductVariant/100', previous_price: 30, changed_at: '2026-04-16T18:00:00Z' },
    ];
    await runHandler({
      customer_id: 'gid://shopify/Customer/1',
      country_code: 'US',
      items: [{ variant_id: 'gid://shopify/ProductVariant/100', quantity: 1 }],
      pre_increase_pricing: true,
    });
    const li = lastCreateDraftOrderArgs.lineItems[0];
    // 32 - 28*0.5 = 32 - 14 = 18 (uses 28, not 30)
    assert.equal(li.appliedDiscount.value, 18);
  });

  it('with flag + non-default discount_percent, FIXED_AMOUNT honors the override', async () => {
    // 30% discount instead of 50%: target = 28 * 0.7 = 19.60. FIXED = 32 - 19.60 = 12.40.
    stubPriceHistoryRows = [
      { variant_id: 'gid://shopify/ProductVariant/100', previous_price: 28, changed_at: '2026-04-16T12:00:00Z' },
    ];
    await runHandler({
      customer_id: 'gid://shopify/Customer/1',
      country_code: 'US',
      items: [{ variant_id: 'gid://shopify/ProductVariant/100', quantity: 1 }],
      discount_percent: 30,
      pre_increase_pricing: true,
    });
    const li = lastCreateDraftOrderArgs.lineItems[0];
    assert.equal(li.appliedDiscount.valueType, 'FIXED_AMOUNT');
    assert.equal(li.appliedDiscount.value, 12.4);
  });

  it('with flag, preview output includes pre-Apr-16 annotation per snapshot line', async () => {
    stubPriceHistoryRows = [
      { variant_id: 'gid://shopify/ProductVariant/100', previous_price: 28, changed_at: '2026-04-16T12:00:00Z' },
    ];
    const result = await runHandler({
      customer_id: 'gid://shopify/Customer/1',
      country_code: 'US',
      items: [
        { variant_id: 'gid://shopify/ProductVariant/100', quantity: 1 },
        { variant_id: 'gid://shopify/ProductVariant/101', quantity: 1 },
      ],
      pre_increase_pricing: true,
    });
    const text = result.content[0].text;
    assert.match(text, /pre_increase_pricing=true/);
    assert.match(text, /pre-Apr-16 retail \$28\.00/);
    assert.match(text, /no Apr-16 change/);
  });

  it('with flag, preview includes price-change summary grouped by product + price pair (one row, not per-size)', async () => {
    // Three AJ adult sizes (same $28→$32 jump) should collapse into one summary row.
    stubVariantPrices = {
      'gid://shopify/ProductVariant/100': '32.00',
      'gid://shopify/ProductVariant/101': '32.00',
      'gid://shopify/ProductVariant/102': '32.00',
    };
    stubPriceHistoryRows = [
      { variant_id: 'gid://shopify/ProductVariant/100', previous_price: 28, changed_at: '2026-04-16T12:00:00Z' },
      { variant_id: 'gid://shopify/ProductVariant/101', previous_price: 28, changed_at: '2026-04-16T12:00:00Z' },
      { variant_id: 'gid://shopify/ProductVariant/102', previous_price: 28, changed_at: '2026-04-16T12:00:00Z' },
    ];
    const result = await runHandler({
      customer_id: 'gid://shopify/Customer/1',
      country_code: 'US',
      items: [
        { variant_id: 'gid://shopify/ProductVariant/100', quantity: 2 },
        { variant_id: 'gid://shopify/ProductVariant/101', quantity: 3 },
        { variant_id: 'gid://shopify/ProductVariant/102', quantity: 1 },
      ],
      pre_increase_pricing: true,
    });
    const text = result.content[0].text;
    assert.match(text, /Price changes for customer/);
    // One summary row covering all 6 units (2+3+1)
    assert.match(text, /TEST PRODUCT: this order \$14\.00 → next order \$16\.00 \(retail \$28\.00 → \$32\.00, 6 units\)/);
    // Should NOT have three separate rows
    const matches = text.match(/this order \$14\.00 → next order \$16\.00/g);
    assert.equal(matches.length, 1);
  });

  it('with flag but no snapshot items in order, price-change summary is omitted', async () => {
    stubPriceHistoryRows = []; // nothing changed
    const result = await runHandler({
      customer_id: 'gid://shopify/Customer/1',
      country_code: 'US',
      items: [{ variant_id: 'gid://shopify/ProductVariant/101', quantity: 1 }],
      pre_increase_pricing: true,
    });
    assert.doesNotMatch(result.content[0].text, /Price changes for customer/);
  });

  it('without flag, price-change summary is never emitted', async () => {
    stubPriceHistoryRows = [
      { variant_id: 'gid://shopify/ProductVariant/100', previous_price: 28, changed_at: '2026-04-16T12:00:00Z' },
    ];
    const result = await runHandler({
      customer_id: 'gid://shopify/Customer/1',
      country_code: 'US',
      items: [{ variant_id: 'gid://shopify/ProductVariant/100', quantity: 1 }],
    });
    assert.doesNotMatch(result.content[0].text, /Price changes for customer/);
  });

  it('with flag, draft note carries the pre-Apr-16 marker', async () => {
    stubPriceHistoryRows = [
      { variant_id: 'gid://shopify/ProductVariant/100', previous_price: 28, changed_at: '2026-04-16T12:00:00Z' },
    ];
    await runHandler({
      customer_id: 'gid://shopify/Customer/1',
      country_code: 'US',
      items: [{ variant_id: 'gid://shopify/ProductVariant/100', quantity: 1 }],
      pre_increase_pricing: true,
    });
    assert.match(lastCreateDraftOrderArgs.note, /pre-Apr-16 pricing/);
  });
});
