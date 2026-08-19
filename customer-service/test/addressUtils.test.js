/**
 * Unit tests for lib/addressUtils.js — shared address formatting helpers.
 *
 * Run: node --test customer-service/test/addressUtils.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { formatAddressBlock, formatAddressLine, formatRecipientName, toCountryCode } = require('../lib/addressUtils');

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

  // The ship-to block in a draft-order preview is the only place an operator can
  // check the name that will be printed on the label before confirming.
  describe('recipient name', () => {
    it('leads the block when the address carries a camelCase Shopify name', () => {
      const result = formatAddressBlock({
        firstName: 'Neve', lastName: 'Graham57',
        address1: 'PO Box 57', city: 'Tahoe City', province: 'CA', zip: '96145', country: 'United States',
      });
      assert.equal(result, 'Neve Graham57\nPO Box 57\nTahoe City, CA 96145\nUnited States');
    });

    it('accepts the snake_case shape used by tool parameters', () => {
      const result = formatAddressBlock({ first_name: 'Casey', last_name: 'Smith', address1: '1 New St', city: 'Toronto' });
      assert.equal(result, 'Casey Smith\n1 New St\nToronto');
    });

    it('renders a first name alone without a stray separator', () => {
      const result = formatAddressBlock({ firstName: 'Neve', address1: 'PO Box 57', city: 'Tahoe City' });
      assert.equal(result, 'Neve\nPO Box 57\nTahoe City');
    });

    it('omits the name line entirely when the address has no name', () => {
      const result = formatAddressBlock({ address1: '1 New St', city: 'Toronto' });
      assert.equal(result, '1 New St\nToronto');
    });

    it('returns the fallback when a name is the only field', () => {
      // A name with no address behind it is not a shippable address — a bare
      // "Neve" must not read as somewhere we can send a parcel.
      assert.equal(formatAddressBlock({ firstName: 'Neve' }, '—'), '—');
    });
  });
});

// ---------------------------------------------------------------------------
// formatRecipientName
// ---------------------------------------------------------------------------

describe('formatRecipientName', () => {
  it('joins camelCase first and last name', () => {
    assert.equal(formatRecipientName({ firstName: 'Neve', lastName: 'Graham57' }), 'Neve Graham57');
  });

  it('joins snake_case first and last name', () => {
    assert.equal(formatRecipientName({ first_name: 'Casey', last_name: 'Smith' }), 'Casey Smith');
  });

  it('falls back to a pre-joined name field', () => {
    assert.equal(formatRecipientName({ name: 'Neve Graham57' }), 'Neve Graham57');
  });

  it('returns empty string for a nameless or absent address', () => {
    assert.equal(formatRecipientName({ address1: '1 New St' }), '');
    assert.equal(formatRecipientName(null), '');
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
