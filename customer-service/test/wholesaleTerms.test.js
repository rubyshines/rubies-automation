const test = require('node:test');
const assert = require('node:assert');

const { resolveWholesaleTerms, incotermsLabel } = require('../lib/wholesaleTerms');
const { pickTitleZone, incotermsForTitle, getShippingMethodTitle } = require('../lib/orderUtils');

// ---------------------------------------------------------------------------
// resolveWholesaleTerms — precedence: param > partner > default
// ---------------------------------------------------------------------------

test('defaults with no partner: 50% US/AU, 30% elsewhere, zone incoterms, local currency', () => {
  const us = resolveWholesaleTerms({ countryCode: 'US' });
  assert.strictEqual(us.discountPercent, 50);
  assert.strictEqual(us.discountSource, 'default');
  const au = resolveWholesaleTerms({ countryCode: 'AU' });
  assert.strictEqual(au.discountPercent, 50);
  const dk = resolveWholesaleTerms({ countryCode: 'DK' });
  assert.strictEqual(dk.discountPercent, 30);
  assert.strictEqual(dk.incoterms, null); // null = zone decides
  assert.strictEqual(dk.currency, null);  // null = customer's local currency
});

test('stored partner terms beat defaults (the Transting shape: DK at 50% + DDU)', () => {
  const r = resolveWholesaleTerms({
    countryCode: 'DK',
    partner: { name: 'Transting', wholesale_discount_percent: 50, wholesale_incoterms: 'ddu', wholesale_currency: null },
  });
  assert.strictEqual(r.discountPercent, 50);
  assert.strictEqual(r.discountSource, 'partner');
  assert.strictEqual(r.incoterms, 'ddu');
  assert.strictEqual(r.incotermsSource, 'partner');
  assert.strictEqual(r.currency, null);
  assert.strictEqual(r.partnerName, 'Transting');
});

test('explicit params beat stored partner terms', () => {
  const r = resolveWholesaleTerms({
    countryCode: 'DK',
    params: { discount_percent: 40, incoterms: 'ddp' },
    partner: { name: 'Transting', wholesale_discount_percent: 50, wholesale_incoterms: 'ddu' },
  });
  assert.strictEqual(r.discountPercent, 40);
  assert.strictEqual(r.discountSource, 'param');
  assert.strictEqual(r.incoterms, 'ddp');
  assert.strictEqual(r.incotermsSource, 'param');
});

test('partner row with all-NULL terms behaves exactly like no partner', () => {
  const r = resolveWholesaleTerms({
    countryCode: 'DE',
    partner: { name: 'Somewhere', wholesale_discount_percent: null, wholesale_incoterms: null, wholesale_currency: null },
  });
  assert.strictEqual(r.discountPercent, 30);
  assert.strictEqual(r.discountSource, 'default');
  assert.strictEqual(r.incoterms, null);
  assert.strictEqual(r.currency, null);
});

test('stored currency is applied (the Sock Drawer Heroes shape: AU in USD)', () => {
  const r = resolveWholesaleTerms({
    countryCode: 'AU',
    partner: { name: 'Sock Drawer Heroes', wholesale_currency: 'USD' },
  });
  assert.strictEqual(r.currency, 'USD');
  assert.strictEqual(r.currencySource, 'partner');
  assert.strictEqual(r.discountPercent, 50); // AU default untouched
});

test('numeric string discount from Postgres numeric column is coerced', () => {
  const r = resolveWholesaleTerms({
    countryCode: 'DK',
    partner: { name: 'Transting', wholesale_discount_percent: '50' },
  });
  assert.strictEqual(r.discountPercent, 50);
  assert.strictEqual(typeof r.discountPercent, 'number');
});

test('invalid stored incoterms value is ignored, not applied', () => {
  const r = resolveWholesaleTerms({
    countryCode: 'DK',
    partner: { name: 'X', wholesale_incoterms: 'exw' },
  });
  assert.strictEqual(r.incoterms, null);
});

