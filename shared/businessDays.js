/**
 * Shared business days utility — US holidays + weekends.
 *
 * Warehouse ships from Portland, OR so US federal holidays apply.
 * Used by: shipping responses, unfulfilled order reports, delivery time sync, alerts.
 */

// ---------------------------------------------------------------------------
// US Federal Holidays (fixed + floating)
// ---------------------------------------------------------------------------

/**
 * Get US federal holidays for a given year.
 * Includes: New Year's, MLK, Presidents' Day, Memorial Day, Juneteenth,
 * Independence Day, Labor Day, Thanksgiving, day after Thanksgiving, Christmas.
 */
function getUSHolidays(year) {
  const holidays = [];

  // Fixed-date holidays
  holidays.push(new Date(year, 0, 1));   // New Year's Day (Jan 1)
  holidays.push(new Date(year, 5, 19));  // Juneteenth (Jun 19)
  holidays.push(new Date(year, 6, 4));   // Independence Day (Jul 4)
  holidays.push(new Date(year, 11, 25)); // Christmas (Dec 25)

  // MLK Day: 3rd Monday of January
  holidays.push(nthWeekday(year, 0, 1, 3));

  // Presidents' Day: 3rd Monday of February
  holidays.push(nthWeekday(year, 1, 1, 3));

  // Memorial Day: last Monday of May
  holidays.push(lastWeekday(year, 4, 1));

  // Labor Day: 1st Monday of September
  holidays.push(nthWeekday(year, 8, 1, 1));

  // Thanksgiving: 4th Thursday of November
  const thanksgiving = nthWeekday(year, 10, 4, 4);
  holidays.push(thanksgiving);

  // Day after Thanksgiving (warehouse typically closed)
  const dayAfter = new Date(thanksgiving);
  dayAfter.setDate(dayAfter.getDate() + 1);
  holidays.push(dayAfter);

  // Observed: if holiday falls on Saturday, observed Friday. Sunday → observed Monday.
  const observed = [];
  for (const h of holidays) {
    const dow = h.getDay();
    if (dow === 6) {
      const fri = new Date(h);
      fri.setDate(fri.getDate() - 1);
      observed.push(fri);
    } else if (dow === 0) {
      const mon = new Date(h);
      mon.setDate(mon.getDate() + 1);
      observed.push(mon);
    } else {
      observed.push(h);
    }
  }

  return new Set(observed.map(d => d.toISOString().split('T')[0]));
}

/** Nth occurrence of a weekday in a month (1-indexed). weekday: 0=Sun..6=Sat */
function nthWeekday(year, month, weekday, n) {
  const first = new Date(year, month, 1);
  let dayOfFirst = first.getDay();
  let diff = weekday - dayOfFirst;
  if (diff < 0) diff += 7;
  return new Date(year, month, 1 + diff + (n - 1) * 7);
}

/** Last occurrence of a weekday in a month */
function lastWeekday(year, month, weekday) {
  const last = new Date(year, month + 1, 0); // last day of month
  let diff = last.getDay() - weekday;
  if (diff < 0) diff += 7;
  return new Date(year, month, last.getDate() - diff);
}

// Cache holidays by year
const _holidayCache = {};
function holidaysForYear(year) {
  if (!_holidayCache[year]) _holidayCache[year] = getUSHolidays(year);
  return _holidayCache[year];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check if a date is a business day (not weekend, not US holiday).
 */
function isBusinessDay(date) {
  const d = new Date(date);
  const dow = d.getDay();
  if (dow === 0 || dow === 6) return false;
  const dateStr = d.toISOString().split('T')[0];
  return !holidaysForYear(d.getFullYear()).has(dateStr);
}

/**
 * Count business days between two dates (exclusive of start, inclusive of end — like "how many work days passed").
 */
function businessDaysBetween(startDate, endDate) {
  const start = new Date(startDate);
  const end = new Date(endDate);
  start.setHours(0, 0, 0, 0);
  end.setHours(0, 0, 0, 0);
  let count = 0;
  const cursor = new Date(start);
  while (cursor < end) {
    cursor.setDate(cursor.getDate() + 1);
    if (isBusinessDay(cursor)) count++;
  }
  return count;
}

/**
 * Count business days from a date until now.
 */
function businessDaysSince(dateStr) {
  if (!dateStr) return null;
  let d;
  if (/^\d{4}-\d{2}-\d{2}/.test(dateStr)) {
    d = new Date(dateStr);
  } else if (dateStr.includes(',')) {
    d = new Date(dateStr);
  } else {
    d = new Date(`${dateStr} ${new Date().getFullYear()}`);
  }
  if (isNaN(d)) return null;
  return businessDaysBetween(d, new Date());
}

/**
 * Add N business days to a date.
 */
function addBusinessDays(date, days) {
  const result = new Date(date);
  let added = 0;
  while (added < days) {
    result.setDate(result.getDate() + 1);
    if (isBusinessDay(result)) added++;
  }
  return result;
}

/**
 * Returns true if the shipping deadline for an order has passed: 5pm Pacific
 * Time on the next business day (US holidays + weekends) after the order date.
 * Orders not yet past their deadline are still expected to ship normally.
 */
function pastNextBusinessDay5pmPT(orderDateStr) {
  const orderDate = new Date(orderDateStr);

  // Resolve the order's calendar date in Pacific Time.
  const ptDateStr = orderDate.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const [y, m, d] = ptDateStr.split('-').map(Number);

  // Advance to the next business day (skips weekends + US federal holidays).
  const ptDateLocal = new Date(y, m - 1, d);
  const nextBizDay = addBusinessDays(ptDateLocal, 1);

  // Construct 5pm Pacific on that day — try PDT (UTC-7) then PST (UTC-8).
  const nbY = nextBizDay.getFullYear();
  const nbM = String(nextBizDay.getMonth() + 1).padStart(2, '0');
  const nbD = String(nextBizDay.getDate()).padStart(2, '0');
  const nextBizDateStr = `${nbY}-${nbM}-${nbD}`;
  let deadline;
  for (const off of ['-07:00', '-08:00']) {
    const t = new Date(`${nextBizDateStr}T17:00:00${off}`);
    const ptH = Number(new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles', hour: 'numeric', hour12: false,
    }).format(t));
    if (ptH === 17) { deadline = t; break; }
  }
  if (!deadline) deadline = new Date(`${nextBizDateStr}T17:00:00-08:00`);
  return Date.now() > deadline.getTime();
}

module.exports = {
  isBusinessDay,
  businessDaysBetween,
  businessDaysSince,
  addBusinessDays,
  getUSHolidays,
  pastNextBusinessDay5pmPT,
};
