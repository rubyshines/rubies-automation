/**
 * Calendar-driven meeting sync (2026-09-09).
 *
 * The pure halves — event normalisation and the status decision — carry the
 * reschedule / cancel / reinstate / dismissed-stays rules. syncMeetings is
 * exercised against a stubbed Supabase client with injected events so the
 * insert/update/skip paths are asserted without a calendar or a network.
 *
 * Run: node --test customer-service/test/meetingSync.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');

// Stub the Supabase singleton before requiring anything that might touch it.
const CLIENT_PATH = require.resolve('../../shared/supabaseClient');
let state;

function makeClient() {
  const ok = (data) => Promise.resolve({ data, error: null });
  return {
    from(table) {
      const q = { _table: table, _f: {}, _select: null };
      q.select = (cols) => { q._select = cols; return q; };
      q.eq = (c, v) => { q._f[c] = v; return q; };
      q.ilike = (c, v) => { q._f['ilike:' + c] = v; return q; };
      q.gte = () => q; q.lt = () => q; q.in = () => q; q.order = () => q; q.limit = () => q;
      q.maybeSingle = () => {
        if (table === 'b2b_contacts') {
          const hit = state.contacts.find(c => c.email === q._f.email);
          return ok(hit ? { company_id: hit.company_id } : null);
        }
        if (table === 'b2b_companies') {
          if (q._f.general_email !== undefined) {
            const hit = state.companies.find(c => c.general_email === q._f.general_email);
            return ok(hit ? { id: hit.id } : null);
          }
          return ok(state.companies.find(c => c.id === q._f.id) || null);
        }
        if (table === 'b2b_meetings') {
          return ok(state.meetings.find(m => m.company_id === q._f.company_id
            && m.google_event_id === q._f.google_event_id) || null);
        }
        return ok(null);
      };
      q.then = (resolve) => {
        const pat = (q._f['ilike:website'] || q._f['ilike:email'] || '').replace(/%/g, '');
        if (table === 'b2b_companies') return resolve({ data: state.companies.filter(c => (c.website || '').includes(pat)), error: null });
        if (table === 'b2b_contacts') return resolve({ data: state.contacts.filter(c => (c.email || '').endsWith(pat)), error: null });
        return resolve({ data: [], error: null });
      };
      q.insert = (row) => {
        state.inserts.push({ table, row });
        if (table === 'b2b_meetings') state.meetings.push({ id: 100 + state.meetings.length, ...row });
        return ok(null);
      };
      q.update = (patch) => {
        const rec = { table, patch, filters: {} };
        state.updates.push(rec);
        const u = { eq(c, v) { rec.filters[c] = v; return u; }, then(resolve) { return resolve({ data: null, error: null }); } };
        return u;
      };
      return q;
    },
  };
}
require.cache[CLIENT_PATH] = { id: CLIENT_PATH, filename: CLIENT_PATH, loaded: true, exports: { getSupabaseClient: makeClient } };

const { normalizeEvent, plannedStatus, syncMeetings } = require('../../b2b-outreach/lib/meetingSync');

function reset(over = {}) {
  state = { companies: [], contacts: [], meetings: [], inserts: [], updates: [], ...over };
}

const NOW = new Date('2026-09-09T15:00:00Z');
const US = 'jamie@rubyshines.com';

// The live Stand with Trans shape: Calendly created the event, Dion organises,
// the Zoom link sits in the location, Jamie is an accepted attendee.
const CALENDLY = (over = {}) => ({
  id: 'tfe2njp80v0nrdlqq7ufopk4ok', status: 'confirmed',
  summary: 'Discuss RUBIES Clothing Donations and Dion Bourque',
  start: { dateTime: '2026-09-10T14:00:00Z' }, end: { dateTime: '2026-09-10T14:30:00Z' },
  organizer: { email: 'dion@standwithtrans.org' },
  location: 'https://us04web.zoom.us/j/79983679365?pwd=abc',
  htmlLink: 'https://www.google.com/calendar/event?eid=x',
  attendees: [
    { email: 'dion@standwithtrans.org', organizer: true, responseStatus: 'accepted' },
    { email: US, self: true, responseStatus: 'accepted' },
  ],
  ...over,
});

// Ours: Book & Send created it on the RUBIES calendar with a Meet link.
const OURS = (over = {}) => ({
  id: 'ev-ours', status: 'confirmed', summary: 'RUBIES x Le JAG',
  start: { dateTime: '2026-09-10T13:30:00Z' }, end: { dateTime: '2026-09-10T14:00:00Z' },
  organizer: { email: US, self: true }, hangoutLink: 'https://meet.google.com/web-srvw-rft',
  attendees: [
    { email: US, self: true, organizer: true, responseStatus: 'accepted' },
    { email: 'philippe@lejag.org', responseStatus: 'accepted' },
  ],
  ...over,
});

// ------------------------------------------------------------ normalizeEvent

test('a partner-created event: external attendees, partner organizer, Zoom link from the location', () => {
  const ev = normalizeEvent(CALENDLY());
  assert.deepEqual(ev.attendee_emails, ['dion@standwithtrans.org']);
  assert.equal(ev.organizer_is_ours, false);
  assert.equal(ev.organizer_email, 'dion@standwithtrans.org');
  assert.match(ev.meet_url, /zoom\.us/);
  assert.equal(ev.duration_minutes, 30);
  assert.equal(ev.cancelled, false);
  assert.equal(ev.self_declined, false);
});

test('our own event: we are never an external attendee, and the Meet link is the hangoutLink', () => {
  const ev = normalizeEvent(OURS());
  assert.deepEqual(ev.attendee_emails, ['philippe@lejag.org']);
  assert.equal(ev.organizer_is_ours, true);
  assert.equal(ev.meet_url, 'https://meet.google.com/web-srvw-rft');
});

test('all-day entries and events without attendees are not meetings', () => {
  assert.equal(normalizeEvent({ id: 'x', summary: 'Natta in Toronto', start: { date: '2026-09-10' }, end: { date: '2026-09-11' } }), null);
  const ev = normalizeEvent(OURS({ attendees: undefined }));
  assert.equal(ev.external.length, 0);
});

test('a cancelled instance arrives without times and is still reported', () => {
  const ev = normalizeEvent({ id: 'gone', status: 'cancelled' });
  assert.equal(ev.cancelled, true);
  assert.equal(ev.starts_at, null);
});

test('Jamie declining reads as the call being off', () => {
  const ev = normalizeEvent(CALENDLY({ attendees: [
    { email: 'dion@standwithtrans.org', organizer: true, responseStatus: 'accepted' },
    { email: US, self: true, responseStatus: 'declined' },
  ] }));
  assert.equal(ev.self_declined, true);
});

// ------------------------------------------------------------- plannedStatus

test('plannedStatus: the reschedule / cancel / reinstate / dismissed-stays rules', () => {
  const live = normalizeEvent(CALENDLY());
  const cancelled = normalizeEvent(CALENDLY({ status: 'cancelled' }));
  assert.equal(plannedStatus(null, live, NOW), 'booked');
  assert.equal(plannedStatus(null, cancelled, NOW), 'cancelled');
  assert.equal(plannedStatus({ status: 'booked', starts_at: live.starts_at }, cancelled, NOW), 'cancelled');
  assert.equal(plannedStatus({ status: 'cancelled', starts_at: live.starts_at }, live, NOW), 'booked', 'a cancelled row whose event is live again is booked');
  // A dismissed follow-up stays dismissed unless the call actually moved into the future.
  assert.equal(plannedStatus({ status: 'followup_dismissed', starts_at: live.starts_at }, live, NOW), 'followup_dismissed');
  const moved = normalizeEvent(CALENDLY({ start: { dateTime: '2026-09-15T13:30:00Z' }, end: { dateTime: '2026-09-15T14:00:00Z' } }));
  assert.equal(plannedStatus({ status: 'followup_dismissed', starts_at: '2026-09-09T13:30:00Z' }, moved, NOW), 'booked');
  // …but a past reschedule (the row's start moved to another past time) does not resurrect it.
  const movedPast = normalizeEvent(CALENDLY({ start: { dateTime: '2026-09-08T13:30:00Z' }, end: { dateTime: '2026-09-08T14:00:00Z' } }));
  assert.equal(plannedStatus({ status: 'followup_dismissed', starts_at: '2026-09-09T13:30:00Z' }, movedPast, NOW), 'followup_dismissed');
});

// -------------------------------------------------------------- syncMeetings

test('a Calendly call with a known contact gets a partner-booked row', async () => {
  reset({
    contacts: [{ email: 'dion@standwithtrans.org', company_id: 'lgbtq-standwithtrans' }],
    companies: [{ id: 'lgbtq-standwithtrans', name: 'Stand with Trans', country: 'United States', region: 'MI' }],
  });
  const r = await syncMeetings(makeClient(), { now: NOW, events: [CALENDLY()] });
  assert.equal(r.inserted, 1);
  assert.equal(r.unmatched.length, 0);
  const row = state.inserts.find(i => i.table === 'b2b_meetings').row;
  assert.equal(row.company_id, 'lgbtq-standwithtrans');
  assert.equal(row.google_event_id, 'tfe2njp80v0nrdlqq7ufopk4ok');
  assert.equal(row.booked_by, 'partner');
  assert.equal(row.source, 'calendar_sync');
  assert.equal(row.status, 'booked');
  assert.equal(row.organizer_email, 'dion@standwithtrans.org');
  assert.deepEqual(row.attendee_emails, ['dion@standwithtrans.org']);
  assert.equal(row.thread_id, null, 'the sync never guesses a thread');
  assert.ok('their_timezone' in row);
});

test('an attendee at a known company DOMAIN matches like inbound mail does', async () => {
  reset({ companies: [{ id: 'lejag', website: 'https://lejag.org', relationship_state: 'in_contact', country: 'Canada', region: 'QC' }] });
  const r = await syncMeetings(makeClient(), { now: NOW, events: [OURS()] });
  assert.equal(r.inserted, 1);
  const row = state.inserts[0].row;
  assert.equal(row.company_id, 'lejag');
  assert.equal(row.booked_by, 'operator');
});

test('a moved event updates the row in place and leaves operator fields alone', async () => {
  reset({
    contacts: [{ email: 'dion@standwithtrans.org', company_id: 'lgbtq-standwithtrans' }],
    meetings: [{ id: 7, company_id: 'lgbtq-standwithtrans', google_event_id: 'tfe2njp80v0nrdlqq7ufopk4ok', status: 'booked',
      starts_at: '2026-09-09T14:00:00Z', ends_at: '2026-09-09T14:30:00Z', title: 'Discuss RUBIES Clothing Donations and Dion Bourque',
      their_timezone: 'America/Detroit', notes: 'bring the closet numbers' }],
  });
  const r = await syncMeetings(makeClient(), { now: NOW, events: [CALENDLY()] });
  assert.equal(r.updated, 1);
  assert.equal(r.inserted, 0);
  const u = state.updates.find(x => x.table === 'b2b_meetings');
  assert.equal(u.filters.id, 7);
  assert.equal(u.patch.starts_at, '2026-09-10T14:00:00.000Z');
  assert.equal(u.patch.status, 'booked');
  for (const k of ['notes', 'their_timezone', 'thread_id', 'booked_by', 'outcome']) {
    assert.ok(!(k in u.patch), `${k} is an operator fact and must not be in the patch`);
  }
});

test('an unchanged event writes nothing', async () => {
  const ev = normalizeEvent(CALENDLY());
  reset({
    contacts: [{ email: 'dion@standwithtrans.org', company_id: 'lgbtq-standwithtrans' }],
    meetings: [{ id: 7, company_id: 'lgbtq-standwithtrans', google_event_id: ev.google_event_id, status: 'booked',
      starts_at: ev.starts_at, ends_at: ev.ends_at, title: ev.title, attendee_emails: ev.attendee_emails,
      attendee_responses: ev.attendee_responses, meet_url: ev.meet_url, html_link: ev.html_link, organizer_email: ev.organizer_email }],
  });
  const r = await syncMeetings(makeClient(), { now: NOW, events: [CALENDLY()] });
  assert.equal(r.unchanged, 1);
  assert.equal(state.updates.length, 0);
});

test('a cancelled event marks the row cancelled; one we never held is ignored', async () => {
  reset({
    contacts: [{ email: 'dion@standwithtrans.org', company_id: 'lgbtq-standwithtrans' }],
    meetings: [{ id: 7, company_id: 'lgbtq-standwithtrans', google_event_id: 'tfe2njp80v0nrdlqq7ufopk4ok', status: 'booked',
      starts_at: '2026-09-10T14:00:00Z', ends_at: '2026-09-10T14:30:00Z', title: 'Discuss' }],
  });
  const r = await syncMeetings(makeClient(), { now: NOW, events: [CALENDLY({ status: 'cancelled' })] });
  assert.equal(r.cancelled, 1);
  assert.equal(state.updates[0].patch.status, 'cancelled');

  reset({ contacts: [{ email: 'dion@standwithtrans.org', company_id: 'lgbtq-standwithtrans' }] });
  const r2 = await syncMeetings(makeClient(), { now: NOW, events: [CALENDLY({ status: 'cancelled' })] });
  assert.equal(r2.inserted, 0);
  assert.equal(r2.unchanged, 1, 'nothing to record for a cancellation we have no row for');
});

test('an event nobody on file attends is listed as unmatched, never guessed', async () => {
  reset({ companies: [{ id: 'lejag', website: 'https://lejag.org', relationship_state: 'in_contact' }] });
  const r = await syncMeetings(makeClient(), { now: NOW, events: [CALENDLY()] });
  assert.equal(r.inserted, 0);
  assert.equal(r.unmatched.length, 1);
  assert.deepEqual(r.unmatched[0].attendees, ['dion@standwithtrans.org']);
});

test('a free-mail attendee identifies nobody', async () => {
  reset({ contacts: [{ email: 'someone@gmail.com', company_id: 'other' }].slice(1) });
  const ev = CALENDLY({ attendees: [{ email: 'friend@gmail.com', responseStatus: 'accepted' }, { email: US, self: true }] });
  const r = await syncMeetings(makeClient(), { now: NOW, events: [ev] });
  assert.equal(r.matched, 0);
  assert.equal(r.unmatched.length, 1);
});

test('the live trigger only writes rows for the company it was called for', async () => {
  reset({
    contacts: [
      { email: 'dion@standwithtrans.org', company_id: 'lgbtq-standwithtrans' },
      { email: 'philippe@lejag.org', company_id: 'lejag' },
    ],
    companies: [{ id: 'lejag', name: 'Le JAG' }, { id: 'lgbtq-standwithtrans', name: 'Stand with Trans' }],
  });
  const r = await syncMeetings(makeClient(), { now: NOW, events: [CALENDLY(), OURS()], companyId: 'lejag' });
  assert.equal(r.inserted, 1);
  assert.equal(state.inserts[0].row.company_id, 'lejag');
});

test('Jamie declining a partner invite marks the row cancelled', async () => {
  reset({
    contacts: [{ email: 'dion@standwithtrans.org', company_id: 'lgbtq-standwithtrans' }],
    meetings: [{ id: 7, company_id: 'lgbtq-standwithtrans', google_event_id: 'tfe2njp80v0nrdlqq7ufopk4ok', status: 'booked',
      starts_at: '2026-09-10T14:00:00Z', ends_at: '2026-09-10T14:30:00Z', title: 'Discuss RUBIES Clothing Donations and Dion Bourque' }],
  });
  const declined = CALENDLY({ attendees: [
    { email: 'dion@standwithtrans.org', organizer: true, responseStatus: 'accepted' },
    { email: US, self: true, responseStatus: 'declined' },
  ] });
  const r = await syncMeetings(makeClient(), { now: NOW, events: [declined] });
  assert.equal(r.cancelled, 1);
});
