/**
 * meetingNotes.js — a call's notes arrive by themselves.
 *
 * Jamie records partner calls with Wispr Flow Notetaker. This module finds the
 * recording for a `b2b_meetings` row, stores the summary (and transcript, and
 * the link to the notes page) on the row, marks the call held, and turns the
 * summary's Next Steps into commitments — mine and theirs — on the list
 * (commitments.js). Then the relationship recap is rebuilt so it knows a call
 * happened and what was agreed.
 *
 * Two triggers, one function (2026-09-10):
 *   - nightly in daily-sync-all, for every call in the last week with no notes;
 *   - the moment the operator marks a call Held (scheduleMeeting.recordMeetingOutcome),
 *     so the notes are on the company before the post-call email is written.
 *
 * Finding the recording: Wispr keys a recording on the Google event id when the
 * Notetaker joined from the calendar, so that lookup is tried first — on every
 * event id the row knows (our Book & Send event and a partner's own invite for
 * the same call are two ids, see meetingSync's dedupe). A recording Jamie
 * started by hand has no calendar link (Stand with Trans, 2026-09-10), so the
 * fallback is deterministic: a recording whose start is within 45 minutes of
 * the call's and whose title names the company.
 *
 * A recording is proof the call happened, so `outcome` becomes held when it was
 * unrecorded. Absence proves nothing — a recording Jamie forgot to start is not
 * a no-show — and an operator-recorded no-show is never overwritten: the notes
 * are stored and the conflict is reported.
 *
 * Only the summary ever reaches an AI context. The transcript is kept on the
 * row for the human.
 */
const C = require('./commitments');

const DEFAULT_DAYS_BACK = 7;
const MATCH_WINDOW_MS = 45 * 60 * 1000;
const STOP = new Set(['the', 'and', 'with', 'for', 'centre', 'center', 'group', 'community', 'society', 'inc', 'org', 'organization', 'foundation', 'meeting', 'call', 'rubies']);

/** The words of a company name worth matching a title on. PURE. */
function nameTokens(name) {
  return C.normalizeText(name).split(' ').filter(w => w.length >= 4 && !STOP.has(w));
}

/** Does a recording title name this company? PURE. "Standing With Trans" names "Stand with Trans". */
function titleMatchesCompany(title, companyName) {
  const t = C.normalizeText(title);
  if (!t) return false;
  return nameTokens(companyName).some(tok => t.includes(tok));
}

/**
 * Pick the recording for a call from a list of candidates. PURE.
 * Within 45 minutes of the call's start and titled for the company; the
 * closest start wins. Null when nothing qualifies.
 */
function matchRecording(row, companyName, candidates) {
  const start = new Date(row.starts_at).getTime();
  let best = null;
  for (const c of candidates || []) {
    if (!c || !c.start) continue;
    const diff = Math.abs(new Date(c.start).getTime() - start);
    if (diff > MATCH_WINDOW_MS) continue;
    if (!titleMatchesCompany(c.title, companyName)) continue;
    if (!best || diff < best.diff) best = { meeting: c, diff };
  }
  return best ? best.meeting : null;
}

/** Every calendar event id a row knows for this call. PURE. */
function eventIds(row) {
  return [...new Set([row.google_event_id, ...(row.linked_event_ids || [])].filter(Boolean))];
}

async function findRecording(row, companyName, { wispr }) {
  for (const id of eventIds(row)) {
    const m = await wispr.meetingByCalendarId(id);
    if (m) return { meeting: m, matched_by: 'calendar' };
  }
  const start = new Date(row.starts_at);
  const list = await wispr.searchMeetings({ since: new Date(start.getTime() - 86400000).toISOString(), limit: 50 });
  const hit = matchRecording(row, companyName, list);
  if (!hit) return null;
  const full = await wispr.getMeeting(hit.id);
  return { meeting: full || hit, matched_by: 'time_title' };
}

/**
 * Write notes onto a meeting row and lift its commitments. Shared by the
 * automatic path (a recording from Wispr) and the manual fallback (a session
 * hands in the summary). `notes` = { summary, share_link, transcript,
 * wispr_meeting_id, commitments? }.
 */
async function recordMeetingNotes(sb, { row, notes, now = new Date(), refreshSummary = true } = {}) {
  const stamp = now.toISOString();
  const summary = notes.summary || null;
  const patch = {
    summary,
    transcript: notes.transcript || null,
    wispr_meeting_id: notes.wispr_meeting_id || null,
    wispr_share_link: notes.share_link || null,
    notes_fetched_at: stamp,
    updated_at: stamp,
  };
  const heldNow = !row.outcome;
  if (heldNow) { patch.outcome = 'held'; patch.outcome_at = stamp; }
  const { error } = await sb.from('b2b_meetings').update(patch).eq('id', row.id);
  if (error) throw new Error(`meeting notes write: ${error.message}`);

  // The action items. Parsed from the summary's Next Steps unless the caller
  // hands in an explicit list (the manual fallback, or a session that read the
  // transcript and knows better).
  const items = Array.isArray(notes.commitments) && notes.commitments.length
    ? notes.commitments.map(c => ({ owner: c.owner === 'us' ? 'me' : (c.owner || 'them'), text: c.text, due_on: c.due_on || null }))
    // Theirs keep the person's name in the text ("Dion: intro Jamie to
    // Affirmations"): on a list of things you are waiting on, who is the point.
    : C.parseNextSteps(summary).map(i => ({
      owner: i.owner,
      text: i.owner === 'them' && i.owner_name ? `${i.owner_name}: ${i.text}` : i.text,
    }));
  const up = items.length
    ? await C.upsertCommitments(sb, { company_id: row.company_id, meeting_id: row.id, items, source: 'meeting', created_by: 'engine', now })
    : { inserted: [], matched: [] };

  if (refreshSummary) {
    try {
      await require('./relationshipSummary').refreshCompanySummary(sb, row.company_id, { force: true, now });
    } catch (err) {
      console.warn(`[meetingNotes] recap refresh for ${row.company_id} skipped: ${err.message}`);
    }
  }
  return {
    held: heldNow,
    conflict: row.outcome === 'no_show',
    commitments: { added: up.inserted.length, matched: up.matched.length, items: up.inserted },
  };
}

