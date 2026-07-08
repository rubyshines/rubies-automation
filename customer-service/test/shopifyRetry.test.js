/**
 * Unit tests for shopifyGraphQL retry idempotency (customer-service/lib/shopify.js).
 *
 * A mutation must NOT be retried on a network error / 5xx (it may have already
 * applied → double refund / duplicate order). Reads may be retried freely. 429
 * is retried for both (rejected before execution).
 *
 * Run: node --test customer-service/test/shopifyRetry.test.js
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.SHOPIFY_STORE_URL = process.env.SHOPIFY_STORE_URL || 'test.myshopify.com';
process.env.SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN || 'test-token';

const { shopifyGraphQL } = require('../lib/shopify');

const MUTATION = `
    mutation refundCreate($input: RefundInput!) { refundCreate(input: $input) { refund { id } userErrors { message } } }`;
const QUERY = `
    query getOrder($id: ID!) { order(id: $id) { id } }`;

let realFetch;
before(() => { realFetch = global.fetch; });
after(() => { global.fetch = realFetch; });

let calls;
beforeEach(() => { calls = 0; });

function econnreset() {
  const e = new Error('fetch failed');
  e.cause = { code: 'ECONNRESET' };
  return e;
}
function okResponse(data) {
  return { ok: true, status: 200, json: async () => ({ data }) };
}
function status(code) {
  return { ok: false, status: code, text: async () => `err ${code}` };
}

describe('shopifyGraphQL retry idempotency', () => {
  it('does NOT retry a mutation on ECONNRESET (would double-execute)', async () => {
    global.fetch = async () => { calls++; throw econnreset(); };
    await assert.rejects(() => shopifyGraphQL(MUTATION, {}), /fetch failed/);
    assert.equal(calls, 1, 'mutation should be attempted exactly once');
  });

  it('does NOT retry a mutation on 5xx', async () => {
    global.fetch = async () => { calls++; return status(503); };
    await assert.rejects(() => shopifyGraphQL(MUTATION, {}), /503/);
    assert.equal(calls, 1, 'mutation should not retry a 5xx');
  });

  it('DOES retry a query on ECONNRESET', async () => {
    global.fetch = async () => {
      calls++;
      if (calls < 3) throw econnreset();
      return okResponse({ order: { id: 'gid://x' } });
    };
    const data = await shopifyGraphQL(QUERY, {});
    assert.equal(calls, 3, 'query should retry transient network errors');
    assert.deepEqual(data, { order: { id: 'gid://x' } });
  });

  it('DOES retry a mutation on 429 (rejected before execution)', async () => {
    global.fetch = async () => {
      calls++;
      if (calls < 2) return status(429);
      return okResponse({ refundCreate: { refund: { id: 'r1' }, userErrors: [] } });
    };
    const data = await shopifyGraphQL(MUTATION, {});
    assert.equal(calls, 2, 'mutation should retry a 429');
    assert.equal(data.refundCreate.refund.id, 'r1');
  });

  it('honours an explicit idempotent:true override for a mutation-shaped op', async () => {
    global.fetch = async () => {
      calls++;
      if (calls < 2) throw econnreset();
      return okResponse({ ok: true });
    };
    const data = await shopifyGraphQL(MUTATION, {}, { idempotent: true });
    assert.equal(calls, 2, 'explicit idempotent:true allows transient retry');
    assert.deepEqual(data, { ok: true });
  });
});
