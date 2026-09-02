#!/usr/bin/env node
/**
 * OCADU course seat watcher (personal — not a RUBIES system).
 *
 * Watches two specific Fall 2026 sections of ENGL-1003 (The Essay & the
 * Argument) in OCAD University's public course catalog (Ellucian Colleague
 * Self-Service — no login required), and alerts Jamie by email + macOS
 * notification the moment either has a seat.
 *
 * Why these two: his daughter holds ENGL-1003-301G (tutorial Tue 11:50).
 * Every section shares the same Friday 10:00-11:30 lecture; only the
 * tutorial slot differs. 301B (tutorial Mon 3:10-4:40) or 301D (tutorial
 * Fri 3:10-4:40) would free her Tuesday entirely — a seat in either means
 * drop 301G and add it immediately (the swap is not atomic).
 *
 * Notify-only by design: registration stays a manual act in Self-Service.
 * Automating it would require the student's SSO login + authenticator-app
 * MFA on every run, which is fragile and risks the account.
 *
 * Run once per invocation (stateless HTTP handshake each time); launchd
 * re-runs it on an interval. State lives in .state.json next to this file
 * so an open seat alerts once, re-alerts every REALERT_MINUTES while it
 * stays open, and goes quiet when it closes.
 *
 * Usage: node personal/ocadu-watch/watch.js [--dry-run] [--test-alert]
 *   --dry-run: print what would be alerted, send nothing, don't touch state.
 *   --test-alert: pretend every watched section has a seat, to exercise the
 *     alert path/formatting ([TEST] subject). Combine with --dry-run to
 *     only print.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { sendEmail } = require('../../shared/sendgridClient');

const BASE = 'https://selfservice.ocadu.ca/SelfService';
const WATCHED_COURSES = ['ENGL-1003'];
// Only these sections alert. Empty list = all sections of the watched courses.
const WATCHED_SECTIONS = ['ENGL-1003-301B', 'ENGL-1003-301D'];
const WATCHED_TERM = 'Fall 2026';
const ALERT_TO = 'jamie@rubyshines.com';
const REALERT_MINUTES = 30; // while a seat stays open
const FAILURE_ALERT_EVERY = 40; // consecutive failed runs (~2h at 3-min interval)
const STATE_FILE = path.join(__dirname, '.state.json');
// Context lines appended to every alert so the email needs no cross-referencing.
const SWAP_NOTE = [
  'She currently holds ENGL-1003-301G (lecture F 10:00-11:30 + tutorial T 11:50-1:20).',
  'To swap: in Self-Service, DROP 301G and immediately ADD the open section.',
  'The swap is not atomic — only do it while this alert is fresh (minutes old).',
  'Either section frees her Tuesday completely (4-day week).',
].join('\n');

const DRY_RUN = process.argv.includes('--dry-run');
const TEST_ALERT = process.argv.includes('--test-alert');

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { sections: {}, consecutiveFailures: 0 };
  }
}

function saveState(state) {
  if (DRY_RUN || TEST_ALERT) return;
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

/** Minimal cookie jar: the catalog needs the anti-forgery cookie + matching header token. */
async function openSession() {
  const res = await fetch(`${BASE}/Courses`, { redirect: 'follow' });
  if (!res.ok) throw new Error(`catalog page HTTP ${res.status}`);
  const cookies = (res.headers.getSetCookie ? res.headers.getSetCookie() : [])
    .map((c) => c.split(';')[0])
    .join('; ');
  const html = await res.text();
  const m = html.match(/__RequestVerificationToken[^>]*value="([^"]+)"/);
  if (!m) throw new Error('no verification token on catalog page');
  return { cookies, token: m[1] };
}

async function postJson(session, urlPath, body) {
  const res = await fetch(`${BASE}${urlPath}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json, charset=utf-8',
      '__RequestVerificationToken': session.token,
      'X-Requested-With': 'XMLHttpRequest',
      Cookie: session.cookies,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${urlPath} HTTP ${res.status}`);
  return res.json();
}

