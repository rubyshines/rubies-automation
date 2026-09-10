/**
 * Moving and cancelling a booked call.
 *
 * A partner who writes "can we push our chat to next week" used to get a
 * SECOND event from Book & Send. rescheduleMeeting patches the one they hold.
 * Calendar and Supabase are stand-ins here; the shape of every call to them
 * is what these tests pin.
 *
 * Run: node --test customer-service/test/scheduleMeetingMove.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');

// Stubs go in before the module under test loads them.
const stub = (rel, exports) => {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
stub('../../shared/systemFlags', { isFlagEnabled: async () => true, setFlag: async () => {} });
stub('../../b2b-outreach/lib/sendB2bEmail', {
  sendB2bEmail: async () => { throw new Error('sendB2bEmail must not be called'); },
  resolveDelivery: async () => ({ mode: 'email', email: 'katy@example.org', name: 'Katy' }),
  addressList: v => v,
  SEND_FLAG: 'b2b_send',
  FROM_EMAIL: 'jamie@rubyshines.com',
});

const { rescheduleMeeting, cancelMeeting, renderConfirmationLine, upcomingBookedMeeting } = require('../../b2b-outreach/lib/scheduleMeeting');

/** One company, one meeting, no pending draft. Records updates. */
function fakeSb({ meeting, company = { id: 'colage', name: 'COLAGE', country: 'US' } }) {
  const st = { meeting: { ...meeting }, updates: [] };
  const rowsFor = table => table === 'b2b_companies' ? [company] : table === 'b2b_meetings' ? [st.meeting] : [];
  const q = (table, rows) => {
    const self = {
      eq: (k, v) => q(table, rows.filter(r => r[k] === v)),
      gte: (k, v) => q(table, rows.filter(r => r[k] >= v)),
      order: () => self, limit: () => self, select: () => self,
      maybeSingle: async () => ({ data: rows[0] ? { ...rows[0] } : null, error: null }),
    };
    return self;
  };
  st.sb = {
    from: table => ({
      select: () => q(table, rowsFor(table)),
      update: patch => ({
        eq: async (k, v) => {
          if (table !== 'b2b_meetings' || st.meeting[k] !== v) return { error: { message: 'no such row' } };
          st.updates.push(patch); st.meeting = { ...st.meeting, ...patch };
          return { error: null };
        },
      }),
    }),
  };
  return st;
}

const NOW = new Date('2026-09-09T20:00:00Z');
const MEETING = {
  id: 7, company_id: 'colage', status: 'booked', google_event_id: 'ev-colage', google_calendar_id: 'jamie@rubyshines.com',
  starts_at: '2026-09-10T16:00:00.000Z', ends_at: '2026-09-10T16:30:00.000Z', duration_minutes: 30,
  title: 'RUBIES x COLAGE', meet_url: 'https://meet.google.com/abc', html_link: 'https://calendar.google.com/x',
  attendee_emails: ['katy@example.org'], their_timezone: 'America/Los_Angeles', thread_id: 41,
};
const NEW_START = '2026-09-17T17:00:00.000Z'; // Thu Sept 17 1:00 PM ET

test('the moved sentence says moved, in both zones', () => {
  assert.equal(
    renderConfirmationLine({ start: NEW_START, theirTimeZone: 'America/Los_Angeles', moved: true }),
    'Ok, I moved our call to Thu Sept 17 at 1:00 PM ET (10:00 AM your time).',
  );
  assert.equal(renderConfirmationLine({ start: NEW_START, moved: true }), 'Ok, I moved our call to Thu Sept 17 at 1:00 PM ET.');
});

test('preview: a move names the call it moves and writes the moved sentence, touching nothing', async () => {
  const st = fakeSb({ meeting: MEETING });
  const r = await rescheduleMeeting({ company_id: 'colage', start: NEW_START }, { sb: st.sb, now: NOW });
  assert.equal(r.phase, 'preview');
  assert.equal(r.mode, 'move');
  assert.equal(r.meeting_id, 7);
  assert.equal(r.previous_start, MEETING.starts_at);
  assert.equal(r.when_ours, 'Thu Sept 17 1:00 PM Eastern');
  assert.equal(r.when_theirs, '10:00 AM (America/Los_Angeles)');
  assert.match(r.confirmation_line, /^Ok, I moved our call to Thu Sept 17 at 1:00 PM ET \(10:00 AM your time\)\.$/);
  assert.match(r.confirmation_body, /^Hi Katy,\n\nOk, I moved our call/);
  assert.equal(st.updates.length, 0);
});

