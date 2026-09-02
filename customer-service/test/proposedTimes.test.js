/**
 * extractProposedTimes post-processing tests. The model is stubbed — what is
 * pinned here is the deterministic half: the sent-date anchor reaching the
 * prompt, wall-clock → UTC conversion, and window ("after 1pm" / "until 5:30")
 * handling. Regression for the Blue Mountain Clinic misread (2026-09-02): a
 * message saying "tomorrow" was resolved against panel-open day instead of its
 * send date, and "until 5:30" had no schema slot so the model invented a
 * bookable midnight.
 */
const test = require('node:test');
const assert = require('node:assert');

const aiClientPath = require.resolve('../../shared/aiClient');
let lastCall = null;
let nextTimes = [];
let nextStatedTz = null;
require.cache[aiClientPath] = {
  id: aiClientPath,
  filename: aiClientPath,
  loaded: true,
  exports: {
    callClaude: async (args) => {
      lastCall = args;
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ times: nextTimes, stated_timezone: nextStatedTz, wants_to_meet: true }),
        }],
      };
    },
  },
};

const { extractProposedTimes } = require('../../b2b-outreach/lib/proposedTimes');
const { formatTimeInZone } = require('../../b2b-outreach/lib/availability');

const ET = 'America/Toronto';
const NOW = new Date('2026-09-02T19:35:00Z');       // Wed — when the panel was opened
const SENT = new Date('2026-09-01T16:04:15Z');      // Tue — when they actually wrote

async function run(times, { statedTz = null, sentAt = SENT, fallbackTimeZone = null } = {}) {
  nextTimes = times;
  nextStatedTz = statedTz;
  return extractProposedTimes({
    message: 'hello', now: NOW, sentAt, fallbackTimeZone,
  });
}

test('the prompt anchors relative days on the SEND date, not today', async () => {
  await run([]);
  const content = lastCall.messages[0].content;
  assert.match(content, /TODAY is Wednesday, 2 September 2026/);
  assert.match(content, /THE MESSAGE BELOW WAS SENT on Tuesday, 1 September 2026/);
});

test('without a sentAt the send line falls back to today', async () => {
  await run([], { sentAt: null });
  assert.match(lastCall.messages[0].content, /WAS SENT on Wednesday, 2 September 2026/);
});

test('a start-only window converts and stays a range', async () => {
  const res = await run([{
    date: '2026-09-02', time: '13:00', end_time: null,
    timezone: 'America/Denver', is_range: true, quote: 'after 1mst tomorrow',
  }]);
  const t = res.times[0];
  // 1:00 PM in Denver observes MDT (UTC-6) in September, not fixed MST.
  assert.strictEqual(t.start, '2026-09-02T19:00:00.000Z');
  assert.strictEqual(t.end, null);
  assert.strictEqual(t.isRange, true);
  assert.strictEqual(t.label, formatTimeInZone(new Date(t.start), ET)); // 3:00 PM ET
});

test('"until 5:30" is an end bound, never a bookable start', async () => {
  // is_range deliberately false: a stated end forces range-ness even when the
  // model forgets to say so.
  const res = await run([{
    date: '2026-09-03', time: null, end_time: '17:30',
    timezone: 'America/Denver', is_range: false, quote: 'until 5:30mst on Thursday',
  }]);
  const t = res.times[0];
  assert.strictEqual(t.start, null);
  assert.strictEqual(t.end, '2026-09-03T23:30:00.000Z');
  assert.strictEqual(t.isRange, true);
  assert.strictEqual(t.endLabel, formatTimeInZone(new Date(t.end), ET)); // 7:30 PM ET
  assert.strictEqual(t.dayOnly, false);
});

test('a bounded window carries both instants', async () => {
  const res = await run([{
    date: '2026-09-03', time: '14:00', end_time: '16:00',
    timezone: 'America/New_York', is_range: true, quote: 'between 2 and 4',
  }]);
  const t = res.times[0];
  assert.strictEqual(t.start, '2026-09-03T18:00:00.000Z');
  assert.strictEqual(t.end, '2026-09-03T20:00:00.000Z');
  assert.strictEqual(t.isRange, true);
});

test('an exact time stays a bookable non-range', async () => {
  const res = await run([{
    date: '2026-09-03', time: '10:00', end_time: null,
    timezone: 'America/New_York', is_range: false, quote: 'at 10am Thursday',
  }]);
  assert.strictEqual(res.times[0].isRange, false);
  assert.strictEqual(res.times[0].start, '2026-09-03T14:00:00.000Z');
});

test('a day with no times at all is a day hint', async () => {
  const res = await run([{
    date: '2026-09-04', time: null, end_time: null,
    timezone: null, is_range: true, quote: 'any time Friday',
  }]);
  assert.strictEqual(res.times[0].dayOnly, true);
  assert.strictEqual(res.times[0].start, null);
});

test('no knowable zone keeps the wall clock and flags it', async () => {
  const res = await run([{
    date: '2026-09-03', time: '13:00', end_time: '17:30',
    timezone: null, is_range: true, quote: '1 till 5:30',
  }]);
  const t = res.times[0];
  assert.strictEqual(t.needsTimeZone, true);
  assert.strictEqual(t.start, null);
  assert.strictEqual(t.wallClock, '13:00');
  assert.strictEqual(t.wallClockEnd, '17:30');
});
