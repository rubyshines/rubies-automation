/**
 * Unit tests for lib/addressUtils.js — shared address formatting helpers.
 *
 * Run: node --test customer-service/test/addressUtils.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { formatAddressBlock, formatAddressLine, toCountryCode } = require('../lib/addressUtils');

// ---------------------------------------------------------------------------
// formatAddressBlock
// ---------------------------------------------------------------------------

describe('formatAddressBlock', () => {
  it('renders a full US address across 4 lines', () => {
    const result = formatAddressBlock({
      address1: '909 N Beech Street',
      address2: 'Suite A',
      city: 'Portland',
      province: 'Oregon',
      zip: '97227',
      country: 'United States',
    });
    assert.equal(result, '909 N Beech Street\nSuite A\nPortland, Oregon 97227\nUnited States');
  });

  it('omits address2 when empty', () => {
    const result = formatAddressBlock({
      address1: '123 Main St',
      address2: '',
      city: 'Portland',
      province: 'OR',
      zip: '97227',
      country: 'USA',
    });
    assert.equal(result, '123 Main St\nPortland, OR 97227\nUSA');
  });

  it('drops province entirely when null (Denmark, Ireland, etc.)', () => {
    // Regression: the old formatter wrote "Aalborg, null 9000"
    const result = formatAddressBlock({
      address1: 'Lundsgårdsgade 16',
      address2: null,
      city: 'Aalborg',
      province: null,
      zip: '9000',
      country: 'Denmark',
    });
    assert.equal(result, 'Lundsgårdsgade 16\nAalborg 9000\nDenmark');
    assert.ok(!result.includes('null'));
  });

  it('drops zip when missing (some IE addresses)', () => {
    const result = formatAddressBlock({
      address1: '1 Dame Street',
      city: 'Dublin',
      province: null,
      zip: null,
      country: 'Ireland',
    });
    assert.equal(result, '1 Dame Street\nDublin\nIreland');
  });

  it('drops country when missing', () => {
    const result = formatAddressBlock({
      address1: '100 Queen St',
      city: 'Toronto',
      province: 'ON',
      zip: 'M5H 2N2',
      country: null,
    });
    assert.equal(result, '100 Queen St\nToronto, ON M5H 2N2');
  });

  it('renders just city when only city is present', () => {
    const result = formatAddressBlock({ city: 'Berlin' });
    assert.equal(result, 'Berlin');
  });

  it('returns fallback for null address', () => {
    assert.equal(formatAddressBlock(null), 'No address on file');
  });

  it('returns fallback for undefined address', () => {
    assert.equal(formatAddressBlock(undefined), 'No address on file');
  });

  it('returns fallback for empty object', () => {
    assert.equal(formatAddressBlock({}), 'No address on file');
  });

  it('accepts a custom fallback string', () => {
    assert.equal(formatAddressBlock(null, '—'), '—');
  });

  it('trims whitespace from inputs', () => {
    const result = formatAddressBlock({
      address1: '  123 Main St  ',
      city: ' Portland ',
      province: 'OR',
      zip: '97227',
      country: 'USA',
    });
    assert.equal(result, '123 Main St\nPortland, OR 97227\nUSA');
  });
});

// ---------------------------------------------------------------------------
// formatAddressLine
// ---------------------------------------------------------------------------

describe('formatAddressLine', () => {
  it('renders a full address on one comma-separated line', () => {
    const result = formatAddressLine({
      address1: '909 N Beech Street',
      address2: 'Suite A',
      city: 'Portland',
      province: 'OR',
      zip: '97227',
      country: 'USA',
    });
    assert.equal(result, '909 N Beech Street, Suite A, Portland OR 97227, USA');
  });

  it('drops null province', () => {
    const result = formatAddressLine({
      address1: 'Lundsgårdsgade 16',
      city: 'Aalborg',
      province: null,
      zip: '9000',
      country: 'Denmark',
    });
    assert.equal(result, 'Lundsgårdsgade 16, Aalborg 9000, Denmark');
    assert.ok(!result.includes('null'));
  });

  it('returns fallback for null address', () => {
    assert.equal(formatAddressLine(null), 'No address');
  });

  it('accepts a custom fallback', () => {
    assert.equal(formatAddressLine(undefined, 'n/a'), 'n/a');
  });
});

// ---------------------------------------------------------------------------
// toCountryCode
// ---------------------------------------------------------------------------

describe('toCountryCode', () => {
  it('maps the full canonical name to its ISO code (the bug that broke #32014)', () => {
    // Shopify rejected "United States" on the countryCode enum — must become "US".
    assert.equal(toCountryCode('United States'), 'US');
  });

  it('maps canonical names for the markets we ship to', () => {
    assert.equal(toCountryCode('Canada'), 'CA');
    assert.equal(toCountryCode('Australia'), 'AU');
    assert.equal(toCountryCode('New Zealand'), 'NZ');
    assert.equal(toCountryCode('United Kingdom'), 'GB');
    assert.equal(toCountryCode('Germany'), 'DE');
    assert.equal(toCountryCode('Ireland'), 'IE');
  });

  it('handles common non-canonical aliases', () => {
    assert.equal(toCountryCode('USA'), 'US');
    assert.equal(toCountryCode('United States of America'), 'US');
    assert.equal(toCountryCode('UK'), 'GB');
    assert.equal(toCountryCode('Great Britain'), 'GB');
    assert.equal(toCountryCode('England'), 'GB');
    assert.equal(toCountryCode('Holland'), 'NL');
  });

  it('passes a valid ISO code through, upper-cased', () => {
    assert.equal(toCountryCode('US'), 'US');
    assert.equal(toCountryCode('ca'), 'CA');
    assert.equal(toCountryCode('Au'), 'AU');
  });

  it('is case- and punctuation-insensitive on names', () => {
    assert.equal(toCountryCode('  united states '), 'US');
    assert.equal(toCountryCode('U.S.A.'), 'US');
    assert.equal(toCountryCode('the netherlands'), 'NL');
  });

  it('returns unknown values unchanged so Shopify rejects them loudly', () => {
    assert.equal(toCountryCode('Atlantis'), 'Atlantis');
  });

  it('passes null/undefined/empty through untouched', () => {
    assert.equal(toCountryCode(null), null);
    assert.equal(toCountryCode(undefined), undefined);
    assert.equal(toCountryCode(''), '');
    assert.equal(toCountryCode('   '), '');
  });
});
