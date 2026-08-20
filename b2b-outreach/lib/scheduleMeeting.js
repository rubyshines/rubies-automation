/**
 * scheduleMeeting.js — book a call with a company and tell them, in one action.
 *
 * Booking and telling are deliberately not separable. A calendar event the other
 * side was never told about is worse than no feature, so the tool either does
 * both or reports precisely which half happened.
 *
 * Order of operations is chosen so the recoverable failure is the one we take:
 *   1. resolve the recipient and check the send gate — BEFORE touching the calendar
 *   2. re-check the slot is still free
 *   3. create the event (this is what emails them the invite + Meet link)
 *   4. send the reply through sendB2bEmail, the one send path
 * If step 4 fails after step 3, the event STAYS. They already hold the invite;
 * deleting it would fire a cancellation and read as chaos. The caller is told to
 * send the reply by hand.
 */
const { getSupabaseClient } = require('../../shared/supabaseClient');
const { isFlagEnabled } = require('../../shared/systemFlags');
const {
  getCalendar, ORGANIZER_CALENDAR_ID, BUSINESS_TIMEZONE,
} = require('../../shared/googleCalendarClient');
const { sendB2bEmail, resolveDelivery, SEND_FLAG, FROM_EMAIL } = require('./sendB2bEmail');
const { fetchCalendarEvents, checkSlotFree, formatTimeInZone, formatDayInZone } = require('./availability');
const { isValidTimeZone } = require('./meetingTimezone');

const DEFAULT_DURATION_MIN = 30;
const DEFAULT_MESSAGE_TYPE = 'meeting_confirmation';

/** "RUBIES x Uniting Pride". Pure. */
function meetingTitle(companyName) {
  return `RUBIES x ${String(companyName || 'partner').trim()}`;
}

/**
 * The one sentence the panel drops into the draft. Deterministic, not AI.
 *
 * Wording is Jamie's own (2026-08-20). Terse on purpose: the rule that killed
 * the old bloated scheduling paragraph bans narrating the mechanics, so this
 * states a completed fact and stops. The Meet link is not repeated — it is in
 * the invite.
 *
 * The date is ABSOLUTE, never "next Wednesday": a relative date is a stale fact
 * with a long fuse, and this text can sit in a pending draft for days before it
 * sends. Their local time is appended only when their zone actually differs —
 * the both-zones habit exists because timezone confusion killed real meetings,
 * but for a Toronto org it prints the same number twice. Pure.
 */
function renderConfirmationLine({ start, businessTimeZone = BUSINESS_TIMEZONE, theirTimeZone = null }) {
  const d = new Date(start);
  const day = formatDayInZone(d, businessTimeZone);
  const ours = formatTimeInZone(d, businessTimeZone);
  if (theirTimeZone && isValidTimeZone(theirTimeZone) && theirTimeZone !== businessTimeZone) {
    return `I just created an invite for ${day} at ${ours} ET (${formatTimeInZone(d, theirTimeZone)} your time).`;
  }
  return `I just created an invite for ${day} at ${ours} ET.`;
}

/**
 * Book the call.
 *
 * @param {object} p
 * @param {string} p.company_id
 * @param {string} p.start              ISO instant of the slot
 * @param {number} p.duration_minutes   default 30
 * @param {string} p.body               the reply to send (already containing the time)
 * @param {number} p.thread_id          thread to reply on
 * @param {string} p.subject            required only for a brand-new thread
 * @param {string} p.their_timezone     IANA zone, for the record + labels
 * @param {string} p.title              overrides "RUBIES x <Company>"
 * @param {boolean} p.confirmed         phase 2; without it this only previews
 * @param {boolean} p.test_mode         real event + real invite, but only to Jamie,
 *                                      titled [TEST], writing nothing to the record
 * @param {boolean} p.force             book over a clash
 * @param {boolean} p.skip_reply        create the event and invite, send NO email —
 *                                      for repairing a message that already stated
 *                                      the time before the event existed
 */
