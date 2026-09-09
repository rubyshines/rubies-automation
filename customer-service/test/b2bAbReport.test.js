const { test } = require('node:test');
const assert = require('node:assert');
const { computeAbReport, renderAbReport } = require('../../b2b-outreach/lib/abReport');

const NOW = new Date('2026-09-22T12:00:00Z');
const out = (company, variant, sent_at, over = {}) => ({
  company_id: company, direction: 'outbound', message_type: 'intro_outreach', variant_id: variant,
  sent_at, source: 'send_tool', undelivered_at: null, ...over,
});
const reply = (company, sent_at, over = {}) => ({ company_id: company, direction: 'inbound', message_type: null, sent_at, ...over });

test('a human reply inside the window counts; a reply after it does not', () => {
  const r = computeAbReport({
    outbound: [out('a', 'subject_a', '2026-09-01T10:00:00Z'), out('b', 'subject_a', '2026-09-01T10:00:00Z')],
    inbound: [reply('a', '2026-09-03T10:00:00Z'), reply('b', '2026-09-20T10:00:00Z')],
    now: NOW,
  });
  const row = r.rows.find(x => x.variant_id === 'subject_a');
  assert.equal(row.sent, 2);
  assert.equal(row.replied, 1);
  assert.equal(row.matured, 2, 'both windows closed by the 22nd');
  assert.equal(row.reply_rate, 0.5);
  assert.equal(row.final, true);
});

test('machine mail is not a reply, and a bounce leaves every rate', () => {
  const r = computeAbReport({
    outbound: [out('a', 'subject_b', '2026-09-01T10:00:00Z'), out('b', 'subject_b', '2026-09-01T10:00:00Z', { undelivered_at: '2026-09-01T11:00:00Z' })],
    inbound: [reply('a', '2026-09-02T10:00:00Z', { message_type: 'auto_reply' })],
    now: NOW,
  });
  const row = r.rows.find(x => x.variant_id === 'subject_b');
  assert.equal(row.sent, 2);
  assert.equal(row.bounced, 1);
  assert.equal(row.delivered, 1);
  assert.equal(row.replied, 0);
  assert.equal(row.matured, 1);
  assert.equal(row.reply_rate, 0);
});

test('an open window is pending, and the report says when it reads', () => {
  const r = computeAbReport({
    outbound: [out('a', 'pitch_a', '2026-09-15T10:00:00Z'), out('b', 'pitch_a', '2026-09-18T10:00:00Z')],
    inbound: [reply('b', '2026-09-19T10:00:00Z')],
    now: NOW,
  });
  const row = r.rows.find(x => x.variant_id === 'pitch_a');
  assert.equal(row.pending, 1, 'a is still open');
  assert.equal(row.matured, 1, 'a reply matures b early');
  assert.equal(row.reads_on, '2026-09-29');
  assert.equal(row.reply_rate, 0.5, 'over delivered, not over matured — an early reply must not read as 100%');
  assert.equal(row.final, false);
});

test('one company votes once per type: a delivered retry is not a second send', () => {
  const r = computeAbReport({
    outbound: [
      out('a', 'subject_a', '2026-09-01T10:00:00Z', { undelivered_at: '2026-09-01T11:00:00Z' }),
      out('a', 'subject_a', '2026-09-02T10:00:00Z'),
      out('a', 'subject_a', '2026-09-03T10:00:00Z'),
    ],
    inbound: [],
    now: NOW,
  });
  const row = r.rows[0];
  assert.equal(row.bounced, 1);
  assert.equal(row.sent, 2, 'the bounce plus one delivered send');
  assert.equal(row.matured, 1);
});

test('manual sends and rows without a variant are outside the test', () => {
  const r = computeAbReport({
    outbound: [
      out('a', 'subject_a', '2026-09-01T10:00:00Z', { source: 'manual_send' }),
      out('b', null, '2026-09-01T10:00:00Z'),
    ],
    inbound: [],
    now: NOW,
  });
  assert.equal(r.rows.length, 0);
});

test('render groups by type and flags a small read as directional', () => {
  const r = computeAbReport({
    outbound: [out('a', 'subject_a', '2026-09-01T10:00:00Z'), out('b', 'pitch_b', '2026-09-01T10:00:00Z', { message_type: 'intro_pitch' })],
    inbound: [],
    now: NOW,
  });
  const md = renderAbReport(r, { subjects: { intro_pitch: { pitch_b: 'For your trans customers' } } });
  assert.match(md, /\*\*intro_outreach\*\*/);
  assert.match(md, /\*\*intro_pitch\*\*/);
  assert.match(md, /pitch_b: "For your trans customers"/);
  assert.match(md, /directional only/);
  assert.match(renderAbReport({ as_of: '2026-09-22', window_days: 14, rows: [] }), /no sends carry a variant/);
});
