const { test } = require('node:test');
const assert = require('node:assert');
const { computeQueueEntry, assembleQueue } = require('../../b2b-outreach/lib/queue');
const { detectContactLoss, looksLikeOrder } = require('../../b2b-outreach/lib/replyCorrelation');

const NOW = new Date('2026-06-10T12:00:00Z');
const retailer = (over = {}) => ({ id: 'shop-x', name: 'Shop X', relationship_type: 'wholesale', relationship_state: 'active', program_flags: {}, ...over });

test('Tier 1: inbound newer than outbound wins, even when snoozed', () => {
  const c = retailer({ snoozed_until: '2026-07-01' });
  const e = computeQueueEntry(c, { lastInboundAt: '2026-06-10T08:00:00Z', lastOutboundAt: '2026-06-09T00:00:00Z' }, NOW);
  assert.equal(e.tier, 1);
  assert.match(e.reason, /waiting on us/);
});

test('Tier 2: signal beats cadence', () => {
  const c = retailer();
  const e = computeQueueEntry(c, {
    sentTypes: new Set(),
    lastOrderAt: '2026-01-01T00:00:00Z', orderCount: 5, // reorder also due (tier 3)
    signalDue: { message_type: 'price_change_notice', reason: 'pricing change scheduled Jul 1' },
  }, NOW);
  assert.equal(e.tier, 2);
  assert.equal(e.message_type, 'price_change_notice');
});

test('Tier 3: cadence reorder nudge', () => {
  const e = computeQueueEntry(retailer(), { sentTypes: new Set(), lastOrderAt: '2026-02-01T00:00:00Z', orderCount: 3 }, NOW);
  assert.equal(e.tier, 3);
  assert.equal(e.message_type, 'reorder_nudge');
});

test('Tier 5: overdue next_action_date with nothing else due', () => {
  const c = retailer({ next_action_date: '2026-05-30' });
  const e = computeQueueEntry(c, { sentTypes: new Set() }, NOW);
  assert.equal(e.tier, 5);
  assert.match(e.reason, /overdue 11d/);
});

test('Tier 6: dormant revival sorts below everything', () => {
  const dormant = retailer({ id: 'shop-d', relationship_state: 'dormant' });
  const queue = assembleQueue([
    { company: dormant, ctx: { sentTypes: new Set(), newCollectionSinceDormant: false } },
    { company: retailer(), ctx: { lastInboundAt: '2026-06-10T08:00:00Z' } },
  ], NOW);
  assert.equal(queue[0].tier, 1);
  assert.equal(queue[1].tier, 6);
  assert.equal(queue[1].message_type, 'reactivation');
});

test('Tier 1 ordering: oldest unanswered first', () => {
  const queue = assembleQueue([
    { company: retailer({ id: 'b', name: 'B' }), ctx: { lastInboundAt: '2026-06-10T08:00:00Z' } },
    { company: retailer({ id: 'a', name: 'A' }), ctx: { lastInboundAt: '2026-06-09T08:00:00Z' } },
  ], NOW);
  assert.deepEqual(queue.map(q => q.company_id), ['a', 'b']);
});

test('lost companies never queue', () => {
  assert.equal(computeQueueEntry(retailer({ relationship_state: 'lost' }), { lastInboundAt: '2026-06-10T08:00:00Z' }, NOW), null);
});

test('detectContactLoss: bounces and departures', () => {
  assert.equal(detectContactLoss({ from: 'mailer-daemon@googlemail.com', subject: 'Delivery Status Notification (Failure)', body: 'address not found' }), 'hard_bounce');
  assert.equal(detectContactLoss({ from: 'auto@org.org', body: 'Kim is no longer with the organization. Please contact info@org.org going forward.' }), 'departed');
  assert.equal(detectContactLoss({ from: 'kim@org.org', body: 'Thanks so much, ordering next week!' }), null);
});

test('looksLikeOrder: item lines and PO mentions', () => {
  assert.equal(looksLikeOrder('2 x AJ size 10 black\n3 x Ruby size M pink\nthanks!'), true);
  assert.equal(looksLikeOrder('Please find our PO #4451 attached'), true);
  assert.equal(looksLikeOrder('Love the samples, will be in touch!'), false);
});
