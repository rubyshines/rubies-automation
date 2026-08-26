// Book & Send must consume the company's pending draft, not send around it.
//
// The composer autosaves what the operator types into a pending b2b_drafts row.
// Book & Send used to hand that text to sendB2bEmail as a loose body, so the row
// stayed `pending` after a successful booking — and mergePendingDraftEntries puts
// any company holding a pending draft back in the queue without consulting the
// cadence. A booked, answered call therefore read as outstanding work.
//
// Gmail, Google Calendar, the send flag and Supabase are all stubbed via
// require.cache, so this exercises the real scheduleMeeting -> sendDraftById wiring
// without touching any infrastructure.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

function stub(modulePath, exports) {
  const p = require.resolve(modulePath);
  require.cache[p] = { id: p, filename: p, loaded: true, path: path.dirname(p), exports };
}

let lastSendArgs = null;
// queueService destructures sendB2bEmail at module load, so swapping the export
// object's property later would not reach it. One stable delegating function,
// with the behaviour swapped underneath it, reaches both callers.
const SENT_OK = async (args) => ({
  ok: true, phase: 'sent', sent_at: '2026-08-26T18:34:55Z',
  thread_id: args.thread_id || 537, to: 'jess@unityconejo.org',
});
let sendImpl = SENT_OK;
stub('../../b2b-outreach/lib/sendB2bEmail.js', {
  sendB2bEmail: async (args) => { lastSendArgs = args; return sendImpl(args); },
  resolveDelivery: async () => ({ mode: 'email', email: 'jess@unityconejo.org', name: 'Jessica', via: 'contact' }),
  addressList: v => String(v || '').split(',').map(s => s.trim()).filter(Boolean).join(', '),
  SEND_FLAG: 'b2b_send_enabled',
  FROM_EMAIL: 'jamie@rubyshines.com',
});

stub('../../shared/systemFlags.js', { isFlagEnabled: async () => true });

let lastEventRequest = null;
stub('../../shared/googleCalendarClient.js', {
  getCalendar: async () => ({
    events: {
      insert: async (req) => {
        lastEventRequest = req;
        return { data: { id: 'evt-1', htmlLink: 'https://cal/evt-1', hangoutLink: 'https://meet.google.com/cbs-jpvg-gts' } };
      },
    },
  }),
  ORGANIZER_CALENDAR_ID: 'jamie@rubyshines.com',
  BUSINESS_TIMEZONE: 'America/Toronto',
});

// The slot is always free; the real formatters stay in play so the confirmation
// line and labels are exercised as written.
const realAvailability = require('../../b2b-outreach/lib/availability');
stub('../../b2b-outreach/lib/availability.js', {
  ...realAvailability,
  fetchCalendarEvents: async () => ({ busy: [] }),
  checkSlotFree: () => ({ free: true }),
});

const COMPANY = { id: 'unity-conejo', name: 'Unity Conejo', city: null, region: 'CA', country: 'USA' };
const START = new Date(Date.now() + 5 * 86400 * 1000).toISOString();

/**
 * Chainable fake covering the query shapes this path uses. `draft` is the
 * company's pending draft, or null for "no draft exists" (console / MCP).
 */
function fakeSb({ draft }) {
  const updates = [];
  const inserts = [];
  const sb = {
    updates,
    inserts,
    from(table) {
      const builder = {
        _table: table,
        select() { return builder; },
        eq() { return builder; },
        insert(row) { inserts.push({ table, row }); return builder; },
        update(fields) { updates.push({ table, fields }); return { eq: async () => ({ error: null }) }; },
        async maybeSingle() {
          if (table === 'b2b_companies') return { data: { ...COMPANY }, error: null };
          if (table === 'b2b_drafts') return { data: draft ? { ...draft } : null, error: null };
          if (table === 'b2b_meetings') return { data: { id: 2 }, error: null };
          return { data: null, error: null };
        },
      };
      return builder;
    },
  };
  return sb;
}

stub('../../shared/supabaseClient.js', { getSupabaseClient: () => currentSb });
let currentSb = null;

const { scheduleMeeting } = require('../../b2b-outreach/lib/scheduleMeeting');

const PENDING = {
  id: 132,
  company_id: 'unity-conejo',
  thread_id: null,
  message_type: 'operator_message',
  variant_id: null,
  subject: null,
  body: 'Hi Jessica,\n\nI just created an invite for Mon Aug 31 at 3:00 PM ET.',
  status: 'pending',
  structured: {},
};

const BOOK = {
  company_id: 'unity-conejo',
  start: START,
  thread_id: 537,
  body: 'Hi Jessica,\n\nI just created an invite for Mon Aug 31 at 3:00 PM ET.',
  confirmed: true,
  their_timezone: 'America/Los_Angeles',
};

