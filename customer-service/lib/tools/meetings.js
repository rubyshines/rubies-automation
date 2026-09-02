/**
 * meetings.js — MCP tools for looking up availability and booking a call.
 *
 * Agent-agnostic by design: `company_id` is optional on the availability tool,
 * so any advisor (or the operator console) can ask "when am I free?" without a
 * B2B company in hand. The B2B panel is simply the first surface that uses them.
 */
const { getSupabaseClient } = require('../../../shared/supabaseClient');
const { fetchAvailability } = require('../../../b2b-outreach/lib/availability');
const { scheduleMeeting, meetingTitle, renderConfirmationLine } = require('../../../b2b-outreach/lib/scheduleMeeting');
const { timezoneFromLocation, isValidTimeZone, timeZoneLabel } = require('../../../b2b-outreach/lib/meetingTimezone');
const { extractProposedTimes } = require('../../../b2b-outreach/lib/proposedTimes');

/**
 * Their timezone, in order of trust: what the operator/caller passed, then what
 * the company's address implies. Never a guess beyond the deterministic table.
 */
async function resolveTheirTimeZone(sb, { company_id, their_timezone }) {
  if (isValidTimeZone(their_timezone)) {
    return { timeZone: their_timezone, source: 'set by you', split: false, reason: null };
  }
  if (!company_id) return { timeZone: null, source: 'unknown', split: false, reason: null };

  const { data, error } = await sb.from('b2b_companies')
    .select('city, region, country, address').eq('id', company_id).maybeSingle();
  if (error || !data) return { timeZone: null, source: 'unknown', split: false, reason: null };
  return timezoneFromLocation(data);
}

async function handleAvailability(args = {}) {
  const sb = getSupabaseClient();
  const tz = await resolveTheirTimeZone(sb, args);

  const grid = await fetchAvailability({
    durationMinutes: args.duration_minutes || 30,
    days: args.days || 10,
    theirTimeZone: tz.timeZone,
  });

  // A compact rendering: the console wants to read this, not parse it.
  const lines = grid.days.map(day => {
    const free = day.slots.filter(s => !s.busy);
    const notes = day.notes.length ? `  [${day.notes.map(n => n.summary).join('; ')}]` : '';
    if (!free.length) return `${day.label}: nothing free${notes}`;
    const shown = free.slice(0, 8).map(s => (s.theirLabel ? `${s.label} (${s.theirLabel})` : s.label));
    return `${day.label}: ${shown.join(', ')}${free.length > 8 ? `, +${free.length - 8} more` : ''}${notes}`;
  });

  return {
    ok: true,
    timezone: grid.timeZone,
    their_timezone: tz.timeZone,
    their_timezone_source: tz.source,
    their_timezone_warning: tz.split ? tz.reason : null,
    their_timezone_label: tz.timeZone ? timeZoneLabel(tz.timeZone) : null,
    duration_minutes: grid.durationMinutes,
    calendars_checked: grid.calendars,
    summary: lines.join('\n'),
    days: grid.days,
  };
}

async function handleReadProposedTimes(args = {}) {
  const sb = getSupabaseClient();
  const tz = await resolveTheirTimeZone(sb, args);

  let message = args.message;
  let sentAt = null;
  if (!message && args.company_id) {
    const { data } = await sb.from('b2b_messages')
      .select('body_text, sent_at')
      .eq('company_id', args.company_id)
      .eq('direction', 'inbound')
      .order('sent_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    message = data?.body_text || null;
    sentAt = data?.sent_at || null;
  }
  if (!message) return { ok: false, error: 'No message to read — pass `message`, or a company_id with an inbound message.' };

  const res = await extractProposedTimes({
    message,
    sentAt,
    fallbackTimeZone: tz.timeZone,
    company_id: args.company_id || null,
  });
  return {
    ok: !res.error,
    error: res.error,
    their_timezone: tz.timeZone,
    their_timezone_source: tz.source,
    ...res,
  };
}

async function handleSchedule(args = {}) {
  const sb = getSupabaseClient();
  const tz = await resolveTheirTimeZone(sb, args);
  return scheduleMeeting({
    ...args,
    their_timezone: tz.timeZone,
    their_timezone_source: tz.source,
  });
}

module.exports = [
  {
    name: 'calendar_availability',
    description: 'When is Jamie free? Reads ALL of his calendars (rubyshines, personal, bridgecard) and returns 30-minute slots inside 9-5 Eastern on weekdays, starting the next business day (no same-day booking). Pass company_id to also get each slot labelled in the other party\'s local time, inferred from their address. Read-only — books nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        company_id: { type: 'string', description: 'b2b_companies id slug. Optional — only used to work out the other party\'s timezone.' },
        days: { type: 'number', description: 'How many business days to return. Default 10.' },
        duration_minutes: { type: 'number', description: 'Meeting length. Default 30.' },
        their_timezone: { type: 'string', description: 'IANA zone for the other party (e.g. America/Los_Angeles). Overrides what the address implies.' },
      },
    },
    handler: handleAvailability,
  },
  {
    name: 'read_proposed_times',
    description: 'Read the meeting times someone suggested out of their email, resolved to Eastern. Pass a company_id to read their latest inbound message, or pass the message text directly. Returns candidate times with the timezone each was stated in. Books nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        company_id: { type: 'string', description: 'b2b_companies id slug — reads their latest inbound message.' },
        message: { type: 'string', description: 'Message text to read instead of fetching one.' },
        their_timezone: { type: 'string', description: 'IANA zone to assume when the message states none.' },
      },
    },
    handler: handleReadProposedTimes,
  },
  {
    name: 'schedule_meeting',
    description: 'Book a call with a company: creates a Google Calendar event titled "RUBIES x <Company>" with a Google Meet link, invites their contact, and sends the reply telling them the time. Two-phase — without confirmed:true it only previews. Pass test_mode:true to rehearse: a real event and real invite addressed to Jamie only, titled [TEST], writing nothing to the company record.',
    inputSchema: {
      type: 'object',
      properties: {
        company_id: { type: 'string', description: 'b2b_companies id slug.' },
        start: { type: 'string', description: 'ISO instant of the slot start, e.g. 2026-08-25T18:00:00.000Z.' },
        duration_minutes: { type: 'number', description: 'Default 30.' },
        body: { type: 'string', description: 'The reply to send. Required to confirm.' },
        thread_id: { type: 'number', description: 'b2b_threads id to reply on. Omit to start a new thread (then subject is required).' },
        subject: { type: 'string', description: 'Subject — only needed for a new thread.' },
        cc: { type: 'string', description: 'Additional recipients, comma-separated. They are invited too.' },
        title: { type: 'string', description: 'Overrides the default "RUBIES x <Company>" title.' },
        their_timezone: { type: 'string', description: 'IANA zone for the other party. Defaults to what their address implies.' },
        notes: { type: 'string', description: 'Description on the calendar event.' },
        confirmed: { type: 'boolean', description: 'Phase 2. Without it, returns a preview and books nothing.' },
        test_mode: { type: 'boolean', description: 'Rehearsal: real event + invite to Jamie only, [TEST] title, nothing written to the record.' },
        force: { type: 'boolean', description: 'Book even though the slot now clashes with something.' },
      },
      required: ['company_id', 'start'],
    },
    handler: handleSchedule,
  },
];

module.exports.helpers = { resolveTheirTimeZone, meetingTitle, renderConfirmationLine };
