const { test } = require('node:test');
const assert = require('node:assert');
const {
  statedNextTouch, withoutStatedNextTouch, resolveNextActionDate, nextActionDateAfterSend, STATED_TOUCH_MIN_LEAD_DAYS, nextScheduledTouch,
} = require('../../b2b-outreach/lib/cadence');
const { computeQueueEntry } = require('../../b2b-outreach/lib/queue');
const {
  statedNextTouchFromOutput, weAnswered, renderSummaryPrompt, OUTPUT_SCHEMA,
} = require('../../b2b-outreach/lib/relationshipSummary');

const NOW = new Date('2026-09-08T15:00:00Z');
const org = (over = {}) => ({
  id: 'genderswap', name: 'G(END)ER SWAP', relationship_type: 'lgbtq_org', relationship_state: 'in_contact', program_flags: {}, ...over,
});
const stated = (date, basis = 'we will be re-launching things in the new year') => ({ metadata: { stated_next_touch: { date, basis } } });

// ── cadence: reading the stated date ────────────────────────────────────────

test('a stated date well ahead is honoured, with their words', () => {
  const r = statedNextTouch(org(stated('2027-01-15')), NOW);
  assert.deepEqual(r, { date: '2027-01-15', basis: 'we will be re-launching things in the new year' });
});

test('a stated date that has passed, or sits inside the lead window, is consumed rather than honoured', () => {
  assert.equal(statedNextTouch(org(stated('2026-09-01')), NOW), null);
  const tooClose = new Date(NOW.getTime() + (STATED_TOUCH_MIN_LEAD_DAYS - 1) * 86400000).toISOString().slice(0, 10);
  assert.equal(statedNextTouch(org(stated(tooClose)), NOW), null);
  const justEnough = new Date(NOW.getTime() + (STATED_TOUCH_MIN_LEAD_DAYS + 1) * 86400000).toISOString().slice(0, 10);
  assert.equal(statedNextTouch(org(stated(justEnough)), NOW).date, justEnough);
});

test('garbage in metadata is ignored, never thrown on', () => {
  assert.equal(statedNextTouch(org(), NOW), null);
  assert.equal(statedNextTouch(org({ metadata: null }), NOW), null);
  assert.equal(statedNextTouch(org({ metadata: { stated_next_touch: 'January' } }), NOW), null);
  assert.equal(statedNextTouch(org({ metadata: { stated_next_touch: { date: 'next year' } } }), NOW), null);
  assert.equal(statedNextTouch(org({ metadata: { stated_next_touch: { date: '2027-13-45' } } }), NOW), null);
});

test('withoutStatedNextTouch strips only that key', () => {
  assert.deepEqual(withoutStatedNextTouch({ reorder_threshold_days: 120, stated_next_touch: { date: '2027-01-15' } }), { reorder_threshold_days: 120 });
  assert.deepEqual(withoutStatedNextTouch({ reorder_threshold_days: 120 }), { reorder_threshold_days: 120 });
  assert.equal(withoutStatedNextTouch(null), null);
});

// ── cadence: what a send stamps ─────────────────────────────────────────────

test('a reply with no stated date gets the per-type table, as before', () => {
  const r = resolveNextActionDate({ message_type: 'operator_message', sentAt: NOW, company: org() });
  assert.equal(r.source, 'cadence');
  assert.equal(r.date, nextActionDateAfterSend('operator_message', NOW));
});

test('the date they stated outranks the table', () => {
  const r = resolveNextActionDate({ message_type: 'operator_message', sentAt: NOW, company: org(stated('2027-01-15')) });
  assert.deepEqual(r, { date: '2027-01-15', source: 'stated', basis: 'we will be re-launching things in the new year' });
});

test("the advisor's explicit override outranks the stated date — the operator saw it before sending", () => {
  const r = resolveNextActionDate({ message_type: 'community_checkin', sentAt: NOW, next_touch_days: 45, company: org(stated('2027-01-15')) });
  assert.equal(r.source, 'advisor');
  assert.equal(r.date, nextActionDateAfterSend('community_checkin', NOW, 45));
});

test('a stated date the send itself acts on falls back to the table (COLAGE in September)', () => {
  const r = resolveNextActionDate({ message_type: 'community_checkin', sentAt: NOW, company: org(stated('2026-09-01', 'Do you have time to meet in September?')) });
  assert.equal(r.source, 'cadence');
});

// ── queue: Tier 5 says whose date it was ────────────────────────────────────

