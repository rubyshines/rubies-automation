/**
 * Slot-engine tests. All pure — no calendar, no network.
 *
 * The business window, the no-same-day rule and DST are the parts that fail
 * silently and land in a customer-facing sentence, so they are pinned here.
 */
const test = require('node:test');
const assert = require('node:assert');

const {
  buildSlots, checkSlotFree, wallClockToUtc, zoneOffsetMinutes,
  addDaysToIso, isWeekendIso, formatTimeInZone,
} = require('../../b2b-outreach/lib/availability');

const ET = 'America/Toronto';

/** The instant of a given Eastern wall-clock time, for readable fixtures. */
const et = (iso, hh, mm = 0) => {
  const [year, month, day] = iso.split('-').map(Number);
  return wallClockToUtc({ year, month, day, hour: hh, minute: mm }, ET).toISOString();
};

test('zoneOffsetMinutes tracks DST in Eastern', () => {
  // January: EST = UTC-5. July: EDT = UTC-4.
  assert.strictEqual(zoneOffsetMinutes(new Date('2026-01-15T12:00:00Z'), ET), -300);
  assert.strictEqual(zoneOffsetMinutes(new Date('2026-07-15T12:00:00Z'), ET), -240);
});

test('wallClockToUtc is correct either side of the spring-forward boundary', () => {
  // DST 2026 begins Sunday 8 March. 9am Eastern on the 6th is EST (14:00Z);
  // on the 9th it is EDT (13:00Z). A naive offset would put both at the same
  // UTC hour and silently shift every slot by one hour for half the year.
  assert.strictEqual(wallClockToUtc({ year: 2026, month: 3, day: 6, hour: 9 }, ET).toISOString(), '2026-03-06T14:00:00.000Z');
  assert.strictEqual(wallClockToUtc({ year: 2026, month: 3, day: 9, hour: 9 }, ET).toISOString(), '2026-03-09T13:00:00.000Z');
});

test('slots run 9-5 Eastern and a meeting must END by 5', () => {
  const grid = buildSlots({ now: new Date('2026-08-20T15:00:00Z'), days: 1, durationMinutes: 30 });
  const day = grid.days[0];
  assert.strictEqual(formatTimeInZone(new Date(day.slots[0].start), ET), '9:00 AM');
  const last = day.slots[day.slots.length - 1];
  assert.strictEqual(formatTimeInZone(new Date(last.start), ET), '4:30 PM');
  assert.strictEqual(new Date(last.end).toISOString(), et('2026-08-21', 17));
  assert.strictEqual(day.slots.length, 16); // 9:00 → 16:30 at 30-min steps
});

test('a longer meeting stops earlier so it still ends by 5', () => {
  const grid = buildSlots({ now: new Date('2026-08-20T15:00:00Z'), days: 1, durationMinutes: 90 });
  const last = grid.days[0].slots[grid.days[0].slots.length - 1];
  assert.strictEqual(formatTimeInZone(new Date(last.start), ET), '3:30 PM');
  assert.strictEqual(new Date(last.end).toISOString(), et('2026-08-21', 17));
});

test('no same-day booking — the grid starts tomorrow', () => {
  // Thursday 20 August 2026, 9am ET. First day offered is Friday the 21st.
  const grid = buildSlots({ now: new Date(et('2026-08-20', 9)), days: 3 });
  assert.strictEqual(grid.days[0].date, '2026-08-21');
});

test('weekends are skipped', () => {
  // From Thursday, three business days are Fri, Mon, Tue.
  const grid = buildSlots({ now: new Date(et('2026-08-20', 9)), days: 3 });
  assert.deepStrictEqual(grid.days.map(d => d.date), ['2026-08-21', '2026-08-24', '2026-08-25']);
});

test('a busy block marks exactly the slots it overlaps, and names what it is', () => {
  const grid = buildSlots({
    now: new Date(et('2026-08-20', 9)),
    days: 1,
    busy: [{ start: et('2026-08-21', 10), end: et('2026-08-21', 11), summary: 'Natta call' }],
  });
  const byLabel = Object.fromEntries(grid.days[0].slots.map(s => [s.label, s]));
  assert.strictEqual(byLabel['9:30 AM'].busy, false);
  assert.strictEqual(byLabel['10:00 AM'].busy, true);
  assert.strictEqual(byLabel['10:00 AM'].busyWith, 'Natta call');
  assert.strictEqual(byLabel['10:30 AM'].busy, true);
  assert.strictEqual(byLabel['11:00 AM'].busy, false);
});

test('a meeting that would straddle a busy block is busy, not free', () => {
  // 60-minute meeting at 9:30 runs to 10:30 and collides with a 10:00 event,
  // even though 9:30 itself is clear.
  const grid = buildSlots({
    now: new Date(et('2026-08-20', 9)),
    days: 1,
    durationMinutes: 60,
    busy: [{ start: et('2026-08-21', 10), end: et('2026-08-21', 10, 30), summary: 'QC' }],
  });
  const byLabel = Object.fromEntries(grid.days[0].slots.map(s => [s.label, s]));
  assert.strictEqual(byLabel['9:30 AM'].busy, true);
});

test('all-day events annotate a day without blocking any slot', () => {
  const grid = buildSlots({
    now: new Date(et('2026-08-20', 9)),
    days: 1,
    allDay: [{ date: '2026-08-21', summary: 'Civic Holiday' }],
  });
  assert.strictEqual(grid.days[0].notes[0].summary, 'Civic Holiday');
  assert.ok(grid.days[0].slots.every(s => !s.busy));
  assert.strictEqual(grid.days[0].freeCount, 16);
});

