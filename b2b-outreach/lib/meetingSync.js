/**
 * meetingSync.js — Google Calendar is the source of truth for every call.
 *
 * b2b_meetings used to hold only the calls booked from the panel (Book & Send
 * writes the row after creating the event). A call a partner books through
 * THEIR scheduler (Calendly, their Google Calendar) lands on Jamie's calendar
 * exactly like ours — but had no row, so the cadence did not suppress under
 * it, the post-call follow-up never fired for it, and the thank-you closer had
 * to read "Invitation: …" subjects out of Gmail as a stopgap. Reschedules and
 * cancellations of OUR bookings never reached the row either.
 *
 * So: read the organizer calendar over a window, match attendees to companies
 * with the same resolution inbound mail uses (companyMatch.js), and upsert
 * rows keyed on (company_id, google_event_id). Partner-created events get rows
 * (booked_by 'partner'), moved events update start/end in place, cancelled or
 * declined events mark `cancelled`, and attendee RSVPs land on the row in any
 * language — Google reports responseStatus, not a subject line.
 *
 * What the sync never touches on an existing row: notes, their_timezone,
 * thread_id, booked_by, and the outcome columns. Those are operator facts.
 *
 * The event → row decision is a pure function (plannedStatus) so the
 * reschedule / cancel / reinstate / dismissed-stays rules are testable without
 * a calendar; the fetch is injectable for the same reason.
 */
const { getCalendar, ORGANIZER_CALENDAR_ID } = require('../../shared/googleCalendarClient');
const { resolveCompanyForAddress, normalizeAddress } = require('./companyMatch');
const { emailDomain } = require('./emailDomains');

const DEFAULT_DAYS_BACK = 7;
const DEFAULT_DAYS_AHEAD = 90;
const DAY_MS = 86400000;

// Our side of any call. Anyone here is never a partner attendee.
const OUR_DOMAINS = new Set(['rubyshines.com']);

