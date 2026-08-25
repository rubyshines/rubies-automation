const test = require('node:test');
const assert = require('node:assert');

const { addressIsGrounded, normalizeForEvidence } = require('../../b2b-discovery/lib/orgAnalyzer');
const {
  buildCompanyUpdate,
  buildEnrichNotes,
  nameLooksLikeDomainSlug,
} = require('../../b2b-discovery/enrichOrgs');

// ── The evidence guard ───────────────────────────────────────────────────────
// This is what stops a recalled address becoming a routing decision, so it gets
// the most coverage. A model that "knows" where an org is will produce a
// plausible address with no counterpart in the page we scraped.

test('addressIsGrounded accepts an address transcribed from the page', () => {
  const content = 'Visit us at 128 East Cabarrus Street, Raleigh, NC 27601. Open weekdays.';
  assert.equal(addressIsGrounded('128 East Cabarrus Street, Raleigh, NC, 27601', content), true);
});

test('addressIsGrounded tolerates reformatting of a transcribed address', () => {
  const content = 'Mailing address:\n128 E. Cabarrus St.\nRaleigh, North Carolina 27601';
  // Model rewrote the street type and expanded the state; the digits still match.
  assert.equal(addressIsGrounded('128 East Cabarrus Street, Raleigh, NC 27601', content), true);
});

test('addressIsGrounded rejects an address the page never mentions', () => {
  const content = 'We are a community center serving trans and nonbinary people. Contact us by email.';
  assert.equal(addressIsGrounded('1035 Market Street, San Francisco, CA 94103', content), false);
});

test('addressIsGrounded rejects an address whose street number is invented', () => {
  // Postal code appears on the page, street number does not — the exact shape of
  // a half-recalled address, and the one most likely to look right.
  const content = 'Serving the 27601 area of downtown Raleigh since 2011.';
  assert.equal(addressIsGrounded('500 Fayetteville Street, Raleigh, NC 27601', content), false);
});

test('addressIsGrounded rejects everything when there is no content', () => {
  assert.equal(addressIsGrounded('128 East Cabarrus Street, Raleigh, NC 27601', ''), false);
  assert.equal(addressIsGrounded('128 East Cabarrus Street', null), false);
});

test('addressIsGrounded treats a null address as ungrounded', () => {
  assert.equal(addressIsGrounded(null, 'any content at all'), false);
});

test('normalizeForEvidence strips punctuation and case', () => {
  assert.equal(normalizeForEvidence('128 E. Cabarrus St.'), '128ecabarrusst');
});

// ── Domain-slug name detection ───────────────────────────────────────────────

test('nameLooksLikeDomainSlug spots a name derived from the domain', () => {
  assert.equal(nameLooksLikeDomainSlug('Metrotampabay', 'https://metrotampabay.org'), true);
  assert.equal(nameLooksLikeDomainSlug('Outcenter', 'https://outcenter.org'), true);
  assert.equal(nameLooksLikeDomainSlug('Waf', 'https://waf.org'), true);
});

test('nameLooksLikeDomainSlug leaves a human-written name alone', () => {
  assert.equal(nameLooksLikeDomainSlug('Metro Inclusive Health', 'https://metrotampabay.org'), false);
  assert.equal(nameLooksLikeDomainSlug('LGBT Center of Raleigh', 'https://lgbtcenterofraleigh.com'), false);
});

test('nameLooksLikeDomainSlug needs both a name and a usable website', () => {
  assert.equal(nameLooksLikeDomainSlug('Outcenter', null), false);
  assert.equal(nameLooksLikeDomainSlug(null, 'https://outcenter.org'), false);
  // A free-mail domain identifies nobody, so it can't establish a slug.
  assert.equal(nameLooksLikeDomainSlug('Gmail', 'https://gmail.com'), false);
});

// ── Write-back rules ─────────────────────────────────────────────────────────

const GEO = {
  lat: 27.9506, lng: -82.4572, country_code: 'US', region: 'Florida', city: 'Tampa',
  formatted_address: '3251 3rd Ave N, St. Petersburg, FL 33713, USA',
};
const ANALYSIS = {
  analysisStatus: 'success',
  orgName: 'Metro Inclusive Health',
  addressText: '3251 3rd Ave N, St. Petersburg, FL 33713',
  descriptionShort: 'An LGBTQ+ health and community organization serving the Tampa Bay area.',
  runsClothingProgram: true,
  servesTransCommunity: true,
  appearsActive: true,
};
const CONTACTS = { email: 'info@metrotampabay.org', contactFormUrl: 'https://metrotampabay.org/contact', phone: '727-321-3854' };

