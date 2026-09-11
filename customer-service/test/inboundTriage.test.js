/**
 * inboundTriage — the "New inbound" strip's candidate derivation.
 *
 * The pure half is what carries the correctness burden: which classified
 * inbound is listed, which is suppressed, and how messages group per domain.
 * A wrong exclusion here resurfaces a known partner as a cold prospect; a
 * wrong inclusion floods the strip with individuals.
 */
const { test } = require('node:test');
const assert = require('node:assert');

const {
  deriveInboundCandidates,
  applyOrderHistory,
  inferNameFromDomain,
  normalizeSender,
  parseEnrichment,
  buildEnrichPrompt,
} = require('../../b2b-outreach/lib/inboundTriage');

const msg = (over = {}) => ({
  gmail_message_id: 'g1',
  from_address: 'fearne@bluemountainclinic.org',
  from_name: 'Fearne Perez',
  subject: 'Interest in Partnering!',
  date: '2026-08-31T22:28:14+00:00',
  body_text: 'Hello! I wanted to reach out…',
  classification: 'lgbtq_org',
  is_sent: false,
  is_auto_reply: false,
  ...over,
});

const noKnown = { domains: new Set(), emails: new Set() };

test('an unmatched org sender becomes one candidate', () => {
  const out = deriveInboundCandidates([msg()], noKnown);
  assert.equal(out.length, 1);
  assert.equal(out[0].domain, 'bluemountainclinic.org');
  assert.equal(out[0].channel, 'lgbtq_org');
  assert.equal(out[0].sender_email, 'fearne@bluemountainclinic.org');
  assert.equal(out[0].sender_name, 'Fearne Perez');
  assert.equal(out[0].message_count, 1);
});

test('a known company domain is suppressed — including lost stubs', () => {
  const known = { domains: new Set(['bluemountainclinic.org']), emails: new Set() };
  assert.equal(deriveInboundCandidates([msg()], known).length, 0);
});

test('a known contact address is suppressed even when the domain is new', () => {
  const known = { domains: new Set(), emails: new Set(['fearne@bluemountainclinic.org']) };
  assert.equal(deriveInboundCandidates([msg()], known).length, 0);
});

test('free-mail senders are never listed — an individual identifies no organisation', () => {
  const out = deriveInboundCandidates([msg({ from_address: 'someorg@gmail.com' })], noKnown);
  assert.equal(out.length, 0);
});

test('sent, auto-reply, and non-outreach classifications are skipped', () => {
  const out = deriveInboundCandidates([
    msg({ is_sent: true }),
    msg({ is_auto_reply: true }),
    msg({ classification: 'customer_support' }),
    msg({ classification: 'production_orders' }),
  ], noKnown);
  assert.equal(out.length, 0);
});

test('several messages from one domain collapse to one row, latest message wins the display fields', () => {
  const out = deriveInboundCandidates([
    msg({ date: '2026-08-31T22:28:14+00:00', subject: 'Interest in Partnering!' }),
    msg({
      gmail_message_id: 'g2',
      date: '2026-09-01T16:04:15+00:00',
      subject: 'Re: Interest in Partnering!',
      body_text: 'I am free after 1 MST tomorrow!',
    }),
  ], noKnown);
  assert.equal(out.length, 1);
  assert.equal(out[0].message_count, 2);
  assert.equal(out[0].first_seen, '2026-08-31T22:28:14+00:00');
  assert.equal(out[0].last_seen, '2026-09-01T16:04:15+00:00');
  assert.equal(out[0].subject, 'Re: Interest in Partnering!');
  assert.match(out[0].snippet, /free after 1 MST/);
  assert.match(out[0].body, /free after 1 MST/);
  // …and message order must not matter
  const reversed = deriveInboundCandidates([
    msg({ gmail_message_id: 'g2', date: '2026-09-01T16:04:15+00:00', subject: 'Re: Interest in Partnering!' }),
    msg({ date: '2026-08-31T22:28:14+00:00' }),
  ], noKnown);
  assert.equal(reversed[0].subject, 'Re: Interest in Partnering!');
  assert.equal(reversed[0].first_seen, '2026-08-31T22:28:14+00:00');
});

test('wholesale classification maps to the wholesale channel', () => {
  const out = deriveInboundCandidates(
    [msg({ from_address: 'buyer@coolshop.com', classification: 'wholesale' })], noKnown);
  assert.equal(out[0].channel, 'wholesale');
});

test('candidates sort newest inbound first', () => {
  const out = deriveInboundCandidates([
    msg({ from_address: 'a@older.org', date: '2026-08-01T00:00:00+00:00' }),
    msg({ from_address: 'b@newer.org', date: '2026-09-01T00:00:00+00:00', gmail_message_id: 'g2' }),
  ], noKnown);
  assert.deepEqual(out.map(c => c.domain), ['newer.org', 'older.org']);
});

test('sender normalization strips display names and case', () => {
  assert.equal(normalizeSender('Fearne Perez <Fearne@BlueMountainClinic.org>'), 'fearne@bluemountainclinic.org');
});