test('confirmed: the existing event is patched with the new time and the row moves in place', async () => {
  const st = fakeSb({ meeting: MEETING });
  const patches = [];
  const cal = { events: { patch: async (args) => { patches.push(args); return { data: { id: 'ev-colage', htmlLink: 'https://calendar.google.com/x', hangoutLink: 'https://meet.google.com/abc' } }; } } };
  // The calendar still shows the call at its OLD time: that block must not count as a clash.
  const fetchEvents = async () => ({ busy: [{ start: MEETING.starts_at, end: MEETING.ends_at, summary: 'RUBIES x COLAGE', eventId: 'ev-colage' }] });
  const r = await rescheduleMeeting(
    { company_id: 'colage', start: NEW_START, confirmed: true, skip_reply: true },
    { sb: st.sb, now: NOW, cal, fetchEvents },
  );
  assert.equal(r.ok, true, r.error);
  assert.equal(r.phase, 'moved');
  assert.equal(patches.length, 1);
  assert.equal(patches[0].eventId, 'ev-colage');
  assert.equal(patches[0].calendarId, 'jamie@rubyshines.com');
  assert.equal(patches[0].sendUpdates, 'all');
  assert.equal(patches[0].requestBody.start.dateTime, NEW_START);
  assert.equal(patches[0].requestBody.end.dateTime, '2026-09-17T17:30:00.000Z');
  assert.equal(st.meeting.starts_at, NEW_START);
  assert.equal(st.meeting.ends_at, '2026-09-17T17:30:00.000Z');
  assert.equal(st.meeting.status, 'booked');
  assert.equal(st.meeting.google_event_id, 'ev-colage'); // same event, same Meet link
  assert.equal(r.meet_url, 'https://meet.google.com/abc');
  assert.equal(r.previous_start, MEETING.starts_at);
});

test('confirmed: another booking in the new slot is a clash; its own old block at the new time is not', async () => {
  const st = fakeSb({ meeting: MEETING });
  let patched = 0;
  const cal = { events: { patch: async () => { patched++; return { data: {} }; } } };
  const fetchEvents = async () => ({ busy: [
    { start: NEW_START, end: '2026-09-17T17:30:00.000Z', summary: 'Natta call', eventId: 'ev-other' },
  ] });
  const r = await rescheduleMeeting({ company_id: 'colage', start: NEW_START, confirmed: true, skip_reply: true }, { sb: st.sb, now: NOW, cal, fetchEvents });
  assert.equal(r.phase, 'clash');
  assert.match(r.error, /Natta call/);
  assert.equal(patched, 0);
  assert.equal(st.updates.length, 0);
});

test('nothing to move: no upcoming booked call, or a cancelled one', async () => {
  const none = fakeSb({ meeting: { ...MEETING, status: 'cancelled' } });
  const r1 = await rescheduleMeeting({ company_id: 'colage', start: NEW_START }, { sb: none.sb, now: NOW });
  assert.equal(r1.ok, false);
  assert.match(r1.error, /no upcoming booked call/);
  const r2 = await rescheduleMeeting({ company_id: 'colage', meeting_id: 7, start: NEW_START }, { sb: none.sb, now: NOW });
  assert.match(r2.error, /is cancelled, not booked/);
  assert.equal(await upcomingBookedMeeting(none.sb, 'colage', NOW), null);
});

test('cancel: deletes the event with updates to attendees and marks the row', async () => {
  const st = fakeSb({ meeting: MEETING });
  const deletes = [];
  const cal = { events: { delete: async (args) => { deletes.push(args); } } };
  const r = await cancelMeeting(st.sb, { meeting_id: 7, company_id: 'colage', now: NOW }, { cal });
  assert.equal(r.ok, true);
  assert.equal(r.calendar_deleted, true);
  assert.deepEqual(deletes, [{ calendarId: 'jamie@rubyshines.com', eventId: 'ev-colage', sendUpdates: 'all' }]);
  assert.equal(st.meeting.status, 'cancelled');
  // Idempotent, and an event already gone from Google still lets the row be marked.
  const again = await cancelMeeting(st.sb, { meeting_id: 7, now: NOW }, { cal });
  assert.equal(again.already, true);
  const gone = fakeSb({ meeting: MEETING });
  const r2 = await cancelMeeting(gone.sb, { meeting_id: 7, now: NOW }, { cal: { events: { delete: async () => { const e = new Error('Not Found'); e.code = 404; throw e; } } } });
  assert.equal(r2.calendar_deleted, false);
  assert.equal(gone.meeting.status, 'cancelled');
});

test('cancel refuses another company\'s meeting and a call that already started', async () => {
  const st = fakeSb({ meeting: MEETING });
  await assert.rejects(() => cancelMeeting(st.sb, { meeting_id: 7, company_id: 'lejag', now: NOW }), /not lejag's/);
  await assert.rejects(() => cancelMeeting(st.sb, { meeting_id: 7, now: new Date('2026-09-10T16:05:00Z') }), /already started/);
  assert.equal(st.meeting.status, 'booked');
});
