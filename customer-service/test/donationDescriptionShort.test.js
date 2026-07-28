/**
 * Donation partner descriptions in CS emails:
 *  - partner with description_short → email text uses the short version, not the full one
 *  - partner without description_short → falls back to the full description
 *  - partner with neither → no stray "null"/"undefined" in the email text
 * Supabase is stubbed via require.cache (see resolveLineItems.test.js pattern).
 */
const { test } = require('node:test');
const assert = require('node:assert');

const FULL_DESC = 'We host a queer closet including shirts, pants, accessories, underwear, swimwear, binders, binding tape, tucking tape, and other gender affirming products 100% free of charge.';
const SHORT_DESC = 'Test Org runs a free queer closet offering clothing and gender-affirming products.';

const basePartner = {
  id: 1, name: 'Test Org', region: 'CA', city: 'Testville',
  address: '1 Main St, Testville, CA',
  mailing_address: 'RUBIES Returns\nc/o Test Org\n1 Main St\nTestville, CA',
  donations_routed: 0, latitude: null, longitude: null,
};
let partnersResult = [];

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

const { prescribeDonationRouting } = require('../lib/donationRouting');

const intake = { items: [{ issue: 'close_fit_tight' }, { issue: 'close_fit_tight' }] };
const ctx = {
  customerCountry: 'US',
  customer: null,
  targetOrder: { lineItems: [{ title: 'item', quantity: 1 }] },
};

test('partner with description_short → email uses the short version only', async () => {
  partnersResult = [{ ...basePartner, description: FULL_DESC, description_short: SHORT_DESC }];
  const r = await prescribeDonationRouting(intake, ctx);
  assert.strictEqual(r.type, 'partner');
  assert.ok(r.response_text.includes(SHORT_DESC));
  assert.ok(!r.response_text.includes(FULL_DESC));
});

test('partner without description_short → falls back to the full description', async () => {
  partnersResult = [{ ...basePartner, description: FULL_DESC, description_short: null }];
  const r = await prescribeDonationRouting(intake, ctx);
  assert.strictEqual(r.type, 'partner');
  assert.ok(r.response_text.includes(FULL_DESC));
});

test('partner with neither description → no null/undefined leaks into the email', async () => {
  partnersResult = [{ ...basePartner, description: null, description_short: null }];
  const r = await prescribeDonationRouting(intake, ctx);
  assert.strictEqual(r.type, 'partner');
  assert.ok(!/\b(null|undefined)\b/.test(r.response_text));
});
