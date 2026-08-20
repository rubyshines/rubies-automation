/**
 * availability.js — what times are actually free, across all of Jamie's calendars.
 *
 * The slot math is a PURE function (`buildSlots`) so it can be tested without a
 * network: DST boundaries, the no-same-day rule and the business window are all
 * deterministic given a clock and a list of busy intervals.
 *
 * Why events.list rather than freebusy.query: freebusy returns anonymous busy
 * blocks, and the whole point of the panel is to show *why* a slot is awkward
 * ("Natta call" vs "QC booking"), not merely that it is taken.
 */
const {
  getCalendar,
  BUSY_CALENDAR_IDS,
  HOLIDAY_CALENDAR_ID,
  BUSINESS_TIMEZONE,
} = require('../../shared/googleCalendarClient');

const BUSINESS_START_HOUR = 9;   // 09:00 local
const BUSINESS_END_HOUR = 17;    // 17:00 local — a meeting must END by this
const SLOT_GRANULARITY_MIN = 30;
const DEFAULT_DURATION_MIN = 30;
const DEFAULT_LOOKAHEAD_DAYS = 10; // business days

// ---------------------------------------------------------------------------
// Timezone primitives (pure)
// ---------------------------------------------------------------------------

/** Minutes that `timeZone` is ahead of UTC at the given instant. Pure. */
function zoneOffsetMinutes(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = {};
  for (const part of dtf.formatToParts(date)) {
    if (part.type !== 'literal') p[part.type] = part.value;
  }
  // hour can come back as "24" at midnight in some ICU versions.
  const asIfUtc = Date.UTC(+p.year, +p.month - 1, +p.day, (+p.hour) % 24, +p.minute, +p.second);
  return (asIfUtc - date.getTime()) / 60000;
}

/**
 * A wall-clock time in `timeZone` → the UTC instant. Two passes, because the
 * offset depends on the instant we are trying to find: guess with the offset at
 * the naive instant, then re-read the offset at the guess. That second pass is
 * what makes the spring-forward and fall-back days correct. Pure.
 */
function wallClockToUtc({ year, month, day, hour = 0, minute = 0 }, timeZone) {
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0);
  let ts = naive - zoneOffsetMinutes(new Date(naive), timeZone) * 60000;
  ts = naive - zoneOffsetMinutes(new Date(ts), timeZone) * 60000;
  return new Date(ts);
}

/** The calendar date + weekday in `timeZone` for an instant. Pure. */
function zonedDateParts(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const p = {};
  for (const part of dtf.formatToParts(date)) {
    if (part.type !== 'literal') p[part.type] = part.value;
  }
  return {
    year: +p.year,
    month: +p.month,
    day: +p.day,
    weekday: p.weekday,
    iso: `${p.year}-${p.month}-${p.day}`,
  };
}

/** "2:00 PM" in `timeZone`. Pure. */
function formatTimeInZone(date, timeZone) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone, hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(date).replace(/ /g, ' ');
}

/** "Tue 26 Aug" in `timeZone`. Pure. */
function formatDayInZone(date, timeZone) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone, weekday: 'short', day: 'numeric', month: 'short',
  }).format(date);
}

