const { test } = require('node:test');
const assert = require('node:assert');
const { computeTriage } = require('../../b2b-outreach/lib/triage');
const { renderMetadataFacts } = require('../../b2b-outreach/lib/outreachAdvisor');
const { isUntouchedProspect } = require('../../scripts/assignB2bProspectStates');

const NOW = new Date('2026-08-05T12:00:00Z');

// ── triage ──────────────────────────────────────────────────────────────────

test('keep admits to the queue by stamping vetted_at', () => {
  const upd = computeTriage('keep', { now: NOW });
  assert.equal(upd.vetted_at, NOW.toISOString());
});

test('drop marks lost and demands a reason', () => {
  const upd = computeTriage('drop', { reason: 'shop closed', now: NOW });
  assert.equal(upd.relationship_state, 'lost');
  assert.equal(upd.triage_reason, 'shop closed');
  assert.equal(upd.vetted_at, null, 'a dropped company is not admitted');
  assert.throws(() => computeTriage('drop', { now: NOW }), /requires a reason/);
});

test('snooze validates the date', () => {
  assert.equal(computeTriage('snooze', { until: '2026-12-01', now: NOW }).snoozed_until, '2026-12-01');
  assert.throws(() => computeTriage('snooze', { now: NOW }), /requires an until date/);
  assert.throws(() => computeTriage('snooze', { until: '01/12/2026', now: NOW }), /YYYY-MM-DD/);
  assert.throws(() => computeTriage('snooze', { until: '2026-01-01', now: NOW }), /must be in the future/);
});

test('an unknown action is refused rather than silently ignored', () => {
  assert.throws(() => computeTriage('archive', { now: NOW }), /unknown triage action/);
});

// ── prospect classification ─────────────────────────────────────────────────

const co = (over = {}) => ({
  relationship_state: 'in_contact', last_outbound_at: null, samples_shipped_at: null,
  order_count: 0, ai_summary: null, ...over,
});

test('a never-approached import becomes a prospect', () => {
  assert.equal(isUntouchedProspect(co(), false), true);
});

test('any sign of a relationship keeps it out of the first-touch lane', () => {
  assert.equal(isUntouchedProspect(co({ last_outbound_at: '2026-07-01' }), false), false, 'we emailed them');
  assert.equal(isUntouchedProspect(co(), true), false, 'a thread exists');
  assert.equal(isUntouchedProspect(co({ samples_shipped_at: '2025-11-04' }), false), false, 'samples went out');
  assert.equal(isUntouchedProspect(co({ order_count: 2 }), false), false, 'they bought');
  // This is what keeps the 41 sheet retailers out — they were worked in Feb 2026.
  assert.equal(isUntouchedProspect(co({ ai_summary: 'Sent samples, they loved them but could not expand inventory' }), false), false);
});

test('lost, active and already-prospect rows are left alone', () => {
  for (const s of ['lost', 'active', 'prospect']) {
    assert.equal(isUntouchedProspect(co({ relationship_state: s }), false), false, s);
  }
});

// ── survey metadata reaching the advisor ────────────────────────────────────

test('survey answers render for the advisor', () => {
  const out = renderMetadataFacts({
    size_ranges: 'Youth 4-8, Adult XS - 4X',
    contact_person_title: 'Sam Jean (she/her), Communications & Outreach Manager',
    program_url: 'https://transponder.community/behavioral-health-program/',
  }).join('\n');
  assert.match(out, /What they told us/);
  assert.match(out, /Sizes they said they need: Youth 4-8, Adult XS - 4X/);
  assert.match(out, /Sam Jean/);
  assert.match(out, /Do NOT recite them back as a list/, 'guards against reciting their own details at them');
});

test('prior-outreach history renders for re_approach drafts', () => {
  const out = renderMetadataFacts({
    campaign: 'sample', initial_reach_out: '2025-11-04',
    last_reach_out: '2026-02-18', no_response_count: 2,
  }).join('\n');
  assert.match(out, /Prior outreach on record/);
  assert.match(out, /Times we asked with no reply: 2/);
});

test('stringified metadata still renders — run order must not matter', () => {
  const out = renderMetadataFacts(JSON.stringify({ no_response_count: 3 })).join('\n');
  assert.match(out, /Times we asked with no reply: 3/);
});

