const { test } = require('node:test');
const assert = require('node:assert');
const {
  computeFieldRepair, hasShiftSignature, isStreetAddress, isPhone,
  isCountryName, isStatusWord, normalizeWebsite, parseCityRegion, normalizeMetadata,
} = require('../../scripts/repairB2bImportFields');

// ── metadata stored as a JSON string scalar in jsonb ────────────────────────

test('normalizeMetadata parses a stringified metadata blob back to an object', () => {
  const real = { campaign: 'sample', initial_reach_out: '2026-02-19', no_response_count: 2 };
  assert.deepEqual(normalizeMetadata(JSON.stringify(real)), real);
});

test('normalizeMetadata leaves healthy metadata alone', () => {
  assert.equal(normalizeMetadata({ klaviyo_list: 'centerlink' }), null, 'already an object');
  assert.equal(normalizeMetadata(null), null);
  assert.equal(normalizeMetadata(''), null);
});

test('normalizeMetadata refuses non-object JSON rather than corrupting the column', () => {
  assert.equal(normalizeMetadata('"just a string"'), null);
  assert.equal(normalizeMetadata('[1,2]'), null);
  assert.equal(normalizeMetadata('not json at all'), null);
});

// ── classifiers ─────────────────────────────────────────────────────────────

test('isStreetAddress recognises the shifted address values', () => {
  assert.equal(isStreetAddress('56 JFK Street, Cambridge, MA 02138'), true);
  assert.equal(isStreetAddress('9414 Norton Commons Blvd, #101,\nProspect, KY 40059'), true);
  assert.equal(isStreetAddress('1040 Gaines School Rd.,Suite 115, Athens, GA 30605'), true);
  assert.equal(isStreetAddress('17 Thames Street, Brooklyn NY 11206'), true);
  assert.equal(isStreetAddress('https://thebraroom.ca/'), false);
  assert.equal(isStreetAddress('broadlingerie.com'), false);
  assert.equal(isStreetAddress('Brooklyn, NY'), false, 'city+state is not a street address');
  assert.equal(isStreetAddress(null), false);
});

test('isPhone accepts phone punctuation only', () => {
  assert.equal(isPhone('828-484-8878'), true);
  assert.equal(isPhone('(716) 633-8999'), true);
  assert.equal(isPhone('+1 602-475-4800'), true);
  assert.equal(isPhone('United States'), false);
  assert.equal(isPhone('lead'), false);
  assert.equal(isPhone('12345'), false, 'too few digits');
});

test('isCountryName and isStatusWord', () => {
  assert.equal(isCountryName('United States'), true);
  assert.equal(isCountryName('canada'), true);
  assert.equal(isCountryName('Brooklyn'), false);
  assert.equal(isStatusWord('lead'), true);
  assert.equal(isStatusWord('qualified_lead'), true);
  assert.equal(isStatusWord('United States'), false);
});

test('normalizeWebsite preserves the path', () => {
  assert.equal(normalizeWebsite('bit.ly/m/mactrans'), 'https://bit.ly/m/mactrans');
  assert.equal(normalizeWebsite('https://transponder.community/behavioral-health'), 'https://transponder.community/behavioral-health');
});

test('normalizeWebsite cleans whitespace, www, trailing slash, multi-domain', () => {
  assert.equal(normalizeWebsite('selfservetoys.com '), 'https://selfservetoys.com');
  assert.equal(normalizeWebsite('www.masstpc.org'), 'https://masstpc.org');
  assert.equal(normalizeWebsite('bigbrosbarbershop.com/'), 'https://bigbrosbarbershop.com');
  assert.equal(normalizeWebsite('transformationcloset.ca and shns.ca'), 'https://transformationcloset.ca');
  assert.equal(normalizeWebsite('illusionslingerie.com.au'), 'https://illusionslingerie.com.au');
  assert.equal(normalizeWebsite('http://tgv.org.au'), 'http://tgv.org.au', 'existing scheme kept');
  assert.equal(normalizeWebsite('61 North Merrimon Avenue, Suite 107'), null, 'no domain');
  assert.equal(normalizeWebsite(null), null);
});

