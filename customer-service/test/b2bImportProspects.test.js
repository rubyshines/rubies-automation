const { test } = require('node:test');
const assert = require('node:assert');
const {
  classifyEmail, cleanStoreName, parseCountry, parseRegion, planProspect, planImport, summarize, findCompanyByDomain,
} = require('../../b2b-outreach/lib/importProspects');

const NOW = new Date('2026-09-10T12:00:00Z');
const freshIndex = () => ({ byDomain: new Map(), bySourceId: new Set(), ids: new Set() });
const prospect = (over = {}) => ({
  id: 4242, company_name: 'Femme Fatale Intimates', website: 'http://www.ffintimates.com/',
  address: '26 N Broadway ST, Denver, CO 80203, United States', city: 'Denver', state: 'CO',
  email: 'hello@ffintimates.com', contact_name: 'Angel', contact_role: 'Owner', phone: '9305075175',
  contact_form_url: 'http://www.ffintimates.com/contact', subcategory: 'intimates', score: 7,
  outreach_angle: 'Already specialises in plus-size intimates; pitch RUBIES as a complementary line.',
  raw_profile: 'Independently owned lingerie boutique in Denver.', researched_date: '2026-06-10T18:11:55Z',
  mentions_trans: false, mentions_lgbtq: true, carries_underwear_swimwear: true, has_physical_store: true,
  independently_owned: true, brands_list: [], services_list: ['fittings'], discovery_tier: '1', ...over,
});

// ── email hygiene ───────────────────────────────────────────────────────────

test('classifyEmail tells a real address from the scrape artefacts', () => {
  assert.deepEqual(classifyEmail('Hello@FFintimates.com', 'http://www.ffintimates.com/'), { email: 'hello@ffintimates.com', kind: 'own_domain' });
  assert.equal(classifyEmail('user@domain.com', 'http://x.com').kind, 'placeholder');
  assert.equal(classifyEmail('hi@mystore.com', 'http://earthandsaltshop.com').kind, 'placeholder', 'a theme template default, seen on a real row');
  assert.equal(classifyEmail('logo@2x.png', 'http://x.com').kind, 'image');
  assert.equal(classifyEmail('hero-banner.jpg', 'http://x.com').kind, 'image');
  assert.equal(classifyEmail('not an email', 'http://x.com').kind, 'malformed');
  assert.equal(classifyEmail('', 'http://x.com').kind, 'none');
  assert.equal(classifyEmail(null).kind, 'none');
});

test('a free-mail address is kept and labelled; a foreign business domain is kept and flagged', () => {
  assert.deepEqual(classifyEmail('shop@gmail.com', 'http://x.com'), { email: 'shop@gmail.com', kind: 'free_mail' });
  // one boutique carried its font vendor's address
  assert.deepEqual(classifyEmail('sales@fontvendor.com', 'http://boutique.com'), { email: 'sales@fontvendor.com', kind: 'other_domain' });
  // a subdomain of the store is still the store
  assert.equal(classifyEmail('info@shop.boutique.com', 'http://boutique.com').kind, 'own_domain');
  // the page's vendors are not the store: a font foundry, a rewards widget
  assert.equal(classifyEmail('team@latofonts.com', 'https://redvaultchicago.com/').kind, 'placeholder');
  assert.equal(classifyEmail('support@riiwards.com', 'https://hausofelectriclove.com/').kind, 'placeholder');
  assert.equal(classifyEmail('hello@fonts.com', 'https://fonts.com/').kind, 'own_domain', 'unless the vendor IS the site');
});

// ── name and location ───────────────────────────────────────────────────────

test('cleanStoreName drops only a trailing generic descriptor', () => {
  assert.equal(cleanStoreName('Stag Shop - Adult Sex Store'), 'Stag Shop');
  assert.equal(cleanStoreName('Out On The Street Inc'), 'Out On The Street Inc');
  assert.equal(cleanStoreName('Bits + Pieces - Miami'), 'Bits + Pieces - Miami', 'a place is not a descriptor');
  assert.equal(cleanStoreName('  Two   Spaces  '), 'Two Spaces');
});

test('country and region come off the Google Maps address', () => {
  assert.equal(parseCountry('26 N Broadway ST, Denver, CO 80203, United States'), 'United States');
  assert.equal(parseCountry('2950 Dougall Ave, Windsor, ON N9E 1S2, Canada'), 'Canada');
  assert.equal(parseCountry('Somewhere, Amsterdam, Netherlands'), 'Netherlands');
  assert.equal(parseCountry('no commas'), null);
  assert.equal(parseRegion({ state: 'TX' }), 'TX');
  assert.equal(parseRegion({ state: '', address: '2950 Dougall Ave, Windsor, ON N9E 1S2, Canada' }), 'ON');
  assert.equal(parseRegion({ state: '', address: 'Prinsengracht 1, 1054 BV Amsterdam, Netherlands' }), null);
});

// ── planning ────────────────────────────────────────────────────────────────

