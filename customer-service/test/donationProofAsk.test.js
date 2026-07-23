/**
 * include_proof_ask routing behavior (refund-pattern soft accountability ask):
 *  - single item + proof ask → partner routing (not local_single) with the ask
 *  - single item without → local_single unchanged
 *  - no partners in country → local fallback, NO ask (no org to notify)
 *  - multi-item without proof ask → partner text unchanged
 * Supabase is stubbed via require.cache (see resolveLineItems.test.js pattern).
 */
const { test } = require('node:test');
const assert = require('node:assert');

const PARTNERS = [
  { id: 1, name: 'Test Org', region: 'CA', city: 'Testville', address: '1 Main St, Testville, CA', mailing_address: 'RUBIES Returns\nc/o Test Org\n1 Main St\nTestville, CA', description: 'Test Org runs a gender-affirming closet.', donations_routed: 0, latitude: null, longitude: null },
];
let partnersResult = PARTNERS;

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
    getSupabaseClient: () => ({
      from: (table) => chainable(table === 'donation_partners' ? partnersResult : []),
    }),
    fetchAllPaginated: async (fn) => {
      const { data } = await fn();
      return data || [];
    },
  },
};

const { prescribeDonationRouting, PROOF_ASK_TEXT } = require('../lib/donationRouting');

const intakeOf = (n) => ({ items: Array.from({ length: n }, () => ({ issue: 'close_fit_tight' })) });
const ctx = (extra = {}) => ({
  customerCountry: 'US',
  customer: null,
  targetOrder: { lineItems: [{ title: 'item', quantity: 1 }] },
  ...extra,
});

test('single item + includeProofAsk routes to a partner with the ask', async () => {
  partnersResult = PARTNERS;
  const r = await prescribeDonationRouting(intakeOf(1), ctx({ includeProofAsk: true }));
  assert.strictEqual(r.type, 'partner');
  assert.strictEqual(r.proof_ask, true);
  assert.ok(r.response_text.includes(PROOF_ASK_TEXT));
  assert.ok(r.response_text.indexOf(PROOF_ASK_TEXT) > r.response_text.indexOf('Please wash'));
});

test('single item without proof ask keeps the local_single default', async () => {
  partnersResult = PARTNERS;
  const r = await prescribeDonationRouting(intakeOf(1), ctx());
  assert.strictEqual(r.type, 'local_single');
  assert.ok(!r.response_text.includes(PROOF_ASK_TEXT));
});

test('no partners in country → local fallback with NO proof ask', async () => {
  partnersResult = [];
  const r = await prescribeDonationRouting(intakeOf(2), ctx({ includeProofAsk: true }));
  assert.strictEqual(r.type, 'local_no_partner');
  assert.ok(!r.response_text.includes(PROOF_ASK_TEXT));
});

test('multi-item without proof ask has unchanged partner text', async () => {
  partnersResult = PARTNERS;
  const r = await prescribeDonationRouting(intakeOf(3), ctx());
  assert.strictEqual(r.type, 'partner');
  assert.strictEqual(r.proof_ask, false);
  assert.ok(!r.response_text.includes(PROOF_ASK_TEXT));
});

test('defect-only intake still skips donation entirely', async () => {
  partnersResult = PARTNERS;
  const r = await prescribeDonationRouting({ items: [{ issue: 'defect' }] }, ctx({ includeProofAsk: true }));
  assert.strictEqual(r.skip, true);
});
