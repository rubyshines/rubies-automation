/**
 * gorgiasClient.getTicketMessages — pagination shape.
 *
 * Why this exists: /tickets/{id}/messages paginates by PAGE
 * ({page, per_page, item_count, nb_pages, next_page}) and never returns
 * `next_cursor`, while its siblings /tickets and /views/{id}/items genuinely
 * are cursor-based. `limit` is ignored — per_page is fixed at 30.
 *
 * That difference has cost two versions of this function: first a single
 * 50-message page, then a cursor loop copied from getViewItems that read a
 * `meta.next_cursor` which is always undefined here and so exited after page
 * one. Both silently returned only the OLDEST messages. Callers ask "did the
 * customer reply?" by reading messages[length-1], so every thread past 30
 * messages looked frozen at message 30 — on ticket 109556554 (32 messages) the
 * customer's newest reply lived on page 2, intake resolved the latest customer
 * message to one that already had a draft, and left them unanswered for 9 days.
 *
 * Neither prior version failed any test, because no test ever handed the client
 * a multi-page response. That is the gap this file closes.
 *
 * Run: node --test customer-service/test/gorgiasMessagePagination.test.js
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const CLIENT_PATH = require.resolve('../import/gorgiasClient');
const ENV_KEYS = ['GORGIAS_DOMAIN', 'GORGIAS_API_KEY', 'GORGIAS_EMAIL'];

let origFetch;
let origEnv;
let origWarn;
let warnings;

function freshClient() {
  delete require.cache[CLIENT_PATH];
  return require('../import/gorgiasClient');
}

const msg = id => ({ id, created_datetime: `2026-08-${String((id % 27) + 1).padStart(2, '0')}T00:00:00+00:00` });

/**
 * The real page-based envelope, verified live against Gorgias 2026-08-24.
 * `nb_pages` and `item_count` are the endpoint stating its own total.
 */
function pageResponse(ids, { page, nbPages, itemCount }) {
  return {
    data: ids.map(msg),
    meta: {
      page,
      per_page: 30,
      item_count: itemCount,
      nb_pages: nbPages,
      current_page: `/api/tickets/1/messages/?page=${page}`,
      ...(page < nbPages ? { next_page: `/api/tickets/1/messages/?page=${page + 1}` } : {}),
    },
  };
}

function stubFetch(responsesByPage) {
  const seen = [];
  global.fetch = async (url) => {
    seen.push(url);
    const page = Number(new URL(url).searchParams.get('page') || 1);
    const body = responsesByPage[page];
    if (!body) throw new Error(`unexpected request for page ${page}`);
    return { ok: true, json: async () => body };
  };
  return seen;
}

describe('getTicketMessages — page-based pagination', () => {
  beforeEach(() => {
    origFetch = global.fetch;
    origWarn = console.warn;
    warnings = [];
    console.warn = (m) => warnings.push(String(m));
    origEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
    process.env.GORGIAS_DOMAIN = 'test-shop';
    process.env.GORGIAS_API_KEY = 'test-key';
    process.env.GORGIAS_EMAIL = 'test@example.com';
  });

  afterEach(() => {
    global.fetch = origFetch;
    console.warn = origWarn;
    for (const k of ENV_KEYS) {
      if (origEnv[k] === undefined) delete process.env[k]; else process.env[k] = origEnv[k];
    }
    delete require.cache[CLIENT_PATH];
  });

  it('follows nb_pages to the last page — the newest messages are NOT dropped', async () => {
    // The live shape of ticket 109556554: 32 messages, 30 on page 1, the two
    // newest (our reply and the customer's) stranded on page 2.
    const pageOne = Array.from({ length: 30 }, (_, i) => 100 + i);
    const pageTwo = [130, 131];
    const seen = stubFetch({
      1: pageResponse(pageOne, { page: 1, nbPages: 2, itemCount: 32 }),
      2: pageResponse(pageTwo, { page: 2, nbPages: 2, itemCount: 32 }),
    });

    const messages = await freshClient().getTicketMessages(1);

    assert.equal(messages.length, 32);
    assert.deepEqual(messages.map(m => m.id).slice(-2), [130, 131]);
    assert.equal(seen.length, 2);
    assert.match(seen[1], /[?&]page=2\b/);
    assert.deepEqual(warnings, [], 'a complete read must not warn');
  });

  it('stops after the last page rather than requesting an empty one', async () => {
    // Page 3 exists on the server and returns []. Requesting it is harmless but
    // wasteful, and a loop that only stops on an empty page would never
    // terminate against an endpoint that keeps echoing the last page.
    const seen = stubFetch({ 1: pageResponse([1, 2], { page: 1, nbPages: 1, itemCount: 2 }) });

    const messages = await freshClient().getTicketMessages(1);

    assert.equal(messages.length, 2);
    assert.equal(seen.length, 1);
  });

  it('still honours a cursor if Gorgias ever aligns this endpoint with its siblings', async () => {
    let call = 0;
    const seen = [];
    global.fetch = async (url) => {
      seen.push(url);
      call++;
      if (call === 1) return { ok: true, json: async () => ({ data: [msg(1)], meta: { next_cursor: 'abc' } }) };
      return { ok: true, json: async () => ({ data: [msg(2)], meta: { next_cursor: null } }) };
    };

    const messages = await freshClient().getTicketMessages(1);

    assert.deepEqual(messages.map(m => m.id), [1, 2]);
    assert.match(seen[1], /[?&]cursor=abc\b/);
  });

  it('warns when the collected count falls short of the endpoint-reported total', async () => {
    // The tripwire for the whole class: this endpoint publishes item_count, so a
    // short read is checkable. Silent truncation is the defect that shipped
    // twice — it must be loud if a future shape change reintroduces it.
    stubFetch({ 1: { data: [msg(1)], meta: { page: 1, per_page: 30, item_count: 32, nb_pages: 1 } } });

    const messages = await freshClient().getTicketMessages(4242);

    assert.equal(messages.length, 1);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /4242/);
    assert.match(warnings[0], /1 of 32 messages/);
  });

  it('tolerates a response with no meta at all', async () => {
    stubFetch({ 1: { data: [msg(1), msg(2)] } });

    const messages = await freshClient().getTicketMessages(1);

    assert.deepEqual(messages.map(m => m.id), [1, 2]);
    assert.deepEqual(warnings, []);
  });

  it('bounds a pathological thread instead of paginating forever', async () => {
    // nb_pages far beyond MAX_PAGES: the loop must stop, and say that it did.
    let calls = 0;
    global.fetch = async (url) => {
      calls++;
      const page = Number(new URL(url).searchParams.get('page') || 1);
      return { ok: true, json: async () => pageResponse([page], { page, nbPages: 999, itemCount: 999 * 30 }) };
    };

    const messages = await freshClient().getTicketMessages(1);

    assert.equal(calls, 20, 'MAX_PAGES bound');
    assert.equal(messages.length, 20);
    assert.equal(warnings.length, 1, 'a bounded read is a short read and must warn');
  });
});
