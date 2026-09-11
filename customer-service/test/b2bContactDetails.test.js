const { test } = require('node:test');
const assert = require('node:assert');
const {
  planDetailsFill, missingDetails, isPlausibleName, isPlausibleTitle, harvestContactDetails,
} = require('../../b2b-outreach/lib/contactDetails');

const empty = { first_name: null, last_name: null, full_name: null, title: null };

test('a signature fills every empty field', () => {
  const p = planDetailsFill(empty,
    { first_name: 'Katherine', last_name: 'Crilley', title: 'Co-Owner' },
    { companyName: 'The Bra Room' });
  assert.deepEqual(p.patch, {
    first_name: 'Katherine', last_name: 'Crilley',
    full_name: 'Katherine Crilley', title: 'Co-Owner',
  });
});

// Rule 1. The whole reason this can run unattended over the entire book.
test('a field already on file is never overwritten', () => {
  const p = planDetailsFill(
    { first_name: 'Kat', last_name: null, full_name: 'Kat, Assistant Director', title: 'Youth Lead' },
    { first_name: 'Katherine', last_name: 'Pamplin', title: 'Assistant Director' },
    { companyName: 'Four Corners' });
  assert.deepEqual(p.patch, { last_name: 'Pamplin' },
    'only the empty field may be written — the operator-set ones stand');
});

test('nothing to fill returns null rather than an empty write', () => {
  const full = { first_name: 'Joy', last_name: 'Iwancio', full_name: 'Joy Iwancio', title: 'Director' };
  assert.equal(planDetailsFill(full, { first_name: 'Joy', last_name: 'Iwancio', title: 'Director' }, {}), null);
});

// Rule 2. The tail of a reply is more often our own signature than theirs.
test('our own quoted signature is never harvested onto a contact', () => {
  assert.equal(planDetailsFill(empty,
    { first_name: 'Jamie', last_name: 'Alexander', title: 'RUBIES Founder' },
    { companyName: 'Broad Lingerie' }), null);
  assert.equal(planDetailsFill(empty, { first_name: 'Jamie', last_name: null, title: null }, {}), null);
});

test('an organisation signing as itself is not a person', () => {
  assert.equal(planDetailsFill(empty,
    { first_name: 'Colors+', last_name: 'Youth Center', title: null },
    { companyName: 'Colors+ Youth Center' }), null);
});

// Rule 3. Forwarded mail and shared mailboxes.
test('a signature naming someone else is dropped whole, title included', () => {
  const p = planDetailsFill(
    { ...empty, full_name: 'Moon' },
    { first_name: 'Syana', last_name: null, title: 'Coordinator' },
    { companyName: 'Projet 10' });
  assert.equal(p, null, 'the title in a colleague\'s sig block is the colleague\'s title');
});

test('a shortened first name still agrees with the signature', () => {
  const p = planDetailsFill({ ...empty, full_name: 'Jess' },
    { first_name: 'Jessica', last_name: 'Bernacki', title: 'Executive Board Secretary' },
    { companyName: 'Unity Conejo' });
  assert.deepEqual(p.patch, {
    first_name: 'Jessica', last_name: 'Bernacki', title: 'Executive Board Secretary',
  }, 'full_name stays "Jess" — fill-only — but the rest is believed');
});

test('a two-letter name agrees with itself', () => {
  const p = planDetailsFill({ ...empty, full_name: 'Ez Lowes' },
    { first_name: 'Ez', last_name: null, title: null }, { companyName: 'Transgender Victoria' });
  assert.deepEqual(p.patch, { first_name: 'Ez' });
});

// The sheet import left company names in the name field. That is not a claim
// about a person, so it blocks nothing — but it is still never overwritten.
test('a company name sitting in full_name does not veto the real signature', () => {
  const p = planDetailsFill(
    { ...empty, full_name: 'LGBTQ+ Resource Center of Kutztown University' },
    { first_name: 'Maddison', last_name: 'Stanley', title: 'Graduate Assistant' },
    { companyName: 'LGBTQ+ Resource Center of Kutztown University' });
  assert.deepEqual(p.patch, {
    first_name: 'Maddison', last_name: 'Stanley', title: 'Graduate Assistant',
  });
  assert.ok(!('full_name' in p.patch), 'the junk name is left exactly as it is');
});

test('a title with no name still lands when we know who the address is', () => {
  const p = planDetailsFill({ first_name: 'Daniel', last_name: 'Ensley', full_name: 'Daniel Ensley', title: null },
    { first_name: null, last_name: null, title: 'Director of Development & Partnerships' },
    { companyName: 'Oasis Youth Center' });
  assert.deepEqual(p.patch, { title: 'Director of Development & Partnerships' });
});

