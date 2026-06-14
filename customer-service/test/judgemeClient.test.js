/**
 * judgemeClient — retry-with-backoff behaviour.
 *
 * The daily review pipeline was losing ~1 run/week to single transient `fetch
 * failed` blips because one failed request killed the whole sub-step. apiFetch
 * now retries network errors + 429/5xx with exponential backoff, and fails fast
 * on other 4xx (a bad token won't recover). These tests pin that contract
 * against a mocked global.fetch.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const CLIENT_PATH = require.resolve('../../shared/judgemeClient');

let origFetch;
let origToken;
let origDomain;
let origBaseMs;

function freshClient() {
  // Module caches the singleton at module scope, so re-require with a clean
  // cache entry for an isolated client per test.
  delete require.cache[CLIENT_PATH];
  return require('../../shared/judgemeClient').getJudgemeClient();
}

describe('judgemeClient — apiFetch retries', () => {
  beforeEach(() => {
    origFetch = global.fetch;
    origToken = process.env.JUDGEME_API_TOKEN;
    origDomain = process.env.JUDGEME_SHOP_DOMAIN;
    origBaseMs = process.env.JUDGEME_RETRY_BASE_MS;
    process.env.JUDGEME_API_TOKEN = 'test-token';
    process.env.JUDGEME_SHOP_DOMAIN = 'test-shop.myshopify.com';
    process.env.JUDGEME_RETRY_BASE_MS = '1'; // keep backoff near-instant in tests
  });

  afterEach(() => {
    global.fetch = origFetch;
    if (origToken === undefined) delete process.env.JUDGEME_API_TOKEN; else process.env.JUDGEME_API_TOKEN = origToken;
    if (origDomain === undefined) delete process.env.JUDGEME_SHOP_DOMAIN; else process.env.JUDGEME_SHOP_DOMAIN = origDomain;
    if (origBaseMs === undefined) delete process.env.JUDGEME_RETRY_BASE_MS; else process.env.JUDGEME_RETRY_BASE_MS = origBaseMs;
    delete require.cache[CLIENT_PATH];
  });

  it('retries a transient network failure then succeeds', async () => {
    let calls = 0;
    global.fetch = async () => {
      calls++;
      if (calls < 3) throw new TypeError('fetch failed'); // mimic undici network error
      return { ok: true, json: async () => ({ count: 42 }) };
    };

    const client = freshClient();
    const count = await client.getReviewCount();

    assert.equal(count, 42);
    assert.equal(calls, 3, 'should retry twice before the successful third call');
  });

  it('retries a 500 server error then succeeds', async () => {
    let calls = 0;
    global.fetch = async () => {
      calls++;
      if (calls < 2) return { ok: false, status: 500, text: async () => 'server error' };
      return { ok: true, json: async () => ({ reviews: [{ id: 1 }] }) };
    };

    const client = freshClient();
    const reviews = await client.getReviews();

    assert.deepEqual(reviews, [{ id: 1 }]);
    assert.equal(calls, 2);
  });

  it('retries a 429 rate-limit then succeeds', async () => {
    let calls = 0;
    global.fetch = async () => {
      calls++;
      if (calls < 2) return { ok: false, status: 429, text: async () => 'rate limited' };
      return { ok: true, json: async () => ({ count: 7 }) };
    };

    const client = freshClient();
    const count = await client.getReviewCount();

    assert.equal(count, 7);
    assert.equal(calls, 2);
  });

  it('fails fast on a 401 without retrying', async () => {
    let calls = 0;
    global.fetch = async () => {
      calls++;
      return { ok: false, status: 401, text: async () => 'invalid token' };
    };

    const client = freshClient();
    await assert.rejects(client.getReviewCount(), /Judge\.me 401/);
    assert.equal(calls, 1, 'a 4xx auth error should not be retried');
  });

  it('gives up after MAX_ATTEMPTS on a persistent network failure', async () => {
    let calls = 0;
    global.fetch = async () => {
      calls++;
      throw new TypeError('fetch failed');
    };

    const client = freshClient();
    await assert.rejects(client.getReviewCount(), /fetch failed/);
    assert.equal(calls, 4, 'should attempt exactly MAX_ATTEMPTS times');
  });
});
