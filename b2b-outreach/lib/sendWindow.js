/**
 * sendWindow.js — when should an automatic follow-up actually land?
 *
 * Pure and dependency-free: (location, company id, now) → a UTC instant. The
 * scheduler stamps it on the draft; the send pass picks the draft up once it
 * passes. No IO, no Date.now(), so it is fully testable across DST boundaries.
 *
 * Two ideas do all the work here.
 *
 * **Mid-morning on a weekday.** 09:30-11:30 local avoids both failure modes of
 * sending the instant a sweep happens to run: arriving at 3am, and arriving at
 * 5pm on a Friday. It is after the overnight inbox has been triaged and before
 * lunch.
 *
 * **A zone we do not know is not a zone we guess.** `timezoneFromLocation`
 * deliberately answers nothing for a multi-zone country with no region, and 104
 * of 222 live companies land there. Rather than invent an offset, we pick a time
 * that is business hours in EVERY zone the country spans — noon Eastern is 9am
 * Pacific, so a US company with no state on file gets a slot that is mid-morning
 * or early afternoon wherever it actually is. That keeps the domain's "no match
 * means no facts" rule while still answering the question.
 *
 * The looser standard than meetingTimezone.js applies on purpose: a wrong zone
 * there lands verbatim in "…, 1pm your time" in customer-facing text, whereas
 * the worst case here is an email arriving a little early.
 *
 * Not modelled: public holidays. An email arriving on a bank holiday is read the
 * next morning, which is the same outcome as sending the next morning.
 */
const { isValidTimeZone, normalizeCountry } = require('./meetingTimezone');

/** The preferred local window, in minutes past local midnight. */
const WINDOW_START_MIN = 9 * 60 + 30;  // 09:30
const WINDOW_END_MIN = 11 * 60 + 30;   // 11:30

/** Where a company with no resolvable zone and no country ends up. */
const DEFAULT_TIME_ZONE = 'America/Toronto';

/**
 * Multi-zone countries: a window that is business hours across the WHOLE
 * country, expressed in one representative zone.
 *
 * US spans Eastern to Pacific, so noon-2pm Eastern is 9-11am Pacific — inside
 * 9-5 at both ends. Canada reaches Halifax (1-3pm) and Vancouver (9-11am) on the
 * same instants. Australia's Sydney noon is Perth 9-10am depending on daylight
 * saving. Alaska, Hawaii and Newfoundland are outliers we accept rather than
 * shrink the window to nothing for.
 */
const COUNTRY_FALLBACK = {
  US: { timeZone: 'America/New_York', startMin: 12 * 60, endMin: 14 * 60 },
  CA: { timeZone: 'America/Toronto', startMin: 12 * 60, endMin: 14 * 60 },
  AU: { timeZone: 'Australia/Sydney', startMin: 12 * 60, endMin: 14 * 60 },
};

/** Local wall-clock parts for an instant in a zone. */
function zonedParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const out = {};
  for (const p of fmt.formatToParts(date)) out[p.type] = p.value;
  return {
    year: +out.year, month: +out.month, day: +out.day,
    // hour12:false renders midnight as '24' in some ICU versions.
    hour: (+out.hour) % 24, minute: +out.minute, second: +out.second,
  };
}

/** Offset (ms) to add to UTC to get local time in `timeZone` at that instant. */
function tzOffsetMs(date, timeZone) {
  const p = zonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - (Math.floor(date.getTime() / 1000) * 1000);
}

/**
 * The instant at which the local clock in `timeZone` reads this date and
 * minute-of-day. Two passes because the offset depends on the answer: the first
 * guess can land on the wrong side of a DST transition, and re-reading the
 * offset at the guessed instant converges.
 */
function instantForLocal({ year, month, day, minuteOfDay }, timeZone) {
  const wall = Date.UTC(year, month - 1, day, 0, minuteOfDay, 0);
  let ts = wall - tzOffsetMs(new Date(wall), timeZone);
  ts = wall - tzOffsetMs(new Date(ts), timeZone);
  return new Date(ts);
}

/**
 * A stable minute inside the window, derived from the company id.
 *
 * Eight follow-ups scheduled by one sweep would otherwise all be stamped
 * 09:30:00 and arrive as an obvious batch. Deliberately a hash rather than
 * Math.random: this function has to stay pure so the scheduled time is
 * reproducible and testable, and so a re-run does not move an existing slot.
 */
function slotOffsetMinutes(companyId, spanMin) {
  if (!companyId || spanMin <= 0) return 0;
  const s = String(companyId);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h % spanMin;
}

/**
 * Which zone and window apply to this company. Pure.
 * @returns {{ timeZone, startMin, endMin, resolved: boolean, reason: string }}
 */
function resolveWindow({ timeZone, country } = {}) {
  if (isValidTimeZone(timeZone)) {
    return {
      timeZone,
      startMin: WINDOW_START_MIN,
      endMin: WINDOW_END_MIN,
      resolved: true,
      reason: `mid-morning in ${timeZone}`,
    };
  }
  const code = normalizeCountry(country);
  const fallback = code && COUNTRY_FALLBACK[code];
  if (fallback) {
    return {
      ...fallback,
      resolved: false,
      reason: `no region on file — using a time that is business hours across all of ${code}`,
    };
  }
  return {
    timeZone: DEFAULT_TIME_ZONE,
    startMin: WINDOW_START_MIN,
    endMin: WINDOW_END_MIN,
    resolved: false,
    reason: country
      ? `no timezone mapping for ${country} — using Eastern`
      : 'no location on file — using Eastern',
  };
}

/**
 * The next moment this company should receive an automatic email.
 *
 * @param {object} p { timeZone, country, companyId, now }
 * @returns {{ at: Date, timeZone: string, resolved: boolean, reason: string }}
 */
function nextSendSlot({ timeZone, country, companyId, now = new Date() } = {}) {
  const w = resolveWindow({ timeZone, country });
  const minuteOfDay = w.startMin + slotOffsetMinutes(companyId, w.endMin - w.startMin);

  // Walk forward a day at a time in the TARGET zone. Bounded rather than
  // while(true): a bad zone must not spin.
  for (let i = 0; i < 14; i++) {
    const probe = new Date(now.getTime() + i * 86400000);
    const { year, month, day } = zonedParts(probe, w.timeZone);
    const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const at = instantForLocal({ year, month, day, minuteOfDay }, w.timeZone);
    if (at > now) {
      return { at, timeZone: w.timeZone, resolved: w.resolved, reason: w.reason };
    }
  }
  // Unreachable for any real zone; fail loudly rather than return a bad date.
  throw new Error(`no send slot found within 14 days for timeZone '${w.timeZone}'`);
}

/** "Thu 09:47 (Europe/London)" — what the panel shows next to a scheduled draft. */
function describeSlot({ at, timeZone } = {}) {
  if (!at || !isValidTimeZone(timeZone)) return null;
  return new Intl.DateTimeFormat('en-GB', {
    timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(at instanceof Date ? at : new Date(at)) + ` (${timeZone})`;
}

module.exports = {
  nextSendSlot,
  resolveWindow,
  describeSlot,
  slotOffsetMinutes,
  zonedParts,
  instantForLocal,
  WINDOW_START_MIN,
  WINDOW_END_MIN,
  DEFAULT_TIME_ZONE,
  COUNTRY_FALLBACK,
};