test('inferred name is a readable title-cased guess', () => {
  assert.equal(inferNameFromDomain('bluemountainclinic.org'), 'Bluemountainclinic');
  assert.equal(inferNameFromDomain('trans-closet.org.uk'), 'Trans Closet');
});

test('enrichment parse accepts a clean answer and normalizes null country', () => {
  assert.deepEqual(
    parseEnrichment('{"org_name": "Blue Mountain Clinic", "country": "United States"}'),
    { org_name: 'Blue Mountain Clinic', country: 'United States', city: null, region: null, pitch: false });
  assert.deepEqual(
    parseEnrichment('Here you go: {"org_name": "Le JAG", "country": null}'),
    { org_name: 'Le JAG', country: null, city: null, region: null, pitch: false });
  // the string "null" is a model tic, not a country
  assert.deepEqual(
    parseEnrichment('{"org_name": "Le JAG", "country": "null"}'),
    { org_name: 'Le JAG', country: null, city: null, region: null, pitch: false });
});

test('enrichment parse carries a stated city and region, and treats a missing one as null', () => {
  assert.deepEqual(
    parseEnrichment('{"org_name": "Blue Mountain Clinic", "country": "United States", "city": "Missoula", "region": "Montana"}'),
    { org_name: 'Blue Mountain Clinic', country: 'United States', city: 'Missoula', region: 'Montana', pitch: false });
  // A signature with no address is the normal case, not a parse failure.
  const bare = parseEnrichment('{"org_name": "Le JAG", "country": "France", "city": null, "region": "null"}');
  assert.equal(bare.city, null);
  assert.equal(bare.region, null);
  assert.equal(bare.org_name, 'Le JAG', 'a missing location never costs us the name');
  // Junk in a location field is dropped, and never blocks the row.
  const junk = parseEnrichment(`{"org_name": "Le JAG", "city": "${'x'.repeat(120)}", "region": ""}`);
  assert.equal(junk.city, null);
  assert.equal(junk.region, null);
  assert.equal(junk.org_name, 'Le JAG');
});

test('the pitch flag only reads literal true — a spam guess fails toward showing the row normally', () => {
  assert.equal(parseEnrichment('{"org_name": "Optimize Synergy", "pitch": true}').pitch, true);
  assert.equal(parseEnrichment('{"org_name": "Le JAG", "pitch": false}').pitch, false);
  assert.equal(parseEnrichment('{"org_name": "Le JAG", "pitch": "true"}').pitch, false);
  assert.equal(parseEnrichment('{"org_name": "Le JAG"}').pitch, false);
});

test('enrichment parse rejects garbage rather than letting it become a company name', () => {
  assert.equal(parseEnrichment('I could not determine the organisation.'), null);
  assert.equal(parseEnrichment('{"org_name": ""}'), null);
  assert.equal(parseEnrichment(`{"org_name": "${'x'.repeat(120)}"}`), null);
  assert.equal(parseEnrichment('{"country": "France"}'), null);
  assert.equal(parseEnrichment(''), null);
});

test('enrichment prompt carries the message, sender, and domain', () => {
  const p = buildEnrichPrompt({
    sender_name: 'Fearne Perez', sender_email: 'fearne@bluemountainclinic.org',
    domain: 'bluemountainclinic.org', subject: 'Interest in Partnering!',
    body: 'Hello! BMC would love to partner…',
  });
  assert.match(p, /fearne@bluemountainclinic\.org/);
  assert.match(p, /Interest in Partnering!/);
  assert.match(p, /BMC would love to partner/);
  assert.match(p, /org_name/);
});

test('a sender with retail orders is flagged with the count, everyone else reads 0 — never hidden', () => {
  const rows = deriveInboundCandidates([
    msg({ from_address: 'lizgayford@creativeoutdoor.com', subject: 'Re: Life Update From Jamie & Ruby', classification: 'wholesale' }),
    msg({ gmail_message_id: 'g2', from_address: 'fearne@bluemountainclinic.org' }),
  ], noKnown);
  const history = new Map([['lizgayford@creativeoutdoor.com', { orders: 5, last_order_at: '2025-05-11T15:08:13+00:00' }]]);
  applyOrderHistory(rows, history);
  const liz = rows.find(r => r.domain === 'creativeoutdoor.com');
  const org = rows.find(r => r.domain === 'bluemountainclinic.org');
  assert.equal(liz.customer_orders, 5);
  assert.equal(liz.customer_last_order_at, '2025-05-11T15:08:13+00:00');
  assert.equal(org.customer_orders, 0);
  assert.equal(org.customer_last_order_at, null);
  assert.equal(rows.length, 2, 'a customer is badged, not dropped');
});

test('order-history match is case-insensitive on the sender and survives a missing lookup', () => {
  const rows = deriveInboundCandidates([msg({ from_address: 'Liz@CreativeOutdoor.com' })], noKnown);
  applyOrderHistory(rows, new Map([['liz@creativeoutdoor.com', { orders: 1, last_order_at: '2024-01-01' }]]));
  assert.equal(rows[0].customer_orders, 1);
  applyOrderHistory(rows, undefined);
  assert.equal(rows[0].customer_orders, 0);
});