test('a qualified prospect becomes an unvetted retailer prospect carrying the researcher notes', () => {
  const plan = planProspect(prospect(), freshIndex(), { now: NOW });
  assert.equal(plan.action, 'import');
  assert.equal(plan.id, 'femme-fatale-intimates');
  const c = plan.company;
  assert.equal(c.relationship_type, 'wholesale');
  assert.equal(c.relationship_state, 'prospect');
  assert.equal(c.vetted_at, null, 'Tier 4 only surfaces rows a human has kept');
  assert.equal(c.source, 'discovery');
  assert.equal(c.source_id, '4242');
  assert.equal(c.general_email, 'hello@ffintimates.com');
  assert.equal(c.city, 'Denver');
  assert.equal(c.region, 'CO');
  assert.equal(c.country, 'United States');
  assert.equal(c.enrich_facts.discovery_angle, prospect().outreach_angle);
  assert.equal(c.enrich_facts.discovery_subcategory, 'intimates');
  assert.equal(c.enrich_facts.discovery_score, 7);
  assert.equal(c.enrich_facts.mentions_lgbtq, true);
  assert.equal(c.description, 'Independently owned lingerie boutique in Denver.');
  assert.equal(c.metadata.discovery.email_kind, 'own_domain');
  assert.equal(c.metadata.seeded, '2026-09-10 discovery import');
  assert.deepEqual(plan.contact, {
    id: 'hello@ffintimates.com', email: 'hello@ffintimates.com', company_id: 'femme-fatale-intimates',
    full_name: 'Angel', title: 'Owner', is_primary: true, is_active: true, source: 'discovery',
  });
  assert.equal(plan.delivery, 'email');
});

test('a placeholder email falls back to the contact form; no contact at all is skipped, not shown', () => {
  const form = planProspect(prospect({ email: 'user@domain.com' }), freshIndex(), { now: NOW });
  assert.equal(form.action, 'import');
  assert.equal(form.company.general_email, null);
  assert.equal(form.company.contact_form_url, 'http://www.ffintimates.com/contact');
  assert.equal(form.contact, null, 'no address, so no contact row — the name alone is not a way to reach them');
  assert.equal(form.company.metadata.discovery.contact_name, 'Angel', 'but the name survives on the company');
  assert.equal(form.company.metadata.discovery.contact_role, 'Owner');
  assert.equal(form.delivery, 'form');

  const none = planProspect(prospect({ email: 'logo.png', contact_form_url: null }), freshIndex(), { now: NOW });
  assert.equal(none.action, 'skip');
  assert.equal(none.reason, 'no_contact');
});

test('the book wins: a domain already held by a retailer, or a prospect already imported, is reported and left alone', () => {
  const index = freshIndex();
  index.byDomain.set('ffintimates.com', { id: 'ff-intimates', name: 'FF Intimates' });
  const dup = planProspect(prospect(), index, { now: NOW });
  assert.equal(dup.action, 'skip');
  assert.equal(dup.reason, 'duplicate');
  assert.equal(dup.duplicate_of, 'ff-intimates');

  const index2 = freshIndex();
  index2.bySourceId.add('4242');
  assert.equal(planProspect(prospect(), index2, { now: NOW }).reason, 'already_imported');
});

test('a batch dedupes against itself and disambiguates a slug clash by city', () => {
  const plans = planImport([
    prospect({ id: 1 }),
    prospect({ id: 2, company_name: 'Femme Fatale Intimates', website: 'http://ffintimates.com/shop' }),
    prospect({ id: 3, company_name: 'Femme Fatale Intimates', website: 'http://femmefatale-austin.com', city: 'Austin', state: 'TX', address: '1 Main St, Austin, TX 78701, United States' }),
  ], freshIndex(), { now: NOW });
  assert.equal(plans[0].action, 'import');
  assert.equal(plans[1].reason, 'duplicate', 'same domain, different path');
  assert.equal(plans[2].action, 'import');
  assert.equal(plans[2].id, 'femme-fatale-intimates-austin');
  assert.deepEqual(summarize(plans), { import: 2, duplicate: 1 });
});

// ── the intake guard ────────────────────────────────────────────────────────

function chain(list) {
  const c = {};
  for (const m of ['select', 'eq', 'ilike', 'in', 'is', 'not', 'order']) c[m] = () => c;
  c.then = (res, rej) => Promise.resolve({ data: list, error: null }).then(res, rej);
  return c;
}

test('findCompanyByDomain matches on the website domain, within the channel, and never on a generic domain', async () => {
  const sb = { from: () => chain([
    { id: 'ff-intimates', name: 'FF Intimates', website: 'https://www.ffintimates.com', relationship_type: 'wholesale' },
    { id: 'other', name: 'Other', website: 'https://notffintimates.com', relationship_type: 'wholesale' },
  ]) };
  const hit = await findCompanyByDomain(sb, { website: 'http://ffintimates.com/about', channel: 'wholesale' });
  assert.equal(hit.id, 'ff-intimates');
  assert.equal(await findCompanyByDomain(sb, { website: 'http://ffintimates.com', channel: 'wholesale', excludeId: 'ff-intimates' }), null);
  assert.equal(await findCompanyByDomain(sb, { website: 'https://gmail.com' }), null);
  assert.equal(await findCompanyByDomain(sb, { website: null }), null);
});
