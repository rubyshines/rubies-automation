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

/**
 * Do two zones read the same on a clock at this instant?
 *
 * Comparing zone NAMES is not the same question, and getting it wrong is
 * visible in customer-facing text: a Toronto partner is `America/Toronto`
 * against our `America/New_York`, both Eastern, and the name test printed
 * "9:00 AM ET (9:00 AM your time)" at them. What the reader cares about is
 * whether the number differs, which is the offset at that instant. Pure.
 */
function sameWallClock(date, zoneA, zoneB) {
  if (!zoneA || !zoneB) return false;
  if (zoneA === zoneB) return true;
  try {
    return zoneOffsetMinutes(date, zoneA) === zoneOffsetMinutes(date, zoneB);
  } catch (_) {
    return false;
  }
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

/**
 * "Tue Sept 22" in `timeZone` — weekday, month, day, the order Jamie writes
 * dates in (2026-09-08). en-GB is kept for its month names ("Sept", not "Sep");
 * the parts are reassembled because that locale puts the day first. Pure.
 */
function formatDayInZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, weekday: 'short', day: 'numeric', month: 'short',
  }).formatToParts(date);
  const get = type => parts.find(p => p.type === type)?.value || '';
  return `${get('weekday')} ${get('month')} ${get('day')}`;
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
// Grouping (pure)
// ---------------------------------------------------------------------------

/** Same-day gap, in minutes, still counted as "grouped" though not tight. */
const GROUP_GAP_MIN = 60;

/**
 * How well a free slot groups with what is already booked that day.
 *
 * Jamie stacks calls: when a day already holds one, the next should sit
 * against it rather than open a second hole in the day (2026-09-09). Calls
 * stay 30 minutes; "tight" means no gap at all. Scores, lower is better:
 *   0  starts the minute an existing block ends ("right after")
 *   1  ends the minute an existing block starts ("right before")
 *   2  within GROUP_GAP_MIN of a block on the same day
 *   9  nothing nearby — an empty day, or far from anything
 * After beats before because a call that runs long then spills into open
 * time rather than into the next call. Any timed event counts, since the
 * calendar cannot say which are calls; the name is always returned so the
 * operator can tell. Pure.
 *
 * @param startMs  slot start (epoch ms)
 * @param endMs    slot end
 * @param blocks   [{ start: ms, end: ms, summary }] busy intervals of that day
 */
function scoreAgainstBlocks(startMs, endMs, blocks) {
  let best = null;
  for (const b of blocks) {
    if (b.start < endMs && b.end > startMs) continue; // overlaps: not a free slot
    const after = startMs >= b.end;
    const gap = after ? (startMs - b.end) / 60000 : (b.start - endMs) / 60000;
    let score;
    if (gap === 0) score = after ? 0 : 1;
    else if (gap <= GROUP_GAP_MIN) score = 2;
    else continue;
    if (!best || score < best.score || (score === best.score && gap < best.gap)) {
      best = { score, gap, side: after ? 'after' : 'before', summary: b.summary };
    }
  }
  if (!best) return { score: 9, reason: null, adjacentTo: null };
  const tight = best.gap === 0;
  return {
    score: best.score,
    reason: `${tight ? 'right ' : ''}${best.side} ${best.summary}`,
    adjacentTo: tight ? best.summary : null,
  };
}

/**
 * Does a slot fit inside one of the windows the other party offered? A window
 * is { date, start, end }: `date` (YYYY-MM-DD) pins the day, `start`/`end` are
 * ISO instants or null for an open bound. The meeting must START no earlier
 * than the window opens and END no later than it closes. Pure.
 */
function slotWithin(slot, date, windows) {
  const t0 = Date.parse(slot.start);
  const t1 = Date.parse(slot.end);
  return windows.some(w => {
    if (w.date && w.date !== date) return false;
    if (w.start && t0 < Date.parse(w.start)) return false;
    if (w.end && t1 > Date.parse(w.end)) return false;
    return true;
  });
}