async function scheduleMeeting(p = {}) {
  const {
    company_id, start, thread_id, subject, body,
    duration_minutes = DEFAULT_DURATION_MIN,
    their_timezone = null, their_timezone_source = null,
    title: titleOverride, confirmed, test_mode, force, skip_reply,
    message_type = DEFAULT_MESSAGE_TYPE, cc, notes,
  } = p;

  if (!company_id) throw new Error('company_id required');
  if (!start) throw new Error('start required');
  const startDate = new Date(start);
  if (Number.isNaN(startDate.getTime())) throw new Error(`start is not a valid date: ${start}`);
  const duration = Math.max(5, Math.round(duration_minutes || DEFAULT_DURATION_MIN));
  const endDate = new Date(startDate.getTime() + duration * 60000);

  if (startDate.getTime() < Date.now()) {
    return { ok: false, error: 'That time is in the past.' };
  }

  const sb = getSupabaseClient();
  const { data: company, error: cErr } = await sb.from('b2b_companies')
    .select('id, name, city, region, country').eq('id', company_id).maybeSingle();
  if (cErr) throw new Error(`company lookup: ${cErr.message}`);
  if (!company) return { ok: false, error: `No company ${company_id}` };

  const title = titleOverride || meetingTitle(company.name);

  // --- 1. recipient + gate, before the calendar is touched --------------------
  const delivery = await resolveDelivery(sb, company_id);
  if (delivery.mode === 'form') {
    return {
      ok: false,
      error: `${company.name} publishes no email address, only a contact form (${delivery.url}). `
        + 'A calendar invite needs an address, so book this one by hand after they reply with one.',
    };
  }
  if (delivery.mode === 'none') {
    return { ok: false, error: `No contact on file for ${company.name} — fix the contact record first.` };
  }
  if (!test_mode && !(await isFlagEnabled(SEND_FLAG))) {
    return {
      ok: false,
      phase: 'blocked',
      error: `B2B sending is disabled (system flag '${SEND_FLAG}' is off), so the reply could not go out. `
        + 'Nothing was booked. Use test_mode to rehearse the whole flow against your own calendar.',
    };
  }

  const theirTz = isValidTimeZone(their_timezone) ? their_timezone : null;
  const attendees = test_mode
    ? [FROM_EMAIL]
    : [delivery.email, ...String(cc || '').split(',').map(s => s.trim()).filter(Boolean)];

  const preview = {
    ok: true,
    phase: 'preview',
    company: company.name,
    title: test_mode ? `[TEST] ${title}` : title,
    start: startDate.toISOString(),
    end: endDate.toISOString(),
    duration_minutes: duration,
    when_ours: `${formatDayInZone(startDate, BUSINESS_TIMEZONE)} ${formatTimeInZone(startDate, BUSINESS_TIMEZONE)} Eastern`,
    when_theirs: theirTz ? `${formatTimeInZone(startDate, theirTz)} (${theirTz})` : null,
    attendees,
    confirmation_line: renderConfirmationLine({ start: startDate, theirTimeZone: theirTz }),
  };
  if (!confirmed) return preview;

  if (!skip_reply && (!body || !body.trim())) {
    return { ok: false, error: 'body required — the reply that tells them the time.' };
  }

  // --- 2. is the slot still free? -------------------------------------------
  // The grid may have been rendered a while ago, and these three calendars move.
  let clashInfo = null;
  try {
    const { busy } = await fetchCalendarEvents({
      timeMin: new Date(startDate.getTime() - 3600 * 1000),
      timeMax: new Date(endDate.getTime() + 3600 * 1000),
      includeHolidays: false,
    });
    const check = checkSlotFree({ start: startDate, durationMinutes: duration, busy });
    if (!check.free) {
      clashInfo = check.clash;
      if (!force) {
        return {
          ok: false,
          phase: 'clash',
          error: `${formatDayInZone(startDate, BUSINESS_TIMEZONE)} ${formatTimeInZone(startDate, BUSINESS_TIMEZONE)} `
            + `is no longer free — "${check.clash.summary}" is in that slot. Pick another, or pass force to double-book.`,
          clash: check.clash,
        };
      }
    }
  } catch (e) {
    // A calendar we cannot read must not be treated as empty.
    return { ok: false, error: `Could not verify the slot is free: ${e.message}` };
  }

  // --- 3. create the event (this is what sends them the invite + Meet link) ---
  const cal = await getCalendar();
  let event;
  try {
    const res = await cal.events.insert({
      calendarId: ORGANIZER_CALENDAR_ID,
      conferenceDataVersion: 1,
      sendUpdates: 'all',
      requestBody: {
        summary: test_mode ? `[TEST] ${title}` : title,
        description: test_mode
          ? 'Test booking from the RUBIES outreach panel. Safe to delete.'
          : (notes || undefined),
        start: { dateTime: startDate.toISOString(), timeZone: BUSINESS_TIMEZONE },
        end: { dateTime: endDate.toISOString(), timeZone: BUSINESS_TIMEZONE },
        attendees: attendees.map(email => ({ email })),
        conferenceData: {
          createRequest: {
            // Deterministic per (company, instant) so a retried insert cannot
            // mint a second Meet link for the same call.
            requestId: `rubies-${company_id}-${startDate.getTime()}`.slice(0, 64),
            conferenceSolutionKey: { type: 'hangoutsMeet' },
          },
        },
      },
    });
    event = res.data;
  } catch (e) {
    return { ok: false, error: `Could not create the calendar event: ${e.message}. Nothing was sent.` };
  }

  const meetUrl = event.hangoutLink
    || (event.conferenceData?.entryPoints || []).find(x => x.entryPointType === 'video')?.uri
    || null;

  // --- 4. the reply, down the one send path ---------------------------------
  // `skip_reply` books WITHOUT writing an email: the repair path for a message
  // that already told them the time before the event existed. Sending a second
  // one would restate a time they have already read. Creating the event still
  // emails them the Google invite, which is the thing that was missing.
  let send;
  if (skip_reply) {
    send = { ok: true, phase: 'no_reply_sent', thread_id: thread_id || null };
  } else {
    try {
      send = await sendB2bEmail({
        company_id, thread_id, subject, body, cc,
        message_type,
        confirmed: true,
        // The event exists as of a moment ago; its b2b_meetings row is written
        // after this call, so the row cannot be the evidence here.
        invite_created: true,
        ...(test_mode ? { test_send: true } : {}),
      });
    } catch (e) {
      send = { ok: false, error: e.message };
    }
  }

  if (!send?.ok) {
    // The event exists and they already hold the invite. Deleting it now would
    // fire a cancellation on top, so it stays and the operator is told plainly.
    return {
      ok: false,
      phase: 'event_created_email_failed',
      error: `The calendar invite went out, but the reply email did not: ${send?.error || 'unknown error'}. `
        + 'Send the reply by hand — the meeting itself is booked.',
      event_id: event.id,
      meet_url: meetUrl,
      html_link: event.htmlLink,
    };
  }

  // --- 5. the record ---------------------------------------------------------
  // A test writes NOTHING, same contract as sendB2bEmail's test_send: a rehearsal
  // that left a footprint on the relationship record would be worse than no test.
  if (test_mode) {
    return {
      ok: true,
      phase: 'test_booked',
      event_id: event.id,
      meet_url: meetUrl,
      html_link: event.htmlLink,
      title: `[TEST] ${title}`,
      start: startDate.toISOString(),
      when_ours: preview.when_ours,
      when_theirs: preview.when_theirs,
      would_invite: delivery.email,
      note: 'Real event, real Meet link, real invite — to you only. Nothing was written to '
        + `${company.name}'s record and no draft was consumed. Delete the event when you are done.`,
    };
  }

  const { data: meeting, error: mErr } = await sb.from('b2b_meetings').insert({
    company_id,
    thread_id: send.thread_id || thread_id || null,
    google_event_id: event.id,
    google_calendar_id: ORGANIZER_CALENDAR_ID,
    meet_url: meetUrl,
    html_link: event.htmlLink || null,
    title,
    starts_at: startDate.toISOString(),
    ends_at: endDate.toISOString(),
    duration_minutes: duration,
    attendee_emails: attendees,
    their_timezone: theirTz,
    their_timezone_source: their_timezone_source || (theirTz ? 'operator' : null),
    status: 'booked',
    booked_by: 'operator',
    notes: notes || null,
  }).select('id').maybeSingle();
  if (mErr) {
    // The call is booked and they have been told; only our record is missing.
    console.error(`[scheduleMeeting] b2b_meetings insert failed (call IS booked): ${mErr.message}`);
  }

  return {
    ok: true,
    phase: 'booked',
    meeting_id: meeting?.id || null,
    event_id: event.id,
    meet_url: meetUrl,
    html_link: event.htmlLink,
    title,
    start: startDate.toISOString(),
    end: endDate.toISOString(),
    when_ours: preview.when_ours,
    when_theirs: preview.when_theirs,
    invited: attendees,
    thread_id: send.thread_id,
    gmail_message_id: send.gmail_message_id,
    double_booked_over: clashInfo ? clashInfo.summary : null,
    record_written: !mErr,
  };
}

