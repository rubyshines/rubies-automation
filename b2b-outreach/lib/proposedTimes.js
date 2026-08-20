/**
 * proposedTimes.js — read the times the other party suggested out of their message.
 *
 * MODEL CHOICE: Sonnet, deliberately. This is narrow structured extraction whose
 * output is never sent anywhere on its own — the operator sees each candidate
 * resolved to Eastern, marked free or busy, and has to click one before anything
 * is booked. It fails visibly, which is the test the model policy sets for using
 * something cheaper than Opus.
 *
 * The model is kept OUT of offset arithmetic, which is where LLMs actually fail:
 * it returns a wall-clock date + time plus whichever timezone the writer was
 * speaking in, and `wallClockToUtc` does the conversion deterministically.
 *
 * Today's date is injected, per the standing rule that any AI context reasoning
 * about elapsed time must state it — "Tuesday" is meaningless otherwise, and the
 * model would anchor on the newest timestamp it can see.
 */
const { callClaude } = require('../../shared/aiClient');
const { MODELS } = require('../../shared/aiPricing');
const { wallClockToUtc, formatTimeInZone, formatDayInZone } = require('./availability');
const { isValidTimeZone } = require('./meetingTimezone');

const SYSTEM_PROMPT = `You extract proposed meeting times from a business email.

Return ONLY times the writer offered or asked about for a CALL or MEETING. Ignore
deadlines, shipping dates, event dates, and times mentioned as history.

For each time, report the wall-clock date and time exactly as the writer meant it,
plus the IANA timezone THEY were speaking in if the message makes it knowable
(they name a zone, a city, or an offset). Never convert between timezones yourself
and never compute an offset — report what they said and which zone they said it in.

When they give a range ("Tuesday afternoon", "any time Thursday morning"), return
the range's start and set is_range true. When they name a day with no time at all,
return time null and is_range true.

Rules:
- Resolve relative days ("next Tuesday", "tomorrow") against TODAY, given below.
- If the year is not stated, choose the nearest future date.
- If no timezone is knowable from the message, set timezone to null. Do not guess.
- If no meeting times are proposed at all, return an empty array.

Respond with JSON only:
{
  "times": [
    { "date": "YYYY-MM-DD", "time": "HH:MM" or null, "timezone": "IANA name" or null,
      "is_range": false, "quote": "the words they used" }
  ],
  "stated_timezone": "IANA name" or null,
  "wants_to_meet": true|false
}
"stated_timezone" is the zone the writer appears to be in overall, if knowable.`;

/**
 * @param {object} p
 * @param {string} p.message      the latest inbound message text
 * @param {Date}   p.now          today (injected, never read from the clock inside a prompt)
 * @param {string} p.fallbackTimeZone  their inferred zone, used when they stated none
 * @param {string} p.businessTimeZone  our zone, for labelling
 * @returns {{ times: [], statedTimeZone: string|null, wantsToMeet: boolean, error: string|null }}
 *
 * Fails SOFT: any error returns an empty result with `error` set, because the
 * scheduling panel has to open regardless — the operator can always read the
 * message themselves and pick from the grid.
 */
async function extractProposedTimes({
  message,
  now = new Date(),
  fallbackTimeZone = null,
  businessTimeZone = 'America/Toronto',
  company_id = null,
} = {}) {
  const empty = { times: [], statedTimeZone: null, wantsToMeet: false, error: null };
  if (!message || !String(message).trim()) return empty;

  const todayLabel = new Intl.DateTimeFormat('en-GB', {
    timeZone: businessTimeZone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  }).format(now);

  let raw;
  try {
    const res = await callClaude({
      component: 'b2b_proposed_times',
      model: MODELS.SONNET,
      max_tokens: 1000,
      system: SYSTEM_PROMPT,
      metadata: company_id ? { company_id } : null,
      messages: [{
        role: 'user',
        content: `TODAY is ${todayLabel}.\n\nMESSAGE:\n${String(message).slice(0, 8000)}`,
      }],
    });
    raw = (res?.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  } catch (e) {
    return { ...empty, error: `Could not read times from the message: ${e.message}` };
  }

  let parsed;
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(m ? m[0] : raw);
  } catch {
    return { ...empty, error: 'Could not read times from the message (unparseable response)' };
  }

  const statedTimeZone = isValidTimeZone(parsed.stated_timezone) ? parsed.stated_timezone : null;
  const times = [];

  for (const t of Array.isArray(parsed.times) ? parsed.times : []) {
    if (!t || !/^\d{4}-\d{2}-\d{2}$/.test(String(t.date || ''))) continue;
    const [year, month, day] = t.date.split('-').map(Number);

    // Their zone, in order of trust: what they said about THIS time, what they
    // said generally, then what we inferred from their address. If all three are
    // empty we keep the candidate but flag it — the operator picks the zone.
    const zone = [t.timezone, statedTimeZone, fallbackTimeZone].find(z => isValidTimeZone(z)) || null;
    const zoneSource = isValidTimeZone(t.timezone) ? 'stated'
      : isValidTimeZone(statedTimeZone) ? 'stated'
      : isValidTimeZone(fallbackTimeZone) ? 'inferred' : 'unknown';

    const hasTime = /^\d{1,2}:\d{2}$/.test(String(t.time || ''));
    if (!hasTime) {
      // A day with no time is still useful — it tells the operator which day to
      // look at. It is returned as a day hint rather than a bookable candidate.
      times.push({
        date: t.date, start: null, dayOnly: true, isRange: true,
        quote: t.quote || null, timeZone: zone, zoneSource,
        label: null, theirLabel: null,
        dayLabel: formatDayInZone(wallClockToUtc({ year, month, day, hour: 12 }, businessTimeZone), businessTimeZone),
      });
      continue;
    }

    const [hour, minute] = t.time.split(':').map(Number);
    if (!zone) {
      times.push({
        date: t.date, start: null, dayOnly: false, isRange: !!t.is_range,
        quote: t.quote || null, timeZone: null, zoneSource: 'unknown',
        needsTimeZone: true, wallClock: t.time,
        dayLabel: formatDayInZone(wallClockToUtc({ year, month, day, hour: 12 }, businessTimeZone), businessTimeZone),
      });
      continue;
    }

    const start = wallClockToUtc({ year, month, day, hour, minute }, zone);
    times.push({
      date: t.date,
      start: start.toISOString(),
      dayOnly: false,
      isRange: !!t.is_range,
      quote: t.quote || null,
      timeZone: zone,
      zoneSource,
      label: formatTimeInZone(start, businessTimeZone),
      theirLabel: formatTimeInZone(start, zone),
      dayLabel: formatDayInZone(start, businessTimeZone),
    });
  }

  return {
    times,
    statedTimeZone,
    wantsToMeet: !!parsed.wants_to_meet || times.length > 0,
    error: null,
  };
}

module.exports = { extractProposedTimes, SYSTEM_PROMPT };
