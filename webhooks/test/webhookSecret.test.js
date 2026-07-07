/**
 * Unit tests for webhooks/lib/webhookSecret.js — shared-secret verification.
 *
 * Run: node --test webhooks/test/webhookSecret.test.js
 */

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { verifySharedSecret } = require('../lib/webhookSecret');

const ENV = 'TEST_WEBHOOK_SECRET';
function req(secret) {
  return { query: secret === undefined ? {} : { secret } };
}
afterEach(() => { delete process.env[ENV]; });

describe('verifySharedSecret — mandatory', () => {
  it('rejects with 500 when the secret env var is unset', () => {
    const r = verifySharedSecret(req('anything'), ENV, { mandatory: true });
    assert.equal(r.ok, false);
    assert.equal(r.status, 500);
  });

  it('rejects with 401 when the request omits the secret (the bypass bug)', () => {
    process.env[ENV] = 'topsecret';
    const r = verifySharedSecret(req(undefined), ENV, { mandatory: true });
    assert.equal(r.ok, false);
    assert.equal(r.status, 401);
  });

  it('rejects with 401 on a wrong secret', () => {
    process.env[ENV] = 'topsecret';
    const r = verifySharedSecret(req('wrong'), ENV, { mandatory: true });
    assert.equal(r.ok, false);
    assert.equal(r.status, 401);
  });

  it('accepts a matching secret', () => {
    process.env[ENV] = 'topsecret';
    const r = verifySharedSecret(req('topsecret'), ENV, { mandatory: true });
    assert.equal(r.ok, true);
  });
});

describe('verifySharedSecret — optional', () => {
  it('passes through when the secret is unset (falls back to other validation)', () => {
    const r = verifySharedSecret(req(undefined), ENV, { mandatory: false });
    assert.equal(r.ok, true);
  });

  it('still enforces the secret once configured — omitting it is rejected', () => {
    process.env[ENV] = 'topsecret';
    const r = verifySharedSecret(req(undefined), ENV, { mandatory: false });
    assert.equal(r.ok, false);
    assert.equal(r.status, 401);
  });

  it('rejects a wrong secret when configured', () => {
    process.env[ENV] = 'topsecret';
    const r = verifySharedSecret(req('nope'), ENV, { mandatory: false });
    assert.equal(r.ok, false);
    assert.equal(r.status, 401);
  });

  it('accepts a matching secret when configured', () => {
    process.env[ENV] = 'topsecret';
    const r = verifySharedSecret(req('topsecret'), ENV, { mandatory: false });
    assert.equal(r.ok, true);
  });
});

describe('verifySharedSecret — hardening', () => {
  it('does not throw on a mismatched-length secret (timingSafeEqual guard)', () => {
    process.env[ENV] = 'a-very-long-secret-value';
    assert.doesNotThrow(() => verifySharedSecret(req('x'), ENV, { mandatory: true }));
    const r = verifySharedSecret(req('x'), ENV, { mandatory: true });
    assert.equal(r.ok, false);
  });

  it('rejects an array-valued secret param', () => {
    process.env[ENV] = 'topsecret';
    const r = verifySharedSecret({ query: { secret: ['topsecret', 'x'] } }, ENV, { mandatory: true });
    assert.equal(r.ok, false);
    assert.equal(r.status, 401);
  });
});