test('prose, addresses and company names are refused as titles', () => {
  assert.ok(isPlausibleTitle('Director of Community Programs & Empowerment'));
  assert.ok(isPlausibleTitle('Owner & Lead Fitter'));
  assert.ok(!isPlausibleTitle('I run ARAY, a small LGBTQ+ youth center in Florida, and I wanted to reach out'));
  assert.ok(!isPlausibleTitle('sales@example.com'));
  assert.ok(!isPlausibleTitle('https://example.com/about'));
  const p = planDetailsFill(empty, { first_name: 'Nicolette', last_name: null, title: 'She Bop' },
    { companyName: 'She Bop' });
  assert.deepEqual(p.patch, { first_name: 'Nicolette', full_name: 'Nicolette' },
    'the company name is not a job title');
});

test('handles and email addresses are refused as names', () => {
  assert.ok(isPlausibleName('Víctor Manuel'));
  assert.ok(isPlausibleName("O'Brien"));
  assert.ok(isPlausibleName('A.F.'));
  assert.ok(!isPlausibleName('katherine@thebraroom.ca'));
  assert.ok(!isPlausibleName('Team 42'));
  assert.ok(!isPlausibleName('the best point of contact here is'));
});

test('missingDetails is the gate that keeps a model call off a complete row', () => {
  assert.deepEqual(missingDetails({ first_name: 'Joy', last_name: 'Iwancio', full_name: 'Joy Iwancio', title: 'Director' }), []);
  assert.deepEqual(missingDetails({ first_name: 'Joy', last_name: '  ', full_name: 'Joy', title: null }), ['last_name', 'title']);
});

/** A company with nothing left to learn, so the contact gate is what is under
 *  test rather than the company's own gaps. */
const COMPLETE_COMPANY = {
  id: 'the-bra-room', name: 'The Bra Room', address: '1 Main St',
  city: 'Rothesay', region: 'NB', country: 'Canada', phone: '506 555 0100',
};

/** Minimal Supabase stub: one contact row, a count of their stored mail, and a
 *  record of what was written. */
function stubDb(contact, inboundCount = 1, company = COMPLETE_COMPANY) {
  const state = { updates: [], companyUpdates: [], extracted: 0 };
  const sb = {
    from(table) {
      assert.ok(['b2b_contacts', 'b2b_companies', 'b2b_messages'].includes(table));
      if (table === 'b2b_messages') {
        const counter = { select: () => counter, eq: () => counter,
          then: (r) => r({ count: inboundCount, error: null }) };
        return counter;
      }
      const api = {
        select() { return api; },
        eq() { return api; },
        maybeSingle() {
          return Promise.resolve({ data: table === 'b2b_contacts' ? contact : company, error: null });
        },
        update(patch) {
          (table === 'b2b_contacts' ? state.updates : state.companyUpdates).push(patch);
          return { eq: () => Promise.resolve({ error: null }) };
        },
      };
      return api;
    },
  };
  return { sb, state };
}

// Plenty of people never print a title, so the "title is missing" gap never
// closes — without a cap that is one model call per reply, forever.
test('after a few of someone\'s emails, we stop paying to re-read them', async () => {
  const { sb, state } = stubDb({ email: 'k@thebraroom.ca', company_id: 'the-bra-room', ...empty }, 4);
  const got = await harvestContactDetails(sb, {
    company_id: 'the-bra-room', sender: 'k@thebraroom.ca', body: 'thanks!',
    extract: async () => { state.extracted++; return { first_name: 'K', last_name: null, title: null }; },
  });
  assert.equal(got, null);
  assert.equal(state.extracted, 0, 'the fourth reply from someone must not pay for a fourth look');
});

test('a complete contact costs nothing — no extraction is run', async () => {
  const { sb, state } = stubDb({
    email: 'k@thebraroom.ca', company_id: 'the-bra-room',
    first_name: 'Katherine', last_name: 'Crilley', full_name: 'Katherine Crilley', title: 'Co-Owner',
  });
  const extract = async () => { state.extracted++; return { first_name: 'X', last_name: 'Y', title: 'Z' }; };
  const got = await harvestContactDetails(sb, {
    company_id: 'the-bra-room', sender: 'k@thebraroom.ca', body: 'hi', extract,
  });
  assert.equal(got, null);
  assert.equal(state.extracted, 0, 'the cost gate must come before the model call, not after it');
  assert.deepEqual(state.updates, []);
});

test('a known person at a company with no address is still worth reading', async () => {
  const { sb, state } = stubDb({
    email: 'k@thebraroom.ca', company_id: 'the-bra-room',
    first_name: 'Katherine', last_name: 'Crilley', full_name: 'Katherine Crilley', title: 'Co-Owner',
  }, 1, { id: 'the-bra-room', name: 'The Bra Room', address: null, city: 'Rothesay', region: 'NB', country: 'Canada', phone: null });
  const got = await harvestContactDetails(sb, {
    company_id: 'the-bra-room', sender: 'k@thebraroom.ca', body: 'hi',
    extract: async () => { state.extracted++; return { street_address: '2 King St', city: 'Rothesay', phone: '506 555 0111' }; },
  });
  assert.equal(state.extracted, 1, 'the sample-kit address is worth one read even when the person is known');
  assert.deepEqual(got.company_filled.sort(), ['address', 'phone']);
  assert.deepEqual(state.updates, [], 'nothing on the contact changed');
});

