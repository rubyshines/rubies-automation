/**
 * A ticket that has already been given a partner address gets a one-line
 * confirmation on the next donation question, not the whole block again.
 *
 * Two halves are load-bearing and easy to get wrong in opposite directions:
 *  - findPriorPartnerDonation reads what was SENT, so an operator who deleted
 *    the address before sending leaves the next reply owing the full block;
 *  - the local-donation offer must NOT read as an address, or a customer who
 *    accepts it gets "same address" pointing at nothing.
 * Supabase is stubbed via require.cache (see resolveLineItems.test.js pattern).
 */
const { test } = require('node:test');
const assert = require('node:assert');

const PARTNERS = [
  { id: 7, name: 'Test Org', region: 'NY', city: 'Testville', address: '1 Main St, Testville, NY', mailing_address: 'RUBIES Returns\nc/o Test Org\n1 Main St\nTestville, NY', description: 'Test Org runs a gender-affirming closet.', donations_routed: 0, latitude: null, longitude: null },
];

function chainable(result) {
  const p = Promise.resolve({ data: result, error: null });
  const c = {};
  for (const m of ['select', 'eq', 'gte', 'not', 'order', 'range', 'limit']) c[m] = () => c;
  c.then = p.then.bind(p);
  c.catch = p.catch.bind(p);
  return c;
}

require.cache[require.resolve('../../shared/supabaseClient')] = {
  id: require.resolve('../../shared/supabaseClient'),
  filename: require.resolve('../../shared/supabaseClient'),
  loaded: true,
  exports: {
    getSupabaseClient: () => ({ from: (table) => chainable(table === 'donation_partners' ? PARTNERS : []) }),
    fetchAllPaginated: async (fn) => { const { data } = await fn(); return data || []; },
  },
};

const {
  prescribeDonationRouting,
  findPriorPartnerDonation,
  SAME_ADDRESS_TEXT,
  SAME_ADDRESS_TEXT_SINGULAR,
  PROOF_ASK_TEXT,
} = require('../lib/donationRouting');

const intakeOf = (n) => ({ items: Array.from({ length: n }, () => ({ issue: 'close_fit_tight' })) });
const ctx = (extra = {}) => ({
  customerCountry: 'US',
  customer: null,
  targetOrder: { lineItems: [{ title: 'item', quantity: 1 }] },
  ...extra,
});

const SENT_WITH_ADDRESS = 'With this in mind can you please send the items you are returning to:\n\nRUBIES Returns\nc/o Test Org\n1 Main St\nTestville, NY\n\nTake care,';
// The local-donation offer. Note "RUBIES returns" lowercase and mid-sentence —
// a case-insensitive marker reads this as an address block.
const SENT_LOCAL_OFFER = 'We have moved to a model where all RUBIES returns will be donated to organizations that run gender-affirming programs. Since you only have one item to return, feel free to donate it locally.';

// --- findPriorPartnerDonation ------------------------------------------------

test('finds the partner from a sent message containing the address block', () => {
  const prior = findPriorPartnerDonation([
    { sent_response: SENT_WITH_ADDRESS, sent_at: '2026-08-24T13:00:00Z', structured_output: { prescription: { donation: { partner_id: 7, partner_name: 'Test Org' } } } },
  ]);
  assert.deepEqual(prior, { partner_id: 7, partner_name: 'Test Org' });
});

test('the local-donation offer is not an address — returns null', () => {
  assert.strictEqual(findPriorPartnerDonation([
    { sent_response: SENT_LOCAL_OFFER, sent_at: '2026-08-24T13:00:00Z', structured_output: { prescription: { donation: { type: 'local_single' } } } },
  ]), null);
});

test('a draft that routed to a partner but was sent without the address does not count', () => {
  // Operator deleted the block before sending. The customer has no address, so
  // the next reply must still give them one.
  assert.strictEqual(findPriorPartnerDonation([
    { sent_response: 'Hi, your exchange is on its way.', sent_at: '2026-08-24T13:00:00Z', structured_output: { prescription: { donation: { partner_id: 7, partner_name: 'Test Org' } } } },
  ]), null);
});

