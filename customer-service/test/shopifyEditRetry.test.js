/**
 * Order-edit staging mutations: which ones may be retried after a dropped connection.
 *
 * Shopify resets the connection partway through a long staging run (hit live on a
 * 22-mutation repair of #32310: ECONNRESET out of orderEditSetQuantity, aborting the
 * whole edit and leaving a useless half-staged session).
 *
 * shopifyGraphQL deliberately does NOT retry mutations on a network error, because the
 * request may have reached Shopify and applied. The exception is a mutation that is
 * genuinely idempotent: orderEditSetQuantity sets an ABSOLUTE quantity on one line, so
 * replaying it converges. orderEditAddVariant does not — a replay adds a second line —
 * and must keep failing loudly. This test pins that asymmetry, because getting it
 * backwards would silently duplicate line items on a customer's order.
 */

const { test } = require('node:test');
const assert = require('node:assert');

process.env.SHOPIFY_STORE_URL = process.env.SHOPIFY_STORE_URL || 'test.myshopify.com';
process.env.SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN || 'test-token';

const shopify = require('../lib/shopify');

const econnreset = () => Object.assign(new TypeError('fetch failed'), {
  cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
});

const ok = (payload) => ({
  ok: true,
  status: 200,
  json: async () => ({ data: payload }),
});

/** Fails the first `failures` calls with ECONNRESET, then succeeds. */
function flakyFetch(failures, payload) {
  const state = { calls: 0 };
  global.fetch = async () => {
    state.calls += 1;
    if (state.calls <= failures) throw econnreset();
    return ok(payload);
  };
  return state;
}

const realFetch = global.fetch;

test('orderEditSetQuantity retries through a dropped connection', async () => {
  const state = flakyFetch(2, {
    orderEditSetQuantity: {
      calculatedOrder: { id: 'gid://shopify/CalculatedOrder/1', addedLineItems: { edges: [] } },
      calculatedLineItem: { id: 'gid://shopify/CalculatedLineItem/1', quantity: 0 },
      userErrors: [],
    },
  });

  const res = await shopify.orderEditSetQuantity(
    'gid://shopify/CalculatedOrder/1', 'gid://shopify/CalculatedLineItem/1', 0,
  );

  assert.strictEqual(state.calls, 3, 'two failures then a success');
  assert.strictEqual(res.calculatedLineItem.quantity, 0);
  global.fetch = realFetch;
});

test('orderEditAddVariant does NOT retry — a replay would duplicate the line', async () => {
  const state = flakyFetch(1, {
    orderEditAddVariant: {
      calculatedOrder: { id: 'gid://shopify/CalculatedOrder/1' },
      calculatedLineItem: { id: 'gid://shopify/CalculatedLineItem/2', quantity: 1 },
      userErrors: [],
    },
  });

  await assert.rejects(
    () => shopify.orderEditAddVariant('gid://shopify/CalculatedOrder/1', 'gid://shopify/ProductVariant/1', 1),
    /fetch failed/,
    'must surface the network error rather than silently adding the variant twice',
  );
  assert.strictEqual(state.calls, 1, 'exactly one attempt');
  global.fetch = realFetch;
});

test('a retried setQuantity still gives up rather than looping forever', async () => {
  const state = flakyFetch(99, {});
  await assert.rejects(
    () => shopify.orderEditSetQuantity('gid://shopify/CalculatedOrder/1', 'gid://shopify/CalculatedLineItem/1', 0),
    /fetch failed/,
  );
  assert.strictEqual(state.calls, 3, 'bounded by the default retry count');
  global.fetch = realFetch;
});