test('a contact filed under another company is left alone', async () => {
  const { sb, state } = stubDb({
    email: 'k@thebraroom.ca', company_id: 'someone-else', ...empty,
  });
  const got = await harvestContactDetails(sb, {
    company_id: 'the-bra-room', sender: 'k@thebraroom.ca', body: 'hi',
    extract: async () => ({ first_name: 'Katherine', last_name: 'Crilley', title: 'Co-Owner' }),
  });
  assert.equal(got, null);
  assert.deepEqual(state.updates, []);
});

test('an extraction failure is not an error — the reply still correlates', async () => {
  const { sb, state } = stubDb({ email: 'k@thebraroom.ca', company_id: 'the-bra-room', ...empty });
  const got = await harvestContactDetails(sb, {
    company_id: 'the-bra-room', sender: 'k@thebraroom.ca', body: 'hi',
    extract: async () => { throw new Error('529 overloaded'); },
  });
  assert.equal(got, null, 'fails closed and never throws into the correlator');
  assert.deepEqual(state.updates, []);
});

test('a good signature writes exactly the missing fields', async () => {
  const { sb, state } = stubDb({ email: 'k@thebraroom.ca', company_id: 'the-bra-room', ...empty });
  const got = await harvestContactDetails(sb, {
    company_id: 'the-bra-room', sender: 'K@TheBraRoom.ca', body: 'hi', companyName: 'The Bra Room',
    extract: async () => ({ first_name: 'Katherine', last_name: 'Crilley', title: 'Co-Owner' }),
  });
  assert.deepEqual(got.filled.sort(), ['first_name', 'full_name', 'last_name', 'title']);
  assert.equal(state.updates.length, 1);
  assert.equal(state.updates[0].full_name, 'Katherine Crilley');
  assert.ok(state.updates[0].updated_at);
});

// ---------------------------------------------------------------------------
// The address in the signature — "send the sample kit" needs somewhere to send it
// ---------------------------------------------------------------------------
const { planLocationFill } = require('../../b2b-outreach/lib/contactDetails');

test('a signature address fills the empty company fields', () => {
  const p = planLocationFill(
    { city: null, region: null, country: null, address: null, phone: null },
    { street_address: '2097 Danforth Ave', city: 'Toronto', region: 'ON', country: 'Canada', phone: '647 725 6838' });
  assert.deepEqual(p.patch, {
    address: '2097 Danforth Ave', city: 'Toronto', region: 'ON', country: 'Canada', phone: '647 725 6838',
  });
});

test('an address that contradicts the city on file is refused whole', () => {
  const p = planLocationFill(
    { city: 'Austin', region: 'TX', country: 'United States', address: null, phone: null },
    { street_address: '12 Elm St', city: 'Portland', region: 'OR', country: 'United States', phone: '555 0100' });
  assert.equal(p, null, 'a different city is a different place, not better data');
});

test('the same country written two ways is not a conflict', () => {
  const p = planLocationFill(
    { city: 'Austin', region: 'TX', country: 'United States', address: null, phone: null },
    { street_address: '512 Neches St', city: 'Austin', region: 'TX', country: 'USA', phone: null });
  assert.deepEqual(p.patch, { address: '512 Neches St' }, 'street fills; city/region/country already held');
});

test('a website or an email address is never stored as a street', () => {
  assert.equal(planLocationFill({}, { street_address: 'www.example.com', city: 'Austin' }), null);
  assert.equal(planLocationFill({}, { street_address: 'hello@example.com' }), null);
});

test('a phone with no address still lands', () => {
  const p = planLocationFill({ address: '1 Main St' }, { street_address: null, phone: '(828) 484-8878' });
  assert.deepEqual(p.patch, { phone: '(828) 484-8878' });
});

test('a signature with no location writes nothing', () => {
  assert.equal(planLocationFill({}, { street_address: null, city: 'Toronto', phone: null }), null,
    'a bare city is not worth the risk of contradicting a hand-set location');
});

test('a PO box is a real mailing address', () => {
  const p = planLocationFill({}, { street_address: 'PO Box 2973', city: 'Jacksonville', region: 'FL' });
  assert.equal(p.patch.address, 'PO Box 2973');
});

test('our own "Portland, OR" in the city field does not refuse a signature saying "Portland"', () => {
  const p = planLocationFill(
    { city: 'Portland, OR', region: 'Oregon', country: 'United States', address: null },
    { street_address: '909 N Beech St', city: 'Portland', region: 'OR', country: 'United States' });
  assert.deepEqual(p.patch, { address: '909 N Beech St' });
});

test('a region written short does not refuse the address', () => {
  const p = planLocationFill(
    { city: 'Toronto', region: 'Ontario', country: 'Canada', address: null },
    { street_address: '2097 Danforth Ave', city: 'Toronto', region: 'ON', country: 'Canada' });
  assert.deepEqual(p.patch, { address: '2097 Danforth Ave' }, '"ON" vs "Ontario" is not a conflict');
});
