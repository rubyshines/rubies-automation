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
 *   4. send the reply through sendDraftById, the one send path
 * If step 4 fails after step 3, the event STAYS. They already hold the invite;
 * deleting it would fire a cancellation and read as chaos. The caller is told to
 * send the reply by hand.
 *
 * The reply goes out by CONSUMING the company's pending draft rather than as a
 * loose body, because the composer autosaves into that row as the operator types
 * and everything else about the send lives on it. Sending around it left the row
 * `pending` after a successful Book & Send, and `mergePendingDraftEntries` puts
 * any company holding a pending draft straight back in the queue — so a booked,
 * answered call read as outstanding work. Same shape as the empty-state Send bug
 * (2026-08-26): a path that sends without consuming the draft silently discards
 * the operator state accumulated on it.
 */
const { getSupabaseClient } = require('../../shared/supabaseClient');
const { isFlagEnabled } = require('../../shared/systemFlags');
const {
  getCalendar, ORGANIZER_CALENDAR_ID, BUSINESS_TIMEZONE,
} = require('../../shared/googleCalendarClient');
const { sendB2bEmail, resolveDelivery, addressList, SEND_FLAG, FROM_EMAIL } = require('./sendB2bEmail');
const { fetchCalendarEvents, checkSlotFree, formatTimeInZone, formatDayInZone } = require('./availability');
const { isValidTimeZone } = require('./meetingTimezone');
const { greetingName, MAX_NO_SHOWS } = require('./messageTemplates');

const DEFAULT_DURATION_MIN = 30;
const DEFAULT_MESSAGE_TYPE = 'meeting_confirmation';

/** The video entry point on an event, or null. Pure. */
function meetLinkOf(event) {
  return event?.hangoutLink
    || (event?.conferenceData?.entryPoints || []).find(x => x.entryPointType === 'video')?.uri
    || null;
}

/** 'success' | 'pending' | 'failure' | null — Google's verdict on our Meet request. Pure. */
function conferenceStatus(event) {
  return event?.conferenceData?.createRequest?.status?.statusCode || null;
}

const MEET_LINK_ATTEMPTS = 4;
const MEET_LINK_WAIT_MS = 1500;

/**
 * Make sure the event actually has a Meet link before we tell anyone it does.
 *
 * Google creates the room asynchronously: the insert response can carry the
 * request as `pending`, and sometimes as an outright `failure` — Uniting Pride
 * (2026-09-08) went out that way, invite and reply both sent, no link on
 * either, and nothing noticed until the partner's calendar was looked at.
 * Pending is polled; failure is retried with a FRESH requestId, because the
 * deterministic one is idempotent by design and would only replay the same
 * failure. `sendUpdates: 'all'` on the retry, since the attendee already holds
 * the invite and needs the link added to it. Returns the freshest event either
 * way; the caller reports a missing link rather than pretending.
 */
async function ensureMeetLink(cal, event, {
  calendarId, requestIdBase, attempts = MEET_LINK_ATTEMPTS, waitMs = MEET_LINK_WAIT_MS, sleep = ms => new Promise(r => setTimeout(r, ms)),
} = {}) {
  let current = event;
  for (let i = 0; i < attempts; i++) {
    if (meetLinkOf(current)) return current;
    const status = conferenceStatus(current);
    try {
      if (status === 'failure' || status === null) {
        const res = await cal.events.patch({
          calendarId, eventId: current.id, conferenceDataVersion: 1, sendUpdates: 'all',
          requestBody: {
            conferenceData: {
              createRequest: {
                requestId: `${requestIdBase}-r${i + 1}`.slice(0, 64),
                conferenceSolutionKey: { type: 'hangoutsMeet' },
              },
            },
          },
        });
        current = res.data || current;
        if (meetLinkOf(current)) return current;
      }
      await sleep(waitMs);
      const again = await cal.events.get({ calendarId, eventId: current.id });
      current = again.data || current;
    } catch (e) {
      console.warn(`[scheduleMeeting] Meet link check attempt ${i + 1} failed: ${e.message}`);
    }
  }
  return current;
}

/** "RUBIES x Uniting Pride". Pure. */
function meetingTitle(companyName) {
  return `RUBIES x ${String(companyName || 'partner').trim()}`;
}