test('buildCompanyUpdate overwrites the datacenter location with the geocode', () => {
  const company = { name: 'Metrotampabay', website: 'https://metrotampabay.org', region: 'Iowa', city: 'Des Moines', country: 'United States' };
  const u = buildCompanyUpdate({ company, analysis: ANALYSIS, contacts: CONTACTS, geo: GEO });
  assert.equal(u.region, 'Florida');
  assert.equal(u.city, 'Tampa');
  assert.equal(u.country, 'US');
  assert.equal(u.latitude, 27.9506);
  assert.equal(u.longitude, -82.4572);
  assert.equal(u.enrich_status, 'located');
});

test('buildCompanyUpdate leaves location untouched when nothing geocoded', () => {
  const company = { name: 'Outcenter', website: 'https://outcenter.org', region: 'Virginia', city: 'Ashburn' };
  const u = buildCompanyUpdate({
    company, contacts: CONTACTS, geo: null,
    analysis: { ...ANALYSIS, addressText: null },
  });
  // A wrong stored region is bad, but replacing it with null loses the only
  // thing a human could correct. Absent a better answer, don't touch it.
  assert.ok(!('region' in u), 'region must not be written without a geocode');
  assert.ok(!('city' in u), 'city must not be written without a geocode');
  assert.ok(!('latitude' in u), 'latitude must not be written without a geocode');
});

test('buildCompanyUpdate replaces a slug name but never a human-written one', () => {
  const slug = buildCompanyUpdate({
    company: { name: 'Metrotampabay', website: 'https://metrotampabay.org' },
    analysis: ANALYSIS, contacts: CONTACTS, geo: GEO,
  });
  assert.equal(slug.name, 'Metro Inclusive Health');

  const human = buildCompanyUpdate({
    company: { name: 'Metro Inclusive Health (Tampa)', website: 'https://metrotampabay.org' },
    analysis: ANALYSIS, contacts: CONTACTS, geo: GEO,
  });
  assert.ok(!('name' in human), 'a human-entered name must survive enrichment');
});

test('buildCompanyUpdate fills contact holes but never overwrites known contacts', () => {
  const empty = buildCompanyUpdate({
    company: { name: 'Outcenter', website: 'https://outcenter.org' },
    analysis: ANALYSIS, contacts: CONTACTS, geo: GEO,
  });
  assert.equal(empty.general_email, 'info@metrotampabay.org');
  assert.equal(empty.contact_form_url, 'https://metrotampabay.org/contact');
  assert.equal(empty.phone, '727-321-3854');

  const known = buildCompanyUpdate({
    company: {
      name: 'Outcenter', website: 'https://outcenter.org',
      general_email: 'director@metrotampabay.org',
      contact_form_url: 'https://metrotampabay.org/reach-us',
      phone: '727-000-0000',
      description: 'Description an operator wrote.',
    },
    analysis: ANALYSIS, contacts: CONTACTS, geo: GEO,
  });
  assert.ok(!('general_email' in known), 'a known email must not be displaced by a scrape');
  assert.ok(!('contact_form_url' in known));
  assert.ok(!('phone' in known));
  assert.ok(!('description' in known));
});

test('buildCompanyUpdate never sets vetted_at or touches ai_summary', () => {
  const u = buildCompanyUpdate({
    company: { name: 'Outcenter', website: 'https://outcenter.org', ai_summary: 'Pre-migration relationship notes.' },
    analysis: ANALYSIS, contacts: CONTACTS, geo: GEO,
  });
  assert.ok(!('vetted_at' in u), 'admission is a triage decision, not an enrichment side effect');
  assert.ok(!('ai_summary' in u), 'the sheet-era summary is the only history some orgs have');
});

test('buildCompanyUpdate merges program flags without dropping existing ones', () => {
  const u = buildCompanyUpdate({
    company: { name: 'Outcenter', website: 'https://outcenter.org', program_flags: { donation_partner: true } },
    analysis: ANALYSIS, contacts: CONTACTS, geo: GEO,
  });
  assert.equal(u.program_flags.donation_partner, true, 'existing flags must survive');
  assert.equal(u.program_flags.runs_clothing_program, true);
  assert.equal(u.program_flags.serves_trans_community, true);
  assert.equal(u.program_flags.site_appears_active, true);
});

test('buildCompanyUpdate writes no program flags when the analysis failed', () => {
  const u = buildCompanyUpdate({
    company: { name: 'Outcenter', website: 'https://outcenter.org' },
    analysis: { analysisStatus: 'failed', failureReason: 'timeout' }, contacts: {}, geo: null,
  });
  assert.ok(!('program_flags' in u), 'a failed read must not assert facts about the org');
});

