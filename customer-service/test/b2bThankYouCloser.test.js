/**
 * Tests for the B2B thank-you closer — the deterministic gate and formatting.
 * The classifier prompt itself is Sonnet's job and is not exercised here; the
 * gate is what guarantees no model call is ever spent on a message that could
 * not close, and that a failure of any kind leaves the thread open.
 *
 * Run: node --test customer-service/test/b2bThankYouCloser.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { thankYouGate, formatThreadForCloser } = require('../../b2b-outreach/lib/thankYouCloser');

const OUT = (body = 'Hi! Here is everything you asked about.') =>
  ({ direction: 'outbound', body_text: body, sent_at: '2026-08-01T10:00:00Z' });
const IN = (body = 'Thanks so much!') =>
  ({ direction: 'inbound', body_text: body, sent_at: '2026-08-02T10:00:00Z' });

test('a human reply after our outbound in an open thread is a candidate', () => {
  const g = thankYouGate({ inboundType: null, threadWasNew: false, threadStatus: 'open', messages: [OUT(), IN()] });
  assert.equal(g.eligible, true);
});

// The classifier costs money; every gate below is a message shape that must
// never reach it.

test('machine mail never reaches the classifier', () => {
  for (const t of ['auto_reply', 'calendar_notice', 'bounce']) {
    const g = thankYouGate({ inboundType: t, threadWasNew: false, threadStatus: 'open', messages: [OUT(), IN()] });
    assert.equal(g.eligible, false, t);
    assert.equal(g.reason, 'machine_generated');
  }
});

test('a brand-new thread cannot be a thank-you — there is nothing of ours to thank', () => {
  const g = thankYouGate({ inboundType: null, threadWasNew: true, threadStatus: 'open', messages: [IN()] });
  assert.equal(g.eligible, false);
  assert.equal(g.reason, 'thread_born_of_this_message');
});

test('an already-closed thread is left alone', () => {
  const g = thankYouGate({ inboundType: null, threadWasNew: false, threadStatus: 'closed', messages: [OUT(), IN()] });
  assert.equal(g.eligible, false);
  assert.equal(g.reason, 'thread_not_open');
});

test('no prior outbound → an unanswered inquiry must not be swallowed', () => {
  // e.g. an org writes in twice before we ever reply; the second message says
  // "thanks for considering!" — closing here would silence a real inquiry.
  const g = thankYouGate({ inboundType: null, threadWasNew: false, threadStatus: 'open', messages: [IN('Hello! Would you include us?'), IN('Thanks for considering!')] });
  assert.equal(g.eligible, false);
  assert.equal(g.reason, 'no_prior_outbound');
});

test('a bounced outbound does not count as a prior message of ours', () => {
  // The whole point of the bounce path is that they never received it.
  const bounced = { ...OUT(), undelivered_at: '2026-08-01T10:05:00Z' };
  const g = thankYouGate({ inboundType: null, threadWasNew: false, threadStatus: 'open', messages: [bounced, IN()] });
  assert.equal(g.eligible, false);
  assert.equal(g.reason, 'no_prior_outbound');
});

test('latest message must be the inbound in question', () => {
  const g = thankYouGate({ inboundType: null, threadWasNew: false, threadStatus: 'open', messages: [IN(), OUT()] });
  assert.equal(g.eligible, false);
  assert.equal(g.reason, 'latest_not_inbound');
});

test('an empty body is not a thank-you', () => {
  const g = thankYouGate({ inboundType: null, threadWasNew: false, threadStatus: 'open', messages: [OUT(), IN('   ')] });
  assert.equal(g.eligible, false);
  assert.equal(g.reason, 'empty_body');
});

test('formatThreadForCloser tags directions and trims to the last 6', () => {
  const messages = [
    OUT('one'), IN('two'), OUT('three'), IN('four'), OUT('five'), IN('six'), OUT('seven'), IN('eight'),
  ];
  const text = formatThreadForCloser(messages);
  assert.ok(!text.includes('one'), 'older than 6 dropped');
  assert.ok(!text.includes('two'), 'older than 6 dropped');
  assert.ok(text.includes('[US] three'));
  assert.ok(text.includes('[THEM] eight'));
});

test('formatThreadForCloser drops empty bodies rather than emitting bare tags', () => {
  const text = formatThreadForCloser([OUT(''), IN('thanks!')]);
  assert.equal(text, '[THEM] thanks!');
});

// ---------------------------------------------------------------------------
// Booked call on record — the one fact the classifier is handed. A partner's
// "sounds good, talk to you then" is courtesy when the call is booked and a
// live negotiation when it is not, and the model cannot see the meetings table.

const { describeBookedCall, buildCloserUserText } = require('../../b2b-outreach/lib/thankYouCloser');

const NOW = new Date('2026-09-08T17:00:00Z');
const INVITE = (subject, at = '2026-09-08T16:43:04Z') => ({ subject, last_message_at: at });

test('a future booked meeting row is described in their timezone', () => {
  const text = describeBookedCall({
    meetings: [{ title: 'RUBIES x Uniting Pride', starts_at: '2026-09-10T14:00:00Z', their_timezone: 'America/Chicago', status: 'booked' }],
    threads: [], now: NOW,
  });
  assert.ok(text.includes('Booked via our calendar: "RUBIES x Uniting Pride"'));
  assert.ok(text.includes('Thu, Sep 10, 2026'));
  assert.ok(text.includes('9:00 AM'));
});

test('a meeting already over is not a booked call', () => {
  const text = describeBookedCall({
    meetings: [{ title: 'RUBIES x Someone', starts_at: '2026-09-01T14:00:00Z', status: 'booked' }],
    threads: [], now: NOW,
  });
  assert.equal(text, null);
});

test('a partner-sent calendar invitation counts — Calendly calls never get a meetings row', () => {
  // The live Stand with Trans case: booked through THEIR scheduler, so the only
  // trace is the invitation Gmail filed as a calendar_notice thread.
  const text = describeBookedCall({
    meetings: [],
    threads: [INVITE('Invitation: Discuss RUBIES Clothing Donations and Dion Bourque @ Wed Sep 9, 2026 10am - 10:30am (EDT) (jamie@rubyshines.com)')],
    now: NOW,
  });
  assert.ok(text && text.startsWith('Calendar invitation from them on record:'));
  assert.ok(text.includes('Wed Sep 9, 2026 10am'));
});

test('an invitation for a date already past is not a booked call', () => {
  const text = describeBookedCall({
    meetings: [],
    threads: [INVITE('Invitation: Old call @ Tue Sep 1, 2026 10am - 10:30am (EDT) (jamie@rubyshines.com)', '2026-08-25T10:00:00Z')],
    now: NOW,
  });
  assert.equal(text, null);
});

test('a call later today is still upcoming even after it started', () => {
  const text = describeBookedCall({
    meetings: [],
    threads: [INVITE('Invitation: Today call @ Tue Sep 8, 2026 9am - 9:30am (EDT) (jamie@rubyshines.com)')],
    now: NOW,
  });
  assert.ok(text);
});

test('a later cancellation of the same event removes the invitation', () => {
  const text = describeBookedCall({
    meetings: [],
    threads: [
      INVITE('Canceled event: Discuss RUBIES Clothing Donations @ Wed Sep 9, 2026 10am - 10:30am (EDT) (jamie@rubyshines.com)', '2026-09-08T16:50:00Z'),
      INVITE('Invitation: Discuss RUBIES Clothing Donations @ Wed Sep 9, 2026 10am - 10:30am (EDT) (jamie@rubyshines.com)', '2026-09-08T16:43:04Z'),
    ],
    now: NOW,
  });
  assert.equal(text, null);
});

test('an RSVP to OUR invite is not partner-invitation evidence', () => {
  // That call has its own b2b_meetings row; the RSVP subject must not double as one.
  const text = describeBookedCall({
    meetings: [],
    threads: [INVITE('Accepted: RUBIES x Someone @ Wed Sep 9, 2026 10am - 10:30am (EDT) (jamie@rubyshines.com)')],
    now: NOW,
  });
  assert.equal(text, null);
});

test('an ordinary thread subject is never mistaken for a booking', () => {
  const text = describeBookedCall({
    meetings: [],
    threads: [INVITE('Could your community use gender-affirming clothing donations?')],
    now: NOW,
  });
  assert.equal(text, null);
});

test('the user turn tells the model plainly when no call is on record', () => {
  const none = buildCloserUserText({ recentMessages: '[THEM] Sounds good!', priorOutbound: 'Does Tuesday work?', bookedCall: null, now: NOW });
  assert.ok(none.includes('[BOOKED CALL ON RECORD — today is 2026-09-08]'));
  assert.ok(none.includes('(none — no calendar invitation exists'));
  const some = buildCloserUserText({ recentMessages: '[THEM] Sounds good!', priorOutbound: 'Invite sent.', bookedCall: 'Booked via our calendar: "X" on Wed.', now: NOW });
  assert.ok(some.includes('Booked via our calendar: "X"'));
  assert.ok(!some.includes('(none'));
});
