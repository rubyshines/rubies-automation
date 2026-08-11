/**
 * gorgiasClient — transient-failure retry behaviour.
 *
 * 2026-08-11: a single Gorgias 502 on the Unassigned view aborted the whole
 * daily Ticket Reconciliation run, and with it the follow-up sweep (the only
 * engine for snooze-expiry follow-ups, since Gorgias emits no webhook there).
 * apiFetch retried 429 only. It now also retries 5xx + network errors, but
 * ONLY for reads — a write that 5xx'd may already have created a ticket or
 * emailed a customer. These tests pin that split against a mocked global.fetch.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const CLIENT_PATH = require.resolve('../import/gorgiasClient');

const ENV_KEYS = ['GORGIAS_DOMAIN', 'GORGIAS_API_KEY', 'GORGIAS_EMAIL', 'GORGIAS_RETRY_BASE_MS'];
let origFetch;
let origEnv;

function freshClient() {
  // RETRY_BASE_MS is read at module load — re-require so the test override applies.
  delete require.cache[CLIENT_PATH];
  return require('../import/gorgiasClient');
}

function serverError(status = 502) {
  // Gorgias returns a full HTML error page on 5xx.
  return { ok: false, status, text: async () => '<!DOCTYPE html><html>'.padEnd(5000, 'x') };
}

describe('gorgiasClient — apiFetch retries', () => {
  beforeEach(() => {
    origFetch = global.fetch;
    origEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
    process.env.GORGIAS_DOMAIN = 'test-shop';
    process.env.GORGIAS_API_KEY = 'test-key';
    process.env.GORGIAS_EMAIL = 'test@example.com';
    process.env.GORGIAS_RETRY_BASE_MS = '1'; // keep backoff near-instant in tests
  });

  afterEach(() => {
    global.fetch = origFetch;
    for (const k of ENV_KEYS) {
      if (origEnv[k] === undefined) delete process.env[k]; else process.env[k] = origEnv[k];
    }
    delete require.cache[CLIENT_PATH];
  });

  it('retries a 502 on a read then succeeds', async () => {
    let calls = 0;
    global.fetch = async () => {
      calls++;
      if (calls < 3) return serverError(502);
      return { ok: true, json: async () => ({ id: 123 }) };
    };

    const ticket = await freshClient().getTicket(123);

    assert.equal(ticket.id, 123);
    assert.equal(calls, 3, 'should retry twice before the successful third call');
  });

  it('retries a network failure on a read then succeeds', async () => {
    let calls = 0;
    global.fetch = async () => {
      calls++;
      if (calls < 2) throw new TypeError('fetch failed'); // mimic undici network error
      return { ok: true, json: async () => ({ id: 7 }) };
    };

    const ticket = await freshClient().getTicket(7);

    assert.equal(ticket.id, 7);
    assert.equal(calls, 2);
  });

  it('gives up on a read after 5 attempts and truncates the HTML error body', async () => {
    let calls = 0;
    global.fetch = async () => { calls++; return serverError(503); };

    await assert.rejects(
      () => freshClient().getTicket(1),
      (err) => {
        assert.match(err.message, /Gorgias API error 503 on \/tickets\/1/);
        assert.ok(err.message.length < 400, `error body should be truncated, got ${err.message.length} chars`);
        return true;
      },
    );
    assert.equal(calls, 5);
  });

  it('does NOT retry a write on a 502 — it may already have applied', async () => {
    let calls = 0;
    global.fetch = async () => { calls++; return serverError(502); };

    await assert.rejects(() => freshClient().reopenTicket(42), /Gorgias API error 502/);
    assert.equal(calls, 1, 'a write must not be replayed after a server error');
  });

  it('does NOT retry a write on a network error', async () => {
    let calls = 0;
    global.fetch = async () => { calls++; throw new TypeError('fetch failed'); };

    await assert.rejects(() => freshClient().reopenTicket(42), /fetch failed/);
    assert.equal(calls, 1);
  });

  it('still retries a write on 429 — the request was rejected before it ran', async () => {
    let calls = 0;
    global.fetch = async () => {
      calls++;
      if (calls < 2) return { ok: false, status: 429, headers: { get: () => null }, text: async () => 'rate limited' };
      return { ok: true, json: async () => ({ id: 42, status: 'open' }) };
    };

    const result = await freshClient().reopenTicket(42);

    assert.equal(result.status, 'open');
    assert.equal(calls, 2);
  });

  it('fails fast on a 4xx — a bad request will not fix itself', async () => {
    let calls = 0;
    global.fetch = async () => { calls++; return { ok: false, status: 404, text: async () => 'not found' }; };

    await assert.rejects(() => freshClient().getTicket(999), /Gorgias API error 404/);
    assert.equal(calls, 1);
  });
});
