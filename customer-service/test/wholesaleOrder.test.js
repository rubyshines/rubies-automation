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
    // Lines now carry a custom priceOverride (net wholesale); no discount object.
    const unit = li.priceOverride ? parseFloat(li.priceOverride.amount) : retail;
    return {
      node: {
        title: 'TEST PRODUCT',
        quantity: li.quantity,
        originalUnitPrice: unit.toFixed(2),
        originalUnitPriceSet: { presentmentMoney: { amount: unit.toFixed(2), currencyCode: 'USD' } },
        discountedUnitPriceSet: { presentmentMoney: { amount: unit.toFixed(2), currencyCode: 'USD' } },
        variant: { id: li.variantId, title: 'Black / M', price: retail.toFixed(2) },
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

// Phase-2 recap fixture: tests can populate this map keyed by draft GID to
// drive getDraftOrderRecap responses. Format mirrors Shopify's GraphQL shape.
let stubDraftRecaps = {};
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
    getDraftOrderRecap: (id) => Promise.resolve(stubDraftRecaps[id] || null),
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
    applyShippingAddressOverride: realOrderUtils.applyShippingAddressOverride,
    SHIPPING_ADDRESS_OVERRIDE_SCHEMA: realOrderUtils.SHIPPING_ADDRESS_OVERRIDE_SCHEMA,
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

  it('operator can override non-US wholesale back to standard', async () => {
    await runHandler({
      customer_id: 'gid://shopify/Customer/1',
      country_code: 'CA',
      items: [{ sku: 'rub0001-S', quantity: 1 }],
      shipping_speed: 'standard',
    });
    assert.equal(lastCreateDraftOrderArgs.shippingLine.title, 'Free Canada Standard Shipping');
  });

  it('operator can still pass expedited explicitly for non-US wholesale', async () => {
    await runHandler({
      customer_id: 'gid://shopify/Customer/1',
      country_code: 'CA',
      items: [{ sku: 'rub0001-S', quantity: 1 }],
      shipping_speed: 'expedited',
    });
    assert.equal(lastCreateDraftOrderArgs.shippingLine.title, 'Canada Expedited Shipping');
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
    stubDraftRecaps = {};
    stubVariantPrices = {
      'gid://shopify/ProductVariant/100': '32.00', // adult AJ-style: bumped Apr 16
      'gid://shopify/ProductVariant/101': '24.00', // youth-style: unchanged
    };
  });

  it('without flag, line items get a custom priceOverride = currentRetail*(1-discount)', async () => {
    await runHandler({
      customer_id: 'gid://shopify/Customer/1',
      country_code: 'US',
      items: [{ variant_id: 'gid://shopify/ProductVariant/100', quantity: 1 }],
    });
    const li = lastCreateDraftOrderArgs.lineItems[0];
    // No discount object — price is locked via priceOverride. 32 * 0.5 = 16.00.
    assert.equal(li.appliedDiscount, undefined);
    assert.equal(li.priceOverride.amount, '16.00');
    assert.equal(li.priceOverride.currencyCode, 'USD');
  });

  it('with flag, snapshot variant priceOverride = oldRetail*(1-discount)', async () => {
    // AJ-style: current $32, previous $28. US 50% wholesale → $14 (off OLD retail).
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
    assert.equal(li.appliedDiscount, undefined);
    assert.equal(li.priceOverride.amount, '14.00');
  });

  it('with flag, non-snapshot variant prices off current retail (silent — no Apr 16 change)', async () => {
    stubPriceHistoryRows = []; // no rows for this variant
    await runHandler({
      customer_id: 'gid://shopify/Customer/1',
      country_code: 'US',
      items: [{ variant_id: 'gid://shopify/ProductVariant/100', quantity: 1 }],
      pre_increase_pricing: true,
    });
    const li = lastCreateDraftOrderArgs.lineItems[0];
    // 32 * 0.5 = 16.00 (current retail, no pre-increase row)
    assert.equal(li.priceOverride.amount, '16.00');
  });

  it('with flag, mixed order prices snapshot lines off old retail and others off current', async () => {
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
    // adult: off old retail 28 → 14.00; youth: off current retail 24 → 12.00
    assert.equal(adult.priceOverride.amount, '14.00');
    assert.equal(youth.priceOverride.amount, '12.00');
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
    // 28 * 0.5 = 14.00 (uses 28, not 30)
    assert.equal(li.priceOverride.amount, '14.00');
  });

  it('with flag + non-default discount_percent, priceOverride honors the override', async () => {
    // 30% discount instead of 50%: 28 * 0.7 = 19.60.
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
    assert.equal(li.priceOverride.amount, '19.60');
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

  it('with flag + per-item use_current_pricing override, that line prices off current retail', async () => {
    // Apr 16 row exists for variant 100 (would normally price off old retail $28),
    // but operator overrides → uses current retail 32 → 16.00.
    stubPriceHistoryRows = [
      { variant_id: 'gid://shopify/ProductVariant/100', previous_price: 28, changed_at: '2026-04-16T12:00:00Z' },
    ];
    await runHandler({
      customer_id: 'gid://shopify/Customer/1',
      country_code: 'US',
      items: [{ variant_id: 'gid://shopify/ProductVariant/100', quantity: 1, use_current_pricing: true }],
      pre_increase_pricing: true,
    });
    const li = lastCreateDraftOrderArgs.lineItems[0];
    assert.equal(li.priceOverride.amount, '16.00');
  });

  it('with flag, mixing snapshot + per-item override applies each rule independently', async () => {
    stubPriceHistoryRows = [
      { variant_id: 'gid://shopify/ProductVariant/100', previous_price: 28, changed_at: '2026-04-16T12:00:00Z' },
      { variant_id: 'gid://shopify/ProductVariant/101', previous_price: 12, changed_at: '2026-04-16T12:00:00Z' },
    ];
    stubVariantPrices = {
      'gid://shopify/ProductVariant/100': '32.00', // AJ — honor old price
      'gid://shopify/ProductVariant/101': '14.00', // chest pads — operator override to current
    };
    const result = await runHandler({
      customer_id: 'gid://shopify/Customer/1',
      country_code: 'US',
      items: [
        { variant_id: 'gid://shopify/ProductVariant/100', quantity: 1 },
        { variant_id: 'gid://shopify/ProductVariant/101', quantity: 12, use_current_pricing: true },
      ],
      pre_increase_pricing: true,
    });
    const [aj, pads] = lastCreateDraftOrderArgs.lineItems;
    // AJ: snapshot path → off old retail 28 → 14.00
    assert.equal(aj.priceOverride.amount, '14.00');
    // Chest pads: override → off current retail 14 → 7.00
    assert.equal(pads.priceOverride.amount, '7.00');
    // Preview shows operator-override marker for the pads line
    assert.match(result.content[0].text, /current pricing — operator override/);
    // Header reports the override count
    assert.match(result.content[0].text, /1 at current retail \(operator override\)/);
    // Price-change summary should NOT include chest pads (they're not having a price change communicated to customer)
    assert.doesNotMatch(result.content[0].text, /TEST PRODUCT.*\$6\.00/);
  });

  it('with flag, draft is tagged pre-apr-16-pricing (so Phase 2 can detect it)', async () => {
    stubPriceHistoryRows = [
      { variant_id: 'gid://shopify/ProductVariant/100', previous_price: 28, changed_at: '2026-04-16T12:00:00Z' },
    ];
    await runHandler({
      customer_id: 'gid://shopify/Customer/1',
      country_code: 'US',
      items: [{ variant_id: 'gid://shopify/ProductVariant/100', quantity: 1 }],
      pre_increase_pricing: true,
    });
    assert.ok(lastCreateDraftOrderArgs.tags.includes('pre-apr-16-pricing'));
    assert.ok(lastCreateDraftOrderArgs.tags.includes('wholesale'));
  });

  it('without flag, pre-apr-16-pricing tag is NOT added', async () => {
    await runHandler({
      customer_id: 'gid://shopify/Customer/1',
      country_code: 'US',
      items: [{ variant_id: 'gid://shopify/ProductVariant/100', quantity: 1 }],
    });
    assert.ok(!lastCreateDraftOrderArgs.tags.includes('pre-apr-16-pricing'));
  });

  it('Phase 2: invoice confirmation includes customer-facing price-change summary for pre-apr-16 orders', async () => {
    // Simulate a tagged draft with one snapshot AJ line and one current-priced
    // chest-pad line (operator override). Only the AJ line should appear in
    // the customer notice.
    stubPriceHistoryRows = [
      { variant_id: 'gid://shopify/ProductVariant/100', previous_price: 28, changed_at: '2026-04-16T12:00:00Z' },
    ];
    stubDraftRecaps['gid://shopify/DraftOrder/D6715'] = {
      id: 'gid://shopify/DraftOrder/D6715',
      name: 'D6715',
      tags: ['wholesale', 'cs-mcp', 'pre-apr-16-pricing'],
      lineItems: [
        {
          title: 'AJ',
          quantity: 5,
          variant: { id: 'gid://shopify/ProductVariant/100', title: 'Black / M', price: '32.00' },
          originalUnitPriceSet: { presentmentMoney: { amount: '32.00', currencyCode: 'USD' } },
          discountedUnitPriceSet: { presentmentMoney: { amount: '14.00', currencyCode: 'USD' } },
          appliedDiscount: { value: 18, valueType: 'FIXED_AMOUNT', title: 'Wholesale 50% (pre-Apr-16 retail $28.00)' },
        },
        {
          title: 'Chest Pads',
          quantity: 12,
          variant: { id: 'gid://shopify/ProductVariant/200', title: 'Black / M' },
          originalUnitPriceSet: { presentmentMoney: { amount: '14.00', currencyCode: 'USD' } },
          discountedUnitPriceSet: { presentmentMoney: { amount: '7.00', currencyCode: 'USD' } },
          appliedDiscount: { value: 50, valueType: 'PERCENTAGE', title: 'Wholesale 50%' },
        },
      ],
    };
    const result = await runHandler({
      customer_id: 'gid://shopify/Customer/1',
      confirmed: true,
      draft_order_ids: ['gid://shopify/DraftOrder/D6715'],
    });
    const text = result.content[0].text;
    assert.match(text, /Invoice sent/);
    assert.match(text, /Customer notice — prices going up next order/);
    assert.match(text, /AJ: this order \$14\.00 → next order \$16\.00 \(retail \$28\.00 → \$32\.00, 5 units\)/);
    // Chest pads should NOT appear (PERCENTAGE discount = current pricing)
    assert.doesNotMatch(text, /Chest Pads.*next order/);
  });

  it('Phase 2: non-pre-increase orders skip the customer notice', async () => {
    stubDraftRecaps['gid://shopify/DraftOrder/D6716'] = {
      id: 'gid://shopify/DraftOrder/D6716',
      name: 'D6716',
      tags: ['wholesale', 'cs-mcp'], // no pre-apr-16-pricing tag
      lineItems: [
        {
          title: 'AJ',
          quantity: 1,
          variant: { id: 'gid://shopify/ProductVariant/100', title: 'Black / M', price: '32.00' },
          originalUnitPriceSet: { presentmentMoney: { amount: '32.00', currencyCode: 'USD' } },
          discountedUnitPriceSet: { presentmentMoney: { amount: '16.00', currencyCode: 'USD' } },
          appliedDiscount: { value: 50, valueType: 'PERCENTAGE', title: 'Wholesale 50%' },
        },
      ],
    };
    const result = await runHandler({
      customer_id: 'gid://shopify/Customer/1',
      confirmed: true,
      draft_order_ids: ['gid://shopify/DraftOrder/D6716'],
    });
    assert.doesNotMatch(result.content[0].text, /Customer notice/);
  });

  it('Phase 2: aggregates snapshot lines across multiple drafts (AU split case)', async () => {
    stubPriceHistoryRows = [
      { variant_id: 'gid://shopify/ProductVariant/100', previous_price: 28, changed_at: '2026-04-16T12:00:00Z' },
    ];
    // Two drafts (e.g. AU split), each with AJ snapshot lines
    stubDraftRecaps['gid://shopify/DraftOrder/A'] = {
      id: 'gid://shopify/DraftOrder/A',
      name: 'A',
      tags: ['wholesale', 'cs-mcp', 'pre-apr-16-pricing'],
      lineItems: [{
        title: 'AJ',
        quantity: 3,
        variant: { id: 'gid://shopify/ProductVariant/100', title: 'Black / M', price: '32.00' },
        originalUnitPriceSet: { presentmentMoney: { amount: '32.00', currencyCode: 'USD' } },
        discountedUnitPriceSet: { presentmentMoney: { amount: '14.00', currencyCode: 'USD' } },
        appliedDiscount: { value: 18, valueType: 'FIXED_AMOUNT', title: 'pre' },
      }],
    };
    stubDraftRecaps['gid://shopify/DraftOrder/B'] = {
      id: 'gid://shopify/DraftOrder/B',
      name: 'B',
      tags: ['wholesale', 'cs-mcp', 'pre-apr-16-pricing'],
      lineItems: [{
        title: 'AJ',
        quantity: 2,
        variant: { id: 'gid://shopify/ProductVariant/100', title: 'Black / M', price: '32.00' },
        originalUnitPriceSet: { presentmentMoney: { amount: '32.00', currencyCode: 'USD' } },
        discountedUnitPriceSet: { presentmentMoney: { amount: '14.00', currencyCode: 'USD' } },
        appliedDiscount: { value: 18, valueType: 'FIXED_AMOUNT', title: 'pre' },
      }],
    };
    const result = await runHandler({
      customer_id: 'gid://shopify/Customer/1',
      confirmed: true,
      draft_order_ids: ['gid://shopify/DraftOrder/A', 'gid://shopify/DraftOrder/B'],
    });
    // 3 + 2 = 5 units in single grouped row
    assert.match(result.content[0].text, /AJ: this order \$14\.00 → next order \$16\.00 \(retail \$28\.00 → \$32\.00, 5 units\)/);
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

describe('create_wholesale_order — shipping_address operator override', () => {
  beforeEach(() => { lastCreateDraftOrderArgs = null; });

  it('uses customer default address when no override is provided', async () => {
    await runHandler({
      customer_id: 'gid://shopify/Customer/1',
      country_code: 'CA',
      items: [{ sku: 'rub0001-S', quantity: 1 }],
    });
    assert.equal(lastCreateDraftOrderArgs.shippingAddress.address1, '1 Wholesale Way');
    assert.equal(lastCreateDraftOrderArgs.billingAddress.address1, '1 Wholesale Way');
  });

  it('explicit shipping_address overrides the customer default', async () => {
    await runHandler({
      customer_id: 'gid://shopify/Customer/1',
      country_code: 'AU',
      items: [{ sku: 'rub0001-S', quantity: 1 }],
      shipping_address: {
        first_name: 'Erin',
        last_name: 'Spencer',
        address1: '76 Parramatta Rd',
        city: 'Stanmore',
        province: 'NSW',
        country: 'AU',
        zip: '2048',
      },
    });
    assert.equal(lastCreateDraftOrderArgs.shippingAddress.address1, '76 Parramatta Rd');
    assert.equal(lastCreateDraftOrderArgs.shippingAddress.city, 'Stanmore');
    assert.equal(lastCreateDraftOrderArgs.shippingAddress.province, 'NSW');
    assert.equal(lastCreateDraftOrderArgs.shippingAddress.zip, '2048');
    assert.equal(lastCreateDraftOrderArgs.shippingAddress.country, 'AU');
    assert.equal(lastCreateDraftOrderArgs.shippingAddress.firstName, 'Erin');
    assert.equal(lastCreateDraftOrderArgs.billingAddress.address1, '76 Parramatta Rd');
  });

  it('partial override merges onto customer default', async () => {
    await runHandler({
      customer_id: 'gid://shopify/Customer/1',
      country_code: 'CA',
      items: [{ sku: 'rub0001-S', quantity: 1 }],
      shipping_address: { address1: '99 Different St', address2: 'Apt 5' },
    });
    assert.equal(lastCreateDraftOrderArgs.shippingAddress.address1, '99 Different St');
    assert.equal(lastCreateDraftOrderArgs.shippingAddress.address2, 'Apt 5');
    // Unspecified fields fall back to customer default
    assert.equal(lastCreateDraftOrderArgs.shippingAddress.city, 'X');
    assert.equal(lastCreateDraftOrderArgs.shippingAddress.country, 'CA');
    assert.equal(lastCreateDraftOrderArgs.shippingAddress.firstName, 'Test');
  });
});
