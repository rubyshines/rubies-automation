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
  assert.equal(e.message_type, null);
  // A reminder, not a task: the reason says so and names the send that set it.
  assert.match(e.reason, /reminder date passed 11d ago/);
  assert.match(e.reason, /nothing specific is due/);
  const dated = computeQueueEntry(c, { sentTypes: new Set(), lastOutboundAt: '2026-04-30T15:00:00Z' }, NOW);
  assert.match(dated.reason, /set when you wrote on Apr 30/);
});

test('Tier 5: clearing the reminder date takes the company out of the queue', () => {
  // The clear_due triage patch is exactly this — and nothing else on the row
  // moves, so an active account must not fall into the never-contacted lane.
  const c = retailer({ next_action_date: null, vetted_at: null, last_outbound_at: '2026-04-30T15:00:00Z' });
  const e = computeQueueEntry(c, { sentTypes: new Set(), lastOutboundAt: '2026-04-30T15:00:00Z' }, NOW);
  assert.equal(e, null);
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

// ── unreachable companies must not go quiet ─────────────────────────────────
// `contact_unknown` makes companyEligible() false and renders nowhere, so before
// this branch a company whose only contact bounced or resigned dropped silently
// out of the system — going quiet about a partner at the exact moment we learned
// something urgent about them.

test('Tier 1: no working address surfaces despite the eligibility gate', () => {
  const c = retailer({ contact_unknown: true });
  const e = computeQueueEntry(c, { sentTypes: new Set(), lastUndeliveredAt: '2026-06-01T00:00:00Z' }, NOW);
  assert.equal(e.tier, 1);
  assert.match(e.reason, /no working address/);
  assert.match(e.reason, /bounced 10d ago/);
  assert.equal(e.waiting_since, '2026-06-01T00:00:00Z', 'Tier 1 sorts on this');
});

test('a departure reads as "left", never as a bounce', () => {
  // The send reached a mailbox whose owner had gone; the notice said so. Calling
  // that a bounce sent the operator looking for a DSN that does not exist.
  const e = computeQueueEntry(retailer({ contact_unknown: true }), {
    sentTypes: new Set(), lastUndeliveredAt: '2026-06-01T00:00:00Z',
    lastUndeliveredReason: 'recipient left the organisation',
  }, NOW);
  assert.equal(e.tier, 1);
  assert.match(e.reason, /left the organisation, notice 10d ago/);
  assert.doesNotMatch(e.reason, /bounced/);
});

test('a company with no working address and no bounce date still surfaces', () => {
  // The "X has left, contact Y" path knows nothing died on a given date.
  const e = computeQueueEntry(retailer({ contact_unknown: true }), { sentTypes: new Set() }, NOW);
  assert.equal(e.tier, 1);
  assert.match(e.reason, /bounced or left/);
});

test('deferring still outranks an unreachable address', () => {
  // Deciding not to work a relationship covers not chasing a dead address at it.
  const paused = retailer({ contact_unknown: true, outreach_paused_at: '2026-06-01T00:00:00Z' });
  assert.equal(computeQueueEntry(paused, { sentTypes: new Set() }, NOW), null);
  const claimed = retailer({ contact_unknown: true, on_me_at: '2026-06-01T00:00:00Z' });
  assert.equal(computeQueueEntry(claimed, { sentTypes: new Set() }, NOW), null);
});

test('a real reply still beats the unreachable branch', () => {
  // Someone wrote in from another address: they are not unreachable at all.
  const c = retailer({ contact_unknown: true });
  const e = computeQueueEntry(c, {
    lastInboundAt: '2026-06-10T08:00:00Z', lastOutboundAt: '2026-06-09T00:00:00Z',
  }, NOW);
  assert.equal(e.tier, 1);
  assert.match(e.reason, /waiting on us/, 'the human, not the mail server');
});

test('a reminder row replies inside the newest open thread when there is one (2026-09-09)', () => {
  const { computeQueueEntry } = require('../../b2b-outreach/lib/queue');
  const now = new Date('2026-09-09T12:00:00Z');
  const co = { id: 'c', name: 'C', relationship_type: 'wholesale', relationship_state: 'in_contact', next_action_date: '2026-09-08' };
  const withThread = computeQueueEntry(co, { newestOpenThreadId: 'th-7' }, now);
  assert.equal(withThread.tier, 5);
  assert.equal(withThread.thread_id, 'th-7');
  const without = computeQueueEntry(co, {}, now);
  assert.equal(without.tier, 5);
  assert.equal(without.thread_id, undefined, 'no open thread: a new email, subject typed by the operator');
});

// ── a claim nobody made cannot hide the mail that created it (2026-09-11) ───
//
// On Me is derived from open commitments, and the summariser reads a
// commitment out of an incoming reply. Forbidden Fruit asked for the sample
// kit and pricing at 18:41:47; the claim that reply produced was stamped
// 18:41:58, eleven seconds later — and the queue, which drops a reply older
// than the deferral on the reasoning that the operator deferred knowing it was
// there, dropped the newest mail in the system. Provenance decides, not the
// clock: a person's claim may suppress, a machine's may not.
const CLAIM = '2026-06-10T09:00:00Z';
const REPLY_BEFORE = { lastInboundAt: '2026-06-10T08:59:49Z', lastOutboundAt: '2026-06-09T00:00:00Z' };

test('an engine-made claim never suppresses an unanswered reply', () => {
  const c = retailer({ on_me_at: CLAIM, on_me_source: 'engine' });
  const e = computeQueueEntry(c, REPLY_BEFORE, NOW);
  assert.ok(e, 'the reply that created the claim must still be queue work');
  assert.equal(e.tier, 1);
  assert.match(e.reason, /waiting on us/);
});

test('an operator claim still suppresses a reply that predates it', () => {
  // Unchanged, and the reason the rule exists: Jamie saw the mail and claimed
  // the row anyway, so the queue must not hand it back to him.
  const c = retailer({ on_me_at: CLAIM, on_me_source: 'operator' });
  assert.equal(computeQueueEntry(c, REPLY_BEFORE, NOW), null);
});

test('a claim with no source recorded reads as the operator’s', () => {
  // Rows predate the marker; every one of those claims was hand-made.
  const c = retailer({ on_me_at: CLAIM });
  assert.equal(computeQueueEntry(c, REPLY_BEFORE, NOW), null);
});

test('a reply landing after an engine claim surfaces too', () => {
  const c = retailer({ on_me_at: CLAIM, on_me_source: 'engine' });
  const e = computeQueueEntry(c, { lastInboundAt: '2026-06-10T10:00:00Z', lastOutboundAt: '2026-06-09T00:00:00Z' }, NOW);
  assert.equal(e.tier, 1);
});

test('an engine claim does not resurrect a company with nothing waiting', () => {
  // The claim is not a free pass back into the queue — it only stops being a
  // reason to HIDE. With the last word ours, there is still nothing due.
  const c = retailer({ on_me_at: CLAIM, on_me_source: 'engine' });
  const ctx = { sentTypes: new Set(), lastInboundAt: '2026-06-08T00:00:00Z', lastOutboundAt: '2026-06-09T00:00:00Z' };
  assert.equal(computeQueueEntry(c, ctx, NOW), null);
});

test('a pause still suppresses whoever put the claim there', () => {
  // Pause is always a deliberate act, and it is the later stamp here.
  const c = retailer({ on_me_at: CLAIM, on_me_source: 'engine', outreach_paused_at: '2026-06-10T09:30:00Z' });
  assert.equal(computeQueueEntry(c, REPLY_BEFORE, NOW), null);
});
