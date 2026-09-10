/**
 * Two calendar events regularly describe ONE call: we Book & Send, the partner
 * sends their own invite for the same slot. The spare row is 'ignored' — kept,
 * but out of every count — and never a no-show. Recording an outcome on an
 * ignored row is refused, and a no-show it carried is cleared on ignore.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { ignoreMeeting, recordMeetingOutcome } = require('../../b2b-outreach/lib/scheduleMeeting');

function fakeSb(meeting) {
  const st = { meeting: { ...meeting }, updates: [] };
  const q = rows => {
    const self = {
      eq: (k, v) => q(rows.filter(r => r[k] === v)),
      order: () => self, limit: () => self,
      maybeSingle: async () => ({ data: rows[0] ? { ...rows[0] } : null, error: null }),
    };
    return self;
  };
  st.sb = {
    from: table => ({
      select: (_cols, opts) => {
        if (opts?.head) return { eq: () => ({ eq: async () => ({ count: 0, error: null }) }) };
        return q(table === 'b2b_meetings' ? [st.meeting] : []);
      },
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

const PAST = {
  id: 13, company_id: 'lejag', status: 'booked', title: 'Meeting with Jamie',
  starts_at: '2026-09-10T13:30:00.000Z', ends_at: '2026-09-10T14:00:00.000Z',
  outcome: 'no_show', outcome_at: '2026-09-10T17:45:25.926Z', outcome_note: null,
};

test('ignore keeps the row, clears the no-show it carried, and restore brings it back as booked', async () => {
  const st = fakeSb(PAST);
  const r = await ignoreMeeting(st.sb, { meeting_id: 13 });
  assert.equal(r.status, 'ignored');
  assert.equal(st.meeting.status, 'ignored');
  assert.equal(st.meeting.outcome, null, 'a false no-show does not survive the ignore');
  assert.equal(st.meeting.outcome_at, null);

  const back = await ignoreMeeting(st.sb, { meeting_id: 13, restore: true });
  assert.equal(back.status, 'booked');
  assert.equal(st.meeting.status, 'booked');
  assert.equal(st.meeting.outcome, null, 'restore does not resurrect the cleared outcome');
});

test('ignore refuses a cancelled row; restore refuses a row that is not ignored', async () => {
  await assert.rejects(ignoreMeeting(fakeSb({ ...PAST, status: 'cancelled' }).sb, { meeting_id: 13 }), /cancelled/);
  await assert.rejects(ignoreMeeting(fakeSb(PAST).sb, { meeting_id: 13, restore: true }), /not ignored/);
  await assert.rejects(ignoreMeeting(fakeSb(PAST).sb, { meeting_id: 99 }), /not found/);
});

test('an ignored row takes no outcome until restored', async () => {
  const st = fakeSb({ ...PAST, status: 'ignored', outcome: null });
  await assert.rejects(recordMeetingOutcome(st.sb, { meeting_id: 13, outcome: 'held', now: new Date('2026-09-10T18:00:00Z') }), /ignored/);
  assert.equal(st.updates.length, 0);
});
