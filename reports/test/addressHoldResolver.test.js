/**
 * Unit tests for addressHoldResolver.js — geocoding validation + classification priority.
 *
 * Run: node --test reports/test/addressHoldResolver.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// We only need the pure validation function — no API mocking needed
const { validateGeocodedAddress } = require('../lib/addressHoldResolver');

// Also test classifyOrder priority (address holds before recency)
// Mock the warehanceClient so unfulfilled.js can load
const whModulePath = require.resolve('../lib/warehanceClient');
require.cache[whModulePath] = {
  id: whModulePath, filename: whModulePath, loaded: true,
  exports: {
    fetchUnfulfilledOrders: async () => new Map(),
    getHoldReasons: (o) => {
      if (!o || !o.has_hold) return [];
      const holds = [];
      if (o.address_hold) holds.push('address_hold');
      if (o.fraud_hold) holds.push('fraud_hold');
      return holds;
    },
    warehanceOrderUrl: () => '',
    cancelOrder: async () => {},
  },
};

// Mock supabase
const sbModulePath = require.resolve('../../shared/supabaseClient');
require.cache[sbModulePath] = {
  id: sbModulePath, filename: sbModulePath, loaded: true,
  exports: { getSupabaseClient: () => ({}) },
};

// ---------------------------------------------------------------------------
// validateGeocodedAddress tests
// ---------------------------------------------------------------------------

describe('validateGeocodedAddress', () => {
  const baseOriginal = {
    address1: '125 e market st long beach',
    address2: '8',
    city: 'LONG BEACH',
    provinceCode: 'CA',
    zip: '90805',
    countryCode: 'US',
  };

  it('accepts ROOFTOP, no partial match, zip unchanged, subpremise present', () => {
    const geocoded = {
      locationType: 'ROOFTOP',
      partialMatch: false,
      streetNumber: '125',
      route: 'E Market St',
      subpremise: '8',
      city: 'Long Beach',
      province: 'CA',
      zip: '90805',
      country: 'US',
    };
    const result = validateGeocodedAddress(baseOriginal, geocoded);
    assert.ok(result, 'should return cleaned address');
    assert.equal(result.address1, '125 E Market St');
    assert.equal(result.address2, '#8');
    assert.equal(result.city, 'Long Beach');
    assert.equal(result.zip, '90805');
  });

  it('rejects when location type is not ROOFTOP', () => {
    const geocoded = {
      locationType: 'RANGE_INTERPOLATED',
      partialMatch: false,
      streetNumber: '125',
      route: 'E Market St',
      subpremise: '8',
      city: 'Long Beach',
      province: 'CA',
      zip: '90805',
    };
    assert.equal(validateGeocodedAddress(baseOriginal, geocoded), null);
  });

  it('rejects partial match', () => {
    const geocoded = {
      locationType: 'ROOFTOP',
      partialMatch: true,
      streetNumber: '125',
      route: 'E Market St',
      subpremise: '8',
      city: 'Long Beach',
      province: 'CA',
      zip: '90805',
    };
    assert.equal(validateGeocodedAddress(baseOriginal, geocoded), null);
  });

  it('rejects when zip code changes', () => {
    const geocoded = {
      locationType: 'ROOFTOP',
      partialMatch: false,
      streetNumber: '125',
      route: 'E Market St',
      subpremise: '8',
      city: 'Long Beach',
      province: 'CA',
      zip: '90210',
    };
    assert.equal(validateGeocodedAddress(baseOriginal, geocoded), null);
  });

  it('rejects when original has address2 but Google has no subpremise', () => {
    const geocoded = {
      locationType: 'ROOFTOP',
      partialMatch: false,
      streetNumber: '125',
      route: 'E Market St',
      subpremise: null,
      city: 'Long Beach',
      province: 'CA',
      zip: '90805',
    };
    assert.equal(validateGeocodedAddress(baseOriginal, geocoded), null);
  });

  it('accepts when no address2 and no subpremise', () => {
    const original = { ...baseOriginal, address2: '' };
    const geocoded = {
      locationType: 'ROOFTOP',
      partialMatch: false,
      streetNumber: '125',
      route: 'E Market St',
      subpremise: null,
      city: 'Long Beach',
      province: 'CA',
      zip: '90805',
    };
    const result = validateGeocodedAddress(original, geocoded);
    assert.ok(result);
    assert.equal(result.address1, '125 E Market St');
    assert.equal(result.address2, null); // no subpremise, no original address2
  });

  it('accepts when no address2 and null address2', () => {
    const original = { ...baseOriginal, address2: null };
    const geocoded = {
      locationType: 'ROOFTOP',
      partialMatch: false,
      streetNumber: '125',
      route: 'E Market St',
      subpremise: null,
      city: 'Long Beach',
      province: 'CA',
      zip: '90805',
    };
    const result = validateGeocodedAddress(original, geocoded);
    assert.ok(result);
  });

  it('returns null for null geocoded input', () => {
    assert.equal(validateGeocodedAddress(baseOriginal, null), null);
  });

  it('handles Canadian postal codes with spaces', () => {
    const original = { address1: '100 Sheppard Ave E', address2: '', city: 'Toronto', provinceCode: 'ON', zip: 'M2N 6N5', countryCode: 'CA' };
    const geocoded = {
      locationType: 'ROOFTOP',
      partialMatch: false,
      streetNumber: '100',
      route: 'Sheppard Ave E',
      subpremise: null,
      city: 'North York',
      province: 'ON',
      zip: 'M2N 6N5',
    };
    const result = validateGeocodedAddress(original, geocoded);
    assert.ok(result);
    assert.equal(result.city, 'North York'); // Google corrects city
    assert.equal(result.zip, 'M2N 6N5'); // zip unchanged
  });

  it('corrects city name when zip matches', () => {
    const original = { address1: '100 Sheppard Ave E', address2: null, city: 'Toronto', provinceCode: 'ON', zip: 'M2N6N5', countryCode: 'CA' };
    const geocoded = {
      locationType: 'ROOFTOP',
      partialMatch: false,
      streetNumber: '100',
      route: 'Sheppard Ave E',
      subpremise: null,
      city: 'North York',
      province: 'ON',
      zip: 'M2N6N5',
    };
    const result = validateGeocodedAddress(original, geocoded);
    assert.ok(result);
    assert.equal(result.city, 'North York');
  });

  it('rejects when no street number or route', () => {
    const geocoded = {
      locationType: 'ROOFTOP',
      partialMatch: false,
      streetNumber: null,
      route: null,
      subpremise: null,
      city: 'Long Beach',
      province: 'CA',
      zip: '90805',
    };
    const original = { ...baseOriginal, address2: null };
    assert.equal(validateGeocodedAddress(original, geocoded), null);
  });
});

// ---------------------------------------------------------------------------
// classifyOrder priority tests — address holds before recency
// ---------------------------------------------------------------------------

describe('classifyOrder priority', () => {
  // Extract classifyOrder — it's not exported, so we test via the module's behavior.
  // Instead, we replicate the key logic to verify the ordering is correct.

  // The actual code now checks holds BEFORE the recency filter.
  // We verify this by reading the source and checking the order of conditions.
  it('address_hold check comes before recently_placed check in source', () => {
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('../lib/unfulfilled.js'), 'utf8');

    const addressHoldPos = src.indexOf("holds.includes('address_hold')");
    const recentlyPlacedPos = src.indexOf("reason: 'recently_placed'");

    assert.ok(addressHoldPos > 0, 'address_hold check should exist');
    assert.ok(recentlyPlacedPos > 0, 'recently_placed check should exist');
    assert.ok(addressHoldPos < recentlyPlacedPos,
      'address_hold must be checked BEFORE recently_placed');
  });

  it('fraud_hold check comes before recently_placed check in source', () => {
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('../lib/unfulfilled.js'), 'utf8');

    const fraudHoldPos = src.indexOf("holds.includes('fraud_hold')");
    const recentlyPlacedPos = src.indexOf("reason: 'recently_placed'");

    assert.ok(fraudHoldPos > 0, 'fraud_hold check should exist');
    assert.ok(fraudHoldPos < recentlyPlacedPos,
      'fraud_hold must be checked BEFORE recently_placed');
  });
});
