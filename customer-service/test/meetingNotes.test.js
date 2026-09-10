/**
 * Meeting notes ingest (2026-09-10): finding the recording (calendar id first,
 * then time + title), writing the notes onto the row, marking it held without
 * overwriting an operator's no-show, and lifting Next Steps onto the
 * commitments list. Wispr and Supabase are both doubles.
 *
 * Run: node --test customer-service/test/meetingNotes.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');

// The recap refresh at the end of an ingest is an AI call; stub the module.
const SUMMARY_PATH = require.resolve('../../b2b-outreach/lib/relationshipSummary');
let refreshed = [];
require.cache[SUMMARY_PATH] = {
  id: SUMMARY_PATH, filename: SUMMARY_PATH, loaded: true,
  exports: { refreshCompanySummary: async (sb, id) => { refreshed.push(id); return { status: 'updated' }; } },
};

const N = require('../../b2b-outreach/lib/meetingNotes');

const SUMMARY = `Intro call.\n\n### Next Steps\n- (Jamie Alexander) Send ~8 pairs of AJ for the Oct 18 event\n- (Dion) Intro Jamie to Affirmations`;

function fakeSb(seed) {
  const tables = { b2b_meetings: [], b2b_companies: [], b2b_commitments: [], ...seed };
  let nextId = 500;
  function builder(table) {
    const rows = tables[table];
    const b = { _f: [], _op: 'select', _payload: null, _order: null, _limit: null };
    const add = f => { b._f.push(f); return b; };
    b.select = () => b;
    b.eq = (c, v) => add(r => (r[c] ?? null) === v);
    b.neq = (c, v) => add(r => (r[c] ?? null) !== v);
    b.in = (c, v) => add(r => v.includes(r[c] ?? null));
    b.is = (c, v) => add(r => (r[c] ?? null) === v);
    b.not = (c, op, v) => add(r => (r[c] ?? null) !== v);
    b.gte = (c, v) => add(r => String(r[c]) >= v);
    b.lte = (c, v) => add(r => String(r[c]) <= v);
    b.order = (c, { ascending = true } = {}) => { b._order = [c, ascending]; return b; };
    b.limit = n => { b._limit = n; return b; };
    b.insert = row => { b._op = 'insert'; b._payload = row; return b; };
    b.update = p => { b._op = 'update'; b._payload = p; return b; };
    b.delete = () => { b._op = 'delete'; return b; };
    const run = () => {
      if (b._op === 'insert') { const row = { id: nextId++, ...b._payload }; rows.push(row); return [row]; }
      let hit = rows.filter(r => b._f.every(f => f(r)));
      if (b._op === 'update') { hit.forEach(r => Object.assign(r, b._payload)); return hit; }
      if (b._op === 'delete') { hit.forEach(r => rows.splice(rows.indexOf(r), 1)); return hit; }
      if (b._order) { const [c, asc] = b._order; hit = [...hit].sort((x, y) => String(x[c] ?? '').localeCompare(String(y[c] ?? '')) * (asc ? 1 : -1)); }
      if (b._limit) hit = hit.slice(0, b._limit);
      return hit;
    };
    b.maybeSingle = () => Promise.resolve({ data: run()[0] || null, error: null });
    b.single = () => Promise.resolve({ data: run()[0] || null, error: null });
    b.then = res => Promise.resolve({ data: run(), error: null }).then(res);
    return b;
  }
  return { from: t => builder(t), tables };
}

function fakeWispr({ byCalendar = {}, recent = [], configured = true } = {}) {
  const calls = [];
  return {
    calls,
    isConfigured: async () => configured,
    meetingByCalendarId: async id => { calls.push(['byCalendar', id]); return byCalendar[id] || null; },
    searchMeetings: async () => { calls.push(['search']); return recent; },
    getMeeting: async (id, { transcript } = {}) => {
      calls.push(['get', id, !!transcript]);
      const m = [...Object.values(byCalendar), ...recent].find(x => x.id === id);
      return transcript ? { ...m, transcript: 'verbatim words' } : m;
    },
  };
}

const NOW = new Date('2026-09-10T22:00:00Z');
const swtRow = (over = {}) => ({
  id: 9, company_id: 'swt', title: 'Discuss RUBIES Clothing Donations', google_event_id: 'tfe2', status: 'booked',
  starts_at: '2026-09-10T14:00:00Z', outcome: null, summary: null, ...over,
});
const company = { id: 'swt', name: 'Stand with Trans', relationship_type: 'lgbtq_org' };

test('title matching: the company\'s distinctive words, not its stopwords', () => {
  assert.equal(N.titleMatchesCompany('Standing With Trans', 'Stand with Trans'), true, '"stand" is a prefix of "standing"');
  assert.equal(N.titleMatchesCompany('RUBIES x COLAGE', 'COLAGE'), true);
  assert.equal(N.titleMatchesCompany('Meeting with the team', 'Stand with Trans'), false, '"with" alone is not a match');
  assert.equal(N.titleMatchesCompany('', 'COLAGE'), false);
});

test('matchRecording picks the closest titled recording inside 45 minutes and nothing outside it', () => {
  const row = swtRow();
  const near = { id: 'a', title: 'Standing With Trans', start: '2026-09-10T14:06:06Z' };
  const nearer = { id: 'b', title: 'Stand With Trans intro', start: '2026-09-10T14:01:00Z' };
  const far = { id: 'c', title: 'Standing With Trans', start: '2026-09-10T16:00:00Z' };
  const wrong = { id: 'd', title: 'RUBIES x COLAGE', start: '2026-09-10T14:00:00Z' };
  assert.equal(N.matchRecording(row, 'Stand with Trans', [near, far, wrong, nearer])?.id, 'b');
  assert.equal(N.matchRecording(row, 'Stand with Trans', [far, wrong]), null);
});

test('a calendar-linked recording is found by event id, stored, marked held, and its Next Steps become commitments', async () => {
  refreshed = [];
  const sb = fakeSb({ b2b_meetings: [swtRow()], b2b_companies: [company] });
  const wispr = fakeWispr({ byCalendar: { tfe2: { id: 'm1', title: 'Standing With Trans', summary: SUMMARY, share_link: 'https://notes/x', has_transcript: true, start: '2026-09-10T14:06:06Z' } } });
  const r = await N.ingestMeetingNotes(sb, { meeting_id: 9, now: NOW, wispr });
  assert.equal(r.status, 'ingested');
  assert.equal(r.matched_by, 'calendar');
  assert.equal(r.held, true);
  const row = sb.tables.b2b_meetings[0];
  assert.equal(row.outcome, 'held');
  assert.equal(row.summary, SUMMARY);
  assert.equal(row.wispr_share_link, 'https://notes/x');
  assert.equal(row.transcript, 'verbatim words', 'the transcript is kept on the row');
  assert.equal(r.commitments.added, 2);
  const items = sb.tables.b2b_commitments;
  assert.deepEqual(items.map(i => [i.owner, i.source, i.meeting_id]), [['me', 'meeting', 9], ['them', 'meeting', 9]]);
  assert.equal(sb.tables.b2b_companies[0].on_me_at, NOW.toISOString(), 'I owe them something, so the company is on me');
  assert.deepEqual(refreshed, ['swt'], 'the recap is rebuilt so it knows the call was held');
});

test('a hand-started recording with no calendar link is found by time and title', async () => {
  const sb = fakeSb({ b2b_meetings: [swtRow()], b2b_companies: [company] });
  const wispr = fakeWispr({
    recent: [
      { id: 'other', title: 'RUBIES x COLAGE', summary: 'x', start: '2026-09-10T16:00:00Z' },
      { id: 'm2', title: 'Standing With Trans', summary: SUMMARY, share_link: 'https://notes/y', start: '2026-09-10T14:06:06Z' },
    ],
  });
  const r = await N.ingestMeetingNotes(sb, { meeting_id: 9, now: NOW, wispr });
  assert.equal(r.status, 'ingested');
  assert.equal(r.matched_by, 'time_title');
  assert.equal(r.wispr_meeting_id, 'm2');
  assert.ok(wispr.calls.some(c => c[0] === 'byCalendar' && c[1] === 'tfe2'), 'the calendar id was tried first');
});

test('every linked event id is tried before falling back', async () => {
  const sb = fakeSb({ b2b_meetings: [swtRow({ google_event_id: 'ours', linked_event_ids: ['theirs'] })], b2b_companies: [company] });
  const wispr = fakeWispr({ byCalendar: { theirs: { id: 'm3', title: 'Meeting with Jamie', summary: SUMMARY, start: '2026-09-10T14:00:00Z' } } });
  const r = await N.ingestMeetingNotes(sb, { meeting_id: 9, now: NOW, wispr });
  assert.equal(r.status, 'ingested');
  assert.deepEqual(wispr.calls.filter(c => c[0] === 'byCalendar').map(c => c[1]), ['ours', 'theirs']);
});

test('no recording proves nothing: the row is untouched and the result says so', async () => {
  const sb = fakeSb({ b2b_meetings: [swtRow()], b2b_companies: [company] });
  const r = await N.ingestMeetingNotes(sb, { meeting_id: 9, now: NOW, wispr: fakeWispr({ recent: [] }) });
  assert.equal(r.status, 'no_recording');
  assert.equal(sb.tables.b2b_meetings[0].outcome, null);
  assert.equal(sb.tables.b2b_commitments.length, 0);
});

test('an operator-recorded no-show is not overwritten by a recording; the notes are stored and the conflict reported', async () => {
  const sb = fakeSb({ b2b_meetings: [swtRow({ outcome: 'no_show' })], b2b_companies: [company] });
  const wispr = fakeWispr({ byCalendar: { tfe2: { id: 'm1', title: 'Standing With Trans', summary: SUMMARY, start: '2026-09-10T14:06:06Z' } } });
  const r = await N.ingestMeetingNotes(sb, { meeting_id: 9, now: NOW, wispr });
  assert.equal(r.status, 'ingested');
  assert.equal(r.held, false);
  assert.equal(r.conflict, true);
  assert.equal(sb.tables.b2b_meetings[0].outcome, 'no_show');
  assert.equal(sb.tables.b2b_meetings[0].summary, SUMMARY);
});

test('a row with notes is skipped unless forced; not connected is reported, not thrown', async () => {
  const sb = fakeSb({ b2b_meetings: [swtRow({ summary: 'already here' })], b2b_companies: [company] });
  const wispr = fakeWispr({ byCalendar: { tfe2: { id: 'm1', title: 'Standing With Trans', summary: SUMMARY, start: '2026-09-10T14:06:06Z' } } });
  assert.equal((await N.ingestMeetingNotes(sb, { meeting_id: 9, now: NOW, wispr })).status, 'already');
  assert.equal((await N.ingestMeetingNotes(sb, { meeting_id: 9, now: NOW, wispr, force: true })).status, 'ingested');

  const sb2 = fakeSb({ b2b_meetings: [swtRow()], b2b_companies: [company] });
  assert.equal((await N.ingestMeetingNotes(sb2, { meeting_id: 9, now: NOW, wispr: fakeWispr({ configured: false }) })).status, 'not_connected');
  const sweep = await N.ingestRecentNotes(sb2, { now: NOW, wispr: fakeWispr({ configured: false }) });
  assert.match(sweep.skipped, /not connected/);
});

test('the nightly pass covers the last week of calls without notes and nothing else', async () => {
  const sb = fakeSb({
    b2b_meetings: [
      swtRow(),
      swtRow({ id: 10, summary: 'has notes' }),
      swtRow({ id: 11, status: 'cancelled' }),
      swtRow({ id: 12, starts_at: '2026-08-01T14:00:00Z' }),
      swtRow({ id: 13, starts_at: '2026-09-12T14:00:00Z' }),
    ],
    b2b_companies: [company],
  });
  const wispr = fakeWispr({ recent: [] });
  const r = await N.ingestRecentNotes(sb, { now: NOW, wispr });
  assert.equal(r.considered, 1, 'only the recent, live, notes-less call');
  assert.equal(r.no_recording, 1);
});

test('the manual fallback records notes handed in by a session, with an explicit commitments list', async () => {
  refreshed = [];
  const sb = fakeSb({ b2b_meetings: [swtRow()], b2b_companies: [company] });
  const r = await N.recordMeetingNotes(sb, {
    row: sb.tables.b2b_meetings[0], now: NOW,
    notes: { summary: 'Short recap.', share_link: 'https://notes/z', commitments: [{ owner: 'us', text: 'Ship 8 pairs', due_on: '2026-10-10' }] },
  });
  assert.equal(r.held, true);
  assert.equal(r.commitments.added, 1);
  assert.equal(sb.tables.b2b_commitments[0].owner, 'me');
  assert.equal(sb.tables.b2b_commitments[0].due_on, '2026-10-10');
});
