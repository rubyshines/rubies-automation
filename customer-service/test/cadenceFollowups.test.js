/**
 * The follow-up ladder: what it chases, what it refuses to chase, and how it
 * ends. Each case here corresponds to a real row in b2b_companies as of the
 * build (2026-08-26) — the shapes are not invented.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const {
  evaluateDue, followUpRung, exhaustedDecision, answeredSince,
  FOLLOWUP_MAX_AGE_DAYS,
} = require('../../b2b-outreach/lib/cadence');

const NOW = new Date('2026-08-26T12:00:00Z'); // Wednesday

const org = (over = {}) => ({
  id: 'org-1', relationship_type: 'lgbtq_org', relationship_state: 'in_contact',
  program_flags: {}, ...over,
});
const retailer = (over = {}) => ({
  id: 'ret-1', relationship_type: 'wholesale', relationship_state: 'prospect',
  program_flags: {}, ...over,
});

/** ctx whose newest message is an engine send of `type` at `at`, unanswered. */
const sent = (type, at, over = {}) => ({
  sentTypes: new Set([type]),
  lastTypeSentAt: t => (t === type ? at : null),
  lastOutboundType: type,
  lastOutboundSource: 'send_tool',
  lastOutboundMessageAt: at,
  lastOutboundThreadId: 'th-1',
  lastOutboundAt: at,
  lastInboundAt: null,
  unansweredRun: 1,
  unansweredRunSince: at,
  ...over,
});

// ── what it chases ──────────────────────────────────────────────────────────

test('an unanswered intro is chased after 5 business days', () => {
  // Trans Pride Brighton, Not A Phase, The Q Corner: intro_outreach 28-29d ago.
  const c = org();
  const due = evaluateDue(c, sent('intro_outreach', '2026-07-28T00:00:00Z'), NOW);
  assert.equal(due.message_type, 'followup_1');
  assert.equal(due.thread_id, 'th-1', 'the chase must land in the thread it chases');
});

test('a partner check-in waits twice as long before being chased', () => {
  // A partner is not a lead being worked. Sent Fri 21 Aug; Wed 26 Aug is 3
  // business days — too soon on the relationship beat, due on the cold one.
  const partner = org({ relationship_state: 'active', program_flags: { donation_closet: true } });
  assert.equal(evaluateDue(partner, sent('community_checkin', '2026-08-21T00:00:00Z'), NOW), null);
  // Sent Wed 12 Aug → 10 business days by Wed 26 Aug.
  const due = evaluateDue(partner, sent('community_checkin', '2026-08-12T00:00:00Z'), NOW);
  assert.equal(due.message_type, 'followup_1');
});

test('a years-old reply does not count as an answer to last week', () => {
  // THE regression. P10 Qc replied in May 2022 and was sent a check-in on 19
  // Aug 2026; `answered = !!lastInboundAt` made it permanently unchaseable, and
  // the queue showed nothing rather than showing a bug.
  const partner = org({ relationship_state: 'active', program_flags: { donation_closet: true } });
  const ctx = sent('community_checkin', '2026-08-12T00:00:00Z', { lastInboundAt: '2022-05-12T00:00:00Z' });
  assert.equal(evaluateDue(partner, ctx, NOW).message_type, 'followup_1');
  assert.equal(answeredSince(ctx, '2026-08-12T00:00:00Z'), false);
});

test('followup_1 leads to followup_2 after 10 business days', () => {
  const c = org();
  assert.equal(evaluateDue(c, sent('followup_1', '2026-08-24T00:00:00Z'), NOW), null, 'too soon');
  assert.equal(evaluateDue(c, sent('followup_1', '2026-08-10T00:00:00Z'), NOW).message_type, 'followup_2');
});

// ── what it refuses to chase ────────────────────────────────────────────────

test('a graceful close is never chased', () => {
  // TransActual and SoCirC: they answered, we closed. This is the case the
  // all-time `answered` flag was protecting, now handled precisely.
  const c = org({ relationship_state: 'active' });
  assert.equal(followUpRung(c, sent('reply_close', '2026-07-01T00:00:00Z'), NOW), null);
});

test('a manual Gmail send is never chased — it does not say what was asked', () => {
  // 51 of 60 unanswered threads are manual sends carrying message_type null.
  // Chasing one means guessing whether it was an intro or a goodbye.
  const c = org();
  const manual = sent('intro_outreach', '2026-07-28T00:00:00Z', {
    lastOutboundSource: 'manual_send', lastOutboundType: null,
  });
  assert.equal(followUpRung(c, manual, NOW), null);
  // Even a typed message reconciled from a manual send stays out.
  const typedManual = sent('intro_outreach', '2026-07-28T00:00:00Z', { lastOutboundSource: 'manual_send' });
  assert.equal(followUpRung(c, typedManual, NOW), null);
});