/**
 * The one sentence the panel drops into the draft. Deterministic, not AI.
 *
 * Wording is Jamie's own (2026-08-20, reworded 2026-09-08). Terse on purpose: the rule that killed
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
function renderConfirmationLine({ start, businessTimeZone = BUSINESS_TIMEZONE, theirTimeZone = null, moved = false }) {
  const d = new Date(start);
  const day = formatDayInZone(d, businessTimeZone);
  const ours = formatTimeInZone(d, businessTimeZone);
  // A move says so: "sent an invite" for a call they already hold reads as a
  // second call. Same shape otherwise, so the send guard covers both.
  const verb = moved ? 'I moved our call to' : 'I just sent an invite for';
  if (theirTimeZone && isValidTimeZone(theirTimeZone) && theirTimeZone !== businessTimeZone) {
    return `Ok, ${verb} ${day} at ${ours} ET (${formatTimeInZone(d, theirTimeZone)} your time).`;
  }
  return `Ok, ${verb} ${day} at ${ours} ET.`;
}

/**
 * The whole reply around that sentence — greeting named after whoever the
 * email will go to, the sentence, a closing line, Jamie's sign-off. What an
 * empty composer is filled with when a slot is picked; a composer already
 * holding text gets only the sentence. Pure.
 */
function renderConfirmationBody({ firstName, start, businessTimeZone = BUSINESS_TIMEZONE, theirTimeZone = null, moved = false }) {
  // Lazy: messageTemplates reaches back into this module for meeting lookups.
  const { fillMeetingConfirmation } = require('./messageTemplates');
  const confirmationLine = renderConfirmationLine({ start, businessTimeZone, theirTimeZone, moved });
  return fillMeetingConfirmation({ firstName, confirmationLine }).body;
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

  // The pending draft is read BEFORE the recipient, because a To/Cc the operator
  // typed into the panel lives on it — and the invite must go to whoever the
  // email goes to. Resolving them separately is how you book a call with one
  // person and tell a different one about it.
  const { data: pendingDraft } = await sb.from('b2b_drafts')
    .select('id, thread_id, structured')
    .eq('company_id', company_id).eq('status', 'pending').maybeSingle();
  const toOverride = pendingDraft?.structured?.to || null;
  const ccList = cc ?? pendingDraft?.structured?.cc ?? null;

  // --- 1. recipient + gate, before the calendar is touched --------------------
  const delivery = toOverride
    ? { mode: 'email', email: addressList(toOverride) }
    : await resolveDelivery(sb, company_id);
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
  // A To override may name several people; addressList joins them, so split
  // again for the attendee array — one attendee holding "a@x, b@y" invites
  // nobody and Google reports it as a bad request, after the send has gone.
  const splitAddrs = v => String(v || '').split(',').map(s => s.trim()).filter(Boolean);
  const attendees = test_mode
    ? [FROM_EMAIL]
    : [...splitAddrs(delivery.email), ...splitAddrs(ccList)];

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
    // A To override carries no name, so the greeting falls back to "there"
    // rather than naming the contact the operator just wrote around.
    confirmation_body: renderConfirmationBody({
      firstName: greetingName(delivery.name), start: startDate, theirTimeZone: theirTz,
    }),
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

  // Never announce a link we do not hold. See ensureMeetLink.
  event = await ensureMeetLink(cal, event, {
    calendarId: ORGANIZER_CALENDAR_ID,
    requestIdBase: `rubies-${company_id}-${startDate.getTime()}`.slice(0, 58),
  });
  const meetUrl = meetLinkOf(event);
  if (!meetUrl) console.error(`[scheduleMeeting] event ${event.id} for ${company_id} has NO Meet link after retries (${conferenceStatus(event) || 'no status'})`);

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
      // The event exists as of a moment ago; its b2b_meetings row is written
      // after this call, so the row cannot be the evidence for invite_created.
      // Required lazily: queueService pulls in the advisor and the whole queue
      // stack, which this module has no other reason to load.
      const { sendDraftById } = require('./queueService');
      const common = { confirmed: true, invite_created: true, ...(test_mode ? { test_send: true } : {}) };
      send = pendingDraft
        // Consuming the draft is what marks it sent, so a booked call leaves the
        // queue. It also carries the attachments, To/Cc and next_touch_days the
        // operator set, and records sent_body for the edit-rate signal.
        ? await sendDraftById(sb, {
          ...common,
          draft_id: pendingDraft.id,
          body, subject,
          thread_id: thread_id || pendingDraft.thread_id || undefined,
          message_type,
          // The same list the invite went to, so the two can never name
          // different people.
          cc: ccList ?? undefined,
        })
        // No draft exists when this is driven from the console or the MCP tool.
        : await sendB2bEmail({ ...common, company_id, thread_id, subject, body, cc: ccList ?? undefined, message_type });
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
    // Loud rather than a null field: the reply has already said "I just sent
    // an invite", so a missing link is the operator's to fix in the calendar.
    warning: meetUrl ? null : 'The invite went out WITHOUT a Meet link — Google failed to create the room. Add one to the event by hand.',
  };
}