test('buildCompanyUpdate always stamps enriched_at so a re-run skips the row', () => {
  const u = buildCompanyUpdate({ company: { name: 'X', website: 'https://x.org' }, analysis: {}, contacts: {}, geo: null });
  assert.ok(u.enriched_at, 'every terminal outcome must be stamped');
});

// ── Notes ────────────────────────────────────────────────────────────────────

test('buildEnrichNotes distinguishes the ways a location can be missing', () => {
  assert.match(buildEnrichNotes({ analysis: { addressText: null, serviceAreaText: null } }), /no address published/);
  assert.match(buildEnrichNotes({ analysis: { addressText: null, serviceAreaText: 'Greater Kansas City' } }), /"Greater Kansas City" did not geocode/);
  assert.match(buildEnrichNotes({ analysis: { addressText: '1 Main St' }, geo: null }), /did not geocode/);
  assert.match(buildEnrichNotes({ analysis: {}, geo: GEO }), /geocoded to Tampa, Florida, US/);
});

test('buildEnrichNotes reports a thin scrape as inconclusive, not as an absent address', () => {
  const notes = buildEnrichNotes({ analysis: { addressText: null, serviceAreaText: null }, thinContent: 408 });
  assert.match(notes, /408 chars/);
  assert.match(notes, /retry/);
  assert.doesNotMatch(notes, /no address published/, 'our own scrape failure must not be recorded as a fact about the org');
});

test('buildEnrichNotes names the service area an approximate location came from', () => {
  const notes = buildEnrichNotes({
    analysis: { addressText: null, serviceAreaText: 'Southern Oregon (Josephine County area)' },
    geoApprox: { city: null, region: 'Oregon', country_code: 'US' },
  });
  assert.match(notes, /approx from service area/);
  assert.match(notes, /Oregon/);
});

// ── Approximate location from a stated service area ──────────────────────────
// Multi-site and rural orgs routinely publish no street address. Rogue Action
// Center says only "Southern Oregon"; Metro says "the Tampa Bay area, with
// locations in St. Petersburg, Tampa, Clearwater...". Both are useless as
// postal addresses and entirely sufficient to answer "which state".

const GEO_APPROX = { lat: 42.4390, lng: -123.3284, country_code: 'US', region: 'Oregon', city: null };

test('buildCompanyUpdate takes region from a service area when no address is published', () => {
  const u = buildCompanyUpdate({
    company: { name: 'Rogueactioncenter', website: 'https://rogueactioncenter.org', region: 'California', city: 'Mountain View' },
    analysis: { analysisStatus: 'success', orgName: 'Rogue Action Center', addressText: null, serviceAreaText: 'Southern Oregon' },
    contacts: {}, geo: null, geoApprox: GEO_APPROX,
  });
  assert.equal(u.region, 'Oregon');
  assert.equal(u.country, 'US');
  assert.equal(u.enrich_status, 'located_approx');
});

test('an approximate location never populates the postal address field', () => {
  const u = buildCompanyUpdate({
    company: { name: 'Rogueactioncenter', website: 'https://rogueactioncenter.org' },
    analysis: { analysisStatus: 'success', addressText: null, serviceAreaText: 'Southern Oregon' },
    contacts: {}, geo: null, geoApprox: GEO_APPROX,
  });
  assert.equal(u.address, null, 'a county centroid must never be reachable as a mailing address');
  assert.notEqual(u.enrich_status, 'located', 'approximate must be distinguishable from verified');
});

test('a real address still wins and still fills the address field', () => {
  const u = buildCompanyUpdate({
    company: { name: 'Glbtcolorado', website: 'https://glbtcolorado.org' },
    analysis: ANALYSIS, contacts: CONTACTS, geo: GEO, geoApprox: GEO_APPROX,
  });
  assert.equal(u.region, 'Florida', 'the precise geocode must win over the approximate one');
  assert.equal(u.address, GEO.formatted_address);
  assert.equal(u.enrich_status, 'located');
});

test('buildEnrichNotes surfaces a rejected address and an inactive site', () => {
  const notes = buildEnrichNotes({
    analysis: { addressText: null, addressRejected: '1035 Market St, San Francisco, CA', appearsActive: false, appearsActiveReason: 'copyright 2019, no dated content' },
  });
  assert.match(notes, /rejected ungrounded address/);
  assert.match(notes, /site may be inactive/);
});

test('buildEnrichNotes reports a scrape failure ahead of anything else', () => {
  assert.match(buildEnrichNotes({ scrapeError: 'HTTP 403', analysis: { addressText: '1 Main St' } }), /^scrape: HTTP 403/);
});

test('buildEnrichNotes stays within the column bound', () => {
  const notes = buildEnrichNotes({ scrapeError: 'x'.repeat(900) });
  assert.ok(notes.length <= 400);
});
