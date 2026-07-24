// Tests for the 2026-07 "panel truth" fixes: closed threads leave Tier 1,
// queue ages humanize past 48h, and the manual-send reconciler's pure
// partitioning (DRAFT skip, direction by SENT label, idempotency by known id).
const { test } = require('node:test');
const assert = require('node:assert');
const { computeQueueEntry, humanAge } = require('../../b2b-outreach/lib/queue');
const { partitionThreadMessages, extractPlainText } = require('../../b2b-outreach/lib/manualSendReconcile');

// ── humanAge ────────────────────────────────────────────────────────────────

test('humanAge shows hours under 48h', () => {
  const now = new Date('2026-07-24T12:00:00Z');
  assert.equal(humanAge('2026-07-24T07:00:00Z', now), '5h');
  assert.equal(humanAge('2026-07-22T13:00:00Z', now), '47h');
});

test('humanAge shows days at 48h and beyond', () => {
  const now = new Date('2026-07-24T12:00:00Z');
  assert.equal(humanAge('2026-07-22T12:00:00Z', now), '2d');
  assert.equal(humanAge('2026-06-19T12:00:00Z', now), '35d'); // the 837h case
});

test('tier-1 reason uses humanized age', () => {
  const now = new Date('2026-07-24T12:00:00Z');
  const entry = computeQueueEntry(
    { id: 'org-x', relationship_state: 'active' },
    { lastInboundAt: '2026-06-19T12:00:00Z', lastOutboundAt: null },
    now
  );
  assert.equal(entry.tier, 1);
  assert.match(entry.reason, /replied 35d ago/);
});

// ── partitionThreadMessages ─────────────────────────────────────────────────

const gmailMsg = (id, labels, overrides = {}) => ({
  id,
  threadId: 'th-1',
  labelIds: labels,
  internalDate: '1784815200000', // 2026-07-23T14:00:00Z
  snippet: 'snippet text',
  payload: {
    mimeType: 'text/plain',
    body: { data: Buffer.from('hello body', 'utf8').toString('base64url') },
    headers: [
      { name: 'From', value: 'Jamie Alexander <jamie@rubyshines.com>' },
      { name: 'To', value: 'Ez <ez@tgv.org.au>' },
    ],
  },
  ...overrides,
});

test('SENT messages become outbound manual_send rows', () => {
  const rows = partitionThreadMessages([gmailMsg('m1', ['SENT'])], new Set());
  assert.equal(rows.length, 1);
  assert.equal(rows[0].direction, 'outbound');
  assert.equal(rows[0].source, 'manual_send');
  assert.equal(rows[0].from_email, 'jamie@rubyshines.com');
  assert.equal(rows[0].to_email, 'ez@tgv.org.au');
  assert.equal(rows[0].body_text, 'hello body');
  assert.equal(rows[0].message_type, null); // never pollutes A/B metrics
});

test('non-SENT messages become inbound gmail_backfill rows', () => {
  const rows = partitionThreadMessages([gmailMsg('m2', ['INBOX', 'IMPORTANT'])], new Set());
  assert.equal(rows[0].direction, 'inbound');
  assert.equal(rows[0].source, 'gmail_backfill');
});

test('DRAFT-labeled messages are never ingested (checkpoint poison guard)', () => {
  const rows = partitionThreadMessages(
    [gmailMsg('m3', ['DRAFT', 'SENT']), gmailMsg('m4', ['SENT'])],
    new Set()
  );
  assert.deepEqual(rows.map(r => r.gmail_message_id), ['m4']);
});

test('already-known message ids are skipped (idempotency)', () => {
  const rows = partitionThreadMessages(
    [gmailMsg('m5', ['SENT']), gmailMsg('m6', ['SENT'])],
    new Set(['m5'])
  );
  assert.deepEqual(rows.map(r => r.gmail_message_id), ['m6']);
});

test('sent_at derives from internalDate', () => {
  const rows = partitionThreadMessages([gmailMsg('m7', ['SENT'])], new Set());
  assert.equal(rows[0].sent_at, '2026-07-23T14:00:00.000Z');
});

test('falls back to snippet when no text/plain part exists', () => {
  const rows = partitionThreadMessages(
    [gmailMsg('m8', ['SENT'], { payload: { mimeType: 'text/html', body: {}, headers: [] } })],
    new Set()
  );
  assert.equal(rows[0].body_text, 'snippet text');
});

// ── extractPlainText ────────────────────────────────────────────────────────

test('extractPlainText walks nested multipart payloads', () => {
  const payload = {
    mimeType: 'multipart/alternative',
    parts: [
      { mimeType: 'text/html', body: { data: Buffer.from('<b>x</b>').toString('base64url') } },
      { mimeType: 'text/plain', body: { data: Buffer.from('plain wins').toString('base64url') } },
    ],
  };
  assert.equal(extractPlainText(payload), 'plain wins');
});