/**
 * The times to offer, best first, one per day, at most `limit`.
 *
 * Two tiers, in Jamie's order (2026-09-11):
 *   0. a slot sitting against something already booked that day — he stacks
 *      calls rather than opening a second hole in a day, so these lead
 *   1. otherwise the earliest slot in his day: 9am beats 2pm
 * Inside tier 0 the tightest fit wins, then the sooner day. Inside tier 1 the
 * earlier hour wins, then the sooner day. A day contributes at most one slot,
 * so the list reads as a set of days to choose between rather than five
 * variations on Tuesday.
 *
 * `within` — the windows the other party offered — is a HARD constraint, not a
 * preference. A day with no free slot inside their windows contributes
 * nothing, so a time they have already said they cannot make is never offered.
 * A best fit that ignores what they said they could do is not a fit (Colage,
 * 2026-09-09: 10:30 offered against "9-10 or 1-2:30").
 *
 * When their workday is known a fit has to sit inside it; if that leaves
 * nothing (Germany, Australia), that filter is dropped rather than returning
 * an empty list — an annotated awkward time beats no answer. Their WINDOWS are
 * never dropped that way: an empty list is the true answer to "none of the
 * times you gave me are free", and the caller says so rather than quietly
 * offering something else.
 *
 * Days with nothing booked used to be skipped entirely, because this list sat
 * beside a second list that covered them. It is now the only list of times the
 * panel offers, so an empty day has to be able to reach it — that is what
 * tier 1 is. Pure.
 */
function pickBestFits(days, { limit = 5, respectTheirWorkday = true, within = null } = {}) {
  const windows = Array.isArray(within) && within.length ? within : null;
  // scoreAgainstBlocks: 0/1/2 sit against a booking, 9 is an open stretch.
  const abuts = slot => slot.score !== null && slot.score <= 2;

  const pick = (filterWorkday) => {
    const fits = [];
    for (const day of days) {
      let top = null;
      // Slots are built in clock order, so the index IS the time of day — no
      // zone arithmetic needed to know which of two slots is earlier.
      day.slots.forEach((slot, order) => {
        if (slot.busy) return;
        if (windows && !slotWithin(slot, day.date, windows)) return;
        if (filterWorkday && slot.outsideTheirWorkday) return;
        const cand = { slot, order, tier: abuts(slot) ? 0 : 1 };
        if (!top
          || cand.tier < top.tier
          || (cand.tier === top.tier && cand.slot.score < top.slot.score)
          || (cand.tier === top.tier && cand.slot.score === top.slot.score && cand.order < top.order)) {
          top = cand;
        }
      });
      if (!top) continue;
      fits.push({
        date: day.date, dayLabel: day.label,
        start: top.slot.start, end: top.slot.end, label: top.slot.label,
        theirLabel: top.slot.theirLabel || null,
        score: top.slot.score, reason: top.slot.reason,
        // Which tier put it here, so the panel can say why without re-deriving
        // the rule: 0 groups with a booking, 1 is first thing in the day.
        tier: top.tier,
        // Its place in the day, so "first thing" is a fact the panel can check
        // rather than a guess from the label.
        order: top.order,
        unsociableForThem: !!top.slot.unsociableForThem,
      });
    }
    return fits.sort(rankFits).slice(0, limit);
  };

  const strict = pick(respectTheirWorkday);
  return strict.length ? strict : pick(false);
}

