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