/** The company's next booked call, or null. */
async function upcomingBookedMeeting(sb, company_id, now = new Date()) {
  const { data, error } = await sb.from('b2b_meetings')
    .select('*').eq('company_id', company_id).eq('status', 'booked')
    .gte('starts_at', now.toISOString()).order('starts_at', { ascending: true }).limit(1).maybeSingle();
  if (error) throw new Error(error.message);
  return data || null;
}

// The waiting-in-room nudge is offered from a little before the start (Jamie
// is in the room early) until the scheduled end. Shared with nothing else: a
// no-show is recorded against the START, this is about "now".
const LIVE_LEAD_MINUTES = 5;

/**
 * Is this call happening right now: from shortly before its start until its
 * end, still booked, and not yet marked held or no-show? Pure.
 */
function isMeetingLive(m, now = new Date()) {
  if (!m || m.status !== 'booked' || m.outcome) return false;
  const start = new Date(m.starts_at).getTime();
  const end = m.ends_at
    ? new Date(m.ends_at).getTime()
    : start + (Number(m.duration_minutes) || DEFAULT_DURATION_MIN) * 60000;
  if (Number.isNaN(start) || Number.isNaN(end)) return false;
  const t = now.getTime();
  return t >= start - LIVE_LEAD_MINUTES * 60000 && t <= end;
}

/** The company's call that is happening right now, or null. */
async function liveMeeting(sb, company_id, now = new Date()) {
  const { data, error } = await sb.from('b2b_meetings')
    .select('*').eq('company_id', company_id).eq('status', 'booked')
    .lte('starts_at', new Date(now.getTime() + LIVE_LEAD_MINUTES * 60000).toISOString())
    .gte('ends_at', now.toISOString())
    .order('starts_at', { ascending: false }).limit(3);
  if (error) throw new Error(error.message);
  return (data || []).find(m => isMeetingLive(m, now)) || null;
}

/**
 * Move a booked call, and tell them, in one action.
 *
 * Why this exists: a partner writing "can we push our chat to next week"
 * (Lumenus, 2026-08-26) lands in the panel like any reply, and Book & Send
 * would have created a SECOND event while the first stayed in their inbox.
 * A company with an upcoming booked call plus a picked slot is a move by
 * definition, so the caller routes here deterministically — no detection.
 *
 * The existing Google event is PATCHED to the new time (sendUpdates 'all', so
 * Google emails them the change and the Meet link survives), the row updates
 * in place keeping its history, and the reply says "I moved our call". Same
 * order of operations as scheduleMeeting: recipient and gate first, then the
 * slot check (ignoring this call's own block), then the calendar, then the
 * one send path. The event stays moved if the email fails.
 *
 * `deps` is for tests: { cal, fetchEvents, now }.
 */
