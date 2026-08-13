const { test } = require('node:test');
const assert = require('node:assert');
const {
  summaryMode, renderSummaryPrompt, capMessages, FULL_REBUILD_MESSAGE_CAP,
} = require('../../b2b-outreach/lib/relationshipSummary');

const NOW = new Date('2026-08-13T12:00:00Z');

const msg = (sent_at, over = {}) => ({
  direction: 'inbound', from_email: 'kim@shop.com', body_text: 'hello there', sent_at, ...over,
});

const summarized = (through, count, over = {}) => ({
  id: 'shop', name: 'Shop', relationship_type: 'wholesale',
  relationship_summary: 'We sent samples in March 2026; they declined on space.',
  relationship_summary_through: through,
  relationship_summary_msg_count: count,
  ...over,
});

// ── mode selection ──────────────────────────────────────────────────────────

test('a company with no messages needs no pass', () => {
  assert.equal(summaryMode(summarized(null, null), []).mode, 'current');
});

test('a company that has never been summarized gets a full pass', () => {
  const r = summaryMode({ id: 'shop', name: 'Shop' }, [msg('2026-03-01T10:00:00Z')]);
  assert.equal(r.mode, 'full');
  assert.equal(r.newMessages.length, 1);
});

test('nothing new since the watermark means nothing to do', () => {
  const msgs = [msg('2026-03-01T10:00:00Z'), msg('2026-03-04T10:00:00Z')];
  assert.equal(summaryMode(summarized('2026-03-04T10:00:00Z', 2), msgs).mode, 'current');
});

test('strictly newer messages update incrementally, carrying only the new ones', () => {
  const msgs = [
    msg('2026-03-01T10:00:00Z'),
    msg('2026-03-04T10:00:00Z'),
    msg('2026-08-01T10:00:00Z'),
    msg('2026-08-09T10:00:00Z'),
  ];
  const r = summaryMode(summarized('2026-03-04T10:00:00Z', 2), msgs);
  assert.equal(r.mode, 'incremental');
  assert.equal(r.newMessages.length, 2);
  assert.deepEqual(r.newMessages.map(m => m.sent_at), ['2026-08-01T10:00:00Z', '2026-08-09T10:00:00Z']);
});

// This is the case threadBuilder's `date > summary_updated_at` test cannot see,
// and it is not hypothetical: discoverCompanyThreads imports old threads long
// after a company has already been summarized.
test('a message backfilled BEHIND the watermark forces a full rebuild', () => {
  const msgs = [
    msg('2025-06-02T10:00:00Z'), // imported later by thread discovery
    msg('2026-03-01T10:00:00Z'),
    msg('2026-03-04T10:00:00Z'),
  ];
  const r = summaryMode(summarized('2026-03-04T10:00:00Z', 2), msgs);
  assert.equal(r.mode, 'full', 'the narrative it belongs inside was already written');
  assert.equal(r.newMessages.length, 3, 'a full rebuild reconsiders everything');
});

test('a backfill behind the watermark AND a new message still rebuilds in full', () => {
  const msgs = [
    msg('2025-06-02T10:00:00Z'),
    msg('2026-03-04T10:00:00Z'),
    msg('2026-08-09T10:00:00Z'),
  ];
  // count moved by 2 but only 1 message is strictly newer → something landed behind us
  assert.equal(summaryMode(summarized('2026-03-04T10:00:00Z', 1), msgs).mode, 'full');
});

test('out-of-order input does not change the verdict', () => {
  const msgs = [msg('2026-08-09T10:00:00Z'), msg('2026-03-01T10:00:00Z'), msg('2026-03-04T10:00:00Z')];
  const r = summaryMode(summarized('2026-03-04T10:00:00Z', 2), msgs);
  assert.equal(r.mode, 'incremental');
  assert.deepEqual(r.newMessages.map(m => m.sent_at), ['2026-08-09T10:00:00Z']);
});

test('a summary row missing its count still updates incrementally rather than stalling', () => {
  const msgs = [msg('2026-03-04T10:00:00Z'), msg('2026-08-09T10:00:00Z')];
  const co = summarized('2026-03-04T10:00:00Z', null);
  assert.equal(summaryMode(co, msgs).mode, 'incremental');
});

