// Tests for the 2026-07 "panel truth" fixes: closed threads leave Tier 1,
// queue ages humanize past 48h, and the manual-send reconciler's pure
// partitioning (DRAFT skip, direction by SENT label, idempotency by known id).
const { test } = require('node:test');
const assert = require('node:assert');
const { computeQueueEntry, humanAge } = require('../../b2b-outreach/lib/queue');
const { partitionThreadMessages, extractPlainText, discoveredThreadStatus } = require('../../b2b-outreach/lib/manualSendReconcile');

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

test('Cc header is captured on imported rows; absent Cc stores null', () => {
  const withCc = gmailMsg('m1cc', ['SENT'], {
    payload: {
      mimeType: 'text/plain',
      body: { data: Buffer.from('hello body', 'utf8').toString('base64url') },
      headers: [
        { name: 'From', value: 'Jamie Alexander <jamie@rubyshines.com>' },
        { name: 'To', value: 'Ez <ez@tgv.org.au>' },
        { name: 'Cc', value: 'Colleague <col@tgv.org.au>, second@tgv.org.au' },
      ],
    },
  });
  const rows = partitionThreadMessages([withCc, gmailMsg('m1nocc', ['SENT'])], new Set());
  assert.equal(rows[0].cc_email, 'col@tgv.org.au, second@tgv.org.au');
  assert.equal(rows[1].cc_email, null);
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

// ── auto-reply detection ────────────────────────────────────────────────────
const { detectAutoReply } = require('../../b2b-outreach/lib/replyCorrelation');

test('detectAutoReply catches the Mermaids-style body and classic markers', () => {
  assert.ok(detectAutoReply({ subject: 'Re: Hi', body: "Thanks for getting in touch. We'll be back to you within 2 business days." }));
  assert.ok(detectAutoReply({ subject: 'Automatic reply: Hi from RUBIES', body: '' }));
  assert.ok(detectAutoReply({ subject: 'Re: Hi', body: 'I am out of office until Monday.' }));
  assert.ok(detectAutoReply({ subject: '', body: 'This mailbox is not monitored.' }));
});

test('detectAutoReply leaves real replies alone', () => {
  assert.ok(!detectAutoReply({ subject: 'Re: Hi from RUBIES', body: 'Thank you for reaching out! We would love to talk. Are you free Tuesday?' }));
  assert.ok(!detectAutoReply({ subject: 'Re: order', body: 'Thanks Jamie! The invoice is paid.' }));
});

test('auto_reply inbound never sets the Tier-1 signal', () => {
  // via queueContext behavior: computeQueueEntry with only an auto_reply has no lastInboundAt
  const now = new Date('2026-07-24T22:00:00Z');
  const entry = computeQueueEntry(
    { id: 'org-x', relationship_state: 'in_contact' },
    { lastInboundAt: null, lastOutboundAt: '2026-07-24T20:00:00Z', hasPendingDraft: false, sentTypes: new Set(), lastTypeSentAt: () => null },
    now
  );
  assert.equal(entry, null);
});

test('reconciler flags Auto-Submitted messages as auto_reply', () => {
  const rows = partitionThreadMessages([gmailMsg('m9', ['INBOX'], {
    payload: {
      mimeType: 'text/plain',
      body: { data: Buffer.from('We are on holiday.').toString('base64url') },
      headers: [
        { name: 'From', value: 'org@x.org' }, { name: 'To', value: 'jamie@rubyshines.com' },
        { name: 'Auto-Submitted', value: 'auto-replied' },
      ],
    },
  })], new Set());
  assert.equal(rows[0].message_type, 'auto_reply');
});

// ── calendar notifications ──────────────────────────────────────────────────
// A calendar RSVP is sent FROM the contact's own address, so it correlates onto
// the company like any reply — and it lands AFTER our outbound invite, which is
// precisely the Tier-1 condition. Booking a call therefore put the company back
// in the queue at the moment the scheduling was finished.
const { detectCalendarNotice, classifyInbound, NON_REPLY_INBOUND_TYPES } = require('../../b2b-outreach/lib/replyCorrelation');

test('detectCalendarNotice catches RSVPs, invitations, updates and cancellations', () => {
  // The Lumenus case: over Pub/Sub the RSVP arrives with an EMPTY body, so the
  // subject has to carry the decision on its own.
  assert.ok(detectCalendarNotice({ subject: 'Accepted: RUBIES x Lumenus Foundation', body: '' }));
  assert.ok(detectCalendarNotice({
    subject: 'Accepted: RUBIES x BAGLY @ Mon Mar 18, 2024 11am - 11:30am (EDT) (jamie@rubyshines.com)',
    body: 'Liz Flynn has accepted this invitation.\r\n\r\nRUBIES x BAGLY',
  }));
  assert.ok(detectCalendarNotice({ subject: 'Declined: RUBIES x Someone', body: '' }));
  assert.ok(detectCalendarNotice({
    subject: 'Invitation: TGV x Rubies @ Wed Apr 8, 2026 7pm - 7:30pm (EDT)',
    body: 'TGV x Rubies\nWednesday Apr 8, 2026\nView all guest info\nhttps://calendar.google.com/calendar/event?action=VIEW&eid=abc',
  }));
  assert.ok(detectCalendarNotice({
    subject: 'Updated invitation: TGV x Rubies @ Wed Apr 29, 2026 7pm - 7:30pm (EDT)',
    body: 'This event has been updated\r\nChanged: time',
  }));
});

test('detectCalendarNotice leaves real mail alone', () => {
  // "Invitation:" is a subject an org could plausibly write by hand, which is
  // why that half has to be corroborated by the body.
  assert.ok(!detectCalendarNotice({
    subject: 'Invitation: Pride Picnic 2026',
    body: 'We would love to have RUBIES at our picnic in June! Can we send you the details?',
  }));
  // Gmail threads on subject, so a human answering inside the notification's
  // own thread arrives as "Re: Accepted: …" and must stay a reply.
  assert.ok(!detectCalendarNotice({
    subject: 'Re: Accepted: RUBIES x Lumenus Foundation',
    body: 'Actually, could we push this to Thursday?',
  }));
  assert.ok(!detectCalendarNotice({ subject: 'Re: Hi from RUBIES', body: 'Yes please, send the samples.' }));
  assert.ok(!detectCalendarNotice({ subject: 'Accepted', body: 'We accepted your terms.' }));
});

test('classifyInbound prefers calendar_notice over auto_reply', () => {
  // Some Google notices already tripped the auto-reply heuristic; the more
  // specific label is the honest one and both are non-reply types anyway.
  assert.equal(classifyInbound({ subject: 'Accepted: RUBIES x Org', body: 'Do not reply to this email.' }), 'calendar_notice');
  assert.equal(classifyInbound({ subject: 'Re: Hi', body: 'I am out of office until Monday.' }), 'auto_reply');
  assert.equal(classifyInbound({ subject: 'Re: Hi', body: 'Sounds great, Tuesday works.' }), null);
  assert.ok(NON_REPLY_INBOUND_TYPES.has('calendar_notice'));
  assert.ok(NON_REPLY_INBOUND_TYPES.has('auto_reply'));
});

test('reconciler flags a calendar RSVP as calendar_notice', () => {
  const rows = partitionThreadMessages([gmailMsg('m10', ['INBOX'], {
    payload: {
      mimeType: 'text/plain',
      body: { data: Buffer.from('Laura Champion has accepted this invitation.').toString('base64url') },
      headers: [
        { name: 'From', value: 'lchampion@lumenus.ca' }, { name: 'To', value: 'jamie@rubyshines.com' },
        { name: 'Subject', value: 'Accepted: RUBIES x Lumenus Foundation' },
      ],
    },
  })], new Set());
  assert.equal(rows[0].message_type, 'calendar_notice');
});

test('reconciler uses the text/calendar part when the subject alone is ambiguous', () => {
  const rows = partitionThreadMessages([gmailMsg('m11', ['INBOX'], {
    payload: {
      mimeType: 'multipart/alternative',
      headers: [
        { name: 'From', value: 'ez@tgv.org.au' }, { name: 'To', value: 'jamie@rubyshines.com' },
        { name: 'Subject', value: 'Invitation: TGV x Rubies @ Wed Apr 8, 2026' },
      ],
      parts: [
        { mimeType: 'text/plain', body: { data: Buffer.from('TGV x Rubies\nWednesday Apr 8').toString('base64url') } },
        { mimeType: 'text/calendar; method=REQUEST', body: { data: Buffer.from('BEGIN:VCALENDAR').toString('base64url') } },
      ],
    },
  })], new Set());
  assert.equal(rows[0].message_type, 'calendar_notice');
});

test('an imported thread ending in a calendar notice does not open', () => {
  const now = new Date('2026-07-24T12:00:00Z');
  // Recent inbound, so without the message_type this would import as 'open'.
  assert.equal(discoveredThreadStatus(
    { direction: 'inbound', message_type: 'calendar_notice', sent_at: '2026-07-23T12:00:00Z' }, now), 'closed');
  assert.equal(discoveredThreadStatus(
    { direction: 'inbound', message_type: 'auto_reply', sent_at: '2026-07-23T12:00:00Z' }, now), 'closed');
  assert.equal(discoveredThreadStatus(
    { direction: 'inbound', message_type: null, sent_at: '2026-07-23T12:00:00Z' }, now), 'open');
});

// ── adaptive cadence ────────────────────────────────────────────────────────
const { evaluateDue, nextActionDateAfterSend } = require('../../b2b-outreach/lib/cadence');

test('reorder nudge respects per-company threshold from metadata', () => {
  const now = new Date('2026-07-24T12:00:00Z');
  const company = (threshold) => ({
    relationship_type: 'wholesale', relationship_state: 'active',
    metadata: threshold ? { reorder_threshold_days: threshold } : {},
  });
  const ctx = { lastOrderAt: '2026-04-23T00:00:00Z', orderCount: 5, hasPendingDraft: false, sentTypes: new Set(), lastTypeSentAt: () => null };
  // 92d elapsed: default 90d fires; Transting's 302d does not
  assert.equal(evaluateDue(company(null), ctx, now)?.message_type, 'reorder_nudge');
  assert.equal(evaluateDue(company(302), ctx, now), null);
});

test('nextActionDateAfterSend prefers a bounded advisor override', () => {
  const sent = new Date('2026-07-24T12:00:00Z');
  assert.equal(nextActionDateAfterSend('reorder_nudge', sent), '2026-10-22');       // table: 90d
  assert.equal(nextActionDateAfterSend('reorder_nudge', sent, 45), '2026-09-07');   // override
  assert.equal(nextActionDateAfterSend('reorder_nudge', sent, 2), '2026-07-31');    // clamped to 7
  assert.equal(nextActionDateAfterSend('reorder_nudge', sent, 9999), '2027-07-24'); // clamped to 365
});

// ── discoveredThreadStatus ──────────────────────────────────────────────────
// History import must never resurrect ancient waiting-on-us rows.

test('thread ending with our reply imports closed', () => {
  const now = new Date('2026-07-24T12:00:00Z');
  assert.equal(discoveredThreadStatus({ direction: 'outbound', sent_at: '2026-07-23T12:00:00Z' }, now), 'closed');
});

test('recent unanswered inbound imports open (genuinely waiting)', () => {
  const now = new Date('2026-07-24T12:00:00Z');
  assert.equal(discoveredThreadStatus({ direction: 'inbound', sent_at: '2026-07-10T12:00:00Z' }, now), 'open');
});

test('stale unanswered inbound imports closed (no Tier-1 resurrection)', () => {
  const now = new Date('2026-07-24T12:00:00Z');
  assert.equal(discoveredThreadStatus({ direction: 'inbound', sent_at: '2026-04-23T12:00:00Z' }, now), 'closed');
  assert.equal(discoveredThreadStatus(null, now), 'closed');
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