async function rescheduleMeeting(p = {}, deps = {}) {
  const {
    company_id, meeting_id, start, thread_id, subject, body,
    duration_minutes, their_timezone = null,
    confirmed, force, skip_reply, message_type = DEFAULT_MESSAGE_TYPE, cc,
  } = p;
  const now = deps.now || new Date();
  if (!company_id) throw new Error('company_id required');
  if (!start) throw new Error('start required');
  const startDate = new Date(start);
  if (Number.isNaN(startDate.getTime())) throw new Error(`start is not a valid date: ${start}`);
  if (startDate.getTime() < now.getTime()) return { ok: false, error: 'That time is in the past.' };

  const sb = deps.sb || getSupabaseClient();
  const { data: company, error: cErr } = await sb.from('b2b_companies')
    .select('id, name, city, region, country').eq('id', company_id).maybeSingle();
  if (cErr) throw new Error(`company lookup: ${cErr.message}`);
  if (!company) return { ok: false, error: `No company ${company_id}` };

  let meeting;
  if (meeting_id) {
    const { data, error } = await sb.from('b2b_meetings').select('*').eq('id', meeting_id).maybeSingle();
    if (error) throw new Error(error.message);
    meeting = data;
  } else {
    meeting = await upcomingBookedMeeting(sb, company_id, now);
  }
  if (!meeting) return { ok: false, error: `${company.name} has no upcoming booked call to move.` };
  if (meeting.status !== 'booked') return { ok: false, error: `Call #${meeting.id} is ${meeting.status}, not booked — nothing to move.` };
  if (!meeting.google_event_id) return { ok: false, error: `Call #${meeting.id} has no calendar event on record — move it in Google Calendar by hand.` };

  const duration = Math.max(5, Math.round(duration_minutes || meeting.duration_minutes || DEFAULT_DURATION_MIN));
  const endDate = new Date(startDate.getTime() + duration * 60000);
  const theirTz = isValidTimeZone(their_timezone) ? their_timezone
    : isValidTimeZone(meeting.their_timezone) ? meeting.their_timezone : null;
  const calendarId = meeting.google_calendar_id || ORGANIZER_CALENDAR_ID;

  const { data: pendingDraft } = await sb.from('b2b_drafts')
    .select('id, thread_id, structured')
    .eq('company_id', company_id).eq('status', 'pending').maybeSingle();
  const toOverride = pendingDraft?.structured?.to || null;
  const ccList = cc ?? pendingDraft?.structured?.cc ?? null;

  // --- 1. recipient + gate, before the calendar is touched --------------------
  const delivery = toOverride
    ? { mode: 'email', email: addressList(toOverride) }
    : await resolveDelivery(sb, company_id);
  if (delivery.mode !== 'email') {
    return { ok: false, error: `No email address on file for ${company.name} — fix the contact record first.` };
  }
  if (!(await isFlagEnabled(SEND_FLAG))) {
    return {
      ok: false, phase: 'blocked',
      error: `B2B sending is disabled (system flag '${SEND_FLAG}' is off), so the reply could not go out. Nothing was moved.`,
    };
  }

  const preview = {
    ok: true,
    phase: 'preview',
    mode: 'move',
    company: company.name,
    meeting_id: meeting.id,
    title: meeting.title,
    previous_start: meeting.starts_at,
    previous_when_ours: `${formatDayInZone(new Date(meeting.starts_at), BUSINESS_TIMEZONE)} ${formatTimeInZone(new Date(meeting.starts_at), BUSINESS_TIMEZONE)} Eastern`,
    start: startDate.toISOString(),
    end: endDate.toISOString(),
    duration_minutes: duration,
    when_ours: `${formatDayInZone(startDate, BUSINESS_TIMEZONE)} ${formatTimeInZone(startDate, BUSINESS_TIMEZONE)} Eastern`,
    when_theirs: theirTz ? `${formatTimeInZone(startDate, theirTz)} (${theirTz})` : null,
    attendees: meeting.attendee_emails || [],
    confirmation_line: renderConfirmationLine({ start: startDate, theirTimeZone: theirTz, moved: true }),
    confirmation_body: renderConfirmationBody({
      firstName: greetingName(delivery.name), start: startDate, theirTimeZone: theirTz, moved: true,
    }),
  };
  if (!confirmed) return preview;
  if (!skip_reply && (!body || !body.trim())) {
    return { ok: false, error: 'body required — the reply that tells them the new time.' };
  }

  // --- 2. is the new slot free? (this call's own block does not count) --------
  let clashInfo = null;
  try {
    const fetchEvents = deps.fetchEvents || fetchCalendarEvents;
    const { busy } = await fetchEvents({
      timeMin: new Date(startDate.getTime() - 3600 * 1000),
      timeMax: new Date(endDate.getTime() + 3600 * 1000),
      includeHolidays: false,
    });
    const others = busy.filter(b => b.eventId !== meeting.google_event_id);
    const check = checkSlotFree({ start: startDate, durationMinutes: duration, busy: others });
    if (!check.free) {
      clashInfo = check.clash;
      if (!force) {
        return {
          ok: false, phase: 'clash',
          error: `${formatDayInZone(startDate, BUSINESS_TIMEZONE)} ${formatTimeInZone(startDate, BUSINESS_TIMEZONE)} `
            + `is not free — "${check.clash.summary}" is in that slot. Pick another, or pass force to double-book.`,
          clash: check.clash,
        };
      }
    }
  } catch (e) {
    return { ok: false, error: `Could not verify the slot is free: ${e.message}` };
  }

  // --- 3. move the event (Google emails them the update) ----------------------
  const cal = deps.cal || await getCalendar();
  let event;
  try {
    const res = await cal.events.patch({
      calendarId, eventId: meeting.google_event_id, sendUpdates: 'all',
      requestBody: {
        start: { dateTime: startDate.toISOString(), timeZone: BUSINESS_TIMEZONE },
        end: { dateTime: endDate.toISOString(), timeZone: BUSINESS_TIMEZONE },
      },
    });
    event = res.data || {};
  } catch (e) {
    return { ok: false, error: `Could not move the calendar event: ${e.message}. Nothing was sent.` };
  }

  // --- 4. the record, before the reply: the moved event is the evidence -------
  const stamp = now.toISOString();
  const { error: mErr } = await sb.from('b2b_meetings').update({
    starts_at: startDate.toISOString(),
    ends_at: endDate.toISOString(),
    duration_minutes: duration,
    ...(theirTz && !meeting.their_timezone ? { their_timezone: theirTz, their_timezone_source: 'operator' } : {}),
    updated_at: stamp,
  }).eq('id', meeting.id);
  if (mErr) console.error(`[rescheduleMeeting] b2b_meetings update failed (event IS moved): ${mErr.message}`);

  // --- 5. the reply, down the one send path ---------------------------------
  let send;
  if (skip_reply) {
    send = { ok: true, phase: 'no_reply_sent', thread_id: thread_id || meeting.thread_id || null };
  } else {
    try {
      const { sendDraftById } = require('./queueService');
      const common = { confirmed: true, invite_created: true };
      send = pendingDraft
        ? await sendDraftById(sb, {
          ...common, draft_id: pendingDraft.id, body, subject,
          thread_id: thread_id || pendingDraft.thread_id || meeting.thread_id || undefined,
          message_type, cc: ccList ?? undefined,
        })
        : await sendB2bEmail({ ...common, company_id, thread_id: thread_id || meeting.thread_id || undefined, subject, body, cc: ccList ?? undefined, message_type });
    } catch (e) {
      send = { ok: false, error: e.message };
    }
  }
  if (!send?.ok) {
    return {
      ok: false,
      phase: 'event_moved_email_failed',
      error: `The calendar update went out, but the reply email did not: ${send?.error || 'unknown error'}. `
        + 'Send the reply by hand — the call itself is moved.',
      meeting_id: meeting.id, event_id: meeting.google_event_id,
      previous_start: meeting.starts_at, start: startDate.toISOString(),
    };
  }

  return {
    ok: true,
    phase: 'moved',
    meeting_id: meeting.id,
    event_id: meeting.google_event_id,
    meet_url: meetLinkOf(event) || meeting.meet_url || null,
    html_link: event.htmlLink || meeting.html_link || null,
    title: meeting.title,
    previous_start: meeting.starts_at,
    previous_when_ours: preview.previous_when_ours,
    start: startDate.toISOString(),
    end: endDate.toISOString(),
    when_ours: preview.when_ours,
    when_theirs: preview.when_theirs,
    thread_id: send.thread_id,
    gmail_message_id: send.gmail_message_id,
    double_booked_over: clashInfo ? clashInfo.summary : null,
    record_written: !mErr,
  };
}