// ---------------------------------------------------------------------------
// pickTitleZone — incoterms override → which title map to use
// ---------------------------------------------------------------------------

test('pickTitleZone: no override keeps the zone', () => {
  for (const z of ['us', 'canada', 'ddp', 'ddu']) {
    assert.strictEqual(pickTitleZone(z, null), z);
  }
});

test('pickTitleZone: ddu override wins for any non-US zone; US is untouched', () => {
  assert.strictEqual(pickTitleZone('ddp', 'ddu'), 'ddu');
  assert.strictEqual(pickTitleZone('canada', 'ddu'), 'ddu');
  assert.strictEqual(pickTitleZone('ddu', 'ddu'), 'ddu');
  assert.strictEqual(pickTitleZone('us', 'ddu'), 'us');
});

test('pickTitleZone: ddp override maps ddu zone to ddp, keeps Canada titles', () => {
  assert.strictEqual(pickTitleZone('ddu', 'ddp'), 'ddp');
  assert.strictEqual(pickTitleZone('canada', 'ddp'), 'canada'); // Canada titles already route FedEx DDP
  assert.strictEqual(pickTitleZone('ddp', 'ddp'), 'ddp');
  assert.strictEqual(pickTitleZone('us', 'ddp'), 'us');
});

// ---------------------------------------------------------------------------
// incotermsForTitle — the preview reads terms off the actual title
// ---------------------------------------------------------------------------

test('incotermsForTitle maps every known title correctly', () => {
  assert.strictEqual(incotermsForTitle('Free US Standard Shipping'), null);
  assert.strictEqual(incotermsForTitle('US Expedited Shipping'), null);
  assert.strictEqual(incotermsForTitle('Free Canada Standard Shipping'), 'ddp');
  assert.strictEqual(incotermsForTitle('Canada Expedited Shipping'), 'ddp');
  assert.strictEqual(incotermsForTitle('Free International Shipping - All Duties and Import Fees Included'), 'ddp');
  assert.strictEqual(incotermsForTitle('Expedited International Shipping - All Duties and Import Fees Included'), 'ddp');
  assert.strictEqual(incotermsForTitle('Free Standard International Shipping'), 'ddu');
  assert.strictEqual(incotermsForTitle('Expedited International Shipping'), 'ddu');
  assert.strictEqual(incotermsForTitle('Some Unknown Title'), null);
});

test('incotermsLabel says who pays', () => {
  assert.match(incotermsLabel('ddu'), /partner pays/i);
  assert.match(incotermsLabel('ddp'), /RUBIES pays/i);
});

// ---------------------------------------------------------------------------
// getShippingMethodTitle end-to-end with a stubbed zone lookup
// ---------------------------------------------------------------------------

test('getShippingMethodTitle honors incoterms override for a DDP-zone country', async () => {
  // Stub the lazy-required shippingLookup so no Supabase call happens.
  const lookupPath = require.resolve('../lib/tools/shippingLookup');
  const prev = require.cache[lookupPath];
  require.cache[lookupPath] = {
    id: lookupPath, filename: lookupPath, loaded: true,
    exports: { getShippingZone: async (c) => (c === 'DK' ? 'ddp' : 'ddu') },
  };
  try {
    // DK default: DDP title. With ddu terms: plain international title —
    // the exact string Warehance's rule matches to set FedEx + DDU.
    assert.strictEqual(
      await getShippingMethodTitle('DK', 'expedited'),
      'Expedited International Shipping - All Duties and Import Fees Included'
    );
    assert.strictEqual(
      await getShippingMethodTitle('DK', 'expedited', 'ddu'),
      'Expedited International Shipping'
    );
    assert.strictEqual(
      await getShippingMethodTitle('DK', 'standard', 'ddu'),
      'Free Standard International Shipping'
    );
  } finally {
    if (prev) require.cache[lookupPath] = prev; else delete require.cache[lookupPath];
  }
});
