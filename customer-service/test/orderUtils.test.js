/**
 * Unit tests for lib/orderUtils.js — country-based helpers used by order-creation tools.
 *
 * Run: node --test customer-service/test/orderUtils.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// Stub shippingLookup before requiring orderUtils so the lazy require inside
// getFedExTag picks up the stub instead of touching Supabase.
const shippingLookupPath = require.resolve('../lib/tools/shippingLookup');
let stubZone = null;
require.cache[shippingLookupPath] = {
  id: shippingLookupPath,
  filename: shippingLookupPath,
  loaded: true,
  exports: {
    getShippingZone: async () => stubZone,
  },
};

const { isUSCountry, getFedExTag } = require('../lib/orderUtils');

describe('isUSCountry', () => {
  it('matches the 2-letter ISO code', () => {
    assert.equal(isUSCountry('US'), true);
    assert.equal(isUSCountry('us'), true);
  });

  it('matches USA and the full country name', () => {
    assert.equal(isUSCountry('USA'), true);
    assert.equal(isUSCountry('United States'), true);
    assert.equal(isUSCountry('  united states  '), true);
  });

  it('returns false for non-US countries', () => {
    assert.equal(isUSCountry('CA'), false);
    assert.equal(isUSCountry('AU'), false);
    assert.equal(isUSCountry('GB'), false);
    assert.equal(isUSCountry('Australia'), false);
  });

  it('returns false for empty/missing values', () => {
    assert.equal(isUSCountry(''), false);
    assert.equal(isUSCountry(null), false);
    assert.equal(isUSCountry(undefined), false);
  });
});

describe('getFedExTag', () => {
  beforeEach(() => { stubZone = null; });

  it('returns null for US in any form (US never carries a FedEx tag)', async () => {
    assert.equal(await getFedExTag('US'), null);
    assert.equal(await getFedExTag('usa'), null);
    assert.equal(await getFedExTag('United States'), null);
  });

  it('returns null when country is missing — never tag without a known destination', async () => {
    assert.equal(await getFedExTag(''), null);
    assert.equal(await getFedExTag(null), null);
    assert.equal(await getFedExTag(undefined), null);
  });

  it('returns ddp tag for Canada short-circuit (no zone lookup needed)', async () => {
    stubZone = 'should-not-be-used';
    assert.equal(await getFedExTag('CA'), 'ship fedex ddp');
    assert.equal(await getFedExTag('ca'), 'ship fedex ddp');
    assert.equal(await getFedExTag('Canada'), 'ship fedex ddp');
  });

  it('returns ddp tag when zone lookup says ddp', async () => {
    stubZone = 'ddp';
    assert.equal(await getFedExTag('AU'), 'ship fedex ddp');
    assert.equal(await getFedExTag('GB'), 'ship fedex ddp');
    assert.equal(await getFedExTag('DE'), 'ship fedex ddp');
  });

  it('returns ddu tag when zone lookup says ddu', async () => {
    stubZone = 'ddu';
    assert.equal(await getFedExTag('AR'), 'ship fedex ddu');
    assert.equal(await getFedExTag('JP'), 'ship fedex ddu');
  });

  it('falls back to ddu when zone lookup returns null (unknown country)', async () => {
    stubZone = null;
    assert.equal(await getFedExTag('XX'), 'ship fedex ddu');
  });
});
