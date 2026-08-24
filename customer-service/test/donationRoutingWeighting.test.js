/**
 * Unit tests for how a partner is picked INSIDE whichever tier fired —
 * exposure-adjusted load, and the distance weighting in the two tiers that can
 * span real distance.
 *
 * Run: node --test customer-service/test/donationRoutingWeighting.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// Stub the geocoder and Supabase BEFORE requiring donationRouting
// ---------------------------------------------------------------------------

const geocoderPath = require.resolve('../lib/geocoder');
const supabasePath = require.resolve('../../shared/supabaseClient');

let geocodeResult = null;
let partnerRows = [];
let routingRows = [];

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
      from: (table) => fakeQuery(table === 'donation_partners' ? partnerRows : routingRows),
    }),
    fetchAllPaginated: async () => routingRows,
  },
};

const {
  prescribeDonationRouting,
  exposureAdjustedLoad,
  partnerExposureDays,
  proximityBoost,
  LOAD_WINDOW_DAYS,
  MIN_EXPOSURE_DAYS,
} = require('../lib/donationRouting');

// ---------------------------------------------------------------------------
// Fixtures — real coordinates from the live registry
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = n => new Date(Date.now() - n * DAY).toISOString();

const partner = (over) => ({
  mailing_address: `RUBIES Returns\nc/o ${over.name}\n1 Main St`,
  description_short: 'A partner org.',
  created_at: daysAgo(400),
  ...over,
});

const BAGLY = partner({ id: 1, name: 'BAGLY', city: 'Boston', region: 'Massachusetts', latitude: 42.3618, longitude: -71.0600 });
const OUT_METROWEST = partner({ id: 2, name: 'OUT MetroWest', city: 'Framingham', region: 'Massachusetts', latitude: 42.2742, longitude: -71.4177 });
const HUDSON = partner({ id: 3, name: 'Trans Closet of the Hudson Valley', city: 'Poughkeepsie', region: 'New York', latitude: 41.696134, longitude: -73.90302 });
const RISE_LA = partner({ id: 4, name: 'RISE @ LA LGBT Center', city: 'Los Angeles', region: 'California', latitude: 34.0923, longitude: -118.3375 });
const EUREKA_CA = partner({ id: 5, name: 'Eureka Pride', city: 'Eureka', region: 'California', latitude: 40.8021, longitude: -124.1637 });

// Surry, Maine — order #32857, the box that went to Poughkeepsie with two
// Boston partners several hundred kilometres closer.
const SURRY_ME = { lat: 44.5148, lng: -68.4967, city: 'Surry', region: 'Maine', country_code: 'US' };
const BOSTON = { lat: 42.3601, lng: -71.0589, city: 'Boston', region: 'Massachusetts', country_code: 'US' };
const SACRAMENTO = { lat: 38.5816, lng: -121.4944, city: 'Sacramento', region: 'California', country_code: 'US' };

const INTAKE = { items: [{ product: 'Brooke', issue: 'size' }, { product: 'Ruby', issue: 'size' }] };

function contextFor(rng) {
  return {
    customerCountry: 'US',
    customer: { defaultAddress: { address1: '10 Elm St', city: 'Anytown', province: 'ST', zip: '00000', country: 'US' } },
    targetOrder: { lineItems: [{ title: 'Brooke Bra', quantity: 1 }, { title: 'Ruby Bikini', quantity: 1 }] },
    _rng: rng,
  };
}

/**
 * Exact share of the weight range each partner holds, by sweeping the rng
 * uniformly rather than sampling randomly — the assertions below are about
 * proportions, and a flaky distribution test is worse than none.
 */
async function shares(samples = 400) {
  const counts = new Map();
  for (let i = 0; i < samples; i++) {
    const result = await prescribeDonationRouting(INTAKE, contextFor(() => i / samples));
    counts.set(result.partner.name, (counts.get(result.partner.name) || 0) + 1);
  }
  const out = {};
  for (const [name, n] of counts) out[name] = n / samples;
  return out;
}