/** The pecking order above, as a comparator. Pure. */
function rankFits(a, b) {
  if (a.tier !== b.tier) return a.tier - b.tier;
  if (a.tier === 0) {
    if (a.score !== b.score) return a.score - b.score;        // tightest against a booking
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;   // then the sooner day
    return a.order - b.order;
  }
  if (a.order !== b.order) return a.order - b.order;          // 9am before 2pm
  return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;      // then the sooner day
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
      isCall: !!b.isCall,
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

  /** What is booked on a calendar date, named, clamped to the working window. */
  const bookingsOn = (iso) => {
    const [y, m, d] = iso.split('-').map(Number);
    const dayOpen = wallClockToUtc({ year: y, month: m, day: d, hour: BUSINESS_START_HOUR }, timeZone).getTime();
    const dayClose = wallClockToUtc({ year: y, month: m, day: d, hour: BUSINESS_END_HOUR }, timeZone).getTime();
    const dayBusy = busyIntervals.filter(b => b.start < dayClose && b.end > dayOpen);
    const busyBlocks = dayBusy.map(b => ({
      start: new Date(b.start).toISOString(),
      end: new Date(b.end).toISOString(),
      summary: b.summary,
      isCall: !!b.isCall,
      // Clamped to the working day so an all-morning block from 7am reads as
      // starting at 9 rather than implying the grid is hiding something.
      label: `${formatTimeInZone(new Date(Math.max(b.start, dayOpen)), timeZone)}`
        + `–${formatTimeInZone(new Date(Math.min(b.end, dayClose)), timeZone)}`,
    }));
    return {
      dayBusy,
      busyBlocks,
      notes: allDayByDate.get(iso) || [],
      label: formatDayInZone(wallClockToUtc({ year: y, month: m, day: d, hour: 12 }, timeZone), timeZone),
    };
  };

  // Today is never bookable (no same-day rule) but it IS on the calendar, and
  // the week view draws it so the cross-reference matches what Jamie sees in
  // Google Calendar. Bookings only — no slots.
  const todayBookings = bookingsOn(todayIso);
  const today = {
    date: todayIso,
    label: todayBookings.label,
    notes: todayBookings.notes,
    busyBlocks: todayBookings.busyBlocks,
  };

  const out = [];
  let cursor = addDaysToIso(todayIso, 1); // no same-day booking
  let guard = 0;

  while (out.length < days && guard++ < 400) {
    if (isWeekendIso(cursor)) { cursor = addDaysToIso(cursor, 1); continue; }

    const [y, m, d] = cursor.split('-').map(Number);
    const slots = [];
    const lastStartMinutes = BUSINESS_END_HOUR * 60 - duration;

    // The day's bookings, for grouping. Anything touching the working window
    // counts, so a 7-9am block still makes 9:00 "right after" it.
    const { dayBusy, busyBlocks, notes, label } = bookingsOn(cursor);

    for (let mins = BUSINESS_START_HOUR * 60; mins <= lastStartMinutes; mins += SLOT_GRANULARITY_MIN) {
      const start = wallClockToUtc(
        { year: y, month: m, day: d, hour: Math.floor(mins / 60), minute: mins % 60 },
        timeZone,
      );
      const end = new Date(start.getTime() + duration * 60000);
      const clash = busyIntervals.find(b => b.start < end.getTime() && b.end > start.getTime());

      const grouping = clash
        ? { score: null, reason: null, adjacentTo: null }
        : scoreAgainstBlocks(start.getTime(), end.getTime(), dayBusy);
      const slot = {
        start: start.toISOString(),
        end: end.toISOString(),
        label: formatTimeInZone(start, timeZone),
        busy: !!clash,
        busyWith: clash ? clash.summary : null,
        // How this slot groups with the day's bookings (see scoreAgainstBlocks).
        score: grouping.score,
        reason: grouping.reason,
        adjacentTo: grouping.adjacentTo,
      };
      if (theirTimeZone) {
        slot.theirLabel = formatTimeInZone(start, theirTimeZone);
        const parts = {};
        for (const part of new Intl.DateTimeFormat('en-US', {
          timeZone: theirTimeZone, hour: '2-digit', minute: '2-digit', hour12: false,
        }).formatToParts(start)) {
          if (part.type !== 'literal') parts[part.type] = part.value;
        }
        const theirHour = (+parts.hour) % 24;
        const theirStartMins = theirHour * 60 + (+parts.minute);
        // Outside 08:00–20:00 for them is unsociable. Greyed, never hidden —
        // for a German or Australian partner every 9-5 ET slot lands here, and
        // an empty grid would be worse than an annotated one.
        slot.unsociableForThem = theirHour < 8 || theirHour >= 20;
        // Their assumed 9-5 workday (start no earlier than 9, ending by 5 their
        // time). Used when the panel picks slots ITSELF — expanding a window or
        // whole-day offer — where suggesting 7 AM their time reads as careless.
        slot.outsideTheirWorkday = theirStartMins < 9 * 60 || theirStartMins + duration > 17 * 60;
      }
      slots.push(slot);
    }

    out.push({
      date: cursor,
      label,
      notes,
      slots,
      busyBlocks,
      freeCount: slots.filter(s => !s.busy).length,
    });
    cursor = addDaysToIso(cursor, 1);
  }

  return {
    timeZone,
    theirTimeZone: theirTimeZone || null,
    durationMinutes: duration,
    days: out,
    today,
    bestFits: pickBestFits(out, { respectTheirWorkday: !!theirTimeZone }),
  };
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
            eventId: ev.id || null,
            // A call, as opposed to an errand: it has other people on it or a
            // video room. The grid draws these differently because "right
            // after a call" and "right after the dentist" are different offers.
            isCall: !!(ev.hangoutLink || ev.conferenceData
              || (ev.attendees || []).some(a => !a.self)),
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
  sameWallClock,
  scoreAgainstBlocks,
  pickBestFits,
  rankFits,
  slotWithin,
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
  GROUP_GAP_MIN,
};
