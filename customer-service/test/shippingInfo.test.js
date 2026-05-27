/**
 * Unit tests for shippingInfo.js — shipping info, duties, address, speed handlers.
 *
 * Run: node --test customer-service/test/shippingInfo.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

// Mock Supabase before requiring shippingInfo
const supabaseModulePath = require.resolve('../../shared/supabaseClient');

const MOCK_ZONES = {
  GB: { country_code: 'GB', country_name: 'United Kingdom', zone: 'ddp', duties_prepaid: true, standard_rate: 12, expedited_rate: null, free_shipping_threshold: 0, currency: 'USD' },
  US: { country_code: 'US', country_name: 'United States', zone: 'us', duties_prepaid: false, standard_rate: 9, expedited_rate: 22, free_shipping_threshold: 99, currency: 'USD' },
  CA: { country_code: 'CA', country_name: 'Canada', zone: 'canada', duties_prepaid: false, standard_rate: 9.35, expedited_rate: null, free_shipping_threshold: 96, currency: 'USD' },
  IL: { country_code: 'IL', country_name: 'Israel', zone: 'ddu', duties_prepaid: false, standard_rate: 12, expedited_rate: null, free_shipping_threshold: 0, currency: 'USD' },
  DE: { country_code: 'DE', country_name: 'Germany', zone: 'ddp', duties_prepaid: true, standard_rate: 12, expedited_rate: null, free_shipping_threshold: 0, currency: 'USD' },
  DK: { country_code: 'DK', country_name: 'Denmark', zone: 'ddp', duties_prepaid: true, standard_rate: 12, expedited_rate: null, free_shipping_threshold: 0, currency: 'USD' },
};

require.cache[supabaseModulePath] = {
  id: supabaseModulePath,
  filename: supabaseModulePath,
  loaded: true,
  exports: {
    getSupabaseClient: () => ({
      from: (table) => ({
        select: () => ({
          eq: (col, val) => ({
            single: () => {
              if (table === 'shipping_zones') {
                return { data: MOCK_ZONES[val] || null, error: null };
              }
              return { data: null, error: null };
            },
            eq: () => ({ single: () => ({ data: null, error: null }) }),
          }),
          limit: () => ({ data: Object.values(MOCK_ZONES), error: null }),
        }),
      }),
    }),
    upsert: () => {},
  },
};

const {
  buildShippingInfoResponse,
  buildDutiesResponse,
  buildAddressChangeResponse,
  buildShippingSpeedResponse,
  detectCountry,
} = require('../lib/tools/shippingInfo');

// ---------------------------------------------------------------------------
// detectCountry
// ---------------------------------------------------------------------------

describe('detectCountry', () => {
  it('detects "Denmark" from message', async () => {
    const r = await detectCountry('Do you ship to Denmark?');
    assert.equal(r.code, 'DK');
  });

  it('detects "UK" alias', async () => {
    const r = await detectCountry('How much is shipping to the UK?');
    assert.equal(r.code, 'GB');
  });

  it('detects "Israel" from message', async () => {
    const r = await detectCountry('Do you ship to Israel?');
    assert.equal(r.code, 'IL');
  });

  it('returns null for no country', async () => {
    const r = await detectCountry('What is your return policy?');
    assert.equal(r, null);
  });

  it('detects "Germany" from message', async () => {
    const r = await detectCountry('Do you ship to Germany too?');
    assert.equal(r.code, 'DE');
  });
});

// ---------------------------------------------------------------------------
// buildShippingInfoResponse — intent detection + response
// ---------------------------------------------------------------------------

describe('buildShippingInfoResponse', () => {
  it('answers availability only when just asked "do you ship to X?"', () => {
    const zone = MOCK_ZONES.DK;
    const r = buildShippingInfoResponse(zone, { code: 'DK', name: 'Denmark' }, { customerMessage: 'Do you ship to Denmark?' });
    assert.ok(r.text.includes('yes we ship to Denmark'));
    assert.ok(r.text.includes('$12 USD')); // cost included for availability
    assert.ok(!r.text.includes('business days')); // time NOT included
    assert.ok(r.text.includes('taxes and duties')); // DDP info included
  });

  it('includes delivery time when asked', () => {
    const zone = MOCK_ZONES.GB;
    const r = buildShippingInfoResponse(zone, { code: 'GB', name: 'United Kingdom' }, { customerMessage: 'How long does delivery to UK take?' });
    assert.ok(r.text.includes('business days'));
  });

  it('includes cost when asked', () => {
    const zone = MOCK_ZONES.US;
    const r = buildShippingInfoResponse(zone, { code: 'US', name: 'United States' }, { customerMessage: 'How much is shipping?' });
    assert.ok(r.text.includes('$9 USD'));
    assert.ok(r.text.includes('free on orders over $99'));
  });

  it('shows DDU duties warning for Israel', () => {
    const zone = MOCK_ZONES.IL;
    const r = buildShippingInfoResponse(zone, { code: 'IL', name: 'Israel' }, { customerMessage: 'Do you ship to Israel? Are there customs?' });
    assert.ok(r.text.includes('customs duties'));
    assert.ok(r.text.includes('local customs authority'));
    assert.ok(!r.text.includes('reimburse')); // DDU — no reimbursement promise
  });

  it('shows DDP no-fees message for Germany', () => {
    const zone = MOCK_ZONES.DE;
    const r = buildShippingInfoResponse(zone, { code: 'DE', name: 'Germany' }, { customerMessage: 'Do you ship to Germany?' });
    assert.ok(r.text.includes('no additional fees'));
  });

  it('says "ship from Portland" for US customers', () => {
    const zone = MOCK_ZONES.US;
    const r = buildShippingInfoResponse(zone, { code: 'US', name: 'United States' }, { customerMessage: 'Do you ship to the US?' });
    assert.ok(r.text.includes('Portland'));
  });

  it('handles expedited question — US', () => {
    const zone = MOCK_ZONES.US;
    const r = buildShippingInfoResponse(zone, { code: 'US', name: 'United States' }, { customerMessage: 'Do you offer expedited shipping?' });
    assert.ok(r.text.includes('expedited'));
    assert.ok(r.text.includes('$22'));
  });

  it('handles expedited question — no country', () => {
    const r = buildShippingInfoResponse(null, null, { customerMessage: 'Can I get express shipping?' });
    assert.ok(r.text.includes('expedited shipping within the US'));
    assert.ok(r.needsHumanFollowUp);
  });

  it('handles overnight — escalates', () => {
    const zone = MOCK_ZONES.US;
    const r = buildShippingInfoResponse(zone, { code: 'US', name: 'United States' }, { customerMessage: 'Do you offer overnight shipping?' });
    assert.ok(r.text.includes('overnight'));
    assert.ok(r.needsHumanFollowUp);
  });
});

// ---------------------------------------------------------------------------
// buildDutiesResponse
// ---------------------------------------------------------------------------

describe('buildDutiesResponse', () => {
  it('DDP country — offers reimbursement', () => {
    const r = buildDutiesResponse(MOCK_ZONES.GB, { customerName: 'Jo' });
    assert.ok(r.text.includes('reimburse'));
    assert.ok(r.text.includes('send us the receipt'));
    assert.ok(!r.needsHumanFollowUp);
  });

  it('DDU country — cannot cover', () => {
    const r = buildDutiesResponse(MOCK_ZONES.IL, { customerName: null });
    assert.ok(r.text.includes('unable to cover'));
    assert.ok(r.text.includes('local customs authority'));
    assert.ok(!r.needsHumanFollowUp);
  });

  it('no zone — defaults to cannot cover', () => {
    const r = buildDutiesResponse(null, {});
    assert.ok(r.text.includes('unable to cover'));
  });
});

// ---------------------------------------------------------------------------
// buildAddressChangeResponse
// ---------------------------------------------------------------------------

describe('buildAddressChangeResponse', () => {
  const fulfilledOrder = { name: '#29100', displayFulfillmentStatus: 'FULFILLED', fulfillments: [{}] };
  const unfulfilledOrder = { name: '#29600', displayFulfillmentStatus: 'UNFULFILLED' };

  it('fulfilled — can\'t change, asks about access', () => {
    const r = buildAddressChangeResponse(fulfilledOrder, { customerMessage: 'It shipped to my old address', customerName: 'Mel' });
    assert.ok(r.text.includes('can\'t change'));
    assert.ok(r.text.includes('access to that address'));
    assert.equal(r.action, 'ask_human');
  });

  it('fulfilled — offers replacement when no old address mention', () => {
    const r = buildAddressChangeResponse(fulfilledOrder, { customerMessage: 'Wrong address on my order', customerName: null });
    assert.ok(r.text.includes('send out another package'));
  });

  it('unfulfilled + in_progress — tries but may be too late', () => {
    const r = buildAddressChangeResponse(unfulfilledOrder, { customerMessage: 'Wrong address', warehouseStatus: 'in_progress' });
    assert.ok(r.text.includes('already being prepared'));
    assert.ok(r.text.includes('may be too late'));
    assert.equal(r.action, 'ask_human');
  });

  it('unfulfilled + address provided — will update', () => {
    const r = buildAddressChangeResponse(unfulfilledOrder, { customerMessage: 'Please change to 4213 Mulberry Drive, Carrollton, TX 75007', warehouseStatus: 'unfulfilled' });
    assert.ok(r.text.includes('update the address'));
    assert.equal(r.action, 'update_pending');
  });

  it('unfulfilled + no address — places hold', () => {
    const r = buildAddressChangeResponse(unfulfilledOrder, { customerMessage: 'I need to change my address', warehouseStatus: 'unfulfilled' });
    assert.ok(r.text.includes('hold on your order'));
    assert.ok(r.text.includes('correct address'));
    assert.equal(r.action, 'hold_placed');
  });

  it('no order — asks for order number', () => {
    const r = buildAddressChangeResponse(null, { customerMessage: 'Wrong address' });
    assert.ok(r.text.includes('order number'));
    assert.equal(r.action, 'need_order_number');
  });
});

// ---------------------------------------------------------------------------
// buildShippingSpeedResponse
// ---------------------------------------------------------------------------

describe('buildShippingSpeedResponse', () => {
  const fulfilledOrder = { name: '#29100', displayFulfillmentStatus: 'FULFILLED', fulfillments: [{}] };
  const unfulfilledOrder = { name: '#29600', displayFulfillmentStatus: 'UNFULFILLED' };

  it('downgrade — updates + refunds', () => {
    const r = buildShippingSpeedResponse(unfulfilledOrder, { customerMessage: 'Can I change from expedited to normal shipping?' });
    assert.ok(r.text.includes('update the shipping speed'));
    assert.ok(r.text.includes('refund'));
    assert.ok(r.needsHumanFollowUp);
  });

  it('upgrade — confirms upgrade', () => {
    const r = buildShippingSpeedResponse(unfulfilledOrder, { customerMessage: 'Can I upgrade to expedited?' });
    assert.ok(r.text.includes('upgrade'));
    assert.ok(r.text.includes('expedited'));
    assert.ok(r.needsHumanFollowUp);
  });

  it('fulfilled — can\'t change', () => {
    const r = buildShippingSpeedResponse(fulfilledOrder, { customerMessage: 'Can I get faster shipping?' });
    assert.ok(r.text.includes('already shipped'));
    assert.ok(!r.needsHumanFollowUp);
  });

  it('no order — asks for order number', () => {
    const r = buildShippingSpeedResponse(null, { customerMessage: 'Can I get expedited?' });
    assert.ok(r.text.includes('order number'));
    assert.ok(r.needsHumanFollowUp);
  });
});

// ---------------------------------------------------------------------------
// lookupShippingZone — raw authoritative facts for the advisor's shipping_info tool
// ---------------------------------------------------------------------------

const { lookupShippingZone } = require('../lib/tools/shippingInfo');

describe('lookupShippingZone', () => {
  it('resolves a 2-letter code and returns DDP facts (GB)', async () => {
    const r = await lookupShippingZone('GB');
    assert.equal(r.ships_to, true);
    assert.equal(r.covers_duties, true);
    assert.equal(r.zone, 'ddp');
    assert.equal(r.currency, 'USD');
  });

  it('returns the US free-shipping threshold and no DDP', async () => {
    const r = await lookupShippingZone('US');
    assert.equal(r.ships_to, true);
    assert.equal(r.free_shipping_threshold, 99);
    assert.equal(r.covers_duties, false);
  });

  it('resolves a full country name via detectCountry (Canada)', async () => {
    const r = await lookupShippingZone('Canada');
    assert.equal(r.ships_to, true);
    assert.equal(r.country_code, 'CA');
    assert.equal(r.free_shipping_threshold, 96);
  });

  it('resolves an alias (UK → GB)', async () => {
    const r = await lookupShippingZone('UK');
    assert.equal(r.country_code, 'GB');
  });

  it('returns ships_to=false for an unmatched country (no guessing)', async () => {
    const r = await lookupShippingZone('Narnia');
    assert.equal(r.ships_to, false);
    assert.ok(r.note && /confirm/i.test(r.note));
  });

  it('returns ships_to=false for an unknown 2-letter code', async () => {
    const r = await lookupShippingZone('ZZ');
    assert.equal(r.ships_to, false);
  });

  it('handles empty input', async () => {
    const r = await lookupShippingZone('');
    assert.equal(r.ships_to, false);
  });
});