// ---------------------------------------------------------------------------

describe('exposureAdjustedLoad', () => {
  it('leaves a partner older than the window untouched', () => {
    assert.equal(exposureAdjustedLoad(29, daysAgo(400)), 29);
    assert.equal(exposureAdjustedLoad(29, daysAgo(LOAD_WINDOW_DAYS + 1)), 29);
  });

  it('projects a young partner\'s volume up to a full-window equivalent', () => {
    // 6 items over 30 days is the same rate as 18 over 90.
    assert.equal(Math.round(exposureAdjustedLoad(6, daysAgo(30))), 18);
  });

  it('floors the measurement window so one box cannot shut a new partner off', () => {
    // 4 items at 5 days old is measured over 14 days, not 5: 26, not 72.
    const adjusted = exposureAdjustedLoad(4, daysAgo(5));
    assert.equal(Math.round(adjusted), Math.round(4 * LOAD_WINDOW_DAYS / MIN_EXPOSURE_DAYS));
    assert.ok(adjusted < 30, `expected a survivable load, got ${adjusted}`);
  });

  it('treats a partner with no volume as unloaded however new it is', () => {
    assert.equal(exposureAdjustedLoad(0, daysAgo(1)), 0);
  });

  it('does not adjust a row whose age is unknown or unparseable', () => {
    assert.equal(exposureAdjustedLoad(12, null), 12);
    assert.equal(exposureAdjustedLoad(12, 'not a date'), 12);
    assert.equal(partnerExposureDays(null), LOAD_WINDOW_DAYS);
  });

  it('clamps a future-dated row to the floor rather than going negative', () => {
    assert.equal(partnerExposureDays(daysAgo(-10)), MIN_EXPOSURE_DAYS);
  });
});

describe('proximityBoost', () => {
  it('gives the nearest candidate full weight', () => {
    assert.equal(proximityBoost(300, 300), 1);
  });

  it('falls off with the square of the extra distance', () => {
    assert.equal(proximityBoost(600, 300), 0.25);
    assert.ok(Math.abs(proximityBoost(900, 300) - 1 / 9) < 1e-9);
  });

  it('survives a customer geocoding onto the partner\'s own coordinates', () => {
    assert.equal(proximityBoost(0, 0), 1);
    assert.ok(Number.isFinite(proximityBoost(0, 300)));
  });
});

