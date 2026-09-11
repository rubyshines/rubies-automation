/**
 * enrichCompany + admit wiring.
 *
 * The per-row enrichment used to live inside enrichOrgs.js's CLI worker loop;
 * it is now a function two callers share (the batch run, and the inbound
 * strip's background finisher). These tests cover the wiring that extraction
 * created — which outcome reaches the row, and what is NOT called on the way —
 * rather than the pure write rules, which orgEnrichment.test.js owns.
 *
 * Stubs are installed in require.cache BEFORE the modules under test are
 * required, so nothing here touches Puppeteer, Anthropic, Google or Supabase.
 */
const test = require('node:test');
const assert = require('node:assert');

const calls = { scrape: [], analyze: [], geocode: [], verify: [] };
let scrapeResult = { content: 'x'.repeat(2000), rawHtmlByPage: { home: '<html></html>' } };
let analyzeResult = {};
let geocodeResult = null;

function stub(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

stub('../../b2b-discovery/lib/scraper', {
  scrapeProspect: async (url) => { calls.scrape.push(url); return scrapeResult; },
  closePuppeteer: async () => {},
});
stub('../../b2b-discovery/lib/orgAnalyzer', {
  analyzeOrg: async (args) => { calls.analyze.push(args); return analyzeResult; },
});
stub('../../b2b-discovery/lib/contactFinder', {
  findContacts: () => ({ email: 'hello@bluemountainclinic.org', phone: null, contactFormUrl: null }),
});
stub('../../customer-service/lib/geocoder', {
  geocode: async (q) => { calls.geocode.push(q); return geocodeResult; },
});
stub('../../b2b-outreach/lib/emailVerify', {
  verifyEmail: async (_sb, email) => { calls.verify.push(email); return { status: 'deliverable' }; },
});

const { enrichCompany } = require('../../b2b-discovery/enrichOrgs');

/** A Supabase double that records every update written to b2b_companies. */
function fakeSb(writes) {
  return {
    from() {
      return {
        update(values) {
          writes.push(values);
          return { eq: async () => ({ error: null }) };
        },
      };
    },
  };
}

const ORG = {
  id: 'blue-mountain-clinic', name: 'Blue Mountain Clinic',
  website: 'bluemountainclinic.org', general_email: null, contact_form_url: null,
  phone: null, description: null, city: null, region: null, country: 'US',
};

const LOCATED_ANALYSIS = {
  analysisStatus: 'success',
  orgName: 'Blue Mountain Clinic',
  addressText: '610 North California Street, Missoula, MT 59802',
  basedInCountry: 'US', basedInRegion: 'Montana',
  serviceAreaText: null, descriptionShort: 'A community clinic in Missoula.',
  servesTransCommunity: true, runsClothingProgram: false, appearsActive: true,
  confidence: 'high',
};

const MISSOULA = {
  city: 'Missoula', region: 'Montana', country_code: 'US',
  lat: 46.87, lng: -113.99, formatted_address: '610 N California St, Missoula, MT 59802, USA',
};

test.beforeEach(() => {
  calls.scrape = []; calls.analyze = []; calls.geocode = []; calls.verify = [];
  scrapeResult = { content: 'x'.repeat(2000), rawHtmlByPage: { home: '<html></html>' } };
  analyzeResult = { ...LOCATED_ANALYSIS };
  geocodeResult = { ...MISSOULA };
});

test('a located org gets its city, region and country written, and is marked located', async () => {
  const writes = [];
  const res = await enrichCompany(fakeSb(writes), { ...ORG });

  assert.equal(res.status, 'located');
  assert.equal(writes.length, 1, 'one write, not a status write followed by a location write');
  const w = writes[0];
  assert.equal(w.city, 'Missoula');
  assert.equal(w.region, 'Montana');
  assert.equal(w.country, 'US');
  assert.equal(w.enrich_status, 'located');
  assert.ok(w.enriched_at, 'the row records that it was looked at');
  assert.equal(calls.scrape[0], 'bluemountainclinic.org');
  assert.equal(calls.verify[0], 'hello@bluemountainclinic.org', 'a scraped address enters the book verified');
});

test('a row with no usable website is recorded, not scraped', async () => {
  const writes = [];
  const res = await enrichCompany(fakeSb(writes), { ...ORG, website: null });

  assert.equal(res.status, 'no_website');
  assert.equal(calls.scrape.length, 0, 'nothing to scrape means no browser launch');
  assert.equal(writes[0].enrich_status, 'no_website');
  assert.equal(writes[0].city, undefined, 'a failed lookup never blanks a location we already hold');
});

test('a failed scrape stops before the analyzer and is retryable', async () => {
  scrapeResult = { error: 'timeout', content: '' };
  const writes = [];
  const res = await enrichCompany(fakeSb(writes), { ...ORG });

  assert.equal(res.status, 'scrape_failed');
  assert.equal(calls.analyze.length, 0, 'no content means no AI call to pay for');
  assert.equal(writes[0].enrich_status, 'scrape_failed');
});

test('a geocode that contradicts the org is stored as a conflict, never as a location', async () => {
  // The org says Montana; the geocoder lands in New York — the fiscal-sponsor
  // address case, which is how an org ends up 900 miles from where it is.
  geocodeResult = { city: 'New York', region: 'New York', country_code: 'US', lat: 40.7, lng: -74 };
  const writes = [];
  const res = await enrichCompany(fakeSb(writes), { ...ORG });

  assert.equal(res.status, 'conflict');
  assert.equal(writes[0].enrich_status, 'conflict');
  assert.equal(writes[0].city, undefined, 'a refused geocode writes no location at all');
  assert.match(writes[0].enrich_notes, /needs a human/);
});

test('no address and no service area reads as no_address, and thin content says so instead', async () => {
  geocodeResult = null;
  analyzeResult = { ...LOCATED_ANALYSIS, addressText: null, serviceAreaText: null };
  let writes = [];
  assert.equal((await enrichCompany(fakeSb(writes), { ...ORG })).status, 'no_address');

  // The same empty answer from a 400-character splash page is our failure, not
  // the org's — it must stay retryable rather than settle as a fact.
  scrapeResult = { content: 'x'.repeat(400), rawHtmlByPage: {} };
  writes = [];
  assert.equal((await enrichCompany(fakeSb(writes), { ...ORG })).status, 'scrape_thin');
});
