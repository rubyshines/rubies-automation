/**
 * Unit tests for the tiered geographic selection in lib/donationRouting.js —
 * local (same city/metro) → in-state → closest 3 nationally.
 *
 * Run: node --test customer-service/test/donationRoutingTiers.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// Stub the geocoder and Supabase BEFORE requiring donationRouting
// ---------------------------------------------------------------------------

const geocoderPath = require.resolve('../lib/geocoder');
const supabasePath = require.resolve('../../shared/supabaseClient');

// Mutable per-test: what the customer's address geocodes to, and what the
// donation_partners query returns.
let geocodeResult = null;
let geocodeThrows = false;
let partnerRows = [];
let routingRows = [];

require.cache[geocoderPath] = {
  id: geocoderPath,
  filename: geocoderPath,
  loaded: true,
  exports: {
    geocode: async () => {
      if (geocodeThrows) throw new Error('GOOGLE_MAPS_API_KEY is not set');
      return geocodeResult;
    },
  },
};

// Minimal thenable query builder — every chained call returns itself and
// awaiting it yields the fixture rows.
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

const { prescribeDonationRouting } = require('../lib/donationRouting');

// ---------------------------------------------------------------------------
// Fixtures — real partner coordinates from the live registry
// ---------------------------------------------------------------------------

const BAGLY = { id: 1, name: 'BAGLY', city: 'Boston', region: 'Massachusetts', latitude: 42.3618, longitude: -71.0600, mailing_address: 'RUBIES Returns\nc/o BAGLY\n1 Main St\nBoston, MA', description_short: 'Boston youth org.' };
const MTPC = { id: 2, name: 'MTPC', city: 'Boston', region: 'Massachusetts', latitude: 42.3555, longitude: -71.0630, mailing_address: 'RUBIES Returns\nc/o MTPC\n2 Main St\nBoston, MA', description_short: 'Boston coalition.' };
const OUT_METROWEST = { id: 3, name: 'OUT MetroWest', city: 'Framingham', region: 'Massachusetts', latitude: 42.2742, longitude: -71.4177, mailing_address: 'RUBIES Returns\nc/o OUT MetroWest\n3 Main St\nFramingham, MA', description_short: 'MetroWest youth org.' };
const RALEIGH = { id: 4, name: 'LGBT Center of Raleigh', city: 'Raleigh', region: 'North Carolina', latitude: 35.7742, longitude: -78.6372, mailing_address: 'RUBIES Returns\nc/o Raleigh\n4 Main St\nRaleigh, NC', description_short: 'Raleigh center.' };
const RISE_LA = { id: 5, name: 'RISE @ LA LGBT Center', city: 'Los Angeles', region: 'California', latitude: 34.0923, longitude: -118.3375, mailing_address: 'RUBIES Returns\nc/o RISE\n5 Main St\nLos Angeles, CA', description_short: 'LA center.' };
const TUCSON = { id: 6, name: 'Valid USA', city: 'Tucson', region: 'Arizona', latitude: 32.2226, longitude: -110.9747, mailing_address: 'RUBIES Returns\nc/o Valid USA\n6 Main St\nTucson, AZ', description_short: 'Tucson org.' };
const MCMINNVILLE = { id: 7, name: 'McMinnville Trans Network', city: 'McMinnville', region: 'Oregon', latitude: 45.2100, longitude: -123.1926, mailing_address: 'RUBIES Returns\nc/o MTN\n7 Main St\nMcMinnville, OR', description_short: 'Oregon network.' };

const BOSTON = { lat: 42.3601, lng: -71.0589, city: 'Boston', region: 'Massachusetts', country_code: 'US' };
const SACRAMENTO = { lat: 38.5816, lng: -121.4944, city: 'Sacramento', region: 'California', country_code: 'US' };
const EUREKA = { lat: 40.8021, lng: -124.1637, city: 'Eureka', region: 'California', country_code: 'US' };

// Two returned items, so routing goes to a partner rather than the
// single-item donate-locally path.
const INTAKE = { items: [{ product: 'Brooke', issue: 'size' }, { product: 'Ruby', issue: 'size' }] };

function contextFor(rng) {
  return {
    customerCountry: 'US',
    customer: { defaultAddress: { address1: '10 Elm St', city: 'Anytown', province: 'ST', zip: '00000', country: 'US' } },
    targetOrder: { lineItems: [{ title: 'Brooke Bra', quantity: 1 }, { title: 'Ruby Bikini', quantity: 1 }] },
    _rng: rng,
  };
}

// pickWeightedByLoad walks candidates in pool order subtracting weights, so
// rng ~0 lands on the first candidate and rng ~1 on the last. Sweeping both
// ends shows which partners the tier's pool actually contains.
async function partnersReachable(rngValues) {
  const names = new Set();
  const tiers = new Set();
  for (const v of rngValues) {
    const result = await prescribeDonationRouting(INTAKE, contextFor(() => v));
    names.add(result.partner.name);
    // The audit reads "routing: <tier> (<detail>)" — keep just the tier word,
    // since the detail carries a per-partner distance.
    tiers.add(result.audit.split('routing: ')[1].split(' ')[0]);
  }
  return { names, tiers };
}

describe('donation routing — tiered geographic selection', () => {
  it('routes to the one partner in the customer\'s city', async () => {
    geocodeThrows = false;
    geocodeResult = BOSTON;
    partnerRows = [BAGLY, RALEIGH];
    routingRows = [];

    const result = await prescribeDonationRouting(INTAKE, contextFor(() => 0.5));

    assert.equal(result.type, 'partner');
    assert.equal(result.partner.name, 'BAGLY');
    assert.match(result.audit, /routing: local \(0 km — Boston, Massachusetts\)/);
  });

  it('shares a metro between every local partner and never reaches a distant one', async () => {
    geocodeResult = BOSTON;
    partnerRows = [BAGLY, MTPC, OUT_METROWEST, RALEIGH];
    routingRows = [];

    const { names, tiers } = await partnersReachable([0, 0.35, 0.7, 0.999]);

    // Framingham (~30 km) is inside the local radius; Raleigh is not.
    assert.deepEqual([...names].sort(), ['BAGLY', 'MTPC', 'OUT MetroWest']);
    assert.ok(!names.has('LGBT Center of Raleigh'));
    assert.deepEqual([...tiers], ['local']);
  });

  it('matches a partner with no coordinates on exact city + region', async () => {
    geocodeResult = BOSTON;
    partnerRows = [{ ...BAGLY, latitude: null, longitude: null }, RALEIGH];
    routingRows = [];

    const result = await prescribeDonationRouting(INTAKE, contextFor(() => 0.5));

    assert.equal(result.partner.name, 'BAGLY');
    assert.match(result.audit, /routing: local \(same city — Boston, Massachusetts\)/);
  });

  it('stays in-state when the nearest partner is in the same state', async () => {
    geocodeResult = SACRAMENTO;
    partnerRows = [RISE_LA, TUCSON, MCMINNVILLE];
    routingRows = [];

    // LA is ~590 km from Sacramento — too far to be local, but nearer than
    // Tucson or McMinnville, so the in-state tier pins the box to California
    // instead of letting the weighted pick cross a state line.
    const { names, tiers } = await partnersReachable([0, 0.5, 0.999]);

    assert.deepEqual([...names], ['RISE @ LA LGBT Center']);
    assert.deepEqual([...tiers], ['in-state']);
  });

  it('does not force in-state when an out-of-state partner is closer', async () => {
    geocodeResult = EUREKA;
    partnerRows = [RISE_LA, TUCSON, MCMINNVILLE];
    routingRows = [];

    // Oregon is nearer to far-northern California than Los Angeles is, so the
    // in-state guard declines and the national spread takes over.
    const { names, tiers } = await partnersReachable([0, 0.5, 0.999]);

    assert.deepEqual([...tiers], ['geographic']);
    assert.ok(names.has('McMinnville Trans Network'));
    assert.ok(names.size > 1, 'closest-3 spread should reach more than one partner');
  });

  it('weights the local pool by trailing-window load', async () => {
    geocodeResult = BOSTON;
    partnerRows = [BAGLY, MTPC];
    // MTPC has taken 19 items recently, BAGLY none: weights are 1 and 1/20,
    // so BAGLY should hold ~95% of the range.
    routingRows = [{ partner_id: MTPC.id, items_count: 19 }];

    const { names } = await partnersReachable([0, 0.5, 0.9]);
    assert.deepEqual([...names], ['BAGLY']);

    const tail = await prescribeDonationRouting(INTAKE, contextFor(() => 0.999));
    assert.equal(tail.partner.name, 'MTPC');
  });

  it('falls back to country-wide load balancing when geocoding fails', async () => {
    geocodeThrows = true;
    partnerRows = [BAGLY, RALEIGH];
    routingRows = [];

    const result = await prescribeDonationRouting(INTAKE, contextFor(() => 0));

    assert.equal(result.type, 'partner');
    assert.match(result.audit, /routing: load_balance/);
    geocodeThrows = false;
  });

  it('leaves the single-item local-donation path untouched', async () => {
    geocodeResult = BOSTON;
    partnerRows = [BAGLY];
    routingRows = [];

    const result = await prescribeDonationRouting(
      { items: [{ product: 'Brooke', issue: 'size' }] },
      { ...contextFor(() => 0.5), targetOrder: { lineItems: [{ title: 'Brooke Bra', quantity: 1 }] } },
    );

    assert.equal(result.type, 'local_single');
  });
});