/**
 * Cancel a booked call: delete the Google event (which emails them the
 * cancellation) and mark the row. No email of ours goes out — whatever needs
 * saying is the operator's to write. An event already gone from the calendar
 * still lets the row be marked, so the record cannot get stuck.
 */
async function cancelMeeting(sb, { meeting_id, company_id = null, now = new Date() } = {}, deps = {}) {
  if (!meeting_id) throw new Error('meeting_id required');
  const { data: meeting, error } = await sb.from('b2b_meetings').select('*').eq('id', meeting_id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!meeting) throw new Error(`meeting #${meeting_id} not found`);
  if (company_id && meeting.company_id !== company_id) throw new Error(`meeting #${meeting_id} is not ${company_id}'s`);
  if (meeting.status === 'cancelled') return { ok: true, already: true, meeting_id, start: meeting.starts_at };
  if (meeting.starts_at && new Date(meeting.starts_at) <= now) throw new Error(`meeting #${meeting_id} has already started — record an outcome instead`);

  let calendar_deleted = false;
  if (meeting.google_event_id) {
    const cal = deps.cal || await getCalendar();
    try {
      await cal.events.delete({
        calendarId: meeting.google_calendar_id || ORGANIZER_CALENDAR_ID,
        eventId: meeting.google_event_id, sendUpdates: 'all',
      });
      calendar_deleted = true;
    } catch (e) {
      const code = e?.code || e?.response?.status;
      if (code !== 404 && code !== 410) throw new Error(`Could not cancel the calendar event: ${e.message}`);
    }
  }
  const stamp = now.toISOString();
  const { error: uErr } = await sb.from('b2b_meetings')
    .update({ status: 'cancelled', updated_at: stamp }).eq('id', meeting_id);
  if (uErr) throw new Error(uErr.message);
  return { ok: true, meeting_id, start: meeting.starts_at, title: meeting.title, calendar_deleted, cancelled_at: stamp };
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
      .select('id, company_id, thread_id, starts_at, ends_at, title, their_timezone, outcome, booked_by')
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

/**
 * "No follow-up needed" on a held call: the post-call queue entry acts on the
 * MEETING (there is no draft to dismiss), so the dismissal lives on the
 * b2b_meetings row. Scoped to meetings already over — a dismissed FUTURE
 * meeting would also stop suppressing the cadence via
 * upcomingMeetingsByCompany's status filter, which is not what "no follow-up
 * needed" means.
 */
async function dismissPostCallFollowup(sb, { meeting_id } = {}) {
  if (!meeting_id) throw new Error('meeting_id required');
  const { data, error } = await sb.from('b2b_meetings')
    .update({ status: 'followup_dismissed', updated_at: new Date().toISOString() })
    .eq('id', meeting_id)
    .eq('status', 'booked')
    .lt('ends_at', new Date().toISOString())
    .select('id, company_id, title, starts_at');
  if (error) throw new Error(error.message);
  if (!data?.length) throw new Error(`meeting #${meeting_id} is not a held, booked call — nothing to dismiss`);
  return data[0];
}

const MEETING_OUTCOMES = new Set(['held', 'no_show']);

/** How many of this company's calls the operator has marked as no-shows. */
async function noShowCount(sb, companyId) {
  const { count, error } = await sb.from('b2b_meetings')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId).eq('outcome', 'no_show');
  if (error) throw new Error(error.message);
  return count || 0;
}

