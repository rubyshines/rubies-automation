/**
 * Unit tests for lib/orderUtils.js — shipping rate title resolver used by
 * order-creation tools (create_order, create_exchange_order,
 * create_invoice_order, create_wholesale_order).
 *
 * Run: node --test customer-service/test/orderUtils.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// Stub shippingLookup before requiring orderUtils so the lazy require inside
// getShippingMethodTitle picks up the stub instead of touching Supabase.
const shippingLookupPath = require.resolve('../lib/tools/shippingLookup');
let stubZone = null;
require.cache[shippingLookupPath] = {
  id: shippingLookupPath,
  filename: shippingLookupPath,
  loaded: true,
  exports: {
    getShippingZone: async (countryCode) => {
      if (!countryCode) return null;
      if (stubZone) return stubZone;
      const c = countryCode.toUpperCase();
      if (c === 'US') return 'us';
      if (c === 'CA') return 'canada';
      return null;
    },
  },
};

const {
  getShippingMethodTitle,
  SHIPPING_METHOD_TITLES,
  applyShippingAddressOverride,
  SHIPPING_ADDRESS_OVERRIDE_SCHEMA,
  normalizeCountryCode,
  normalizeShippingPrice,
  shippingPreviewLine,
  shippingChargeError,
} = require('../lib/orderUtils');

describe('getShippingMethodTitle', () => {
  beforeEach(() => { stubZone = null; });

  it('returns US titles for US country', async () => {
    assert.equal(await getShippingMethodTitle('US', 'standard'), 'Free US Standard Shipping');
    assert.equal(await getShippingMethodTitle('US', 'expedited'), 'US Expedited Shipping');
  });

  it('returns Canada titles for Canada country', async () => {
    assert.equal(await getShippingMethodTitle('CA', 'standard'), 'Free Canada Standard Shipping');
    assert.equal(await getShippingMethodTitle('CA', 'expedited'), 'Canada Expedited Shipping');
  });

  it('returns DDP titles when zone lookup says ddp', async () => {
    stubZone = 'ddp';
    assert.equal(await getShippingMethodTitle('AU', 'standard'),
      'Free International Shipping - All Duties and Import Fees Included');
    assert.equal(await getShippingMethodTitle('GB', 'expedited'),
      'Expedited International Shipping - All Duties and Import Fees Included');
  });

  it('returns DDU titles when zone lookup says ddu', async () => {
    stubZone = 'ddu';
    assert.equal(await getShippingMethodTitle('AR', 'standard'), 'Free Standard International Shipping');
    assert.equal(await getShippingMethodTitle('JP', 'expedited'), 'Expedited International Shipping');
  });

  it('falls back to DDU titles when zone is unknown', async () => {
    stubZone = null;
    assert.equal(await getShippingMethodTitle('XX', 'standard'), 'Free Standard International Shipping');
    assert.equal(await getShippingMethodTitle('XX', 'expedited'), 'Expedited International Shipping');
  });

  it('treats unknown speed as standard', async () => {
    assert.equal(await getShippingMethodTitle('US'), 'Free US Standard Shipping');
    assert.equal(await getShippingMethodTitle('US', 'unknown-speed'), 'Free US Standard Shipping');
  });

  it('falls back to DDU for missing country', async () => {
    assert.equal(await getShippingMethodTitle(null, 'standard'), SHIPPING_METHOD_TITLES.ddu.standard);
    assert.equal(await getShippingMethodTitle('', 'expedited'), SHIPPING_METHOD_TITLES.ddu.expedited);
  });

  // Regression for order #32333: a spelled-out country name missed the zone
  // lookup (keyed by alpha-2 code) and silently landed on the international line.
  it('normalizes full country names to ISO codes', async () => {
    assert.equal(await getShippingMethodTitle('United States', 'standard'), 'Free US Standard Shipping');
    assert.equal(await getShippingMethodTitle('UNITED STATES', 'expedited'), 'US Expedited Shipping');
    assert.equal(await getShippingMethodTitle('USA', 'standard'), 'Free US Standard Shipping');
    assert.equal(await getShippingMethodTitle('Canada', 'standard'), 'Free Canada Standard Shipping');
  });

  it('normalizes common aliases (UK → GB)', async () => {
    stubZone = 'ddp';
    assert.equal(await getShippingMethodTitle('UK', 'standard'),
      'Free International Shipping - All Duties and Import Fees Included');
    assert.equal(await getShippingMethodTitle('United Kingdom', 'standard'),
      'Free International Shipping - All Duties and Import Fees Included');
  });
});

describe('normalizeCountryCode', () => {
  it('passes through alpha-2 codes uppercased', () => {
    assert.equal(normalizeCountryCode('us'), 'US');
    assert.equal(normalizeCountryCode(' CA '), 'CA');
  });

  it('maps full English names to codes', () => {
    assert.equal(normalizeCountryCode('United States'), 'US');
    assert.equal(normalizeCountryCode('australia'), 'AU');
    assert.equal(normalizeCountryCode('New Zealand'), 'NZ');
    assert.equal(normalizeCountryCode('Germany'), 'DE');
  });

  it('maps aliases', () => {
    assert.equal(normalizeCountryCode('UK'), 'GB');
    assert.equal(normalizeCountryCode('USA'), 'US');
    assert.equal(normalizeCountryCode('Great Britain'), 'GB');
  });

  it('returns empty string for empty or unrecognizable input', () => {
    assert.equal(normalizeCountryCode(''), '');
    assert.equal(normalizeCountryCode(null), '');
    assert.equal(normalizeCountryCode(undefined), '');
    assert.equal(normalizeCountryCode('Not A Country'), '');
  });
});

describe('applyShippingAddressOverride', () => {
  const base = {
    firstName: 'Erin', lastName: 'Spencer',
    address1: '480 Parramatta Rd', address2: '',
    city: 'Petersham', province: 'NSW', country: 'AU', zip: '2049',
  };

  it('returns base unchanged when no override', () => {
    assert.deepEqual(applyShippingAddressOverride(base, undefined), base);
    assert.deepEqual(applyShippingAddressOverride(base, null), base);
  });

  it('returns null when both base and override are absent', () => {
    assert.equal(applyShippingAddressOverride(null, null), null);
    assert.equal(applyShippingAddressOverride(undefined, undefined), null);
  });

  it('full override replaces every field', () => {
    const merged = applyShippingAddressOverride(base, {
      first_name: 'Erin', last_name: 'Spencer',
      address1: '76 Parramatta Rd', address2: '',
      city: 'Stanmore', province: 'NSW', country: 'AU', zip: '2048',
    });
    assert.equal(merged.address1, '76 Parramatta Rd');
    assert.equal(merged.city, 'Stanmore');
    assert.equal(merged.zip, '2048');
  });

  it('partial override merges onto base', () => {
    const merged = applyShippingAddressOverride(base, { address1: '76 Parramatta Rd', city: 'Stanmore', zip: '2048' });
    assert.equal(merged.address1, '76 Parramatta Rd');
    assert.equal(merged.city, 'Stanmore');
    assert.equal(merged.zip, '2048');
    // Unspecified fields fall back to base
    assert.equal(merged.firstName, 'Erin');
    assert.equal(merged.country, 'AU');
    assert.equal(merged.province, 'NSW');
  });

  it('override with no base produces a fresh address from the override fields', () => {
    const merged = applyShippingAddressOverride(null, {
      first_name: 'Casey', last_name: 'Smith',
      address1: '1 New St', city: 'Toronto', province: 'ON', country: 'CA', zip: 'M5V 1A1',
    });
    assert.equal(merged.firstName, 'Casey');
    assert.equal(merged.address1, '1 New St');
    assert.equal(merged.country, 'CA');
  });

  it('snake_case override keys map to camelCase output keys', () => {
    const merged = applyShippingAddressOverride(base, { first_name: 'Pat', last_name: 'Lee' });
    assert.equal(merged.firstName, 'Pat');
    assert.equal(merged.lastName, 'Lee');
  });

  it('does not mutate the base object', () => {
    const baseCopy = { ...base };
    applyShippingAddressOverride(base, { address1: 'changed' });
    assert.deepEqual(base, baseCopy);
  });

  // address2 belongs to the street it was written for. A reship to a corrected
  // PO box once kept "Right side with deck" from the returned-to-sender house
  // address, producing an address wrong in a way nothing downstream can catch.
  describe('address2 does not survive an address1 change', () => {
    const withUnit = { ...base, address1: '480 Parramatta Rd', address2: 'Right side with deck' };

    it('clears address2 when address1 changes and none is supplied', () => {
      const merged = applyShippingAddressOverride(withUnit, {
        address1: 'PO Box 57', city: 'Tahoe City', province: 'CA', country: 'US', zip: '96145',
      });
      assert.equal(merged.address1, 'PO Box 57');
      assert.equal(merged.address2, '');
    });

    it('keeps address2 when it is explicitly re-supplied with the new street', () => {
      const merged = applyShippingAddressOverride(withUnit, { address1: '76 Parramatta Rd', address2: 'Apt 4' });
      assert.equal(merged.address2, 'Apt 4');
    });

    it('keeps address2 when address1 is not part of the override', () => {
      const merged = applyShippingAddressOverride(withUnit, { zip: '2048' });
      assert.equal(merged.address2, 'Right side with deck');
    });

    it('keeps address2 when address1 is re-sent unchanged', () => {
      const merged = applyShippingAddressOverride(withUnit, { address1: '480 Parramatta Rd', zip: '2048' });
      assert.equal(merged.address2, 'Right side with deck');
    });
  });

  // The recipient name is part of the address: a PO box the post office only
  // releases against an exact name is not deliverable under the profile name.
  it('takes the recipient name verbatim, digits and all', () => {
    const merged = applyShippingAddressOverride(base, { first_name: 'Neve', last_name: 'Graham57' });
    assert.equal(merged.firstName, 'Neve');
    assert.equal(merged.lastName, 'Graham57');
  });
});

describe('SHIPPING_ADDRESS_OVERRIDE_SCHEMA', () => {
  it('tells the agent to copy the recipient name verbatim', () => {
    // The agent dropped a customer-specified "57" from a name as a suspected
    // typo. The schema description is the only place that instruction can live.
    assert.match(SHIPPING_ADDRESS_OVERRIDE_SCHEMA.description, /verbatim|EXACTLY/i);
    assert.match(SHIPPING_ADDRESS_OVERRIDE_SCHEMA.description, /address2/);
  });

  it('exposes first_name and last_name as overridable fields', () => {
    assert.ok(SHIPPING_ADDRESS_OVERRIDE_SCHEMA.properties.first_name);
    assert.ok(SHIPPING_ADDRESS_OVERRIDE_SCHEMA.properties.last_name);
  });
});

describe('normalizeShippingPrice', () => {
  it('defaults to free when absent, null or empty', () => {
    assert.equal(normalizeShippingPrice(undefined), '0.00');
    assert.equal(normalizeShippingPrice(null), '0.00');
    assert.equal(normalizeShippingPrice(''), '0.00');
  });

  it('formats numbers and numeric strings to two decimals', () => {
    assert.equal(normalizeShippingPrice(24), '24.00');
    assert.equal(normalizeShippingPrice('24'), '24.00');
    assert.equal(normalizeShippingPrice(24.5), '24.50');
    assert.equal(normalizeShippingPrice(24.567), '24.57');
  });

  // Fails closed to free: a negative would REDUCE the order total, and junk
  // must never reach Shopify as a price. The preview shows $0.00 either way,
  // so a mistyped charge is visible before the invoice goes out.
  it('collapses negative and non-numeric input to free', () => {
    assert.equal(normalizeShippingPrice(-24), '0.00');
    assert.equal(normalizeShippingPrice('abc'), '0.00');
    assert.equal(normalizeShippingPrice(NaN), '0.00');
    assert.equal(normalizeShippingPrice(Infinity), '0.00');
    assert.equal(normalizeShippingPrice({}), '0.00');
  });
});

describe('shippingChargeError', () => {
  // Every `standard` title has "Free" baked in because that is the literal
  // Shopify rate name Warehance matches on. Charging on one would invoice
  // "Free US Standard Shipping — $24.00".
  it('rejects a charge on every standard (Free-named) rate', () => {
    for (const zone of Object.keys(SHIPPING_METHOD_TITLES)) {
      const title = SHIPPING_METHOD_TITLES[zone].standard;
      const err = shippingChargeError(title, 24);
      assert.ok(err, `expected ${zone} standard ("${title}") to reject a charge`);
      assert.match(err, /expedited/);
    }
  });

  it('allows a charge on every expedited rate', () => {
    for (const zone of Object.keys(SHIPPING_METHOD_TITLES)) {
      const title = SHIPPING_METHOD_TITLES[zone].expedited;
      assert.equal(shippingChargeError(title, 24), null,
        `expected ${zone} expedited ("${title}") to allow a charge`);
    }
  });

  it('allows $0 on any rate, including the Free-named ones', () => {
    assert.equal(shippingChargeError('Free US Standard Shipping', 0), null);
    assert.equal(shippingChargeError('Free US Standard Shipping', undefined), null);
    // A negative normalizes to free, so it must not trip the guard either.
    assert.equal(shippingChargeError('Free US Standard Shipping', -5), null);
  });
});

describe('shippingPreviewLine', () => {
  it('says RUBIES covers it when free', () => {
    assert.equal(shippingPreviewLine('US Expedited Shipping', 0),
      'US Expedited Shipping ($0.00 — covered by RUBIES)');
  });

  it('says charged to customer when priced', () => {
    assert.equal(shippingPreviewLine('US Expedited Shipping', 24),
      'US Expedited Shipping ($24.00 — charged to customer)');
  });
});