test('unsent drafts are ignored; the most recent qualifying SEND wins', () => {
  const prior = findPriorPartnerDonation([
    { sent_response: SENT_WITH_ADDRESS, sent_at: '2026-08-20T13:00:00Z', structured_output: { prescription: { donation: { partner_id: 7, partner_name: 'Old Org' } } } },
    { sent_response: null, draft_response: SENT_WITH_ADDRESS, structured_output: { prescription: { donation: { partner_id: 99, partner_name: 'Never Sent' } } } },
    { sent_response: SENT_WITH_ADDRESS, sent_at: '2026-08-24T13:00:00Z', structured_output: { prescription: { donation: { partner_id: 7, partner_name: 'Test Org' } } } },
  ]);
  assert.strictEqual(prior.partner_name, 'Test Org');
});

test('an address that reached the customer counts even with no routing metadata', () => {
  // Pre-2026-06 rows and hand-composed replies carry no prescription.donation.
  // The customer still has the address, so confirm rather than re-send.
  const prior = findPriorPartnerDonation([{ sent_response: SENT_WITH_ADDRESS, sent_at: '2026-08-24T13:00:00Z' }]);
  assert.deepEqual(prior, { partner_id: null, partner_name: null });
});

test('tolerates empty, null and malformed rows', () => {
  assert.strictEqual(findPriorPartnerDonation([]), null);
  assert.strictEqual(findPriorPartnerDonation(null), null);
  assert.strictEqual(findPriorPartnerDonation([null, {}, { sent_response: 42 }]), null);
});

// --- prescribeDonationRouting ------------------------------------------------

const PRIOR = { partner_id: 7, partner_name: 'Test Org' };

test('follow-up on a ticket with the address: one line, no block, no re-route', async () => {
  const r = await prescribeDonationRouting(intakeOf(2), ctx({ priorPartnerDonation: PRIOR }));
  assert.strictEqual(r.type, 'partner');
  assert.strictEqual(r.already_given, true);
  assert.strictEqual(r.response_text, SAME_ADDRESS_TEXT);
  assert.ok(!/RUBIES Returns/.test(r.response_text), 'must not repeat the address block');
  assert.ok(!/Please wash/.test(r.response_text), 'must not repeat the wash reminder');
  assert.ok(!/greatly appreciated/.test(r.response_text), 'must not repeat the appreciation line');
  // Same partner as before, so the follow-up items are logged against the org
  // they are actually going to.
  assert.strictEqual(r.partner.id, 7);
});

test('singular copy when one item is coming back', async () => {
  const r = await prescribeDonationRouting(intakeOf(1), ctx({ priorPartnerDonation: PRIOR }));
  assert.strictEqual(r.response_text, SAME_ADDRESS_TEXT_SINGULAR);
});

test('customerAskedForAddressAgain returns the full block for the same ticket', async () => {
  const r = await prescribeDonationRouting(intakeOf(2), ctx({ priorPartnerDonation: PRIOR, customerAskedForAddressAgain: true }));
  assert.strictEqual(r.already_given, undefined);
  assert.ok(/RUBIES Returns/.test(r.response_text));
  assert.ok(/Please wash/.test(r.response_text));
});

test('no prior address: routing is completely unchanged', async () => {
  const r = await prescribeDonationRouting(intakeOf(2), ctx());
  assert.strictEqual(r.type, 'partner');
  assert.strictEqual(r.already_given, undefined);
  assert.ok(/RUBIES Returns/.test(r.response_text));
});

test('a flagged refund keeps its proof ask on the short confirmation', async () => {
  // The ask is the point of the flag and names no org, so it survives the
  // short-circuit rather than forcing a second address.
  const r = await prescribeDonationRouting(intakeOf(2), ctx({ priorPartnerDonation: PRIOR, includeProofAsk: true }));
  assert.strictEqual(r.already_given, true);
  assert.strictEqual(r.proof_ask, true);
  assert.ok(r.response_text.startsWith(SAME_ADDRESS_TEXT));
  assert.ok(r.response_text.includes(PROOF_ASK_TEXT));
  assert.ok(!/RUBIES Returns/.test(r.response_text));
});

test('defects still skip donation entirely, prior address or not', async () => {
  const r = await prescribeDonationRouting({ items: [{ issue: 'defect' }] }, ctx({ priorPartnerDonation: PRIOR }));
  assert.strictEqual(r.skip, true);
});

// The confirmation is customer-facing copy: house style bans em dashes.
test('confirmation copy carries no em dash', () => {
  for (const t of [SAME_ADDRESS_TEXT, SAME_ADDRESS_TEXT_SINGULAR]) assert.ok(!t.includes('—'), t);
});
