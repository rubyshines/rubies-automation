/**
 * Tests for the wholesale price-override change:
 *  - computeWholesaleUnitPrice: net wholesale unit price (current vs pre-Apr-16 retail)
 *  - order profitability: revenue must be NET of line discounts (so legacy
 *    discount-based wholesale orders don't overstate margin, and priceOverride
 *    orders — which carry no discount — stay correct).
 *
 * Run: node --test customer-service/test/wholesalePriceOverride.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// Stub external deps before requiring the modules under test
// ---------------------------------------------------------------------------
function stubModule(relPath, exports) {
  const p = require.resolve(relPath);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

let fixtureOrder = null;

stubModule('../lib/shopify', {
  getOrderByNumber: async () => fixtureOrder,
  getDraftOrderRecap: async () => null,
  createDraftOrder: async () => ({}),
  deleteDraftOrder: async () => null,
  completeDraftOrder: async () => ({}),
  sendDraftOrderInvoice: async () => ({}),
  getAdminUrl: () => 'https://admin',
  normalizeGid: (id, t) => (String(id).startsWith('gid://') ? id : `gid://shopify/${t}/${id}`),
});
stubModule('../lib/supabaseQueries', {
  getOrderByNumberFromSupabase: async () => fixtureOrder,
});
stubModule('../lib/productCache', { searchProducts: async () => [] });
stubModule('../lib/costsCache', {
  getCostForSku: async () => ({ total_landed_cost: '5.00' }),
  getCostByPrefix: async () => null,
  getAllCosts: async () => [],
});
stubModule('../lib/returnRatesCache', { getRatesForSku: async () => null });

const marginsTools = require('../lib/tools/margins');
const { computeWholesaleUnitPrice } = require('../lib/tools/wholesaleOrder');

const orderProfitability = marginsTools.find(t => t.name === 'get_order_profitability').handler;

// ---------------------------------------------------------------------------
describe('computeWholesaleUnitPrice', () => {
  it('applies the discount to current retail when no pre-increase retail', () => {
    assert.equal(computeWholesaleUnitPrice(32, undefined, 50), 16);
    assert.equal(computeWholesaleUnitPrice(29, undefined, 30), 20.3);
  });

  it('prices off the pre-Apr-16 retail when provided (honors old pricing)', () => {
    // current retail 32, old retail 28 → 50% off the OLD retail = 14, not 16
    assert.equal(computeWholesaleUnitPrice(32, 28, 50), 14);
  });

  it('rounds to cents', () => {
    assert.equal(computeWholesaleUnitPrice(30.5, undefined, 50), 15.25);
  });

  it('treats a null old retail the same as current-pricing', () => {
    assert.equal(
      computeWholesaleUnitPrice(32, null, 50),
      computeWholesaleUnitPrice(32, undefined, 50),
    );
  });
});

// ---------------------------------------------------------------------------
describe('order profitability — revenue is net of line discounts', () => {
  it('subtracts legacy line discounts and ignores zero-discount override lines', async () => {
    fixtureOrder = {
      name: '#TEST',
      lineItems: [
        // Legacy discount-based wholesale line: gross 28.69 x2, half off
        {
          title: 'AJ', variantTitle: 'Black / S', sku: 'aj-s', quantity: 2,
          originalUnitPriceSet: { shopMoney: { amount: '28.69', currencyCode: 'USD' } },
          totalDiscountSet: { shopMoney: { amount: '28.69', currencyCode: 'USD' } },
        },
        // New priceOverride line: gross == net, no discount
        {
          title: 'Brooke', variantTitle: 'Black / M', sku: 'br-m', quantity: 1,
          originalUnitPriceSet: { shopMoney: { amount: '14.00', currencyCode: 'USD' } },
          totalDiscountSet: { shopMoney: { amount: '0', currencyCode: 'USD' } },
        },
      ],
    };

    const res = await orderProfitability({ order_number: 'TEST' });
    const text = res.content[0].text;

    // Net revenue = (28.69*2 - 28.69) + (14.00*1 - 0) = 28.69 + 14.00 = 42.69
    assert.match(text, /42\.69/, `expected net revenue 42.69 in:\n${text}`);
    // Gross would have been 28.69*2 + 14 = 71.38 — must NOT appear as revenue
    assert.doesNotMatch(text, /71\.38/, 'revenue should be net, not gross');
    // Gross profit = 42.69 - 3 units * 5.00 COGS = 27.69
    assert.match(text, /27\.69/, `expected gross profit 27.69 in:\n${text}`);
  });
});
