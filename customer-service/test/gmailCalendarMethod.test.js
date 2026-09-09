/**
 * The calendar MIME method the Gmail intake reads off a text/calendar part.
 * Language-independent RSVP detection: a French Outlook "Acceptée : …" with an
 * empty body still carries `method=REPLY`.
 *
 * Run: node --test customer-service/test/gmailCalendarMethod.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { calendarMethod } = require('../../gmail-management/lib/gmailSync');
const { classifyInbound } = require('../../b2b-outreach/lib/replyCorrelation');

const b64 = (s) => Buffer.from(s, 'utf-8').toString('base64');

test('reads the method off the Content-Type parameter of a text/calendar part', () => {
  const payload = {
    mimeType: 'multipart/alternative',
    parts: [
      { mimeType: 'text/plain', body: { data: b64('') } },
      { mimeType: 'text/calendar', headers: [{ name: 'Content-Type', value: 'text/calendar; charset="utf-8"; method=REPLY' }], body: { data: b64('BEGIN:VCALENDAR') } },
    ],
  };
  assert.equal(calendarMethod(payload), 'REPLY');
});

test('falls back to the METHOD: line in the part body, and walks nested parts', () => {
  const payload = {
    mimeType: 'multipart/mixed',
    parts: [{
      mimeType: 'multipart/alternative',
      parts: [{ mimeType: 'text/calendar', headers: [{ name: 'Content-Type', value: 'text/calendar; charset=UTF-8' }],
        body: { data: b64('BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nEND:VCALENDAR') } }],
    }],
  };
  assert.equal(calendarMethod(payload), 'REQUEST');
});

test('a message with no calendar part has no method', () => {
  assert.equal(calendarMethod({ mimeType: 'text/plain', body: { data: b64('hi') } }), null);
  assert.equal(calendarMethod({ mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/html', body: { data: b64('<p>hi</p>') } }] }), null);
});

test('the method hint classifies an RSVP in any language as a calendar notice', () => {
  // The live Le JAG case: French subject, empty body, method=REPLY part.
  assert.equal(classifyInbound({ subject: 'Acceptée : RUBIES x Le JAG', body: '', from: 'philippe@lejag.org', calendarMethod: 'REPLY' }), 'calendar_notice');
  // Without the hint the same message reads as a person writing — the bug.
  assert.equal(classifyInbound({ subject: 'Acceptée : RUBIES x Le JAG', body: '', from: 'philippe@lejag.org' }), null);
  // A bounce still wins over the hint.
  assert.equal(classifyInbound({ subject: 'Delivery Status Notification (Failure)', body: 'address not found 550', from: 'mailer-daemon@googlemail.com', calendarMethod: 'REPLY' }), 'bounce');
});