test('internal bookkeeping keys never reach the advisor', () => {
  const out = renderMetadataFacts({
    reorder_threshold_days: 302, website_source: 'email_domain',
    klaviyo_list: 'centerlink', backfill: true,
  }).join('\n');
  assert.equal(out, '', 'nothing useful to say — emit nothing rather than noise');
});

test('empty and malformed metadata produce no section', () => {
  assert.deepEqual(renderMetadataFacts(null), []);
  assert.deepEqual(renderMetadataFacts({}), []);
  assert.deepEqual(renderMetadataFacts('not json'), []);
});

// ── deferring outreach: snooze (dated) and pause (indefinite) ────────────────
// Neither is `drop`. A company we have decided not to work is not lost — they
// did not go away, we made a call, and it is ours to reverse.

const { computeQueueEntry, deferredSince } = require('../../b2b-outreach/lib/queue');

test('pause records a reason and is refused without one', () => {
  const upd = computeTriage('pause', { reason: 'not working Canadian retailers this year', now: NOW });
  assert.equal(upd.outreach_paused_at, NOW.toISOString());
  assert.equal(upd.outreach_paused_reason, 'not working Canadian retailers this year');
  assert.equal(upd.relationship_state, undefined, 'pausing must NOT mark them lost');
  assert.throws(() => computeTriage('pause', { now: NOW }), /requires a reason/);
});

test('resume clears every deferral, not just the pause', () => {
  // It used to null only the pause columns, which made the "Resume now" button
  // rendered beside a live snooze a silent no-op.
  const upd = computeTriage('resume', { now: NOW });
  assert.equal(upd.outreach_paused_at, null);
  assert.equal(upd.outreach_paused_reason, null);
  assert.equal(upd.snoozed_until, null);
  assert.equal(upd.snoozed_at, null);
  assert.equal(upd.on_me_at, null);
  assert.equal(upd.on_me_note, null);
});

test('snooze now records when it was set, not just when it lifts', () => {
  const upd = computeTriage('snooze', { until: '2026-12-01', now: NOW });
  assert.equal(upd.snoozed_until, '2026-12-01');
  assert.equal(upd.snoozed_at, NOW.toISOString());
});

const paused = (over = {}) => ({ id: 'x', relationship_state: 'in_contact', ...over });

test('a lapsed snooze stops deferring', () => {
  assert.equal(deferredSince(paused({ snoozed_until: '2026-01-01', snoozed_at: '2025-12-01T00:00:00Z' }), NOW), null);
});

test('a live snooze defers from when it was set', () => {
  const at = '2026-08-01T00:00:00Z';
  assert.equal(deferredSince(paused({ snoozed_until: '2026-12-01', snoozed_at: at }), NOW), at);
});

test('a snooze with no recorded set-time defers nothing', () => {
  // Rows snoozed before snoozed_at existed. Falling back to the END date would
  // suppress a reply that arrived mid-snooze.
  assert.equal(deferredSince(paused({ snoozed_until: '2026-12-01', snoozed_at: null }), NOW), null);
});

// The Bra Room: replied 170 days ago, and Canada is not being worked this year.
test('pausing clears a reply that was already sitting there', () => {
  const co = paused({ outreach_paused_at: '2026-08-05T00:00:00Z' });
  const entry = computeQueueEntry(co, { lastInboundAt: '2026-02-15T00:00:00Z', lastOutboundAt: null }, NOW);
  assert.equal(entry, null, 'an old unanswered reply should stop nagging once paused');
});

// The rule this whole feature has to obey.
test('a reply arriving AFTER the pause still surfaces at Tier 1', () => {
  const co = paused({ outreach_paused_at: '2026-08-01T00:00:00Z' });
  const entry = computeQueueEntry(co, { lastInboundAt: '2026-08-04T00:00:00Z', lastOutboundAt: null }, NOW);
  assert.equal(entry?.tier, 1, 'pausing means stop chasing, never stop listening');
});