/** One line per meeting: "Lecture: F 10:00 a.m.-11:30 a.m. — Main Building / Sharp Centre 190" */
function meetingLines(section) {
  const meetings = section.FormattedMeetingTimes || section.PlannedMeetingTimes || [];
  return meetings.map((mt) => {
    const kind = mt.InstructionalMethodDisplay || 'Meeting';
    const when = `${mt.DaysOfWeekDisplay || ''} ${mt.StartTimeDisplay || ''}-${mt.EndTimeDisplay || ''}`.trim();
    const where = `${mt.BuildingDisplay || ''} ${mt.RoomDisplay || ''}`.trim();
    return `${kind}: ${when}${where ? ` — ${where}` : ''}`;
  });
}

/**
 * Instructor names with their roles, from the SectionDetails endpoint
 * (the sections list itself carries no instructor data). Fail-soft: an
 * alert must never be lost because the details call hiccuped.
 */
async function fetchInstructorLines(session, sectionId) {
  try {
    const d = await postJson(session, '/Courses/SectionDetails', { sectionId });
    let items = [];
    let faculty = [];
    (function dig(o) {
      if (Array.isArray(o)) { o.forEach(dig); return; }
      if (o && typeof o === 'object') {
        if (Array.isArray(o.InstructorItems) && o.InstructorItems.length) items = o.InstructorItems;
        if (Array.isArray(o.Faculty) && o.Faculty.length) faculty = o.Faculty;
        Object.values(o).forEach(dig);
      }
    })(d);
    if (!items.length) return ['Instructors: not yet listed'];
    // Faculty rows repeat one per instructional method; unique ids appear in
    // the same order as InstructorItems names. Pair them to recover roles.
    const uniqueIds = [...new Set(faculty.map((f) => f.FacultyId))];
    const roles = {};
    for (const f of faculty) {
      (roles[f.FacultyId] = roles[f.FacultyId] || []).push(
        f.InstructionalMethodCode === 'LEC' ? 'Lecture' : f.InstructionalMethodCode === 'TUT' ? 'Tutorial' : f.InstructionalMethodCode
      );
    }
    const named = items.map((it, i) => {
      const role = roles[uniqueIds[i]];
      return role ? `${it.Name} (${role.join(', ')})` : it.Name;
    });
    return [`Instructors: ${named.join('; ')}`];
  } catch (err) {
    return [`Instructors: lookup failed (${err.message})`];
  }
}

/** Fetch watched-term sections for one course code, e.g. "ENGL-1003". */
async function fetchCourseSections(session, courseCode) {
  const [subject, number] = courseCode.split('-');
  const search = await postJson(session, '/Courses/PostSearchCriteria', {
    keyword: courseCode,
    pageNumber: 1,
    quantityPerPage: 30,
  });
  const course = (search.Courses || []).find(
    (c) => c.SubjectCode === subject && c.Number === number
  );
  if (!course) return [];
  const sectionIds = course.MatchingSectionIds || [];
  if (!sectionIds.length) return [];
  const data = await postJson(session, '/Courses/Sections', {
    courseId: course.Id,
    sectionIds,
  });
  const out = [];
  for (const term of data.SectionsRetrieved?.TermsAndSections || []) {
    const termName = term.Term?.Description || '';
    if (termName !== WATCHED_TERM) continue;
    for (const wrapper of term.Sections || []) {
      const s = wrapper.Section || wrapper;
      const key = s.SectionNameDisplay || `${courseCode}-${s.Number}`;
      if (WATCHED_SECTIONS.length && !WATCHED_SECTIONS.includes(key)) continue;
      out.push({
        key,
        sectionId: s.Id,
        course: courseCode,
        term: termName,
        available: s.Available ?? 0,
        capacity: s.Capacity ?? 0,
        waitlisted: s.Waitlisted ?? 0,
        meetingLines: meetingLines(s),
        datesDisplay: `${s.StartDateDisplay || ''} - ${s.EndDateDisplay || ''}`,
      });
    }
  }
  return out;
}

