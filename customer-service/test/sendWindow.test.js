const { test } = require('node:test');
const assert = require('node:assert');
const {
  nextSendSlot, resolveWindow, describeSlot, slotOffsetMinutes,
  zonedParts, WINDOW_START_MIN, WINDOW_END_MIN, DEFAULT_TIME_ZONE,
} = require('../../b2b-outreach/lib/sendWindow');

/** Minutes past local midnight that `at` represents in `tz`. */
function localMinute(at, tz) {
  const p = zonedParts(at, tz);
  return p.hour * 60 + p.minute;
}
function localDow(at, tz) {
  const p = zonedParts(at, tz);
  return new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
}

// ── window resolution ───────────────────────────────────────────────────────

test('a known zone gets the mid-morning window', () => {
  const w = resolveWindow({ timeZone: 'Europe/London' });
  assert.equal(w.timeZone, 'Europe/London');
  assert.equal(w.startMin, WINDOW_START_MIN);
  assert.equal(w.endMin, WINDOW_END_MIN);
  assert.equal(w.resolved, true);
});

test('a multi-zone country with no region gets a window valid across the whole country', () => {
  // The 46 US rows that carry a country and no state. We do not guess Eastern
  // vs Pacific — we pick a time that works either way.
  const w = resolveWindow({ country: 'United States' });
  assert.equal(w.resolved, false);
  assert.equal(w.timeZone, 'America/New_York');
  assert.equal(w.startMin, 12 * 60, 'noon Eastern is 9am Pacific');
  assert.match(w.reason, /business hours across all of US/);
});

test('no location at all falls back to Eastern and says so', () => {
  const w = resolveWindow({});
  assert.equal(w.timeZone, DEFAULT_TIME_ZONE);
  assert.equal(w.resolved, false);
  assert.match(w.reason, /no location on file/);
});

test('an unparseable operator-typed zone does not crash the scheduler', () => {
  const w = resolveWindow({ timeZone: 'Mars/Olympus', country: 'United Kingdom' });
  assert.equal(w.resolved, false);
  // Falls through to the country branch; GB is single-zone so it is not in the
  // multi-zone table and lands on the stated default rather than a guess.
  assert.equal(w.timeZone, DEFAULT_TIME_ZONE);
});

// ── slot placement ──────────────────────────────────────────────────────────

test('the slot lands inside the window, on a weekday, in the future', () => {
  const now = new Date('2026-08-26T18:00:00Z'); // Wednesday evening UTC
  const { at, timeZone } = nextSendSlot({ timeZone: 'Europe/London', companyId: 'mermaids', now });
  assert.ok(at > now);
  const m = localMinute(at, timeZone);
  assert.ok(m >= WINDOW_START_MIN && m < WINDOW_END_MIN, `local minute ${m} outside window`);
  const dow = localDow(at, timeZone);
  assert.ok(dow >= 1 && dow <= 5, `landed on weekday ${dow}`);
});

test('a Friday evening send waits for Monday, never the weekend', () => {
  const now = new Date('2026-08-28T20:00:00Z'); // Friday night
  const { at, timeZone } = nextSendSlot({ timeZone: 'America/New_York', companyId: 'x', now });
  assert.equal(localDow(at, timeZone), 1, 'Monday');
});

test('a Saturday send waits for Monday', () => {
  const now = new Date('2026-08-29T12:00:00Z'); // Saturday
  const { at, timeZone } = nextSendSlot({ timeZone: 'America/New_York', companyId: 'x', now });
  assert.equal(localDow(at, timeZone), 1);
});

test('mid-window the same morning still schedules ahead, never in the past', () => {
  // 10:00 London on a Wednesday — inside the window already.
  const now = new Date('2026-08-26T09:00:00Z');
  const { at } = nextSendSlot({ timeZone: 'Europe/London', companyId: 'clare', now });
  assert.ok(at > now);
});

// ── the reason this is a hash and not Math.random ───────────────────────────

test('the slot is deterministic — re-running the sweep does not move it', () => {
  const now = new Date('2026-08-26T18:00:00Z');
  const a = nextSendSlot({ timeZone: 'Europe/London', companyId: 'mermaids', now });
  const b = nextSendSlot({ timeZone: 'Europe/London', companyId: 'mermaids', now });
  assert.equal(a.at.getTime(), b.at.getTime());
});

