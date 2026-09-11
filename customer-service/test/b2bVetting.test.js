const { test } = require('node:test');
const assert = require('node:assert');
const { contactStatus } = require('../../b2b-outreach/lib/queueService');
const { addProspect } = require('../../b2b-outreach/lib/addProspect');

// ── the contact chip ────────────────────────────────────────────────────────

test('contactStatus names how we can reach a company', () => {
  assert.equal(contactStatus({ email: 'hello@store.com', website: 'https://www.store.com' }), 'own_domain');
  assert.equal(contactStatus({ email: 'orders@shop.store.com', website: 'https://store.com' }), 'own_domain');
  assert.equal(contactStatus({ email: 'store@gmail.com', website: 'https://store.com' }), 'free_mail');
  assert.equal(contactStatus({ email: 'sales@fontvendor.com', website: 'https://store.com' }), 'other_domain');
  assert.equal(contactStatus({ email: null, website: 'https://store.com', contact_form_url: 'https://store.com/contact' }), 'form');
  assert.equal(contactStatus({ email: '', website: 'https://store.com' }), 'none');
  assert.equal(contactStatus({}), 'none');
});

// ── the intake guard ────────────────────────────────────────────────────────

function stubSb({ single = null, list = [] } = {}) {
  const log = [];
  const chain = {};
  for (const m of ['select', 'eq', 'ilike', 'in', 'is', 'not', 'order', 'limit', 'insert', 'update']) {
    chain[m] = (...a) => { log.push([m, ...a]); return chain; };
  }
  chain.upsert = (...a) => { log.push(['upsert', ...a]); return chain; };
  chain.maybeSingle = async () => ({ data: single, error: null });
  chain.then = (res, rej) => Promise.resolve({ data: list, error: null }).then(res, rej);
  return { sb: { from: () => chain }, log };
}

test('addProspect refuses to create a second row for a domain the channel already holds', async () => {
  const { sb, log } = stubSb({
    single: null, // no row under the new slug
    list: [{ id: 'the-tool-shed', name: 'The Tool Shed', website: 'https://www.toolshedtoys.com', relationship_type: 'wholesale', relationship_state: 'active' }],
  });
  const res = await addProspect(sb, { name: 'Tool Shed Toys', channel: 'wholesale', website: 'http://toolshedtoys.com/wholesale' });
  assert.equal(res.duplicate_of, 'the-tool-shed');
  assert.equal(res.existed, true);
  assert.equal(res.draft_id, null);
  assert.match(res.warning, /shares its website domain with The Tool Shed/);
  assert.ok(!log.some(([m]) => m === 'upsert'), 'nothing was written');
});

test('an org admitted from its own inbound mail enters as in_contact, a referral as prospect', async () => {
  // `prospect` asserts we have never approached them, and the queue turns that
  // assertion into a cold intro. For a company admitted BECAUSE they wrote to
  // us, it is false the moment the row is written (2026-09-11).
  const inbound = stubSb({ single: null, list: [] });
  await addProspect(inbound.sb, {
    name: 'Foothill College PRIDE Center', channel: 'lgbtq_org',
    website: 'fhda.edu', email: 'lewisalexis@fhda.edu', source: 'inbound_email', draft: false,
  });
  const inboundRow = inbound.log.find(([m]) => m === 'upsert')[1];
  assert.equal(inboundRow.relationship_state, 'in_contact');
  assert.equal(inboundRow.temperature, 'warm');

  // A referral is still someone we have never approached.
  const referral = stubSb({ single: null, list: [] });
  await addProspect(referral.sb, {
    name: 'Some Referred Store', channel: 'wholesale',
    website: 'referredstore.com', referred_by: 'a partner', draft: false,
  });
  assert.equal(referral.log.find(([m]) => m === 'upsert')[1].relationship_state, 'prospect');
});

test('re-adding a company never rewrites the state it already has', async () => {
  // Including the lost guard: an explicitly closed relationship is not
  // resurrected by inbound mail arriving from it.
  const existing = stubSb({ single: { id: 'x', relationship_state: 'active', metadata: {}, vetted_at: '2026-01-01T00:00:00Z' }, list: [] });
  await addProspect(existing.sb, { name: 'X', channel: 'lgbtq_org', source: 'inbound_email', draft: false });
  assert.equal(existing.log.find(([m]) => m === 'upsert')[1].relationship_state, 'active');

  const lost = stubSb({ single: { id: 'y', relationship_state: 'lost', metadata: {}, vetted_at: null }, list: [] });
  await addProspect(lost.sb, { name: 'Y', channel: 'lgbtq_org', source: 'inbound_email', draft: false });
  assert.equal(lost.log.find(([m]) => m === 'upsert')[1].relationship_state, 'lost');
});

// ── the advisor sees the researcher's notes ─────────────────────────────────

const { describeEnrichFacts } = require('../../b2b-outreach/lib/outreachAdvisor');

test('discovery notes reach the why-this-store slot, labelled as our own research', () => {
  const line = describeEnrichFacts({
    discovery_angle: 'Already stocks a gender-affirming section; pitch RUBIES as the underwear it lacks.',
    discovery_subcategory: 'gender-affirming-boutique',
    discovery_researched_at: '2026-06-10T18:11:55Z',
  });
  assert.match(line, /Store type from our research: gender affirming boutique/);
  assert.match(line, /read off their site in June 2026/);
  assert.match(line, /never shown to them/);
  assert.match(line, /pitch RUBIES as the underwear it lacks/);
  assert.equal(describeEnrichFacts({}), null);
  assert.equal(describeEnrichFacts(null), null);
  // the org enrichment facts still render on their own
  assert.match(describeEnrichFacts({ runs_clothing_program: true }), /OWN gender-affirming clothing closet/);
});