async function loadRow(sb, meetingId) {
  const { data: row, error } = await sb.from('b2b_meetings').select('*').eq('id', meetingId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!row) throw new Error(`meeting #${meetingId} not found`);
  return row;
}

/**
 * Fetch and store one call's notes from Wispr.
 *
 * @returns {{ status: 'ingested'|'already'|'no_recording'|'not_connected'|'cancelled', ... }}
 */
async function ingestMeetingNotes(sb, { meeting_id, force = false, now = new Date(), wispr = require('./wisprClient'), refreshSummary = true } = {}) {
  const row = await loadRow(sb, meeting_id);
  if (row.status === 'cancelled') return { status: 'cancelled', meeting_id: row.id };
  if (row.summary && !force) return { status: 'already', meeting_id: row.id, company_id: row.company_id };
  if (!(await wispr.isConfigured())) return { status: 'not_connected', meeting_id: row.id, company_id: row.company_id };

  const { data: company } = await sb.from('b2b_companies').select('id, name').eq('id', row.company_id).maybeSingle();
  const found = await findRecording(row, company?.name || '', { wispr });
  if (!found) return { status: 'no_recording', meeting_id: row.id, company_id: row.company_id, title: row.title };

  const m = found.meeting;
  let transcript = null;
  if (m.has_transcript) {
    try {
      const full = await wispr.getMeeting(m.id, { transcript: true });
      transcript = full?.transcript || null;
    } catch (err) {
      console.warn(`[meetingNotes] transcript for meeting #${row.id} skipped: ${err.message}`);
    }
  }
  const r = await recordMeetingNotes(sb, {
    row, now, refreshSummary,
    notes: { summary: m.summary || m.content || null, share_link: m.share_link || null, transcript, wispr_meeting_id: m.id },
  });
  return {
    status: 'ingested', meeting_id: row.id, company_id: row.company_id, title: row.title,
    matched_by: found.matched_by, wispr_meeting_id: m.id, share_link: m.share_link || null, ...r,
  };
}

/** Every call in the window with no notes yet. The nightly pass. */
async function ingestRecentNotes(sb, { now = new Date(), daysBack = DEFAULT_DAYS_BACK, limit = 25, wispr = require('./wisprClient') } = {}) {
  const result = { considered: 0, ingested: 0, no_recording: 0, already: 0, failed: 0, errors: [], rows: [] };
  if (!(await wispr.isConfigured())) return { ...result, skipped: 'Wispr is not connected (run scripts/authWispr.js, set WISPR_TOKEN_JSON)' };
  const { data: rows, error } = await sb.from('b2b_meetings')
    .select('id, company_id, title, starts_at, status, outcome, summary')
    .gte('starts_at', new Date(now.getTime() - daysBack * 86400000).toISOString())
    .lte('starts_at', now.toISOString())
    .neq('status', 'cancelled').is('summary', null)
    .order('starts_at', { ascending: true }).limit(limit);
  if (error) throw new Error(error.message);
  for (const r of rows || []) {
    result.considered++;
    try {
      const out = await ingestMeetingNotes(sb, { meeting_id: r.id, now, wispr });
      result.rows.push(out);
      if (out.status === 'ingested') result.ingested++;
      else if (out.status === 'already') result.already++;
      else result.no_recording++;
    } catch (err) {
      result.failed++;
      result.errors.push(`#${r.id} ${r.title}: ${err.message}`);
    }
  }
  return result;
}

/** daily-sync-all entry point. Fail-soft: notes are never worth failing a sync over. */
async function run() {
  const { getSupabaseClient } = require('../../shared/supabaseClient');
  const r = await ingestRecentNotes(getSupabaseClient(), {});
  if (r.skipped) {
    console.log(`Meeting Notes — skipped: ${r.skipped}`);
    return { sources: { b2b_meeting_notes: { success: true, rowsWritten: 0, skipped: r.skipped } }, status: 'warn' };
  }
  console.log(`Meeting Notes — ${r.considered} calls without notes, ${r.ingested} fetched, ${r.no_recording} with no recording yet${r.failed ? `, ${r.failed} failed` : ''}`);
  for (const row of r.rows) {
    if (row.status === 'ingested') console.log(`  ${row.company_id}: "${row.title}" — ${row.commitments.added} commitment(s) added (${row.matched_by})`);
  }
  for (const e of r.errors) console.warn(`  error: ${e}`);
  return {
    sources: { b2b_meeting_notes: { success: r.failed === 0, rowsWritten: r.ingested, error: r.failed ? r.errors.slice(0, 3).join('; ') : null, no_recording: r.no_recording } },
    status: r.failed ? 'warn' : 'ok',
  };
}

module.exports = {
  MATCH_WINDOW_MS, nameTokens, titleMatchesCompany, matchRecording, eventIds,
  findRecording, recordMeetingNotes, ingestMeetingNotes, ingestRecentNotes, run,
};
