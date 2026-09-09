/**
 * Post-call follow-up cadence + operator message templates (2026-09-03).
 *
 * The pure halves: template fills are deterministic string builds, and the
 * post-call due condition is a pure function of (ctx, now). DB-bound plumbing
 * (templateContext, applyTemplate, dismissPostCallFollowup) is thin
 * lookup/update glue over these.
 */
const { test } = require('node:test');
const assert = require('node:assert');

const {
  CALL_NOTES_PLACEHOLDER, ONBOARDING_SURVEY_URL, TEMPLATES,
  meetingDayName, greetingName, fillSetupCall, fillPartnerOnboarding,
} = require('../../b2b-outreach/lib/messageTemplates');
const {
  laterEasternDay, postCallFollowupDue, evaluateDue, POST_CALL_MAX_AGE_DAYS,
  INITIATING_TYPES, NEXT_ACTION_DAYS, CHASE_AFTER_BUSINESS_DAYS,
} = require('../../b2b-outreach/lib/cadence');
const { computeQueueEntry, TIER_BY_TYPE } = require('../../b2b-outreach/lib/queue');

// ---------------------------------------------------------------- templates

test('setup_call: program paragraph appears only when no intro was ever sent', () => {
  const withProgram = fillSetupCall({ firstName: 'Emma', companyName: 'Youth OUTright', discount: 50, introEverSent: false });
  assert.match(withProgram.body, /Hi Emma,/);
  assert.match(withProgram.body, /explore a partnership with Youth OUTright/);
  assert.match(withProgram.body, /50% off our retail prices/);
  assert.match(withProgram.body, /Feel free to suggest some times/);

  const without = fillSetupCall({ firstName: 'Emma', companyName: 'Youth OUTright', discount: 50, introEverSent: true });
  assert.ok(!without.body.includes('partnership with'), 'they already read our intro — no program paragraph');
  assert.match(without.body, /30 mins sometime next week/);
  assert.equal(without.attachments.length, 0);
});