test('Tier 5 on a date they named carries their words and a drafting hint', () => {
  const c = org({ next_action_date: '2026-09-01', ...stated('2026-09-01', 'Do you have time to meet in September?') });
  const e = computeQueueEntry(c, { sentTypes: new Set(), lastOutboundAt: '2026-07-16T02:54:55Z', lastInboundAt: '2026-07-15T14:49:37Z' }, NOW);
  assert.equal(e.tier, 5);
  assert.match(e.reason, /they asked us to reach back around 2026-09-01/);
  assert.match(e.reason, /meet in September/);
  assert.match(e.task_hint, /do not write it as a reply/);
});

test('Tier 5 on a cadence date reads as before, and a stale stated date does not hijack it', () => {
  const plain = computeQueueEntry(org({ next_action_date: '2026-08-28' }), { sentTypes: new Set(), lastOutboundAt: '2026-07-29T00:00:00Z' }, NOW);
  assert.equal(plain.tier, 5);
  assert.match(plain.reason, /^reminder date passed 11d ago/);
  assert.equal(plain.task_hint, undefined);
  const mismatched = computeQueueEntry(org({ next_action_date: '2026-08-28', ...stated('2026-06-01') }), { sentTypes: new Set(), lastOutboundAt: '2026-07-29T00:00:00Z' }, NOW);
  assert.match(mismatched.reason, /^reminder date passed/);
});

test('while they are waiting on us, a stated date changes nothing — Tier 1 still wins', () => {
  const c = org({ next_action_date: '2027-01-15', ...stated('2027-01-15') });
  const e = computeQueueEntry(c, { lastInboundAt: '2026-09-08T10:00:00Z', lastOutboundAt: null }, NOW);
  assert.equal(e.tier, 1);
});

// ── summary: recording at intake ────────────────────────────────────────────

test('the schema demands stated_next_touch and the prompt explains how to resolve vague timing', () => {
  assert.ok(OUTPUT_SCHEMA.required.includes('stated_next_touch'));
  const p = renderSummaryPrompt({
    company: org(), mode: 'full', now: NOW,
    messages: [{ direction: 'inbound', from_email: 'info@genderswap.org', body_text: 'we will be re-launching things in the new year', sent_at: '2026-09-08T10:00:00Z' }],
  });
  assert.match(p, /stated_next_touch/);
  assert.match(p, /15 January of the next year/);
  assert.match(p, /A date we proposed does not count/);
});

test('a well-formed future date is stored with their words and a stamp; anything else is null', () => {
  const r = statedNextTouchFromOutput({ stated_next_touch: { date: '2027-01-15', basis: '  we will be re-launching things in the new year ' } }, NOW);
  assert.equal(r.date, '2027-01-15');
  assert.equal(r.basis, 'we will be re-launching things in the new year');
  assert.equal(r.stated_at, NOW.toISOString());
  assert.equal(statedNextTouchFromOutput({ stated_next_touch: null }, NOW), null);
  assert.equal(statedNextTouchFromOutput({ stated_next_touch: { date: '2026-09-01', basis: 'September' } }, NOW), null); // past
  assert.equal(statedNextTouchFromOutput({ stated_next_touch: { date: '2026-09-08', basis: 'today' } }, NOW), null);     // not strictly ahead
  assert.equal(statedNextTouchFromOutput({ stated_next_touch: { date: 'January', basis: 'x' } }, NOW), null);
  assert.equal(statedNextTouchFromOutput({}, NOW), null);
});

test('weAnswered: the newest HUMAN message decides, machine inbound does not reopen', () => {
  const inbound = (sent_at, message_type = null) => ({ direction: 'inbound', message_type, sent_at });
  const outbound = (sent_at) => ({ direction: 'outbound', message_type: null, sent_at });
  assert.equal(weAnswered([inbound('2026-09-08T10:00:00Z')]), false);
  assert.equal(weAnswered([inbound('2026-09-08T10:00:00Z'), outbound('2026-09-08T12:00:00Z')]), true);
  assert.equal(weAnswered([outbound('2026-09-08T12:00:00Z'), inbound('2026-09-08T12:01:00Z', 'auto_reply')]), true);
  assert.equal(weAnswered([outbound('2026-09-08T12:00:00Z'), inbound('2026-09-09T12:01:00Z')]), false);
  assert.equal(weAnswered([]), false);
});

test('the header prediction names the touch they asked for, even before a close applies it', () => {
  const t = nextScheduledTouch(org(stated('2027-01-15')), {}, NOW);
  assert.deepEqual(t, { message_type: 'stated_touch', date: '2027-01-15', label: 'touch they asked for' });
  assert.equal(nextScheduledTouch(org(), {}, NOW), null);
  assert.equal(nextScheduledTouch(org(stated('2026-06-01')), {}, NOW), null); // behind us: not a prediction
});