function macNotify(title, message) {
  if (DRY_RUN || process.platform !== 'darwin') return;
  execFile('osascript', [
    '-e',
    `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)} sound name "Glass"`,
  ], () => {});
}

async function alert(session, openSections) {
  const blocks = [];
  for (const s of openSections) {
    const wl = s.waitlisted > 0 ? ` (waitlist ${s.waitlisted} — seat may go to waitlist first)` : '';
    const instructorLines = await fetchInstructorLines(session, s.sectionId);
    blocks.push([
      `${s.key} — ${s.available} seat${s.available === 1 ? '' : 's'} open of ${s.capacity}${wl}`,
      ...s.meetingLines.map((l) => `  ${l}`),
      ...instructorLines.map((l) => `  ${l}`),
      `  Runs: ${s.datesDisplay}`,
    ].join('\n'));
  }
  const testTag = TEST_ALERT ? '[TEST] ' : '';
  const subject = `${testTag}OCADU seat open — ENGL swap: ${openSections.map((s) => s.key).join(', ')}`;
  const text = [
    `Open seat in a watched ${WATCHED_TERM} section:`,
    '',
    blocks.join('\n\n'),
    '',
    SWAP_NOTE,
    '',
    'Register: https://selfservice.ocadu.ca/SelfService/Planning/DegreePlans',
    `(Checked ${new Date().toLocaleString('en-CA', { timeZone: 'America/Toronto' })} ET)`,
  ].join('\n');

  if (DRY_RUN) {
    console.log(`[dry-run] would alert:\nSubject: ${subject}\n\n${text}`);
    return;
  }
  const result = await sendEmail({ to: ALERT_TO, subject, text, fromName: 'OCADU Watch' });
  if (!result.ok) console.error(`email send failed: ${result.error || result.statusCode}`);
  macNotify(`${testTag}OCADU seat open — swap now`, openSections.map((s) => `${s.key} (${s.available})`).join(', '));
}

async function main() {
  const state = loadState();
  let session;
  let sections;
  try {
    session = await openSession();
    sections = [];
    for (const code of WATCHED_COURSES) {
      sections.push(...(await fetchCourseSections(session, code)));
    }
  } catch (err) {
    // The site 503s from time to time — stay quiet unless it's been down a while.
    state.consecutiveFailures = (state.consecutiveFailures || 0) + 1;
    console.error(`fetch failed (${state.consecutiveFailures} in a row): ${err.message}`);
    if (state.consecutiveFailures % FAILURE_ALERT_EVERY === 0 && !DRY_RUN) {
      await sendEmail({
        to: ALERT_TO,
        subject: 'OCADU watch: catalog unreachable',
        text: `The seat watcher has failed ${state.consecutiveFailures} runs in a row. Last error: ${err.message}`,
        fromName: 'OCADU Watch',
      });
    }
    saveState(state);
    process.exitCode = 1;
    return;
  }
  state.consecutiveFailures = 0;

  const now = Date.now();
  const toAlert = [];
  for (const s of sections) {
    if (TEST_ALERT) { toAlert.push(s); continue; }
    const prev = state.sections[s.key] || {};
    const opened = s.available > 0 && !(prev.available > 0);
    const stillOpenAndDue =
      s.available > 0 && prev.available > 0 &&
      now - (prev.lastAlertedAt || 0) >= REALERT_MINUTES * 60 * 1000;
    if (opened || stillOpenAndDue) toAlert.push(s);
    state.sections[s.key] = {
      available: s.available,
      lastAlertedAt: opened || stillOpenAndDue ? now : prev.lastAlertedAt || 0,
      lastSeenAt: now,
    };
  }

  const summary = sections
    .map((s) => `${s.key} ${s.available}/${s.capacity}`)
    .join(' | ');
  console.log(`[${new Date().toISOString()}] watching ${sections.length} ${WATCHED_TERM} sections: ${summary}`);

  if (toAlert.length) await alert(session, toAlert);
  saveState(state);
}

main().catch((err) => {
  console.error(`unexpected failure: ${err.stack || err.message}`);
  process.exitCode = 1;
});