/** Calendar date `iso` (YYYY-MM-DD) advanced by n days. Pure, zone-free. */
function addDaysToIso(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

function isWeekendIso(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return dow === 0 || dow === 6;
}

// ---------------------------------------------------------------------------
// The slot engine (pure)
// ---------------------------------------------------------------------------

/**
 * Build the bookable grid.
 *
 * @param now            Date — "right now" (real clock, or a fixed one in tests)
 * @param busy           [{ start: ISO, end: ISO, summary?, calendar? }] timed blocks
 * @param allDay         [{ date: 'YYYY-MM-DD', summary, calendar }] all-day notes
 * @param durationMinutes meeting length
 * @param days           how many BUSINESS days to return
 * @param timeZone       business zone
 * @param theirTimeZone  optional IANA zone for the other party — adds their local
 *                       label and flags slots outside their sociable hours
 *
 * No same-day booking: the grid starts on the first business day strictly after
 * today. All-day events (and holidays) annotate a day rather than blocking it —
 * "Natta in Toronto" is not a reason the 2pm slot is unusable, and hiding the
 * day would remove a choice the operator may have a good reason to make.
 */
function buildSlots({
  now,
  busy = [],
  allDay = [],
  durationMinutes = DEFAULT_DURATION_MIN,
  days = DEFAULT_LOOKAHEAD_DAYS,
  timeZone = BUSINESS_TIMEZONE,
  theirTimeZone = null,
} = {}) {
  const duration = Math.max(5, Math.round(durationMinutes || DEFAULT_DURATION_MIN));
  const busyIntervals = busy
    .map(b => ({
      start: new Date(b.start).getTime(),
      end: new Date(b.end).getTime(),
      summary: b.summary || 'Busy',
      calendar: b.calendar || null,
    }))
    .filter(b => Number.isFinite(b.start) && Number.isFinite(b.end) && b.end > b.start)
    .sort((a, b) => a.start - b.start);

  const allDayByDate = new Map();
  for (const a of allDay) {
    if (!a || !a.date) continue;
    if (!allDayByDate.has(a.date)) allDayByDate.set(a.date, []);
    allDayByDate.get(a.date).push({ summary: a.summary || 'All day', calendar: a.calendar || null });
  }

  const todayIso = zonedDateParts(now, timeZone).iso;
  const out = [];
  let cursor = addDaysToIso(todayIso, 1); // no same-day booking
  let guard = 0;

  while (out.length < days && guard++ < 400) {
    if (isWeekendIso(cursor)) { cursor = addDaysToIso(cursor, 1); continue; }

    const [y, m, d] = cursor.split('-').map(Number);
    const slots = [];
    const lastStartMinutes = BUSINESS_END_HOUR * 60 - duration;

    for (let mins = BUSINESS_START_HOUR * 60; mins <= lastStartMinutes; mins += SLOT_GRANULARITY_MIN) {
      const start = wallClockToUtc(
        { year: y, month: m, day: d, hour: Math.floor(mins / 60), minute: mins % 60 },
        timeZone,
      );
      const end = new Date(start.getTime() + duration * 60000);
      const clash = busyIntervals.find(b => b.start < end.getTime() && b.end > start.getTime());

      const slot = {
        start: start.toISOString(),
        end: end.toISOString(),
        label: formatTimeInZone(start, timeZone),
        busy: !!clash,
        busyWith: clash ? clash.summary : null,
      };
      if (theirTimeZone) {
        slot.theirLabel = formatTimeInZone(start, theirTimeZone);
        const theirHour = Number(new Intl.DateTimeFormat('en-US', {
          timeZone: theirTimeZone, hour: 'numeric', hour12: false,
        }).format(start)) % 24;
        // Outside 08:00–20:00 for them is unsociable. Greyed, never hidden —
        // for a German or Australian partner every 9-5 ET slot lands here, and
        // an empty grid would be worse than an annotated one.
        slot.unsociableForThem = theirHour < 8 || theirHour >= 20;
      }
      slots.push(slot);
    }

    const notes = allDayByDate.get(cursor) || [];
    out.push({
      date: cursor,
      label: formatDayInZone(wallClockToUtc({ year: y, month: m, day: d, hour: 12 }, timeZone), timeZone),
      notes,
      slots,
      freeCount: slots.filter(s => !s.busy).length,
    });
    cursor = addDaysToIso(cursor, 1);
  }

  return { timeZone, theirTimeZone: theirTimeZone || null, durationMinutes: duration, days: out };
}

/**
 * Is this exact instant still bookable? Used at booking time, so a slot picked
 * from a grid that was rendered a while ago cannot be double-booked.
 * Returns { free: boolean, clash?: {summary, start, end} }. Pure.
 */
function checkSlotFree({ start, durationMinutes = DEFAULT_DURATION_MIN, busy = [] }) {
  const s = new Date(start).getTime();
  const e = s + Math.round(durationMinutes) * 60000;
  for (const b of busy) {
    const bs = new Date(b.start).getTime();
    const be = new Date(b.end).getTime();
    if (bs < e && be > s) {
      return { free: false, clash: { summary: b.summary || 'Busy', start: b.start, end: b.end } };
    }
  }
  return { free: true };
}

// ---------------------------------------------------------------------------
// Fetching (impure)
// ---------------------------------------------------------------------------

/**
 * Pull events from every busy calendar over a window.
 *
 * `singleEvents: true` expands recurrence, so a weekly standing call blocks
 * every week rather than only its first instance. Three kinds of event are
 * deliberately NOT treated as busy: cancelled ones, ones marked "free"
 * (transparency), and ones Jamie has declined — all three are on the calendar
 * without being commitments.
 */
async function fetchCalendarEvents({ timeMin, timeMax, calendarIds = BUSY_CALENDAR_IDS, includeHolidays = true }) {
  const cal = await getCalendar();
  const ids = [...calendarIds];
  if (includeHolidays && HOLIDAY_CALENDAR_ID) ids.push(HOLIDAY_CALENDAR_ID);

  const busy = [];
  const allDay = [];

  for (const calendarId of ids) {
    let pageToken;
    do {
      let res;
      try {
        res = await cal.events.list({
          calendarId,
          timeMin: new Date(timeMin).toISOString(),
          timeMax: new Date(timeMax).toISOString(),
          singleEvents: true,
          orderBy: 'startTime',
          maxResults: 250,
          pageToken,
        });
      } catch (e) {
        // A calendar we cannot read must not silently read as FREE. Surface it.
        throw new Error(`Could not read calendar ${calendarId}: ${e.message}`);
      }
      for (const ev of res.data.items || []) {
        if (ev.status === 'cancelled') continue;
        if (ev.transparency === 'transparent') continue;
        const self = (ev.attendees || []).find(a => a.self);
        if (self && self.responseStatus === 'declined') continue;

        if (ev.start?.date) {
          allDay.push({ date: ev.start.date, summary: ev.summary || 'All day', calendar: calendarId });
        } else if (ev.start?.dateTime && ev.end?.dateTime) {
          busy.push({
            start: ev.start.dateTime,
            end: ev.end.dateTime,
            summary: ev.summary || 'Busy',
            calendar: calendarId,
          });
        }
      }
      pageToken = res.data.nextPageToken;
    } while (pageToken);
  }

  return { busy, allDay };
}

/**
 * The read the panel and the `calendar_availability` tool both use.
 * @returns buildSlots() output plus the raw busy list (for a later re-check).
 */
async function fetchAvailability({
  durationMinutes = DEFAULT_DURATION_MIN,
  days = DEFAULT_LOOKAHEAD_DAYS,
  theirTimeZone = null,
  now = new Date(),
} = {}) {
  // Widen the fetch window generously past the business days requested —
  // weekends and holidays mean N business days can span well over N calendar days.
  const timeMin = new Date(now.getTime() - 24 * 3600 * 1000);
  const timeMax = new Date(now.getTime() + (days + 14) * 24 * 3600 * 1000);
  const { busy, allDay } = await fetchCalendarEvents({ timeMin, timeMax });
  const grid = buildSlots({ now, busy, allDay, durationMinutes, days, theirTimeZone });
  return { ...grid, busy, calendars: BUSY_CALENDAR_IDS };
}

module.exports = {
  buildSlots,
  checkSlotFree,
  fetchAvailability,
  fetchCalendarEvents,
  zoneOffsetMinutes,
  wallClockToUtc,
  zonedDateParts,
  formatTimeInZone,
  formatDayInZone,
  addDaysToIso,
  isWeekendIso,
  BUSINESS_START_HOUR,
  BUSINESS_END_HOUR,
  SLOT_GRANULARITY_MIN,
  DEFAULT_DURATION_MIN,
  DEFAULT_LOOKAHEAD_DAYS,
};