describe('donation routing — distance weighting in the national tier', () => {
  it('does not send a Maine box past two closer partners to the quietest one', async () => {
    geocodeResult = SURRY_ME;
    // The live shape on 2026-08-23: Hudson Valley five days old with 4 items,
    // both Boston partners established and busy. Load alone made the farthest
    // of the three win 73% of the time.
    partnerRows = [
      { ...BAGLY, region: 'Massachusetts' },
      OUT_METROWEST,
      { ...HUDSON, created_at: daysAgo(5) },
    ];
    routingRows = [
      { partner_id: BAGLY.id, items_count: 29 },
      { partner_id: OUT_METROWEST.id, items_count: 21 },
      { partner_id: HUDSON.id, items_count: 4 },
    ];

    const share = await shares();

    assert.ok(
      share['Trans Closet of the Hudson Valley'] < 0.25,
      `farthest partner should be a minority pick, got ${share['Trans Closet of the Hudson Valley']}`,
    );
    assert.ok(
      share.BAGLY + share['OUT MetroWest'] > 0.7,
      'the two nearer partners should hold most of the range',
    );
  });

  it('still shares between three partners at comparable distance', async () => {
    // A Chicago-shaped case: every partner is roughly 1,000 km away, so
    // distance barely discriminates and load balancing does the work.
    geocodeResult = { lat: 41.8781, lng: -87.6298, city: 'Chicago', region: 'Illinois', country_code: 'US' };
    partnerRows = [
      partner({ id: 10, name: 'Raleigh', city: 'Raleigh', region: 'North Carolina', latitude: 35.7742, longitude: -78.6372 }),
      partner({ id: 11, name: 'Montgomery', city: 'Montgomery', region: 'Alabama', latitude: 32.380348, longitude: -86.3000725 }),
      { ...HUDSON, created_at: daysAgo(400) },
    ];
    routingRows = [
      { partner_id: 10, items_count: 24 },
      { partner_id: 11, items_count: 29 },
      { partner_id: HUDSON.id, items_count: 20 },
    ];

    const share = await shares();

    assert.equal(Object.keys(share).length, 3, 'all three should stay in play');
    for (const [name, s] of Object.entries(share)) {
      assert.ok(s > 0.15, `${name} should keep a real share, got ${s}`);
    }
  });

  it('weights distance inside a state that spans a thousand kilometres', async () => {
    geocodeResult = SACRAMENTO;
    // Both are in California and the nearest partner overall is in-state, so
    // tier 2 fires. Eureka is ~440 km from Sacramento, LA ~580 km — close
    // enough that load still matters, but the nearer one should lead.
    partnerRows = [RISE_LA, EUREKA_CA];
    routingRows = [
      { partner_id: RISE_LA.id, items_count: 10 },
      { partner_id: EUREKA_CA.id, items_count: 10 },
    ];

    const share = await shares();

    assert.ok(share['Eureka Pride'] > share['RISE @ LA LGBT Center'], 'the nearer in-state partner should lead on equal load');
    assert.ok(share['RISE @ LA LGBT Center'] > 0.2, 'the farther one should still take a real share on equal load');
  });

  it('leaves the local tier sharing a metro on load alone', async () => {
    geocodeResult = BOSTON;
    // Boston (0 km) and Framingham (~30 km) are both local. Distance must NOT
    // enter here, or the in-city partner would swallow the whole metro.
    partnerRows = [BAGLY, OUT_METROWEST];
    routingRows = [
      { partner_id: BAGLY.id, items_count: 10 },
      { partner_id: OUT_METROWEST.id, items_count: 10 },
    ];

    const share = await shares();

    assert.ok(Math.abs(share.BAGLY - share['OUT MetroWest']) < 0.05, 'equal load in one metro should split evenly');
  });
});

describe('donation routing — a new partner ramps in and then settles', () => {
  const newcomer = () => ({ ...OUT_METROWEST, id: 9, name: 'Brand New Closet', created_at: daysAgo(3) });

  it('gives a brand-new partner the next box', async () => {
    geocodeResult = BOSTON;
    partnerRows = [BAGLY, newcomer()];
    routingRows = [{ partner_id: BAGLY.id, items_count: 29 }];

    const share = await shares();
    assert.ok(share['Brand New Closet'] > 0.8, `a partner with nothing yet should lead, got ${share['Brand New Closet']}`);
  });

  it('pulls it back into the normal band after a single box', async () => {
    geocodeResult = BOSTON;
    partnerRows = [BAGLY, newcomer()];
    routingRows = [
      { partner_id: BAGLY.id, items_count: 29 },
      { partner_id: 9, items_count: 3 },
    ];

    const share = await shares();
    // Under raw 90-day counts, 3 items against 29 would still hold ~88% of the
    // range for weeks. Measured as a rate, one box is enough to settle it.
    assert.ok(
      share['Brand New Closet'] < 0.7,
      `one box should end the runaway, got ${share['Brand New Closet']}`,
    );
    assert.ok(share['Brand New Closet'] > 0.4, 'but it should still be favoured over a busy established partner');
  });

  it('records the adjustment in the audit line', async () => {
    geocodeResult = BOSTON;
    partnerRows = [newcomer()];
    routingRows = [{ partner_id: 9, items_count: 3 }];

    const result = await prescribeDonationRouting(INTAKE, contextFor(() => 0.5));
    assert.match(result.audit, /3 items routed in last 90d \(weighed as 19 over 14d active\)/);
  });
});
