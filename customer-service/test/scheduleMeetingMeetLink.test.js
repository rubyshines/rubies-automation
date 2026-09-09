/**
 * Book & Send must never announce a Meet link it does not hold. Google creates
 * the room asynchronously and can report the request as pending or as a
 * failure on the insert response (Uniting Pride, 2026-09-08: invite and reply
 * sent, no link on either). ensureMeetLink polls a pending request and retries
 * a failed one with a fresh requestId.
 *
 * Run: node --test customer-service/test/scheduleMeetingMeetLink.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { meetLinkOf, conferenceStatus, ensureMeetLink } = require('../../b2b-outreach/lib/scheduleMeeting');

const FAILED = { id: 'ev1', conferenceData: { createRequest: { requestId: 'rubies-x-1', status: { statusCode: 'failure' } } } };
const PENDING = { id: 'ev1', conferenceData: { createRequest: { requestId: 'rubies-x-1', status: { statusCode: 'pending' } } } };
const OK = { id: 'ev1', hangoutLink: 'https://meet.google.com/abc-defg-hij', conferenceData: { createRequest: { status: { statusCode: 'success' } } } };
const noSleep = async () => {};

test('meetLinkOf and conferenceStatus read what Google returned', () => {
  assert.equal(meetLinkOf(OK), 'https://meet.google.com/abc-defg-hij');
  assert.equal(meetLinkOf(FAILED), null);
  assert.equal(meetLinkOf({ conferenceData: { entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/x' }] } }), 'https://meet.google.com/x');
  assert.equal(conferenceStatus(FAILED), 'failure');
  assert.equal(conferenceStatus({}), null);
});

test('an event that already has its link is returned untouched, no calls made', async () => {
  const cal = { events: { get: async () => { throw new Error('must not be called'); }, patch: async () => { throw new Error('must not be called'); } } };
  const out = await ensureMeetLink(cal, OK, { calendarId: 'c', requestIdBase: 'rubies-x-1', sleep: noSleep });
  assert.equal(out, OK);
});

test('a pending request is polled until the link appears', async () => {
  let gets = 0;
  const cal = { events: {
    get: async () => { gets++; return { data: gets < 2 ? PENDING : OK }; },
    patch: async () => { throw new Error('pending must not be retried'); },
  } };
  const out = await ensureMeetLink(cal, PENDING, { calendarId: 'c', requestIdBase: 'rubies-x-1', sleep: noSleep });
  assert.equal(meetLinkOf(out), OK.hangoutLink);
  assert.equal(gets, 2);
});

test('a failed request is retried with a FRESH requestId and the attendee is updated', async () => {
  const patches = [];
  const cal = { events: {
    patch: async (args) => { patches.push(args); return { data: OK }; },
    get: async () => ({ data: OK }),
  } };
  const out = await ensureMeetLink(cal, FAILED, { calendarId: 'c', requestIdBase: 'rubies-x-1', sleep: noSleep });
  assert.equal(meetLinkOf(out), OK.hangoutLink);
  assert.equal(patches.length, 1);
  assert.equal(patches[0].sendUpdates, 'all');
  const rid = patches[0].requestBody.conferenceData.createRequest.requestId;
  assert.notEqual(rid, 'rubies-x-1', 'the deterministic id would only replay the failure');
  assert.ok(rid.startsWith('rubies-x-1-r'));
});

test('after every attempt fails the freshest event is returned with no link, not a throw', async () => {
  let patches = 0;
  const cal = { events: {
    patch: async () => { patches++; return { data: FAILED }; },
    get: async () => ({ data: FAILED }),
  } };
  const out = await ensureMeetLink(cal, FAILED, { calendarId: 'c', requestIdBase: 'rubies-x-1', attempts: 2, sleep: noSleep });
  assert.equal(meetLinkOf(out), null);
  assert.equal(patches, 2);
});

test('a Google error mid-retry is swallowed and the loop continues', async () => {
  let calls = 0;
  const cal = { events: {
    patch: async () => { calls++; if (calls === 1) throw new Error('rate limited'); return { data: OK }; },
    get: async () => ({ data: FAILED }),
  } };
  const out = await ensureMeetLink(cal, FAILED, { calendarId: 'c', requestIdBase: 'rubies-x-1', sleep: noSleep });
  assert.equal(meetLinkOf(out), OK.hangoutLink);
});