test('an ask older than the ceiling is a re-approach, not a follow-up', () => {
  // The ~32 retailers emailed 189 days ago, and org threads up to 1575 days
  // old. "Just following up" on a conversation from 2022 reads badly.
  const c = org();
  const old = new Date(NOW.getTime() - (FOLLOWUP_MAX_AGE_DAYS + 1) * 86400000).toISOString();
  assert.equal(followUpRung(c, sent('intro_outreach', old), NOW), null);
  const justInside = new Date(NOW.getTime() - (FOLLOWUP_MAX_AGE_DAYS - 1) * 86400000).toISOString();
  assert.equal(followUpRung(c, sent('intro_outreach', justInside), NOW).message_type, 'followup_1');
});

test('a reply after the ask ends the ladder', () => {
  const c = org();
  const answered = sent('intro_outreach', '2026-07-28T00:00:00Z', { lastInboundAt: '2026-07-30T00:00:00Z' });
  assert.equal(followUpRung(c, answered, NOW), null);
});

test('a deferred company is never chased', () => {
  // Transgender Victoria is snoozed. Pause, snooze, on-me and a booked meeting
  // all suppress everything the engine would START.
  const snoozed = org({ relationship_state: 'active', snoozed_until: '2026-12-01' });
  assert.equal(evaluateDue(snoozed, sent('donation_closet_pitch', '2026-07-25T00:00:00Z'), NOW), null);
  const paused = org({ outreach_paused_at: '2026-08-01T00:00:00Z' });
  assert.equal(evaluateDue(paused, sent('intro_outreach', '2026-07-28T00:00:00Z'), NOW), null);
  const claimed = org({ on_me_at: '2026-08-01T00:00:00Z' });
  assert.equal(evaluateDue(claimed, sent('intro_outreach', '2026-07-28T00:00:00Z'), NOW), null);
});

test('a company mid-ladder never gets a cold intro underneath its own sequence', () => {
  // sentTypes holds only 'followup_1', so the old first-touch lookup found no
  // first-touch type and fired intro_pitch at a vetted prospect already being
  // chased.
  const c = retailer({ relationship_state: 'prospect', vetted_at: '2026-05-01T00:00:00Z' });
  const due = evaluateDue(c, sent('followup_1', '2026-08-24T00:00:00Z'), NOW);
  assert.equal(due, null, 'too soon for followup_2, and certainly not an intro');
  const spent = evaluateDue(c, sent('followup_2', '2026-08-01T00:00:00Z'), NOW);
  assert.equal(spent, null);
});

// ── how it ends ─────────────────────────────────────────────────────────────

test('a lead that never answered is retired, never marked lost', () => {
  const c = retailer({ relationship_state: 'in_contact' });
  const ctx = sent('followup_2', '2026-08-10T00:00:00Z', { unansweredRun: 3, unansweredRunSince: '2026-07-01T00:00:00Z' });
  const d = exhaustedDecision(c, ctx, NOW);
  assert.equal(d.decision, 'retire');
  assert.match(d.reason, /3 messages since 2026-07-01/);
  assert.equal(d.note, undefined, 'a retired lead needs no note — nobody is going to work it');
});

test('an active partner is handed over, not retired', () => {
  // Retiring an org we ship donation boxes to because a summer check-in went
  // unread would mute the engine on the relationship most worth keeping.
  const partner = org({ relationship_state: 'active', program_flags: { donation_closet: true } });
  const ctx = sent('followup_2', '2026-08-10T00:00:00Z', { unansweredRun: 3, unansweredRunSince: '2026-07-01T00:00:00Z' });
  const d = exhaustedDecision(partner, ctx, NOW);
  assert.equal(d.decision, 'hand_off');
  assert.match(d.note, /3 unanswered since 2026-07-01/);
  assert.match(d.note, /contact may have moved on/, 'points at the standing org failure mode');
});

test('the ladder does not end early — 10 business days after followup_2', () => {
  const c = retailer({ relationship_state: 'in_contact' });
  assert.equal(exhaustedDecision(c, sent('followup_2', '2026-08-24T00:00:00Z'), NOW), null);
});

test('a reply rescues a company from the end of the ladder', () => {
  const c = retailer({ relationship_state: 'in_contact' });
  const ctx = sent('followup_2', '2026-08-10T00:00:00Z', { lastInboundAt: '2026-08-20T00:00:00Z' });
  assert.equal(exhaustedDecision(c, ctx, NOW), null, 'they answered — Tier 1 owns this now');
});

test('exhaustion only ever fires on an engine-sent followup_2', () => {
  const c = retailer({ relationship_state: 'in_contact' });
  assert.equal(exhaustedDecision(c, sent('intro_outreach', '2026-05-01T00:00:00Z'), NOW), null);
  assert.equal(exhaustedDecision(c, sent('followup_2', '2026-08-01T00:00:00Z', { lastOutboundSource: 'manual_send' }), NOW), null);
});
