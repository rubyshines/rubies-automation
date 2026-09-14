/**
 * resolveOrderFulfillment — the live "has this order shipped?" read that decides
 * edit_order vs create_exchange_order in the operator action chat.
 *
 * Run: node --test customer-service/test/orderFulfillment.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

// Stub shopify before requiring orderUtils: getOrderByNumber is destructured at
// load time, so the stub has to be in the cache first.
const shopifyPath = require.resolve('../lib/shopify');
let stubOrder = null;
let stubError = null;
let calls = [];
require.cache[shopifyPath] = {
  id: shopifyPath,
  filename: shopifyPath,
  loaded: true,
  exports: {
    searchCustomers: async () => [],
    getOrderByNumber: async (n) => {
      calls.push(n);
      if (stubError) throw stubError;
      return stubOrder;
    },
  },
};

const { resolveOrderFulfillment } = require('../lib/orderUtils');

function reset() { stubOrder = null; stubError = null; calls = []; }

test('an unshipped order reports notShipped, so the prompt can rule out an exchange', async () => {
  reset();
  stubOrder = { displayFulfillmentStatus: 'UNFULFILLED', cancelledAt: null };
  assert.deepEqual(await resolveOrderFulfillment('#33694'),
    { status: 'UNFULFILLED', cancelled: false, notShipped: true });
});

test('a shipped order reports notShipped false', async () => {
  reset();
  stubOrder = { displayFulfillmentStatus: 'FULFILLED', cancelledAt: null };
  assert.deepEqual(await resolveOrderFulfillment('33694'),
    { status: 'FULFILLED', cancelled: false, notShipped: false });
});

test('partially fulfilled still counts as not shipped — part of it is editable', async () => {
  reset();
  stubOrder = { displayFulfillmentStatus: 'PARTIALLY_FULFILLED', cancelledAt: null };
  const r = await resolveOrderFulfillment('33694');
  assert.equal(r.notShipped, true);
  assert.equal(r.status, 'PARTIALLY_FULFILLED');
});

test('a cancelled order is reported as cancelled, not silently dropped', async () => {
  reset();
  stubOrder = { displayFulfillmentStatus: 'UNFULFILLED', cancelledAt: '2026-09-13T14:34:45Z' };
  assert.equal((await resolveOrderFulfillment('33700')).cancelled, true);
});

test('status is normalised to upper case whatever Shopify returns', async () => {
  reset();
  stubOrder = { displayFulfillmentStatus: 'unfulfilled', cancelledAt: null };
  const r = await resolveOrderFulfillment('33694');
  assert.equal(r.status, 'UNFULFILLED');
  assert.equal(r.notShipped, true);
});

test('fails soft to null so the caller renders "unknown" rather than guessing', async () => {
  reset();
  stubError = new Error('fetch failed');
  assert.equal(await resolveOrderFulfillment('33694'), null);

  reset();
  stubOrder = null;                                    // order not found
  assert.equal(await resolveOrderFulfillment('99999'), null);

  reset();
  stubOrder = { displayFulfillmentStatus: null };      // present but unreadable
  assert.equal(await resolveOrderFulfillment('33694'), null);
});

test('a missing order number never reaches Shopify', async () => {
  reset();
  assert.equal(await resolveOrderFulfillment(null), null);
  assert.equal(await resolveOrderFulfillment(''), null);
  assert.equal(await resolveOrderFulfillment('   '), null);
  assert.deepEqual(calls, []);
});
