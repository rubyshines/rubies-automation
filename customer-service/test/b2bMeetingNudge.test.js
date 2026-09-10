/**
 * The waiting-in-room nudge (2026-09-10): the email Jamie sends from inside
 * the meeting room when the other side has not joined. Pure halves under test:
 * the fill, the "is this call live right now" window, the template's shape,
 * and composeDraftRow's explicit-null "fresh thread" contract it relies on.
 */
const { test } = require('node:test');
const assert = require('node:assert');

const {
  TEMPLATES, fillWaitingInRoom, WAITING_IN_ROOM_SUBJECT, waitingInRoomAvailability,
} = require('../../b2b-outreach/lib/messageTemplates');
const { isMeetingLive, LIVE_LEAD_MINUTES } = require('../../b2b-outreach/lib/scheduleMeeting');
const { composeDraftRow } = require('../../b2b-outreach/lib/queueService');
const { NEXT_ACTION_DAYS, CHASE_AFTER_BUSINESS_DAYS } = require('../../b2b-outreach/lib/cadence');
const { SIGNATURE_BLOCK_MD } = require('../lib/signatures');

test('waiting_in_room: Jamie\'s sentence, the link as a clickable URL, Thanks + signature', () => {
  const url = 'https://meet.google.com/web-srvw-rft';
  const { body, attachments } = fillWaitingInRoom({ firstName: 'Philippe', meetUrl: url });
  assert.ok(body.startsWith('Hi Philippe,\n\n'));
  assert.match(body, /I am in the meeting room - just checking if you still plan to attend\./);
  assert.ok(body.includes(`Here is the link: [${url}](${url})`), 'URL is its own label so HTML is clickable and plain text shows the address');
  assert.ok(body.endsWith(`Thanks,\n\n${SIGNATURE_BLOCK_MD}`), `sign-off: ${body.slice(-80)}`);
  assert.ok(!body.includes('—'), 'no em dash in customer-facing copy');
  assert.deepEqual(attachments, []);
});

test('waiting_in_room: an event with no Meet link points at the invite rather than inventing a room', () => {
  const { body } = fillWaitingInRoom({ firstName: 'Dion', meetUrl: null });
  assert.match(body, /The link is in the calendar invite\./);
  assert.ok(!body.includes('Here is the link'));
  assert.ok(!body.includes('null'));
});

test('waiting_in_room template: live-call gated, its own type, a fresh thread under Jamie\'s subject', () => {
  const t = TEMPLATES.find(x => x.id === 'waiting_in_room');
  assert.ok(t, 'template registered');
  assert.equal(t.duringCall, true);
  assert.equal(t.message_type, 'meeting_nudge');
  assert.equal(t.new_thread, true);
  assert.equal(t.subject, WAITING_IN_ROOM_SUBJECT);
  assert.equal(WAITING_IN_ROOM_SUBJECT, 'In the meeting room right now');
  assert.ok(!t.afterNoShow && !t.orgOnly, 'nothing about no-shows or org-only applies to a live call');
  assert.ok(!t.next_touch_days, 'not an ask: no next-touch override');
});

test('waitingInRoomAvailability: only while a call is live', () => {
  assert.equal(waitingInRoomAvailability({ liveMeeting: null }).ok, false);
  assert.match(waitingInRoomAvailability({ liveMeeting: null }).reason, /no call is in progress/);
  assert.equal(waitingInRoomAvailability({ liveMeeting: { id: 1 } }).ok, true);
});

test('isMeetingLive: a few minutes before the start until the end, booked, no outcome', () => {
  const m = { status: 'booked', starts_at: '2026-09-10T14:00:00Z', ends_at: '2026-09-10T14:30:00Z', outcome: null };
  const at = iso => new Date(iso);
  assert.equal(LIVE_LEAD_MINUTES, 5);
  assert.equal(isMeetingLive(m, at('2026-09-10T13:50:00Z')), false, 'ten minutes early is not yet live');
  assert.equal(isMeetingLive(m, at('2026-09-10T13:56:00Z')), true, 'inside the lead window');
  assert.equal(isMeetingLive(m, at('2026-09-10T14:10:00Z')), true, 'mid-call');
  assert.equal(isMeetingLive(m, at('2026-09-10T14:30:00Z')), true, 'the scheduled end itself');
  assert.equal(isMeetingLive(m, at('2026-09-10T14:31:00Z')), false, 'over');
  assert.equal(isMeetingLive({ ...m, outcome: 'no_show' }, at('2026-09-10T14:10:00Z')), false, 'outcome recorded: nothing to nudge');
  assert.equal(isMeetingLive({ ...m, outcome: 'held' }, at('2026-09-10T14:10:00Z')), false);
  assert.equal(isMeetingLive({ ...m, status: 'cancelled' }, at('2026-09-10T14:10:00Z')), false);
  assert.equal(isMeetingLive(null, at('2026-09-10T14:10:00Z')), false);
});

test('isMeetingLive: a row without ends_at falls back to duration, then the default', () => {
  const start = '2026-09-10T14:00:00Z';
  assert.equal(isMeetingLive({ status: 'booked', starts_at: start, duration_minutes: 60 }, new Date('2026-09-10T14:50:00Z')), true);
  assert.equal(isMeetingLive({ status: 'booked', starts_at: start, duration_minutes: 60 }, new Date('2026-09-10T15:01:00Z')), false);
  assert.equal(isMeetingLive({ status: 'booked', starts_at: start }, new Date('2026-09-10T14:29:00Z')), true, '30-minute default');
  assert.equal(isMeetingLive({ status: 'booked', starts_at: start }, new Date('2026-09-10T14:31:00Z')), false);
  assert.equal(isMeetingLive({ status: 'booked', starts_at: 'garbage' }, new Date()), false);
});

test('composeDraftRow: explicit null thread means a fresh email; undefined still inherits the queue entry', () => {
  const entry = { thread_id: 77, message_type: 'post_call_followup', tier: 1, reason: 'call held yesterday' };
  const inherit = composeDraftRow({ company_id: 'c1', body: 'hi', entry });
  assert.equal(inherit.thread_id, 77);
  const fresh = composeDraftRow({ company_id: 'c1', body: 'hi', subject: WAITING_IN_ROOM_SUBJECT, message_type: 'meeting_nudge', thread_id: null, entry });
  assert.equal(fresh.thread_id, null, 'the nudge must not become a "Re:" on an old thread');
  assert.equal(fresh.subject, WAITING_IN_ROOM_SUBJECT);
  assert.equal(fresh.message_type, 'meeting_nudge');
  const explicit = composeDraftRow({ company_id: 'c1', body: 'hi', thread_id: 12, entry });
  assert.equal(explicit.thread_id, 12);
});

test('meeting_nudge: a week to next action, never chased by the ladder', () => {
  assert.equal(NEXT_ACTION_DAYS.meeting_nudge, 7);
  assert.equal(CHASE_AFTER_BUSINESS_DAYS.meeting_nudge, undefined, 'not an ask, so no follow-up rung');
});