test('partner_onboarding: placeholder, survey link, discount, agreement spec', () => {
  const { body, attachments } = fillPartnerOnboarding({ firstName: 'Jessica', discount: 50, meetingDay: 'Monday' });
  assert.match(body, /Hi Jessica,/);
  assert.match(body, /Great talking with you on Monday\./);
  assert.ok(body.includes(CALL_NOTES_PLACEHOLDER), 'the operator-fills-this slot must be present');
  // The survey link hangs off its label (2026-09-08), not a bare URL.
  assert.ok(body.includes(`here is the [Onboarding Survey](${ONBOARDING_SURVEY_URL}).`), 'survey is a labelled markdown link');
  assert.match(body, /Also just a reminder that partner organizations can buy anything on the site at 50% off retail\. So if you are ever looking to place an order, you can send it my way and I'll take care of it\./);
  assert.ok(!body.includes('On purchasing:'), 'old purchase line is gone');
  assert.match(body, /attached the agreement to sign and return/);
  assert.deepEqual(attachments, [{ kind: 'partner_agreement' }]);

  const noDay = fillPartnerOnboarding({ firstName: 'Jessica', discount: 30, meetingDay: null });
  assert.match(noDay.body, /Great talking with you\. /);
  assert.match(noDay.body, /30% off retail/);
});

test('templates sign off with the CS signature block: name line + linked rubyshines.com', () => {
  const { SIGNATURE_BLOCK_MD } = require('../lib/signatures');
  for (const body of [
    fillSetupCall({ firstName: 'A', companyName: 'B', discount: 30, introEverSent: true }).body,
    fillPartnerOnboarding({ firstName: 'A', discount: 50, meetingDay: null }).body,
  ]) {
    assert.ok(body.endsWith(`Talk soon,\n\n${SIGNATURE_BLOCK_MD}`), `sign-off is the shared block: ${body.slice(-80)}`);
    assert.ok(body.includes('[rubyshines.com](https://rubyshines.com)'), 'site line is a link, as in the CS advisor');
  }
});

test('no em dashes in any filled body (customer-facing copy guardrail)', () => {
  const bodies = [
    fillSetupCall({ firstName: 'A', companyName: 'B', discount: 30, introEverSent: false }).body,
    fillPartnerOnboarding({ firstName: 'A', discount: 50, meetingDay: 'Friday' }).body,
    CALL_NOTES_PLACEHOLDER,
  ];
  for (const b of bodies) assert.ok(!b.includes('—'), `em dash in: ${b.slice(0, 80)}`);
});

test('meetingDayName: their timezone decides the weekday, old meetings drop it', () => {
  // 2026-08-31T19:00Z is Monday noon in Los Angeles AND Monday afternoon ET.
  const m = { starts_at: '2026-08-31T19:00:00Z', their_timezone: 'America/Los_Angeles' };
  assert.equal(meetingDayName(m, new Date('2026-09-03T12:00:00Z')), 'Monday');
  // 2026-08-30T02:00Z is Saturday evening in LA but Sunday in UTC — the
  // sentence must name THEIR day.
  const late = { starts_at: '2026-08-30T02:00:00Z', their_timezone: 'America/Los_Angeles' };
  assert.equal(meetingDayName(late, new Date('2026-09-01T12:00:00Z')), 'Saturday');
  // Too old for a bare weekday to be unambiguous.
  assert.equal(meetingDayName(m, new Date('2026-09-15T12:00:00Z')), null);
  assert.equal(meetingDayName(null), null);
  // A junk timezone falls back rather than throwing.
  assert.equal(typeof meetingDayName({ starts_at: '2026-08-31T19:00:00Z', their_timezone: 'Not/AZone' }, new Date('2026-09-01T12:00:00Z')), 'string');
});

test('greetingName: first word, "there" fallback', () => {
  assert.equal(greetingName('Jessica Bernacki'), 'Jessica');
  assert.equal(greetingName(null), 'there');
  assert.equal(greetingName('  '), 'there');
});

test('partner_onboarding is org-only in the catalog', () => {
  const t = TEMPLATES.find(t => t.id === 'partner_onboarding');
  assert.equal(t.orgOnly, true);
  assert.ok(!TEMPLATES.find(t => t.id === 'setup_call').orgOnly);
});

// ------------------------------------------------------------------ cadence

test('laterEasternDay: due next ET morning, not the evening of the call', () => {
  const callEnd = '2026-08-31T19:30:00Z'; // Mon 3:30pm ET
  assert.equal(laterEasternDay(callEnd, new Date('2026-08-31T23:00:00Z')), false, 'same ET day');
  assert.equal(laterEasternDay(callEnd, new Date('2026-09-01T01:00:00Z')), false, 'Mon 9pm ET is still Monday');
  assert.equal(laterEasternDay(callEnd, new Date('2026-09-01T11:00:00Z')), true, 'Tue 7am ET');
});

const HELD = { id: 2, thread_id: 537, starts_at: '2026-08-31T19:00:00Z', ends_at: '2026-08-31T19:30:00Z' };
const NOW = new Date('2026-09-03T12:00:00Z');

test('postCallFollowupDue: due after the call until anything goes out', () => {
  const due = postCallFollowupDue({ lastHeldMeeting: HELD, lastOutboundAt: '2026-08-26T18:34:00Z' }, NOW);
  assert.equal(due.message_type, 'post_call_followup');
  assert.equal(due.thread_id, 537);
  assert.equal(due.meeting_id, 2);
  assert.equal(due.waiting_since, HELD.ends_at);
  assert.match(due.reason, /call held/);

  // ANY outbound after the meeting end clears it — including a manual Gmail
  // send the reconcile imported.
  assert.equal(postCallFollowupDue({ lastHeldMeeting: HELD, lastOutboundAt: '2026-09-01T15:00:00Z' }, NOW), null);
  // No meeting on record, nothing due.
  assert.equal(postCallFollowupDue({ lastHeldMeeting: null }, NOW), null);
  // Same ET day as the call: not yet.
  assert.equal(postCallFollowupDue({ lastHeldMeeting: HELD, lastOutboundAt: null }, new Date('2026-08-31T21:00:00Z')), null);
  // The moment is missed past the max age — operator judgment from there.
  const old = { ...HELD, starts_at: '2026-07-01T19:00:00Z', ends_at: '2026-07-01T19:30:00Z' };
  assert.equal(postCallFollowupDue({ lastHeldMeeting: old, lastOutboundAt: null }, NOW), null);
  assert.ok(POST_CALL_MAX_AGE_DAYS >= 14, 'a vacation must not silently eat the window');
});

function org(over = {}) {
  return { relationship_type: 'lgbtq_org', relationship_state: 'active', program_flags: {}, ...over };
}

test('evaluateDue: post-call outranks every other cadence track', () => {
  // October makes community_checkin due for this org; the held call wins.
  const octHeld = { ...HELD, starts_at: '2026-10-01T19:00:00Z', ends_at: '2026-10-01T19:30:00Z' };
  const ctx = { lastHeldMeeting: octHeld, lastOutboundAt: null, sentTypes: new Set() };
  const octNow = new Date('2026-10-05T12:00:00Z');
  assert.equal(evaluateDue(org(), ctx, octNow).message_type, 'post_call_followup');
  // ...and once the moment is missed, the ordinary cadence takes back over.
  assert.equal(evaluateDue(org(), { ...ctx, lastHeldMeeting: HELD }, octNow).message_type, 'community_checkin');
});

test('computeQueueEntry: post-call lands Tier 1 carrying meeting_id + waiting_since', () => {
  const ctx = { lastHeldMeeting: HELD, lastOutboundAt: '2026-08-26T18:34:00Z', lastInboundAt: '2026-08-25T12:00:00Z', sentTypes: new Set() };
  const entry = computeQueueEntry(org(), ctx, NOW);
  assert.equal(entry.tier, 1);
  assert.equal(entry.message_type, 'post_call_followup');
  assert.equal(entry.meeting_id, 2);
  assert.equal(entry.thread_id, 537);
  assert.ok(entry.waiting_since);
});

test('a reply that lands after the call surfaces as Tier 1 reply, not post-call', () => {
  const ctx = { lastHeldMeeting: HELD, lastOutboundAt: '2026-08-26T18:34:00Z', lastInboundAt: '2026-09-01T12:00:00Z', lastInboundThreadId: 537, sentTypes: new Set() };
  const entry = computeQueueEntry(org(), ctx, NOW);
  assert.equal(entry.tier, 1);
  assert.equal(entry.message_type, null, 'the reply is the work; the advisor/operator reads the thread');
});

test('post_call_followup is wired but never auto-drafted', () => {
  assert.ok(!INITIATING_TYPES.includes('post_call_followup'),
    'continuations are operator-written (2026-09-02) — the nightly pass must never draft this');
  assert.equal(TIER_BY_TYPE.post_call_followup, 1);
  assert.ok(NEXT_ACTION_DAYS.post_call_followup, 'needs a Tier-5 backstop after send');
  assert.ok(CHASE_AFTER_BUSINESS_DAYS.post_call_followup, 'the agreement ask gets chased if ignored');
});

test('the meeting confirmation is the whole reply, in Jamie\'s words, around the one sentence', () => {
  const { fillMeetingConfirmation } = require('../../b2b-outreach/lib/messageTemplates');
  const { renderConfirmationBody } = require('../../b2b-outreach/lib/scheduleMeeting');
  const { SIGNATURE_NAME } = require('../lib/signatures');

  const { body, attachments } = fillMeetingConfirmation({
    firstName: 'Emma', confirmationLine: 'Ok, I just sent an invite for Fri Sept 25 at 3:00 PM ET (2:00 PM your time).',
  });
  assert.deepEqual(attachments, []);
  assert.strictEqual(body,
    'Hi Emma,\n\n'
    + 'Ok, I just sent an invite for Fri Sept 25 at 3:00 PM ET (2:00 PM your time).\n\n'
    + 'Looking forward to chatting.\n\n'
    + 'Talk soon,\n\n'
    + SIGNATURE_NAME + '\n[rubyshines.com](https://rubyshines.com)');
  assert.ok(!body.includes('\u2014'), 'no em dashes in customer-facing copy');

  // Through the schedule path: the sentence is rendered from the instant, both zones.
  const full = renderConfirmationBody({
    firstName: 'Emma', start: new Date('2026-09-25T19:00:00.000Z'), theirTimeZone: 'America/Chicago',
  });
  assert.match(full, /^Hi Emma,\n\nOk, I just sent an invite for Fri Sept 25 at 3:00 PM ET \(2:00 PM your time\)\.\n\nLooking forward to chatting\.\n\nTalk soon,/);
  // No name on file: "there", never a blank greeting.
  assert.match(renderConfirmationBody({ firstName: 'there', start: new Date('2026-09-25T19:00:00.000Z') }), /^Hi there,/);
});

// ---------------------------------------------------------------- no-show (2026-09-09)
// The engine cannot see attendance, so the operator records it; a recorded
// no-show turns the post-call entry into a reschedule ask, and after two the
// asks stop.

const {
  fillMissedCall, meetingAsksAllowed, missedCallAvailability, MAX_NO_SHOWS,
} = require('../../b2b-outreach/lib/messageTemplates');

test('missed_call: neutral wording, day named only while unambiguous, times theirs to suggest', () => {
  const { body, attachments } = fillMissedCall({ firstName: 'Dion', meetingDay: 'Thursday' });
  assert.match(body, /Hi Dion,/);
  assert.match(body, /Sorry we missed each other on Thursday\./);
  assert.match(body, /Feel free to suggest a few\./);
  assert.ok(!/you missed/i.test(body), 'never blames them');
  assert.ok(!body.includes('—'), 'no em dashes in customer-facing copy');
  assert.equal(attachments.length, 0);
  assert.match(fillMissedCall({ firstName: 'Dion', meetingDay: null }).body, /Sorry we missed each other\. /);
});

test('missed_call is offered only after a recorded no-show, and never past MAX_NO_SHOWS', () => {
  assert.equal(MAX_NO_SHOWS, 2);
  assert.equal(meetingAsksAllowed(0), true);
  assert.equal(meetingAsksAllowed(1), true);
  assert.equal(meetingAsksAllowed(2), false);
  assert.equal(missedCallAvailability({ lastMeeting: { outcome: null }, noShowCount: 0 }).ok, false);
  assert.equal(missedCallAvailability({ lastMeeting: { outcome: 'held' }, noShowCount: 1 }).ok, false);
  assert.equal(missedCallAvailability({ lastMeeting: { outcome: 'no_show' }, noShowCount: 1 }).ok, true);
  const second = missedCallAvailability({ lastMeeting: { outcome: 'no_show' }, noShowCount: 2 });
  assert.equal(second.ok, false);
  assert.match(second.reason, /October check-in/);
  const t = TEMPLATES.find(x => x.id === 'missed_call');
  assert.equal(t.afterNoShow, true);
  assert.equal(t.message_type, 'missed_call');
  assert.equal(t.next_touch_days, 7);
});

test('postCallFollowupDue: a recorded no-show is not a held call', () => {
  const now = new Date('2026-09-10T15:00:00Z');
  const held = { id: 5, starts_at: '2026-09-09T13:30:00Z', ends_at: '2026-09-09T14:00:00Z', thread_id: null };
  assert.equal(postCallFollowupDue({ lastHeldMeeting: held, lastOutboundAt: null }, now)?.message_type, 'post_call_followup');
  assert.equal(postCallFollowupDue({ lastHeldMeeting: { ...held, outcome: 'no_show' }, lastOutboundAt: null }, now), null);
  assert.equal(postCallFollowupDue({ lastHeldMeeting: { ...held, outcome: 'held' }, lastOutboundAt: null }, now)?.message_type, 'post_call_followup');
});

test('missed_call is its own chased message type, never an initiating one', () => {
  assert.equal(CHASE_AFTER_BUSINESS_DAYS.missed_call, 5);
  assert.equal(NEXT_ACTION_DAYS.missed_call, 7);
  assert.ok(!INITIATING_TYPES.includes('missed_call'));
});