/**
 * Did the call happen? The engine cannot see attendance, so the operator
 * records it. Stored with its own timestamp rather than by overwriting
 * `status`: a rescheduled event on the same row keeps its booked → moved
 * history, and no-shows stay countable — after MAX_NO_SHOWS the reschedule
 * ask stops being offered (messageTemplates.meetingAsksAllowed).
 *
 * Only for a call whose start is past. A no-show is knowable ten minutes in,
 * so the gate is the start, not the end.
 */
async function recordMeetingOutcome(sb, { meeting_id, outcome, note = null, now = new Date() } = {}) {
  if (!meeting_id) throw new Error('meeting_id required');
  if (!MEETING_OUTCOMES.has(outcome)) throw new Error(`outcome must be one of ${[...MEETING_OUTCOMES].join(', ')}`);
  const { data: row, error } = await sb.from('b2b_meetings')
    .select('id, company_id, title, starts_at, ends_at, status, outcome, booked_by')
    .eq('id', meeting_id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!row) throw new Error(`meeting #${meeting_id} not found`);
  if (row.status === 'cancelled') throw new Error(`meeting #${meeting_id} is cancelled — nothing to record`);
  if (row.starts_at && new Date(row.starts_at) > now) throw new Error(`meeting #${meeting_id} has not started yet`);

  const stamp = now.toISOString();
  const { error: uErr } = await sb.from('b2b_meetings')
    .update({ outcome, outcome_at: stamp, outcome_note: note || null, updated_at: stamp })
    .eq('id', meeting_id);
  if (uErr) throw new Error(uErr.message);

  const noShows = await noShowCount(sb, row.company_id);
  return {
    meeting: { ...row, outcome, outcome_at: stamp },
    no_show_count: noShows,
    stop_meeting_asks: outcome === 'no_show' && noShows >= MAX_NO_SHOWS,
  };
}

module.exports = {
  scheduleMeeting,
  rescheduleMeeting,
  cancelMeeting,
  upcomingBookedMeeting,
  isMeetingLive,
  liveMeeting,
  LIVE_LEAD_MINUTES,
  meetingTitle,
  meetLinkOf,
  conferenceStatus,
  ensureMeetLink,
  renderConfirmationLine,
  renderConfirmationBody,
  upcomingMeetingsByCompany,
  lastHeldMeetingsByCompany,
  dismissPostCallFollowup,
  recordMeetingOutcome,
  noShowCount,
  MEETING_OUTCOMES,
  DEFAULT_DURATION_MIN,
};