/**
 * The next booked call for each of these companies, keyed by company_id.
 * Used by the cadence — a company with a call coming up is not waiting on us.
 */
async function upcomingMeetingsByCompany(sb, companyIds, now = new Date()) {
  const ids = [...new Set((companyIds || []).filter(Boolean))];
  if (!ids.length) return new Map();

  const out = new Map();
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const { data, error } = await sb.from('b2b_meetings')
      .select('company_id, starts_at, title, meet_url, duration_minutes')
      .in('company_id', chunk)
      .eq('status', 'booked')
      .gte('starts_at', now.toISOString())
      .order('starts_at', { ascending: true });
    if (error) {
      // Never let a missing meetings table break the queue — the worst case is
      // the pre-existing behaviour (nudging a company that has a call booked).
      console.warn(`[upcomingMeetingsByCompany] ${error.message}`);
      return out;
    }
    for (const row of data || []) {
      if (!out.has(row.company_id)) out.set(row.company_id, row);
    }
  }
  return out;
}

/** The most recent call that has already happened, per company. */
async function lastHeldMeetingsByCompany(sb, companyIds, now = new Date()) {
  const ids = [...new Set((companyIds || []).filter(Boolean))];
  if (!ids.length) return new Map();

  const out = new Map();
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const { data, error } = await sb.from('b2b_meetings')
      .select('company_id, starts_at, ends_at, title')
      .in('company_id', chunk)
      .eq('status', 'booked')
      .lt('ends_at', now.toISOString())
      .order('ends_at', { ascending: false });
    if (error) {
      console.warn(`[lastHeldMeetingsByCompany] ${error.message}`);
      return out;
    }
    for (const row of data || []) {
      if (!out.has(row.company_id)) out.set(row.company_id, row);
    }
  }
  return out;
}

module.exports = {
  scheduleMeeting,
  meetingTitle,
  renderConfirmationLine,
  upcomingMeetingsByCompany,
  lastHeldMeetingsByCompany,
  DEFAULT_DURATION_MIN,
};
