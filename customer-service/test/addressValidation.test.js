/**
 * Unit tests for the Tier-1 address-validation gate (lib/addressValidation.js).
 *
 * Pure classifier + the fetch wrapper (with an injected fetch). No network.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const {
  classifyGeocodeResult,
  addressToQuery,
  validateShippingAddress,
} = require('../lib/addressValidation');

test('addressToQuery joins present fields, skips blanks', () => {
  assert.strictEqual(
    addressToQuery({ address1: '123 Main St', city: 'Austin', province: 'TX', zip: '78701', country: 'US' }),
    '123 Main St, Austin, TX, 78701, US'
  );
  assert.strictEqual(
    addressToQuery({ address1: '1 A St', address2: null, city: 'Austin', province: '', zip: '78701', country: 'US' }),
    '1 A St, Austin, 78701, US'
  );
});

test('classifyGeocodeResult: clean rooftop match is ok with country', () => {
  const json = {
    status: 'OK',
    results: [{ partial_match: false, address_components: [{ types: ['country'], short_name: 'US' }] }],
  };
  const v = classifyGeocodeResult(json);
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.country_code, 'US');
});

test('classifyGeocodeResult: ZERO_RESULTS is not ok', () => {
  const v = classifyGeocodeResult({ status: 'ZERO_RESULTS', results: [] });
  assert.strictEqual(v.ok, false);
  assert.match(v.reason, /did not resolve/);
});

test('classifyGeocodeResult: partial_match is not ok (possible typo/incomplete)', () => {
  const json = {
    status: 'OK',
    results: [{ partial_match: true, address_components: [{ types: ['country'], short_name: 'DE' }] }],
  };
  const v = classifyGeocodeResult(json);
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.country_code, 'DE'); // still surfaces resolved country for cross-border check
  assert.match(v.reason, /partial/);
});

test('classifyGeocodeResult: non-OK status (e.g. OVER_QUERY_LIMIT) is not ok', () => {
  const v = classifyGeocodeResult({ status: 'OVER_QUERY_LIMIT', results: [] });
  assert.strictEqual(v.ok, false);
});

test('classifyGeocodeResult: missing results array is not ok', () => {
  const v = classifyGeocodeResult({ status: 'OK' });
  assert.strictEqual(v.ok, false);
});

test('validateShippingAddress: fail-safe when no API key', async () => {
  const saved = process.env.GOOGLE_MAPS_API_KEY;
  delete process.env.GOOGLE_MAPS_API_KEY;
  try {
    const v = await validateShippingAddress({ address1: '1 A St', city: 'Austin', country: 'US' });
    assert.strictEqual(v.ok, false);
    assert.match(v.reason, /unavailable/);
  } finally {
    if (saved !== undefined) process.env.GOOGLE_MAPS_API_KEY = saved;
  }
});

test('validateShippingAddress: uses injected fetch and classifies the response', async () => {
  const saved = process.env.GOOGLE_MAPS_API_KEY;
  process.env.GOOGLE_MAPS_API_KEY = 'test-key';
  try {
    const fetchImpl = async () => ({
      ok: true,
      json: async () => ({
        status: 'OK',
        results: [{ partial_match: false, address_components: [{ types: ['country'], short_name: 'US' }] }],
      }),
    });
    const v = await validateShippingAddress({ address1: '123 Main St', city: 'Austin', country: 'US' }, { fetchImpl });
    assert.strictEqual(v.ok, true);
    assert.strictEqual(v.country_code, 'US');
  } finally {
    if (saved === undefined) delete process.env.GOOGLE_MAPS_API_KEY;
    else process.env.GOOGLE_MAPS_API_KEY = saved;
  }
});

test('validateShippingAddress: HTTP error is fail-safe (not ok)', async () => {
  const saved = process.env.GOOGLE_MAPS_API_KEY;
  process.env.GOOGLE_MAPS_API_KEY = 'test-key';
  try {
    const fetchImpl = async () => ({ ok: false, status: 500 });
    const v = await validateShippingAddress({ address1: '1 A St', city: 'X', country: 'US' }, { fetchImpl });
    assert.strictEqual(v.ok, false);
  } finally {
    if (saved === undefined) delete process.env.GOOGLE_MAPS_API_KEY;
    else process.env.GOOGLE_MAPS_API_KEY = saved;
  }
});