test('different companies get different minutes so a batch does not arrive as one', () => {
  const ids = ['mermaids', 'clare-project', 'trans-pride-brighton', 'not-a-phase', 'q-corner'];
  const mins = new Set(ids.map(id => slotOffsetMinutes(id, 120)));
  assert.ok(mins.size >= 4, `expected spread across the window, got ${[...mins].join(',')}`);
  for (const m of mins) assert.ok(m >= 0 && m < 120);
});

test('the offset stays inside the window span', () => {
  for (const id of ['a', 'bb', 'ccc', 'a-very-long-company-slug-indeed', '']) {
    const m = slotOffsetMinutes(id, 120);
    assert.ok(m >= 0 && m < 120, `${id} → ${m}`);
  }
});

// ── DST, which is where naive offset arithmetic breaks ──────────────────────

test('lands correctly the day after a spring-forward transition', () => {
  // US DST began Sun 8 Mar 2026. A slot for Monday 9 March must still read
  // mid-morning locally, not an hour off.
  const now = new Date('2026-03-06T22:00:00Z'); // Friday
  const { at, timeZone } = nextSendSlot({ timeZone: 'America/New_York', companyId: 'raleigh', now });
  const m = localMinute(at, timeZone);
  assert.ok(m >= WINDOW_START_MIN && m < WINDOW_END_MIN, `local minute ${m}`);
  assert.equal(localDow(at, timeZone), 1);
});

test('lands correctly around a fall-back transition', () => {
  // US DST ended Sun 1 Nov 2026.
  const now = new Date('2026-10-30T22:00:00Z'); // Friday
  const { at, timeZone } = nextSendSlot({ timeZone: 'America/New_York', companyId: 'raleigh', now });
  const m = localMinute(at, timeZone);
  assert.ok(m >= WINDOW_START_MIN && m < WINDOW_END_MIN, `local minute ${m}`);
});

test('southern-hemisphere zones work — their DST runs the other way', () => {
  const now = new Date('2026-10-02T22:00:00Z');
  const { at, timeZone } = nextSendSlot({ timeZone: 'Australia/Sydney', companyId: 'tgv', now });
  const m = localMinute(at, timeZone);
  assert.ok(m >= WINDOW_START_MIN && m < WINDOW_END_MIN, `local minute ${m}`);
});

test('a half-hour-offset zone is handled', () => {
  const now = new Date('2026-08-26T18:00:00Z');
  const { at, timeZone } = nextSendSlot({ timeZone: 'Asia/Kolkata', companyId: 'x', now });
  const m = localMinute(at, timeZone);
  assert.ok(m >= WINDOW_START_MIN && m < WINDOW_END_MIN, `local minute ${m}`);
});

// ── the US-no-region fallback does what it claims ───────────────────────────

test('the US fallback slot is business hours in BOTH Eastern and Pacific', () => {
  const now = new Date('2026-08-26T02:00:00Z');
  const { at } = nextSendSlot({ country: 'United States', companyId: 'q-corner', now });
  const eastern = localMinute(at, 'America/New_York');
  const pacific = localMinute(at, 'America/Los_Angeles');
  assert.ok(eastern >= 9 * 60 && eastern < 17 * 60, `Eastern ${eastern}`);
  assert.ok(pacific >= 9 * 60 && pacific < 17 * 60, `Pacific ${pacific}`);
});

test('the Canada fallback slot is business hours in both Vancouver and Halifax', () => {
  const now = new Date('2026-08-26T02:00:00Z');
  const { at } = nextSendSlot({ country: 'Canada', companyId: 'p10', now });
  const van = localMinute(at, 'America/Vancouver');
  const hal = localMinute(at, 'America/Halifax');
  assert.ok(van >= 9 * 60 && van < 17 * 60, `Vancouver ${van}`);
  assert.ok(hal >= 9 * 60 && hal < 17 * 60, `Halifax ${hal}`);
});

// ── display ─────────────────────────────────────────────────────────────────

test('describeSlot renders something a human can check at a glance', () => {
  const at = new Date('2026-08-27T08:47:00Z');
  const s = describeSlot({ at, timeZone: 'Europe/London' });
  assert.match(s, /Thu/);
  assert.match(s, /09:47/);
  assert.match(s, /Europe\/London/);
});

test('describeSlot refuses a bad zone rather than rendering nonsense', () => {
  assert.equal(describeSlot({ at: new Date(), timeZone: 'Mars/Olympus' }), null);
  assert.equal(describeSlot({ at: null, timeZone: 'Europe/London' }), null);
});