test('a successful Book & Send marks the pending draft sent, so it leaves the queue', async () => {
  currentSb = fakeSb({ draft: PENDING });
  const res = await scheduleMeeting({ ...BOOK });
  assert.equal(res.ok, true);
  assert.equal(res.phase, 'booked');

  const draftUpdate = currentSb.updates.find(u => u.table === 'b2b_drafts');
  assert.ok(draftUpdate, 'the pending draft must be updated — left pending it re-enters the queue');
  assert.equal(draftUpdate.fields.status, 'sent');
  assert.equal(draftUpdate.fields.sent_body, BOOK.body);
});

test('the booked reply is threaded on the thread the panel had open', async () => {
  currentSb = fakeSb({ draft: PENDING }); // draft.thread_id is null
  await scheduleMeeting({ ...BOOK });
  assert.equal(lastSendArgs.thread_id, 537);
});

test('the booked reply keeps its meeting_confirmation type, not the draft\'s', async () => {
  currentSb = fakeSb({ draft: PENDING }); // operator_message on the row
  await scheduleMeeting({ ...BOOK });
  assert.equal(lastSendArgs.message_type, 'meeting_confirmation');
});

test('invite_created rides through so the invite-claim guard does not block the send', async () => {
  currentSb = fakeSb({ draft: PENDING });
  await scheduleMeeting({ ...BOOK });
  assert.equal(lastSendArgs.invite_created, true);
});

test('attachments and next_touch_days on the draft still apply to a booked reply', async () => {
  currentSb = fakeSb({ draft: { ...PENDING, structured: { next_touch_days: 45 } } });
  await scheduleMeeting({ ...BOOK });
  assert.equal(lastSendArgs.next_touch_days, 45);
});

// The invite and the email must name the same people. Resolving them separately
// is how you book a call with one person and tell a different one about it.
test('a To override on the draft addresses both the email and the calendar invite', async () => {
  currentSb = fakeSb({ draft: { ...PENDING, structured: { to: 'jess@unityconejo.org, board@unityconejo.org' } } });
  await scheduleMeeting({ ...BOOK });
  assert.equal(lastSendArgs.to_override, 'jess@unityconejo.org, board@unityconejo.org');
  assert.deepEqual(
    lastEventRequest.requestBody.attendees.map(a => a.email),
    ['jess@unityconejo.org', 'board@unityconejo.org'],
    'a joined address list must be split — one attendee holding "a@x, b@y" invites nobody',
  );
});

test('a Cc on the draft is invited too', async () => {
  currentSb = fakeSb({ draft: { ...PENDING, structured: { cc: 'sadie@rubyshines.com' } } });
  await scheduleMeeting({ ...BOOK });
  assert.deepEqual(
    lastEventRequest.requestBody.attendees.map(a => a.email),
    ['jess@unityconejo.org', 'sadie@rubyshines.com'],
  );
  assert.equal(lastSendArgs.cc, 'sadie@rubyshines.com');
});

// The console and the MCP tool can book for a company with nothing pending.
test('with no pending draft the raw body still sends', async () => {
  currentSb = fakeSb({ draft: null });
  const res = await scheduleMeeting({ ...BOOK });
  assert.equal(res.ok, true);
  assert.equal(lastSendArgs.body, BOOK.body);
  assert.equal(currentSb.updates.find(u => u.table === 'b2b_drafts'), undefined);
});

// A rehearsal that left a footprint on the relationship record would be worse
// than no test button at all.
test('a test booking consumes nothing — the draft stays pending and no meeting is recorded', async () => {
  currentSb = fakeSb({ draft: PENDING });
  sendImpl = async () => ({ ok: true, phase: 'test_sent', to: 'jamie@rubyshines.com' });
  try {
    const res = await scheduleMeeting({ ...BOOK, test_mode: true });
    assert.equal(res.phase, 'test_booked');
    assert.equal(lastSendArgs.test_send, true);
    assert.equal(currentSb.updates.find(u => u.table === 'b2b_drafts'), undefined);
    assert.equal(currentSb.inserts.find(i => i.table === 'b2b_meetings'), undefined);
  } finally {
    sendImpl = SENT_OK;
  }
});

// If the email fails after the event exists, the event stays and the draft must
// stay pending — the operator has to send that reply by hand.
test('a failed send after the event is created leaves the draft pending', async () => {
  currentSb = fakeSb({ draft: PENDING });
  sendImpl = async () => ({ ok: false, error: 'Gmail 503' });
  try {
    const res = await scheduleMeeting({ ...BOOK });
    assert.equal(res.ok, false);
    assert.equal(res.phase, 'event_created_email_failed');
    assert.equal(currentSb.updates.find(u => u.table === 'b2b_drafts'), undefined);
  } finally {
    sendImpl = SENT_OK;
  }
});