test('their local time is labelled and unsociable hours are flagged, not removed', () => {
  const grid = buildSlots({
    now: new Date(et('2026-08-20', 9)),
    days: 1,
    theirTimeZone: 'Europe/Berlin', // ET+6 in August
  });
  const byLabel = Object.fromEntries(grid.days[0].slots.map(s => [s.label, s]));
  assert.strictEqual(byLabel['9:00 AM'].theirLabel, '3:00 PM');
  assert.strictEqual(byLabel['9:00 AM'].unsociableForThem, false);
  // 2:30pm Eastern is 8:30pm in Berlin — past the sociable window, but still offered.
  assert.strictEqual(byLabel['2:30 PM'].unsociableForThem, true);
  assert.ok(grid.days[0].slots.length > 0);
});

test('a Pacific partner sees mornings; nothing is dropped', () => {
  const grid = buildSlots({
    now: new Date(et('2026-08-20', 9)),
    days: 1,
    theirTimeZone: 'America/Los_Angeles',
  });
  const byLabel = Object.fromEntries(grid.days[0].slots.map(s => [s.label, s]));
  assert.strictEqual(byLabel['9:00 AM'].theirLabel, '6:00 AM');
  assert.strictEqual(byLabel['9:00 AM'].unsociableForThem, true);   // 6am their time
  assert.strictEqual(byLabel['11:00 AM'].theirLabel, '8:00 AM');
  assert.strictEqual(byLabel['11:00 AM'].unsociableForThem, false);
});

test('checkSlotFree catches a clash that appeared after the grid was drawn', () => {
  const busy = [{ start: et('2026-08-21', 14), end: et('2026-08-21', 15), summary: 'Dentist' }];
  assert.strictEqual(checkSlotFree({ start: et('2026-08-21', 13), durationMinutes: 30, busy }).free, true);
  const clash = checkSlotFree({ start: et('2026-08-21', 14, 30), durationMinutes: 30, busy });
  assert.strictEqual(clash.free, false);
  assert.strictEqual(clash.clash.summary, 'Dentist');
  // Back-to-back is NOT a clash: an event ending at 15:00 leaves 15:00 free.
  assert.strictEqual(checkSlotFree({ start: et('2026-08-21', 15), durationMinutes: 30, busy }).free, true);
});

test('the grid still spans the DST change without losing or duplicating a day', () => {
  // Friday 6 March 2026 → DST starts Sunday the 8th.
  const grid = buildSlots({ now: new Date(et('2026-03-05', 9)), days: 3 });
  assert.deepStrictEqual(grid.days.map(d => d.date), ['2026-03-06', '2026-03-09', '2026-03-10']);
  // 9am Eastern on both sides, despite the UTC hour differing.
  assert.strictEqual(grid.days[0].slots[0].label, '9:00 AM');
  assert.strictEqual(grid.days[1].slots[0].label, '9:00 AM');
  assert.notStrictEqual(
    new Date(grid.days[0].slots[0].start).getUTCHours(),
    new Date(grid.days[1].slots[0].start).getUTCHours(),
  );
});

test('date helpers', () => {
  assert.strictEqual(addDaysToIso('2026-08-31', 1), '2026-09-01');
  assert.strictEqual(addDaysToIso('2026-12-31', 1), '2027-01-01');
  assert.strictEqual(isWeekendIso('2026-08-22'), true);  // Saturday
  assert.strictEqual(isWeekendIso('2026-08-23'), true);  // Sunday
  assert.strictEqual(isWeekendIso('2026-08-24'), false); // Monday
});

test('each day names what is booked, clamped to the working window', () => {
  const grid = buildSlots({
    now: new Date(et('2026-08-20', 9)),
    days: 1,
    busy: [
      { start: et('2026-08-21', 10), end: et('2026-08-21', 11), summary: 'Natta call' },
      // Starts before the working day — the label must read from 9, not 7, so it
      // does not imply the grid is hiding earlier slots.
      { start: et('2026-08-21', 7), end: et('2026-08-21', 9, 30), summary: 'Gym' },
      // A different day entirely: must not appear on this one.
      { start: et('2026-08-24', 10), end: et('2026-08-24', 11), summary: 'Elsewhere' },
    ],
  });
  const blocks = grid.days[0].busyBlocks;
  assert.deepStrictEqual(blocks.map(b => b.summary), ['Gym', 'Natta call']);
  assert.strictEqual(blocks[0].label, '9:00 AM–9:30 AM');
  assert.strictEqual(blocks[1].label, '10:00 AM–11:00 AM');
});

test('an untitled block from a free/busy-only calendar still reports as Busy', () => {
  const grid = buildSlots({
    now: new Date(et('2026-08-20', 9)),
    days: 1,
    busy: [{ start: et('2026-08-21', 14), end: et('2026-08-21', 14, 30) }],
  });
  assert.strictEqual(grid.days[0].busyBlocks[0].summary, 'Busy');
});

test('a day with nothing booked carries an empty block list, not undefined', () => {
  const grid = buildSlots({ now: new Date(et('2026-08-20', 9)), days: 1 });
  assert.deepStrictEqual(grid.days[0].busyBlocks, []);
});
