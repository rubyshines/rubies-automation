'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { replayGorgiasDeadLetters } = require('../../lib/replayDeadLetters');

const NOW = new Date('2026-06-29T12:00:00Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

function harness(pending, { failTicketIds = [] } = {}) {
  const removed = [];
  const updated = [];
  const handler = async (payload) => {
    if (failTicketIds.includes(payload?.ticket?.id)) throw new Error('still broken');
  };
  const supabase = {
    from: () => ({ update: (vals) => ({ eq: async () => { updated.push(vals); return { error: null }; } }) }),
  };
  return {
    removed, updated,
    opts: { now: NOW, handler, supabase, listFn: async () => pending, removeFn: async (id) => removed.push(id) },
  };
}

test('replay: recovers fresh gorgias dead-letters and deletes them', async () => {
  const pending = [
    { id: 'g1', source: 'gorgias', created_at: daysAgo(1), retry_count: 0, payload: { ticket: { id: 111 } } },
  ];
  const h = harness(pending);
  const res = await replayGorgiasDeadLetters(h.opts);
  assert.equal(res.recovered.length, 1);
  assert.equal(res.recovered[0].ticketId, 111);
  assert.deepEqual(h.removed, ['g1']);
  assert.equal(res.stillFailing.length, 0);
});

test('replay: a failing entry is kept and its retry_count bumped', async () => {
  const pending = [
    { id: 'g2', source: 'gorgias', created_at: daysAgo(2), retry_count: 1, payload: { ticket: { id: 222 } } },
  ];
  const h = harness(pending, { failTicketIds: [222] });
  const res = await replayGorgiasDeadLetters(h.opts);
  assert.equal(res.recovered.length, 0);
  assert.equal(res.stillFailing.length, 1);
  assert.equal(res.stillFailing[0].ticketId, 222);
  assert.deepEqual(h.removed, []);
  assert.equal(h.updated.length, 1);
  assert.equal(h.updated[0].retry_count, 2);
});

test('replay: skips stale entries beyond the age window', async () => {
  const pending = [
    { id: 'old', source: 'gorgias', created_at: daysAgo(30), retry_count: 0, payload: { ticket: { id: 333 } } },
  ];
  const h = harness(pending);
  const res = await replayGorgiasDeadLetters(h.opts);
  assert.equal(res.staleSkipped, 1);
  assert.equal(res.recovered.length, 0);
  assert.deepEqual(h.removed, []);
});

test('replay: ignores non-gorgias sources', async () => {
  const pending = [
    { id: 's1', source: 'shopify', created_at: daysAgo(1), retry_count: 0, payload: { id: 999 } },
  ];
  const h = harness(pending);
  const res = await replayGorgiasDeadLetters(h.opts);
  assert.equal(res.totalGorgias, 0);
  assert.equal(res.recovered.length, 0);
});

test('replay: mixed batch partitions correctly', async () => {
  const pending = [
    { id: 'g1', source: 'gorgias', created_at: daysAgo(1), retry_count: 0, payload: { ticket: { id: 111 } } },
    { id: 'g2', source: 'gorgias', created_at: daysAgo(2), retry_count: 0, payload: { ticket: { id: 222 } } },
    { id: 'old', source: 'gorgias', created_at: daysAgo(30), retry_count: 0, payload: { ticket: { id: 333 } } },
    { id: 's1', source: 'shopify', created_at: daysAgo(1), retry_count: 0, payload: {} },
  ];
  const h = harness(pending, { failTicketIds: [222] });
  const res = await replayGorgiasDeadLetters(h.opts);
  assert.equal(res.totalGorgias, 3);
  assert.equal(res.recovered.length, 1);
  assert.equal(res.stillFailing.length, 1);
  assert.equal(res.staleSkipped, 1);
  assert.deepEqual(h.removed, ['g1']);
});
