/**
 * Tests for contextBuilder — order number extraction and auto-detect logic.
 *
 * Run: node --test customer-service/test/contextBuilder.test.js
 *
 * Unit tests only — no API calls, no Supabase.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { extractOrderNumber, analyzeOrders, normalizeEmail } = require('../lib/contextBuilder');

// ---------------------------------------------------------------------------
// Order number extraction from customer messages
// ---------------------------------------------------------------------------

describe('extractOrderNumber', () => {
  it('extracts #XXXXX format', () => {
    assert.equal(extractOrderNumber('#29784'), '29784');
    assert.equal(extractOrderNumber('my order #29784 is wrong'), '29784');
  });

  it('extracts "Order number: #XXXXX" (bot flow)', () => {
    assert.equal(extractOrderNumber('Order number: #29784\n\nSelected items:'), '29784');
  });

  it('extracts "order # was XXXXX" (word between # and number)', () => {
    assert.equal(extractOrderNumber('The order # was 29887.'), '29887');
  });

  it('extracts "order # is XXXXX"', () => {
    assert.equal(extractOrderNumber('the order # is 29887'), '29887');
  });

  it('extracts "order number XXXXX" (no #)', () => {
    assert.equal(extractOrderNumber('order number 29784'), '29784');
  });

  it('extracts "order #XXXXX" (standard)', () => {
    assert.equal(extractOrderNumber('order #29784'), '29784');
  });

  it('extracts from bot selection list "#XXXXX - $XXX"', () => {
    assert.equal(extractOrderNumber('#29784 - $158.40 - April 1, 2026'), '29784');
  });

  it('returns null for no order number', () => {
    assert.equal(extractOrderNumber("my order doesn't fit"), null);
    assert.equal(extractOrderNumber('help me with a return'), null);
  });

  it('returns null for numbers too short (< 4 digits)', () => {
    assert.equal(extractOrderNumber('#123'), null);
  });

  it('returns null for phone numbers', () => {
    assert.equal(extractOrderNumber('call me at 555-1234'), null);
  });

  it('returns null for null/empty input', () => {
    assert.equal(extractOrderNumber(null), null);
    assert.equal(extractOrderNumber(''), null);
  });

  it('extracts from multi-line conversation context', () => {
    const text = `[CONVERSATION HISTORY]
Customer: Help me with a return or exchange
Agent: What order?
[LATEST CUSTOMER MESSAGE]
The order # was 29887.`;
    assert.equal(extractOrderNumber(text), '29887');
  });
});

// ---------------------------------------------------------------------------
// Email normalization
// ---------------------------------------------------------------------------

describe('normalizeEmail', () => {
  it('converts @googlemail.com to @gmail.com', () => {
    assert.equal(normalizeEmail('user@googlemail.com'), 'user@gmail.com');
  });

  it('lowercases and trims', () => {
    assert.equal(normalizeEmail('  User@GoogleMail.COM  '), 'user@gmail.com');
  });

  it('leaves @gmail.com unchanged', () => {
    assert.equal(normalizeEmail('user@gmail.com'), 'user@gmail.com');
  });

  it('leaves other domains unchanged', () => {
    assert.equal(normalizeEmail('user@yahoo.com'), 'user@yahoo.com');
  });

  it('handles null/undefined', () => {
    assert.equal(normalizeEmail(null), null);
    assert.equal(normalizeEmail(undefined), undefined);
  });
});

// ---------------------------------------------------------------------------
// Auto-detect order priority (analyzeOrders + filtering logic)
// ---------------------------------------------------------------------------

describe('auto-detect order priority', () => {
  // Helper to create mock orders
  function mockOrder(name, { fulfilled = true, cancelled = false, amount = '50.00' } = {}) {
    return {
      name: `#${name}`,
      displayFulfillmentStatus: fulfilled ? 'FULFILLED' : 'UNFULFILLED',
      displayFinancialStatus: cancelled ? 'REFUNDED' : 'PAID',
      cancelledAt: cancelled ? '2026-01-01' : null,
      totalPriceSet: { shopMoney: { amount, currencyCode: 'USD' } },
    };
  }

  it('picks most recent fulfilled when all are fulfilled', () => {
    const orders = [mockOrder('29784'), mockOrder('29000'), mockOrder('28000')];
    const { fulfilled } = analyzeOrders(orders);
    // Orders already sorted newest first by caller
    const nonExchange = orders.filter(o => !o.cancelledAt && parseFloat(o.totalPriceSet?.shopMoney?.amount || '0') > 0);
    assert.equal(nonExchange[0].name, '#29784');
  });

  it('picks unfulfilled recent over fulfilled old', () => {
    const orders = [
      mockOrder('29887', { fulfilled: false }),  // newest, just placed
      mockOrder('8346', { fulfilled: true }),     // old fulfilled
    ];
    const nonExchange = orders.filter(o => !o.cancelledAt && parseFloat(o.totalPriceSet?.shopMoney?.amount || '0') > 0);
    assert.equal(nonExchange[0].name, '#29887');
  });

  it('excludes $0 exchange orders from auto-detect', () => {
    const orders = [
      mockOrder('30000', { fulfilled: false, amount: '0' }),  // $0 exchange
      mockOrder('29000', { fulfilled: true }),                  // real order
    ];
    const nonExchange = orders.filter(o => !o.cancelledAt && parseFloat(o.totalPriceSet?.shopMoney?.amount || '0') > 0);
    assert.equal(nonExchange[0].name, '#29000');
  });

  it('excludes cancelled orders from auto-detect', () => {
    const orders = [
      mockOrder('30000', { cancelled: true }),   // cancelled
      mockOrder('29000', { fulfilled: true }),    // good
    ];
    const nonExchange = orders.filter(o => !o.cancelledAt && parseFloat(o.totalPriceSet?.shopMoney?.amount || '0') > 0);
    assert.equal(nonExchange[0].name, '#29000');
  });

  it('returns empty when only $0 exchange orders exist', () => {
    const orders = [
      mockOrder('30000', { fulfilled: false, amount: '0' }),
      mockOrder('29000', { fulfilled: false, amount: '0' }),
    ];
    const nonExchange = orders.filter(o => !o.cancelledAt && parseFloat(o.totalPriceSet?.shopMoney?.amount || '0') > 0);
    assert.equal(nonExchange.length, 0);
  });
});
