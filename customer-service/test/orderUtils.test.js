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

const { getShippingMethodTitle, SHIPPING_METHOD_TITLES, applyShippingAddressOverride } = require('../lib/orderUtils');

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
});
