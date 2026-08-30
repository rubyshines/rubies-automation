'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { hasOrderHistory } = require('../lib/knownCustomer');
const { fetchOpenSpamTickets } = require('../sync/lib/gorgiasDriftCore');

// ── hasOrderHistory ──
//
// The regression this pins: Gorgias's spam detector flags real customers, and
// both intake paths used to drop the ticket on that flag alone — a refund
// request sat invisible for six weeks. The override is a mechanical orders
// lookup; the tests pin its fail-soft direction (unknown, never a throw) so a
// broken read defers the sender to nightly triage instead of crashing intake.

function supabaseStub(result) {
  return {
    from: () => ({
      select: () => ({
        ilike: (col, val) => ({
          limit: () => Promise.resolve(typeof result === 'function' ? result(val) : result),
        }),
      }),
    }),
  };
}

test('hasOrderHistory: an email with an order is a known customer', async () => {
  const sb = supabaseStub({ data: [{ order_number: 32246 }], error: null });
  assert.strictEqual(await hasOrderHistory(sb, 'hera.sey@pm.me'), true);
});

test('hasOrderHistory: no orders → unknown sender', async () => {
  const sb = supabaseStub({ data: [], error: null });
  assert.strictEqual(await hasOrderHistory(sb, 'vendor@pitch.example'), false);
});

test('hasOrderHistory: empty/missing email is never a customer', async () => {
  const sb = supabaseStub({ data: [{ order_number: 1 }], error: null });
  assert.strictEqual(await hasOrderHistory(sb, ''), false);
  assert.strictEqual(await hasOrderHistory(sb, null), false);
  assert.strictEqual(await hasOrderHistory(sb, '   '), false);
});

test('hasOrderHistory: lookup error fails soft to unknown, not a throw', async () => {
  const sbErr = supabaseStub({ data: null, error: { message: 'boom' } });
  assert.strictEqual(await hasOrderHistory(sbErr, 'a@b.c'), false);

  const sbThrow = { from: () => { throw new Error('network down'); } };
  assert.strictEqual(await hasOrderHistory(sbThrow, 'a@b.c'), false);
});

test('hasOrderHistory: match is case-insensitive equality (ilike, no wildcards added)', async () => {
  let seenValue = null;
  const sb = supabaseStub(val => { seenValue = val; return { data: [{ order_number: 1 }], error: null }; });
  await hasOrderHistory(sb, '  Hera.Sey@PM.me ');
  assert.strictEqual(seenValue, 'Hera.Sey@PM.me', 'trimmed verbatim — ilike handles case, no % added');
});

// ── fetchOpenSpamTickets ──
//
// The regression this pins: the Gorgias views exclude spam-flagged tickets
// upstream, so the nightly sweep — the safety net — shared the webhook's
// blind spot and a spam-mislabelled customer was invisible to both paths
// permanently. This fetch walks the generic /tickets list (which does return
// them) newest-first until the date floor.

function gorgiasStub(pages) {
  let call = 0;
  return {
    getTickets: async () => {
      const page = pages[call] || { data: [], nextCursor: null };
      call++;
      return page;
    },
    delay: async () => {},
    calls: () => call,
  };
}

const daysAgo = n => new Date(Date.now() - n * 86400000).toISOString();

test('fetchOpenSpamTickets keeps only open + spam-flagged tickets inside the floor', async () => {
  const g = gorgiasStub([
    {
      data: [
        { id: 1, spam: true, status: 'open', created_datetime: daysAgo(1) },
        { id: 2, spam: false, status: 'open', created_datetime: daysAgo(2) },   // not spam
        { id: 3, spam: true, status: 'closed', created_datetime: daysAgo(3) },  // already closed
        { id: 4, spam: 'True', status: 'open', created_datetime: daysAgo(4) },  // template string form
        { id: 5, spam: true, status: 'open', created_datetime: daysAgo(90) },   // beyond floor
      ],
      nextCursor: null,
    },
  ]);
  const found = await fetchOpenSpamTickets(g, { sinceDays: 60 });
  assert.deepStrictEqual(found.map(t => t.id), [1, 4]);
});

test('fetchOpenSpamTickets stops paging once a page crosses the date floor', async () => {
  const g = gorgiasStub([
    { data: [{ id: 1, spam: true, status: 'open', created_datetime: daysAgo(5) }], nextCursor: 'c2' },
    { data: [{ id: 2, spam: true, status: 'open', created_datetime: daysAgo(90) }], nextCursor: 'c3' },
    { data: [{ id: 3, spam: true, status: 'open', created_datetime: daysAgo(120) }], nextCursor: 'c4' },
  ]);
  const found = await fetchOpenSpamTickets(g, { sinceDays: 60 });
  assert.deepStrictEqual(found.map(t => t.id), [1], 'past-floor tickets are excluded');
  assert.strictEqual(g.calls(), 2, 'stops after the page that crossed the floor');
});

test('fetchOpenSpamTickets stops when the cursor runs out', async () => {
  const g = gorgiasStub([
    { data: [{ id: 1, spam: true, status: 'open', created_datetime: daysAgo(1) }], nextCursor: null },
  ]);
  const found = await fetchOpenSpamTickets(g, { sinceDays: 60 });
  assert.deepStrictEqual(found.map(t => t.id), [1]);
  assert.strictEqual(g.calls(), 1);
});

test('fetchOpenSpamTickets respects the page safety cap', async () => {
  const endless = { data: [{ id: 9, spam: true, status: 'open', created_datetime: daysAgo(1) }], nextCursor: 'again' };
  const g = gorgiasStub(Array.from({ length: 50 }, () => endless));
  await fetchOpenSpamTickets(g, { sinceDays: 60, maxPages: 3 });
  assert.strictEqual(g.calls(), 3);
});