// ── message capping ─────────────────────────────────────────────────────────

test('a long relationship keeps its opener plus the recent tail', () => {
  const msgs = Array.from({ length: 40 }, (_, i) =>
    msg(`2026-01-${String((i % 28) + 1).padStart(2, '0')}T10:00:00Z`, { body_text: `m${i}` }));
  const capped = capMessages(msgs);
  assert.equal(capped.length, FULL_REBUILD_MESSAGE_CAP);
  assert.equal(capped[0].body_text, 'm0', 'how the relationship began survives');
  assert.equal(capped[capped.length - 1].body_text, 'm39');
});

test('a short relationship is passed through untouched', () => {
  const msgs = [msg('2026-03-01T10:00:00Z'), msg('2026-03-02T10:00:00Z')];
  assert.deepEqual(capMessages(msgs), msgs);
});

// ── prompt rendering ────────────────────────────────────────────────────────

test('the prompt states today and demands absolute dates', () => {
  const p = renderSummaryPrompt({
    company: { name: 'Shop', relationship_type: 'wholesale' },
    messages: [msg('2026-03-01T10:00:00Z')], mode: 'full', now: NOW,
  });
  assert.match(p, /Today is 2026-08-13/);
  assert.match(p, /Write every date absolutely/);
  assert.match(p, /in March 2026/, 'the rule carries a verbatim template, not just a prohibition');
});

test('an incremental prompt carries the prior summary and only the new messages', () => {
  const co = summarized('2026-03-04T10:00:00Z', 2);
  const p = renderSummaryPrompt({
    company: co, messages: [msg('2026-08-09T10:00:00Z', { body_text: 'the new one' })],
    mode: 'incremental', now: NOW,
  });
  assert.match(p, /EXISTING SUMMARY \(covers everything up to 2026-03-04\)/);
  assert.match(p, /They declined on space|declined on space/);
  assert.match(p, /the new one/);
  assert.doesNotMatch(p, /CONVERSATION \(/, 'incremental does not re-render the whole history');
});

test('a full rebuild shows pre-migration notes, labelled and dated', () => {
  const co = {
    name: 'Shop', relationship_type: 'wholesale',
    ai_summary: 'Sent samples about 10 months ago; they loved them.',
  };
  const p = renderSummaryPrompt({ company: co, messages: [msg('2026-03-01T10:00:00Z')], mode: 'full', now: NOW });
  assert.match(p, /PRE-MIGRATION NOTES/);
  assert.match(p, /before June 2026/);
  assert.match(p, /background only/, 'the model is told not to restate it as current');
});

test('a full rebuild for a company with no prologue does not fabricate the section', () => {
  const p = renderSummaryPrompt({
    company: { name: 'Shop', relationship_type: 'wholesale', ai_summary: null },
    messages: [msg('2026-03-01T10:00:00Z')], mode: 'full', now: NOW,
  });
  assert.doesNotMatch(p, /PRE-MIGRATION NOTES/);
});

test('an org renders as an org, not a retailer', () => {
  const p = renderSummaryPrompt({
    company: { name: 'BAGLY', relationship_type: 'lgbtq_org' },
    messages: [msg('2026-03-01T10:00:00Z')], mode: 'full', now: NOW,
  });
  assert.match(p, /LGBTQ\+ organization partner/);
});

test('outbound messages are attributed to Jamie, inbound to the sender', () => {
  const p = renderSummaryPrompt({
    company: { name: 'Shop', relationship_type: 'wholesale' },
    messages: [
      msg('2026-03-01T10:00:00Z', { direction: 'outbound', body_text: 'ours' }),
      msg('2026-03-02T10:00:00Z', { direction: 'inbound', from_email: 'kim@shop.com', body_text: 'theirs' }),
    ],
    mode: 'full', now: NOW,
  });
  assert.match(p, /\[2026-03-01\] Us \(Jamie\): ours/);
  assert.match(p, /\[2026-03-02\] kim@shop\.com: theirs/);
});