// Where a partner's scheduler puts the call link: Calendly writes the Zoom URL
// into the event's location (and repeats it in the description); Google's own
// conferenceData exists only for Meet. First URL wins.
const CONFERENCE_URL = /https?:\/\/[^\s"'<>]*(?:zoom\.us|meet\.google\.com|teams\.microsoft\.com|whereby\.com|webex\.com)[^\s"'<>]*/i;
function conferenceUrlIn(text) {
  const m = CONFERENCE_URL.exec(String(text || ''));
  return m ? m[0] : null;
}

function isOurs(address) {
  const a = normalizeAddress(address);
  if (!a) return false;
  if (a === String(ORGANIZER_CALENDAR_ID).toLowerCase()) return true;
  return OUR_DOMAINS.has(emailDomain(a));
}

/**
 * A Google Calendar event → the shape the sync reasons about, or null when the
 * event is not a timed meeting (all-day entries, holidays, events with no
 * attendees at all). PURE.
 */
function normalizeEvent(ev) {
  if (!ev || !ev.id) return null;
  const start = ev.start?.dateTime;
  const end = ev.end?.dateTime;
  // Cancelled instances arrive with no times at all (showDeleted), so a
  // cancellation is still reported for a row we may hold.
  const cancelled = ev.status === 'cancelled';
  if (!cancelled && (!start || !end)) return null;

  const attendees = (ev.attendees || []).map(a => ({
    email: normalizeAddress(a.email),
    response: a.responseStatus || 'needsAction',
    organizer: !!a.organizer,
    self: !!a.self,
  })).filter(a => a.email);
  const self = attendees.find(a => a.self || isOurs(a.email));
  const external = attendees.filter(a => !a.self && !isOurs(a.email));
  const organizerEmail = normalizeAddress(ev.organizer?.email) || null;

  const startMs = start ? new Date(start).getTime() : NaN;
  const endMs = end ? new Date(end).getTime() : NaN;
  return {
    google_event_id: ev.id,
    title: ev.summary || 'Call',
    starts_at: Number.isFinite(startMs) ? new Date(startMs).toISOString() : null,
    ends_at: Number.isFinite(endMs) ? new Date(endMs).toISOString() : null,
    duration_minutes: Number.isFinite(startMs) && Number.isFinite(endMs)
      ? Math.max(1, Math.round((endMs - startMs) / 60000)) : null,
    external,
    attendee_emails: external.map(a => a.email),
    attendee_responses: attendees.map(a => ({ email: a.email, response: a.response })),
    organizer_email: organizerEmail,
    organizer_is_ours: organizerEmail ? isOurs(organizerEmail) : true,
    meet_url: ev.hangoutLink
      || (ev.conferenceData?.entryPoints || []).find(x => x.entryPointType === 'video')?.uri
      || conferenceUrlIn(ev.location)
      || conferenceUrlIn(ev.description)
      || null,
    html_link: ev.htmlLink || null,
    cancelled,
    self_declined: !!self && self.response === 'declined',
  };
}

/**
 * What status the row should carry after seeing this event. PURE.
 *
 * - cancelled event, or Jamie declined → 'cancelled'
 * - no row yet → 'booked'
 * - a cancelled row whose event is live again → 'booked'
 * - a followup_dismissed row flips back to 'booked' only when the START moved
 *   into the future — a real reschedule is a new call; the dismissal of the
 *   old one must not resurrect a post-call entry for a meeting that already
 *   passed
 * - otherwise the row keeps its status
 */
function plannedStatus(existing, ev, now = new Date()) {
  if (ev.cancelled || ev.self_declined) return 'cancelled';
  if (!existing) return 'booked';
  if (existing.status === 'cancelled') return 'booked';
  // "Not a separate call" is the operator's fact about the row, not the event;
  // no calendar change un-says it (a move of the spare invite is still the
  // spare invite). Only the panel's Restore does.
  if (existing.status === 'ignored') return 'ignored';
  if (existing.status === 'followup_dismissed') {
    const moved = ev.starts_at && existing.starts_at
      && new Date(ev.starts_at).getTime() !== new Date(existing.starts_at).getTime();
    if (moved && new Date(ev.starts_at) > now) return 'booked';
  }
  return existing.status || 'booked';
}

/** Events on the organizer calendar over the window. Impure. */
async function listCalendarEvents({ timeMin, timeMax, calendarId = ORGANIZER_CALENDAR_ID } = {}) {
  const cal = await getCalendar();
  const out = [];
  let pageToken;
  do {
    const res = await cal.events.list({
      calendarId,
      timeMin: new Date(timeMin).toISOString(),
      timeMax: new Date(timeMax).toISOString(),
      singleEvents: true,
      showDeleted: true,
      orderBy: 'startTime',
      maxResults: 250,
      pageToken,
    });
    out.push(...(res.data.items || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return out;
}

/**
 * Companies for one event: every external attendee resolved, grouped. A shared
 * call with two orgs on it gets two rows, same as a shared Gmail thread.
 */
async function matchEventCompanies(sb, ev) {
  const byCompany = new Map();
  for (const a of ev.external) {
    const r = await resolveCompanyForAddress(sb, a.email);
    if (!r.company_id) continue;
    if (!byCompany.has(r.company_id)) byCompany.set(r.company_id, []);
    byCompany.get(r.company_id).push(a.email);
  }
  return byCompany;
}

/**
 * Sync the window. Returns counts plus the unmatched events (external
 * attendees, no company) so the digest can name them rather than hide them.
 *
 * @param {object} opts
 * @param {string} [opts.companyId]  only write rows for this company (live trigger)
 * @param {Array}  [opts.events]     pre-fetched raw events (tests / replays)
 */
// Two Google events for one call: our Book & Send event and the partner's own
// invite (Le JAG, 2026-09-10) both land on the calendar, minutes apart at the
// same start. One call, one row.
const SAME_CALL_WINDOW_MS = 15 * 60 * 1000;

/**
 * An existing live row for the same company whose start is within 15 minutes
 * of this event's, under a different event id — the same call arriving twice.
 * Null for a cancellation (nothing to link) or when no such row exists.
 */
async function sameCallSibling(sb, companyId, ev) {
  if (ev.cancelled || !ev.starts_at) return null;
  const start = new Date(ev.starts_at).getTime();
  const { data, error } = await sb.from('b2b_meetings')
    .select('id, google_event_id, starts_at, status, linked_event_ids')
    .eq('company_id', companyId)
    .gte('starts_at', new Date(start - SAME_CALL_WINDOW_MS).toISOString())
    .lt('starts_at', new Date(start + SAME_CALL_WINDOW_MS + 1).toISOString());
  if (error) throw new Error(error.message);
  // Never the ignored spare (status 'ignored', 2026-09-11): the kept row is the
  // one whose linked ids the notes lookup reads.
  return (data || []).find(r => r.status !== 'cancelled' && r.status !== 'ignored' && r.google_event_id !== ev.google_event_id) || null;
}

async function syncMeetings(sb, {
  now = new Date(), daysBack = DEFAULT_DAYS_BACK, daysAhead = DEFAULT_DAYS_AHEAD,
  companyId = null, events = null, calendarId = ORGANIZER_CALENDAR_ID,
} = {}) {
  const raw = events || await listCalendarEvents({
    timeMin: new Date(now.getTime() - daysBack * DAY_MS),
    timeMax: new Date(now.getTime() + daysAhead * DAY_MS),
    calendarId,
  });

  const result = {
    events: raw.length, considered: 0, matched: 0, inserted: 0, updated: 0,
    cancelled: 0, unchanged: 0, linked: 0, failed: 0, unmatched: [], errors: [],
  };

  const timezone = require('./meetingTimezone');
  const companyCache = new Map();
  async function companyRow(id) {
    if (!companyCache.has(id)) {
      const { data } = await sb.from('b2b_companies')
        .select('*').eq('id', id).maybeSingle();
      companyCache.set(id, data || null);
    }
    return companyCache.get(id);
  }

  for (const item of raw) {
    const ev = normalizeEvent(item);
    if (!ev || !ev.external.length) continue;
    result.considered++;

    let byCompany;
    try {
      byCompany = await matchEventCompanies(sb, ev);
    } catch (err) {
      result.failed++;
      result.errors.push(`${ev.title}: match failed: ${err.message}`);
      continue;
    }
    if (!byCompany.size) {
      if (!ev.cancelled) result.unmatched.push({ title: ev.title, starts_at: ev.starts_at, attendees: ev.attendee_emails });
      continue;
    }

    for (const [cid, emails] of byCompany) {
      if (companyId && cid !== companyId) continue;
      result.matched++;
      try {
        const { data: existing, error: eErr } = await sb.from('b2b_meetings')
          .select('id, status, starts_at, ends_at, title, attendee_emails, attendee_responses, meet_url, html_link, organizer_email')
          .eq('company_id', cid).eq('google_event_id', ev.google_event_id).maybeSingle();
        if (eErr) throw new Error(eErr.message);

        const status = plannedStatus(existing, ev, now);
        // A cancellation we have no row for is nothing to record.
        if (!existing && status === 'cancelled') { result.unchanged++; continue; }
        const stamp = now.toISOString();

        if (!existing) {
          // The same call under a second event id: link it on the row we have
          // so the notes lookup can try both ids, and make no second row.
          const sibling = await sameCallSibling(sb, cid, ev);
          if (sibling) {
            const linked = [...new Set([...(sibling.linked_event_ids || []), ev.google_event_id])];
            if (linked.length !== (sibling.linked_event_ids || []).length) {
              const { error: lErr } = await sb.from('b2b_meetings')
                .update({ linked_event_ids: linked, updated_at: stamp }).eq('id', sibling.id);
              // Pre-migration the column is missing; a second row is still worse.
              if (lErr && !/linked_event_ids/.test(lErr.message)) throw new Error(lErr.message);
              result.linked++;
            } else {
              result.unchanged++;
            }
            continue;
          }
          const company = await companyRow(cid);
          const tz = company ? require('./companyLocation').resolveCompanyTimeZone(company) : { timeZone: null, source: null };
          const { error } = await sb.from('b2b_meetings').insert({
            company_id: cid,
            thread_id: null,
            google_event_id: ev.google_event_id,
            google_calendar_id: calendarId,
            meet_url: ev.meet_url,
            html_link: ev.html_link,
            title: ev.title,
            starts_at: ev.starts_at,
            ends_at: ev.ends_at,
            duration_minutes: ev.duration_minutes,
            attendee_emails: emails,
            attendee_responses: ev.attendee_responses,
            organizer_email: ev.organizer_email,
            their_timezone: tz.timeZone || null,
            their_timezone_source: tz.timeZone ? `inferred from ${tz.source || 'address'}` : null,
            status,
            booked_by: ev.organizer_is_ours ? 'operator' : 'partner',
            source: 'calendar_sync',
            synced_at: stamp,
          });
          if (error) {
            // The unique index caught a concurrent insert (nightly run vs live
            // trigger). Nothing lost — the other writer holds the same facts.
            if (error.code === '23505') { result.unchanged++; continue; }
            throw new Error(error.message);
          }
          result.inserted++;
          continue;
        }

        const patch = {
          starts_at: ev.starts_at || existing.starts_at,
          ends_at: ev.ends_at || existing.ends_at,
          ...(ev.duration_minutes ? { duration_minutes: ev.duration_minutes } : {}),
          title: ev.cancelled ? existing.title : ev.title,
          attendee_emails: emails.length ? emails : existing.attendee_emails,
          attendee_responses: ev.attendee_responses,
          meet_url: ev.meet_url || existing.meet_url,
          html_link: ev.html_link || existing.html_link,
          organizer_email: ev.organizer_email || existing.organizer_email,
          status,
          synced_at: stamp,
        };
        const changed = ['starts_at', 'ends_at', 'title', 'status', 'meet_url', 'html_link', 'organizer_email']
          .some(k => (patch[k] ?? null) !== (existing[k] ?? null)
            && !(k.endsWith('_at') && patch[k] && existing[k] && new Date(patch[k]).getTime() === new Date(existing[k]).getTime()))
          || JSON.stringify(patch.attendee_responses || null) !== JSON.stringify(existing.attendee_responses || null)
          || JSON.stringify(patch.attendee_emails || null) !== JSON.stringify(existing.attendee_emails || null);
        if (!changed) { result.unchanged++; continue; }

        const { error } = await sb.from('b2b_meetings')
          .update({ ...patch, updated_at: stamp }).eq('id', existing.id);
        if (error) throw new Error(error.message);
        if (status === 'cancelled' && existing.status !== 'cancelled') result.cancelled++;
        else result.updated++;
      } catch (err) {
        result.failed++;
        result.errors.push(`${ev.title} → ${cid}: ${err.message}`);
      }
    }
  }
  return result;
}

/** The live trigger: a calendar notice just landed for this company. Fail-soft. */
async function syncCompanyMeetings(sb, companyId, opts = {}) {
  try {
    return await syncMeetings(sb, { ...opts, companyId });
  } catch (err) {
    console.warn(`[meetingSync] live sync for ${companyId} skipped: ${err.message}`);
    return null;
  }
}

/** daily-sync-all entry point. */
async function run() {
  const { getSupabaseClient } = require('../../shared/supabaseClient');
  const r = await syncMeetings(getSupabaseClient(), {});
  console.log(`Calendar Meetings — ${r.events} events, ${r.considered} with partner attendees, `
    + `${r.matched} matched (${r.inserted} new, ${r.updated} updated, ${r.cancelled} cancelled${r.linked ? `, ${r.linked} linked as the same call` : ''})`
    + `${r.unmatched.length ? `, ${r.unmatched.length} unmatched` : ''}${r.failed ? `, ${r.failed} failed` : ''}`);
  for (const u of r.unmatched) console.log(`  unmatched: "${u.title}" ${u.starts_at || ''} — ${u.attendees.join(', ')}`);
  for (const e of r.errors) console.warn(`  error: ${e}`);
  return {
    sources: {
      b2b_calendar_meetings: {
        success: r.failed === 0,
        rowsWritten: r.inserted + r.updated + r.cancelled,
        error: r.failed ? r.errors.slice(0, 3).join('; ') : null,
        unmatched: r.unmatched.length,
      },
    },
    status: r.failed ? 'warn' : 'ok',
  };
}

module.exports = {
  normalizeEvent,
  conferenceUrlIn,
  plannedStatus,
  listCalendarEvents,
  matchEventCompanies,
  sameCallSibling,
  syncMeetings,
  syncCompanyMeetings,
  run,
  DEFAULT_DAYS_BACK,
  DEFAULT_DAYS_AHEAD,
};
