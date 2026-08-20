/**
 * Size eligibility inside prescribeDonationRouting — a partner that cannot
 * distribute the sizes in the box must not be routed the box.
 *
 * Queen's Yellow House prompted this: they were receiving kids sizes a
 * university student centre has no way to hand out.
 *
 * Run: node --test customer-service/test/donationRoutingSizes.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const geocoderPath = require.resolve('../lib/geocoder');
const supabasePath = require.resolve('../../shared/supabaseClient');

let geocodeResult = null;
let partnerRows = [];

require.cache[geocoderPath] = {
  id: geocoderPath,
  filename: geocoderPath,
  loaded: true,
  exports: { geocode: async () => geocodeResult },
};

function fakeQuery(rows) {
  const q = {
    select: () => q,
    eq: () => q,
    gte: () => q,
    not: () => q,
    order: () => q,
    then: (resolve, reject) => Promise.resolve({ data: rows, error: null }).then(resolve, reject),
  };
  return q;
}

require.cache[supabasePath] = {
  id: supabasePath,
  filename: supabasePath,
  loaded: true,
  exports: {
    getSupabaseClient: () => ({
      from: (table) => fakeQuery(table === 'donation_partners' ? partnerRows : []),
    }),
    fetchAllPaginated: async () => [],
  },
};

const { prescribeDonationRouting } = require('../lib/donationRouting');

// ---------------------------------------------------------------------------
// Fixtures — a local adults-only org and a distant one that takes everything,
// so the size filter has to overcome proximity to be observable.
// ---------------------------------------------------------------------------

const base = {
  mailing_address: 'RUBIES Returns\nc/o Org\n1 Main St',
  description_short: 'An org.',
};

const YELLOW_HOUSE = {
  ...base, id: 1, name: 'Yellow House', city: 'Kingston', region: 'Ontario',
  latitude: 44.2253, longitude: -76.4951,
  accepts_smaller_sizes: false, accepts_larger_sizes: true,
};
const SKIPPING_STONE = {
  ...base, id: 2, name: 'Skipping Stone', city: 'Calgary', region: 'Alberta',
  latitude: 51.0447, longitude: -114.0719,
  accepts_smaller_sizes: true, accepts_larger_sizes: true,
};
const KIDS_ONLY = {
  ...base, id: 3, name: 'Kids Closet', city: 'Kingston', region: 'Ontario',
  latitude: 44.2300, longitude: -76.4900,
  accepts_smaller_sizes: true, accepts_larger_sizes: false,
};

const KINGSTON = { lat: 44.2312, lng: -76.4860, city: 'Kingston', region: 'Ontario', country_code: 'CA' };

const INTAKE = { items: [{ product: 'Brooke', issue: 'size' }, { product: 'Ruby', issue: 'size' }] };

function contextWith(sizes, rng = () => 0) {
  return {
    customerCountry: 'CA',
    customer: { defaultAddress: { address1: '10 Elm St', city: 'Kingston', province: 'ON', zip: 'K7L', country: 'CA' } },
    targetOrder: { lineItems: [{ title: 'Brooke Bra', quantity: 1 }, { title: 'Ruby Bikini', quantity: 1 }] },
    donationSizes: sizes,
    _rng: rng,
  };
}

describe('donation routing — size eligibility', () => {
  it('skips the local partner that cannot use these sizes', async () => {
    // Yellow House is 4 km away, Skipping Stone is ~2700 km. Without the size
    // filter the local tier would win outright.
    partnerRows = [YELLOW_HOUSE, SKIPPING_STONE];
    geocodeResult = KINGSTON;

    const result = await prescribeDonationRouting(INTAKE, contextWith(['6', '8']));

    assert.equal(result.type, 'partner');
    assert.equal(result.partner.name, 'Skipping Stone');
    assert.match(result.audit, /1 partner\(s\) excluded/);
  });

  it('routes to the local partner when the sizes do fit', async () => {
    partnerRows = [YELLOW_HOUSE, SKIPPING_STONE];
    geocodeResult = KINGSTON;

    const result = await prescribeDonationRouting(INTAKE, contextWith(['L', '1X']));

    assert.equal(result.partner.name, 'Yellow House');
    assert.match(result.audit, /sizes: larger/);
  });

  it('a mixed box needs a partner that takes both categories', async () => {
    // Two local orgs, each covering half the box; only the distant one can
    // take the whole thing without splitting it.
    partnerRows = [YELLOW_HOUSE, KIDS_ONLY, SKIPPING_STONE];
    geocodeResult = KINGSTON;

    const result = await prescribeDonationRouting(INTAKE, contextWith(['8', 'L']));

    assert.equal(result.partner.name, 'Skipping Stone');
    assert.match(result.audit, /2 partner\(s\) excluded/);
  });

  it('falls back to donating locally when no partner in the country fits', async () => {
    partnerRows = [YELLOW_HOUSE];
    geocodeResult = KINGSTON;

    const result = await prescribeDonationRouting(INTAKE, contextWith(['6', '8']));

    assert.equal(result.type, 'local_no_partner');
    assert.match(result.audit, /can use these sizes/);
    assert.doesNotMatch(result.response_text, /Yellow House/);
  });

  it('routes normally when sizes are not supplied', async () => {
    // Every existing caller and the whole back-catalogue of tests omit sizes;
    // an absent list must not narrow the pool.
    partnerRows = [YELLOW_HOUSE, SKIPPING_STONE];
    geocodeResult = KINGSTON;

    const result = await prescribeDonationRouting(INTAKE, contextWith(undefined));

    assert.equal(result.partner.name, 'Yellow House');
    assert.doesNotMatch(result.audit, /sizes:/);
  });

  it('an unreadable size does not narrow the pool', async () => {
    partnerRows = [YELLOW_HOUSE, SKIPPING_STONE];
    geocodeResult = KINGSTON;

    const result = await prescribeDonationRouting(INTAKE, contextWith(['One Size', 'mystery']));

    assert.equal(result.partner.name, 'Yellow House');
    assert.doesNotMatch(result.audit, /sizes:/);
  });

  it('defect-only returns skip routing before sizes are considered', async () => {
    partnerRows = [YELLOW_HOUSE];
    geocodeResult = KINGSTON;

    const result = await prescribeDonationRouting(
      { items: [{ issue: 'defect' }] },
      contextWith(['6']),
    );

    assert.equal(result.skip, true);
  });
});
