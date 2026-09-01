#!/usr/bin/env node
/**
 * OCADU course seat watcher (personal — not a RUBIES system).
 *
 * Polls OCAD University's public course catalog (Ellucian Colleague
 * Self-Service — no login required) for open seats in the courses below,
 * and alerts Jamie by email + macOS notification the moment a watched
 * Fall-term section has seats available.
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
 * Usage: node personal/ocadu-watch/watch.js [--dry-run]
 *   --dry-run: print what would be alerted, send nothing, don't touch state.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { sendEmail } = require('../../shared/sendgridClient');

const BASE = 'https://selfservice.ocadu.ca/SelfService';
const WATCHED_COURSES = ['ENGL-1003', 'IVCV-1001', 'VISC-1001', 'VISC-1002', 'VISC-1004', 'GART-1025'];
const WATCHED_TERM = 'Fall 2026';
const ALERT_TO = 'jamie@rubyshines.com';
const REALERT_MINUTES = 30; // while a seat stays open
const FAILURE_ALERT_EVERY = 40; // consecutive failed runs (~2h at 3-min interval)
const STATE_FILE = path.join(__dirname, '.state.json');

const DRY_RUN = process.argv.includes('--dry-run');

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { sections: {}, consecutiveFailures: 0 };
  }
}

function saveState(state) {
  if (DRY_RUN) return;
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

function parseTimeToMinutes(display) {
  // "3:10 p.m." / "10:00 a.m." -> minutes since midnight; null if unparseable
  const m = String(display || '').match(/(\d{1,2}):(\d{2})\s*([ap])/i);
  if (!m) return null;
  let h = Number(m[1]) % 12;
  if (m[3].toLowerCase() === 'p') h += 12;
  return h * 60 + Number(m[2]);
}

function describeMeetings(section) {
  const meetings = section.FormattedMeetingTimes || section.PlannedMeetingTimes || [];
  const parts = [];
  let isEvening = false;
  for (const mt of meetings) {
    const start = mt.StartTimeDisplay || '';
    const end = mt.EndTimeDisplay || '';
    const days = mt.DaysOfWeekDisplay || '';
    if (!days && !start) continue;
    parts.push(`${days} ${start}-${end}`.trim());
    const startMin = parseTimeToMinutes(start);
    if (startMin !== null && startMin >= 17 * 60) isEvening = true;
  }
  return { text: parts.join('; ') || 'no meeting times listed', isEvening };
}

/** Fetch all watched-term sections for one course code, e.g. "ENGL-1003". */
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
      const { text: meetingText, isEvening } = describeMeetings(s);
      out.push({
        key: s.SectionNameDisplay || `${courseCode}-${s.Number}`,
        course: courseCode,
        term: termName,
        available: s.Available ?? 0,
        capacity: s.Capacity ?? 0,
        waitlisted: s.Waitlisted ?? 0,
        meetingText,
        isEvening,
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

async function alert(openSections) {
  const lines = openSections.map((s) => {
    const evening = s.isEvening ? ' [EVENING]' : '';
    const wl = s.waitlisted > 0 ? ` (waitlist ${s.waitlisted} — seat may go to waitlist first)` : '';
    return `${s.key}: ${s.available} seat${s.available === 1 ? '' : 's'} of ${s.capacity} — ${s.meetingText}${evening}${wl}`;
  });
  const subject = `OCADU seat open (${WATCHED_TERM}): ${openSections.map((s) => s.key).join(', ')}`;
  const text = [
    `Open seats detected in watched ${WATCHED_TERM} sections:`,
    '',
    ...lines,
    '',
    'Register now: https://selfservice.ocadu.ca/SelfService/Planning/DegreePlans',
    `(Checked ${new Date().toLocaleString('en-CA', { timeZone: 'America/Toronto' })} ET)`,
  ].join('\n');

  if (DRY_RUN) {
    console.log(`[dry-run] would alert:\n${subject}\n${text}`);
    return;
  }
  const result = await sendEmail({ to: ALERT_TO, subject, text, fromName: 'OCADU Watch' });
  if (!result.ok) console.error(`email send failed: ${result.error || result.statusCode}`);
  macNotify('OCADU seat open', openSections.map((s) => `${s.key} (${s.available})`).join(', '));
}

async function main() {
  const state = loadState();
  let sections;
  try {
    const session = await openSession();
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
    .map((s) => `${s.key} ${s.available}/${s.capacity}${s.isEvening ? ' (eve)' : ''}`)
    .join(' | ');
  console.log(`[${new Date().toISOString()}] ${sections.length} ${WATCHED_TERM} sections: ${summary}`);

  if (toAlert.length) await alert(toAlert);
  saveState(state);
}

main().catch((err) => {
  console.error(`unexpected failure: ${err.stack || err.message}`);
  process.exitCode = 1;
});
