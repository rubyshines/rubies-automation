'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  failedAgentMessages,
  partitionBouncedDrift,
  isStatusInSync,
} = require('../sync/lib/gorgiasDriftCore');

// ── failedAgentMessages ──

test('failedAgentMessages keeps only agent messages that failed to deliver', () => {
  const msgs = [
    { id: 1, from_agent: false, failed_datetime: null },
    { id: 2, from_agent: true, failed_datetime: null },              // delivered fine
    { id: 3, from_agent: true, failed_datetime: '2026-08-12T03:00:00Z' },
    { id: 4, from_agent: false, failed_datetime: '2026-08-12T03:00:00Z' }, // inbound, not ours
  ];
  assert.deepStrictEqual(failedAgentMessages(msgs).map(m => m.id), [3]);
});

test('failedAgentMessages tolerates missing/empty message lists', () => {
  assert.deepStrictEqual(failedAgentMessages(undefined), []);
  assert.deepStrictEqual(failedAgentMessages([]), []);
});

// ── partitionBouncedDrift ──
//
// The regression this pins: Gorgias reopens a ticket when our reply bounces, so
// a ticket we answered and closed shows G:open / A:closed at the next sync. That
// is real drift by the status check, but it is NOT a missed customer — and
// driftTriage has no 'bounced' disposition, so it falls through to real_miss and
// alarms in the digest alongside the (correct) undelivered report. One event,
// reported twice, one of them frightening and wrong.

const drift = (id, email, reason = 'status drift (G:open → A:closed)') => ({
  ticket: { id, customer: { email } },
  reason,
});

test('bounced drift is routed to undelivered, never left as a real miss', () => {
  const items = [drift(112327347, 'melanie.b2005@outlook.com')];
  const { driftToTriage, bounceResolved } = partitionBouncedDrift(items, new Set([112327347]));

  assert.deepStrictEqual(driftToTriage, [], 'bounced ticket must not reach triage');
  assert.strictEqual(bounceResolved.length, 1);
  assert.strictEqual(bounceResolved[0].ticketId, 112327347);
  assert.strictEqual(bounceResolved[0].email, 'melanie.b2005@outlook.com');
  assert.strictEqual(bounceResolved[0].disposition, 'undelivered');
});

test('drift with no bounce still reaches triage untouched', () => {
  const items = [drift(1, 'a@example.com'), drift(2, 'b@example.com')];
  const { driftToTriage, bounceResolved } = partitionBouncedDrift(items, new Set());

  assert.deepStrictEqual(driftToTriage, items, 'non-bounced drift must pass through by reference');
  assert.deepStrictEqual(bounceResolved, []);
});

test('a mixed batch splits without losing or duplicating any ticket', () => {
  const items = [drift(1, 'a@example.com'), drift(2, 'b@example.com'), drift(3, 'c@example.com')];
  const { driftToTriage, bounceResolved } = partitionBouncedDrift(items, new Set([2]));

  assert.deepStrictEqual(driftToTriage.map(i => i.ticket.id), [1, 3]);
  assert.deepStrictEqual(bounceResolved.map(b => b.ticketId), [2]);
  assert.strictEqual(driftToTriage.length + bounceResolved.length, items.length);
});

test('a bounce on a ticket that is NOT drifting produces nothing to resolve', () => {
  // The undelivered sweep covers every open ticket, so bouncedIds routinely
  // holds ids that never drifted. Those must not appear as auto-resolved drift.
  const { driftToTriage, bounceResolved } = partitionBouncedDrift([], new Set([99]));
  assert.deepStrictEqual(driftToTriage, []);
  assert.deepStrictEqual(bounceResolved, []);
});

test('partitionBouncedDrift tolerates missing inputs', () => {
  assert.deepStrictEqual(partitionBouncedDrift(undefined, new Set()), { driftToTriage: [], bounceResolved: [] });
  assert.deepStrictEqual(partitionBouncedDrift([], undefined), { driftToTriage: [], bounceResolved: [] });
  const items = [drift(1, 'a@example.com')];
  assert.deepStrictEqual(partitionBouncedDrift(items, undefined).driftToTriage, items);
});

test('a ticket with no customer email still resolves with a placeholder', () => {
  const items = [{ ticket: { id: 7 }, reason: 'status drift (G:open → A:closed)' }];
  const { bounceResolved } = partitionBouncedDrift(items, new Set([7]));
  assert.strictEqual(bounceResolved[0].email, '?');
});

// ── the status rule that turns a bounce into drift in the first place ──

test('G:open / A:closed is drift — which is why the bounce reopen surfaces', () => {
  assert.strictEqual(isStatusInSync('open', 'closed'), false);
  assert.strictEqual(isStatusInSync('open', 'snoozed'), true);
  assert.strictEqual(isStatusInSync('closed', 'closed'), true);
});
