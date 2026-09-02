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
 * Relative days ("tomorrow", "Thursday") resolve against the date the message
 * was SENT, not the date the operator opens the panel — a message can sit for
 * days before being read, and "tomorrow" does not drift with it. Today's date
 * is still injected for the nearest-future-year rule.
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

When they give a WINDOW rather than a single time, set is_range true and report
only the bounds they actually stated:
- "free after 1pm" → time "13:00", end_time null
- "available until 5:30" → time null, end_time "17:30" — "until X" is when their
  availability ENDS, never a time to meet at
- "between 2 and 4" → time "14:00", end_time "16:00"
- "Tuesday afternoon" → time "12:00", end_time null
When they name a day with no time at all, return time and end_time null and
is_range true.

Rules:
- Resolve relative days ("next Tuesday", "tomorrow") against the date the message
  was SENT, given below — the message may have been written days before today.
- If the year is not stated, choose the nearest future date.
- If no timezone is knowable from the message, set timezone to null. Do not guess.
- If no meeting times are proposed at all, return an empty array.

Respond with JSON only:
{
  "times": [
    { "date": "YYYY-MM-DD", "time": "HH:MM" or null, "end_time": "HH:MM" or null,
      "timezone": "IANA name" or null, "is_range": false,
      "quote": "the words they used" }
  ],
  "stated_timezone": "IANA name" or null,
  "wants_to_meet": true|false
}
"stated_timezone" is the zone the writer appears to be in overall, if knowable.`;

const HHMM = /^\d{1,2}:\d{2}$/;

/**
 * @param {object} p
 * @param {string} p.message      the latest inbound message text
 * @param {Date}   p.now          today (injected, never read from the clock inside a prompt)
 * @param {Date|string|null} p.sentAt  when the message was sent — the anchor for "tomorrow"
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
  sentAt = null,
  fallbackTimeZone = null,
  businessTimeZone = 'America/Toronto',
  company_id = null,
} = {}) {
  const empty = { times: [], statedTimeZone: null, wantsToMeet: false, error: null };
  if (!message || !String(message).trim()) return empty;

  const dayFmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: businessTimeZone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
  const sent = sentAt ? new Date(sentAt) : null;
  const todayLabel = dayFmt.format(now);
  const sentLabel = dayFmt.format(sent && !Number.isNaN(sent.getTime()) ? sent : now);

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
        content: `TODAY is ${todayLabel}.\nTHE MESSAGE BELOW WAS SENT on ${sentLabel}.\n\nMESSAGE:\n${String(message).slice(0, 8000)}`,
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

    const hasStart = HHMM.test(String(t.time || ''));
    const hasEnd = HHMM.test(String(t.end_time || ''));
    if (!hasStart && !hasEnd) {
      // A day with no time is still useful — it tells the operator which day to
      // look at. It is returned as a day hint rather than a bookable candidate.
      times.push({
        date: t.date, start: null, end: null, dayOnly: true, isRange: true,
        quote: t.quote || null, timeZone: zone, zoneSource,
        label: null, theirLabel: null, endLabel: null, theirEndLabel: null,
        dayLabel: formatDayInZone(wallClockToUtc({ year, month, day, hour: 12 }, businessTimeZone), businessTimeZone),
      });
      continue;
    }

    if (!zone) {
      times.push({
        date: t.date, start: null, end: null, dayOnly: false,
        isRange: !!t.is_range || !hasStart || hasEnd,
        quote: t.quote || null, timeZone: null, zoneSource: 'unknown',
        needsTimeZone: true, wallClock: hasStart ? t.time : null,
        wallClockEnd: hasEnd ? t.end_time : null,
        dayLabel: formatDayInZone(wallClockToUtc({ year, month, day, hour: 12 }, businessTimeZone), businessTimeZone),
      });
      continue;
    }

    const toUtc = (hhmm) => {
      const [hour, minute] = hhmm.split(':').map(Number);
      return wallClockToUtc({ year, month, day, hour, minute }, zone);
    };
    const start = hasStart ? toUtc(t.time) : null;
    const end = hasEnd ? toUtc(t.end_time) : null;
    const anchor = start || end;
    times.push({
      date: t.date,
      start: start ? start.toISOString() : null,
      end: end ? end.toISOString() : null,
      dayOnly: false,
      // A stated end, or a missing start, is a window even if the model forgot
      // to say so — "until 5:30" can never be a single bookable instant.
      isRange: !!t.is_range || !hasStart || hasEnd,
      quote: t.quote || null,
      timeZone: zone,
      zoneSource,
      label: start ? formatTimeInZone(start, businessTimeZone) : null,
      theirLabel: start ? formatTimeInZone(start, zone) : null,
      endLabel: end ? formatTimeInZone(end, businessTimeZone) : null,
      theirEndLabel: end ? formatTimeInZone(end, zone) : null,
      dayLabel: formatDayInZone(anchor, businessTimeZone),
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