// Fenway Health: replied 72 days ago, but we have since spoken on the phone.
test('snoozing clears a stale waiting-on-us but not a fresh one', () => {
  const co = paused({ snoozed_until: '2026-09-15', snoozed_at: '2026-08-04T00:00:00Z' });
  assert.equal(computeQueueEntry(co, { lastInboundAt: '2026-06-01T00:00:00Z' }, NOW), null);
  assert.equal(
    computeQueueEntry(co, { lastInboundAt: '2026-08-04T12:00:00Z' }, NOW)?.tier, 1,
    'they wrote again after we snoozed — that is new information');
});

test('a paused company is off the cadence entirely, not just off Tier 1', () => {
  const co = paused({ outreach_paused_at: '2026-08-01T00:00:00Z', next_action_date: '2026-01-01' });
  assert.equal(computeQueueEntry(co, {}, NOW), null, 'no Tier 5 overdue nag either');
});

test('an unpaused company with the same overdue date still surfaces', () => {
  const co = paused({ next_action_date: '2026-01-01' });
  assert.equal(computeQueueEntry(co, {}, NOW)?.tier, 5, 'control: the pause is what suppressed it');
});

// ── On Me: the third deferral, where the work is still live ──────────────────
// Pause and snooze both say "we are not working this". On Me says "I am working
// this, just not in the queue" — so it must hold the same never-silence-a-live-
// correspondent rule, and must NOT clear the draft the way the other two do.

const { onMeHeld } = require('../../b2b-outreach/lib/queue');

test('on_me records the stamp and takes an optional note', () => {
  const upd = computeTriage('on_me', { reason: 'waiting on pricing first', now: NOW });
  assert.equal(upd.on_me_at, NOW.toISOString());
  assert.equal(upd.on_me_note, 'waiting on pricing first');
  assert.equal(upd.relationship_state, undefined, 'claiming it must NOT mark them lost');
});

test('on_me needs no reason — the whole point is that it is one click', () => {
  const upd = computeTriage('on_me', { now: NOW });
  assert.equal(upd.on_me_at, NOW.toISOString());
  assert.equal(upd.on_me_note, null);
});

test('claiming a company clears its stale waiting-on-us', () => {
  const co = paused({ on_me_at: '2026-08-05T00:00:00Z' });
  assert.equal(
    computeQueueEntry(co, { lastInboundAt: '2026-07-01T00:00:00Z', lastOutboundAt: null }, NOW), null,
    'it is on Jamie now, so it must leave the queue');
});

test('a reply arriving after the claim comes back to Tier 1', () => {
  const co = paused({ on_me_at: '2026-08-01T00:00:00Z' });
  const entry = computeQueueEntry(co, { lastInboundAt: '2026-08-04T00:00:00Z', lastOutboundAt: null }, NOW);
  assert.equal(entry?.tier, 1, '"I know, it is on my list" must never silence a live correspondent');
});

test('a claimed company is off the cadence too, not just off Tier 1', () => {
  const co = paused({ on_me_at: '2026-08-01T00:00:00Z', next_action_date: '2026-01-01' });
  assert.equal(computeQueueEntry(co, {}, NOW), null, 'no Tier 5 nag underneath work Jamie has picked up');
});

test('onMeHeld follows the same boundary the queue uses', () => {
  const co = paused({ on_me_at: '2026-08-01T00:00:00Z' });
  assert.equal(onMeHeld(co, {}), true, 'no reply at all — still held');
  assert.equal(onMeHeld(co, { lastInboundAt: '2026-07-20T00:00:00Z' }), true, 'the reply he claimed');
  assert.equal(onMeHeld(co, { lastInboundAt: '2026-08-04T00:00:00Z' }), false, 'superseded — back in the queue');
  assert.equal(onMeHeld(paused({}), { lastInboundAt: '2026-08-04T00:00:00Z' }), false, 'never claimed');
});

test('the latest deferral judges staleness when more than one is set', () => {
  // Claimed on the 20th, then paused on the 1st having seen the reply from the
  // 25th. The pause is the decision that saw the most mail, so it is the one
  // that decides whether that reply is still outstanding.
  const co = paused({ on_me_at: '2026-07-20T00:00:00Z', outreach_paused_at: '2026-08-01T00:00:00Z' });
  assert.equal(deferredSince(co, NOW), '2026-08-01T00:00:00Z');
  assert.equal(computeQueueEntry(co, { lastInboundAt: '2026-07-25T00:00:00Z' }, NOW), null);
});