test('parseCityRegion splits city from state code', () => {
  assert.deepEqual(parseCityRegion('Brooklyn, NY'), { city: 'Brooklyn', region: 'NY' });
  assert.deepEqual(parseCityRegion('Arlington Heights, IL'), { city: 'Arlington Heights', region: 'IL' });
  assert.deepEqual(parseCityRegion('SF'), { city: 'SF', region: null });
  assert.deepEqual(parseCityRegion('NY'), { city: null, region: 'NY' }, 'bare state code');
  assert.deepEqual(parseCityRegion(null), { city: null, region: null });
});

// ── signature gating ────────────────────────────────────────────────────────

const shifted = (over = {}) => ({
  id: 'a', name: 'Forty Winks', website: '56 JFK Street, Cambridge, MA 02138',
  city: 'United States', region: null, country: '617-492-9100', phone: null,
  address: 'Cambridge, MA', ...over,
});

test('signature needs BOTH halves — country-in-city and junk-in-country', () => {
  assert.equal(hasShiftSignature(shifted()), true);
  assert.equal(hasShiftSignature(shifted({ country: 'United States' })), false);
  assert.equal(hasShiftSignature(shifted({ city: 'Cambridge' })), false);
});

test('a correctly-imported row is never touched', () => {
  const clean = {
    id: 'b', name: 'Story Essentials', website: 'https://mystoryessentials.com/',
    city: 'Phoenix', region: 'AZ', country: 'United States',
    phone: '602-475-4800', address: null,
  };
  // Only the trailing-slash normalization, nothing structural.
  assert.deepEqual(computeFieldRepair(clean), { website: 'https://mystoryessentials.com' });
});

// ── the repair itself ───────────────────────────────────────────────────────

test('shifted row with a street address is fully unwound', () => {
  const upd = computeFieldRepair(shifted());
  assert.equal(upd.address, '56 JFK Street, Cambridge, MA 02138');
  assert.equal(upd.website, null);
  assert.equal(upd.country, 'United States');
  assert.equal(upd.phone, '617-492-9100');
  assert.equal(upd.city, 'Cambridge');
  assert.equal(upd.region, 'MA');
});

test('shifted row whose country held the status word drops it, keeps no phone', () => {
  const upd = computeFieldRepair(shifted({
    name: 'The Pleasure Chest', website: null, country: 'lead', address: 'West Hollywood, CA',
  }));
  assert.equal(upd.country, 'United States');
  assert.equal(upd.phone, undefined, '"lead" is not a phone — phone stays null');
  assert.equal(upd.city, 'West Hollywood');
  assert.equal(upd.region, 'CA');
  assert.equal(upd.address, null, 'city+state moved to city/region, no street address to keep');
});

test('shifted row with a real URL keeps the URL', () => {
  const upd = computeFieldRepair(shifted({
    name: 'The Tool Shed', website: 'https://toolshedtoys.com',
    country: 'lead', address: 'Milwaukee, WI',
  }));
  assert.equal(upd.website, undefined, 'already a clean URL');
  assert.equal(upd.address, null);
  assert.equal(upd.city, 'Milwaukee');
  assert.equal(upd.region, 'WI');
});

test('repair is idempotent — re-running over a fixed row is a no-op', () => {
  const row = shifted();
  const fixed = { ...row, ...computeFieldRepair(row) };
  assert.equal(computeFieldRepair(fixed), null);
});

test('street address outside the signature moves only when address is free', () => {
  const noSig = { id: 'c', name: 'X', website: '17 Thames Street, Brooklyn NY 11206', city: 'Brooklyn', region: null, country: 'United States', phone: null, address: null };
  assert.deepEqual(computeFieldRepair(noSig), { address: '17 Thames Street, Brooklyn NY 11206', website: null });
  assert.equal(computeFieldRepair({ ...noSig, address: 'existing address' }), null, 'never overwrite an address on file');
});

test('rows with nothing wrong return null', () => {
  assert.equal(computeFieldRepair({ id: 'd', name: 'Y', website: null, city: 'Halifax', region: null, country: 'Canada', phone: null, address: null }), null);
});
