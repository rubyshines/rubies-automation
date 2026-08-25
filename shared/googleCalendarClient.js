/**
 * googleCalendarClient.js — Google Calendar OAuth2 client.
 *
 * DELIBERATELY SEPARATE FROM THE GMAIL TOKEN. The Gmail token is scoped
 * `gmail.modify` and is what CS intake and every outbound B2B email run on.
 * Re-minting it with calendar scopes risks coming back without gmail.modify,
 * which would break intake silently. So calendar gets its own token file /
 * env var and gmailClient.js is never touched.
 *
 * Credentials (the OAuth *app*) are shared with Gmail — same Google Cloud
 * project, same client_id — only the token differs.
 *
 * Usage:
 *   const { getCalendar, BUSY_CALENDAR_IDS } = require('./googleCalendarClient');
 *   const cal = await getCalendar();
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

/**
 * Walk UP looking for a directory, rather than counting `..` segments. A fixed
 * depth is wrong in a git worktree — the tree sits at `<repo>/worktrees/<name>/`,
 * two levels deeper than the main checkout, so a hardcoded `../../` silently
 * resolves somewhere that does not exist. (This is why the first run of this
 * client reported missing credentials that were in fact present.)
 */
function findUpward(name, { file = false } = {}) {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate) && (file || fs.statSync(candidate).isDirectory())) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Repo root = wherever package.json lives above us. */
const REPO_ROOT = (() => {
  const pkg = findUpward('package.json', { file: true });
  return pkg ? path.dirname(pkg) : path.join(__dirname, '..');
})();

/**
 * Where the token lives.
 *
 * `rubies-utilities/creds/` is the house convention and wins when that checkout
 * is present. It is absent on this machine, which runs entirely from env vars,
 * so there is a fallback — and the fallback must NOT be the current working
 * tree: every code session happens in a git worktree that gets deleted when the
 * branch lands, which would take the token with it.
 *
 * So it follows `.env`, which worktrees symlink back to the main checkout. That
 * puts the token beside the secrets it belongs with, shared by every worktree,
 * and surviving `git worktree remove`.
 */
const UTILITIES_CREDS = findUpward('rubies-utilities');
const SHARED_ROOT = (() => {
  const envFile = findUpward('.env', { file: true });
  if (!envFile) return REPO_ROOT;
  try {
    return path.dirname(fs.realpathSync(envFile)); // resolves the worktree symlink
  } catch {
    return REPO_ROOT;
  }
})();
const CREDS_DIR = process.env.GOOGLE_CALENDAR_CREDS_DIR
  || (UTILITIES_CREDS ? path.join(UTILITIES_CREDS, 'creds') : path.join(SHARED_ROOT, '.creds'));

const CREDENTIALS_PATH = process.env.GOOGLE_CALENDAR_CREDENTIALS_PATH
  || process.env.GMAIL_CREDENTIALS_PATH
  || path.join(CREDS_DIR, 'gmail-credentials.json');
const TOKEN_PATH = process.env.GOOGLE_CALENDAR_TOKEN_PATH
  || path.join(CREDS_DIR, 'calendar-token.json');

// calendar.events to create the meeting, calendar.readonly for freebusy.
const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
];

/**
 * The calendars that count as BUSY. Verified 2026-08-20: all three are on one
 * calendar list and all three report America/Toronto.
 *
 * Overlaying a calendar in the Google UI is NOT the same as freebusy seeing it —
 * `freebusy.query` returns only the IDs you ask for. A calendar missing from
 * this list contributes no busy blocks and produces a confidently empty answer,
 * so `assertCalendarsResolve` exists to make that loud instead of silent.
 */
const BUSY_CALENDAR_IDS = (process.env.BUSY_CALENDAR_IDS
  || 'jamie@rubyshines.com,iamjamiealexander@gmail.com,jamie@bridgecard.app')
  .split(',').map(s => s.trim()).filter(Boolean);

/** Events here grey a day rather than blocking it — a holiday is a hint, not a rule. */
const HOLIDAY_CALENDAR_ID = process.env.HOLIDAY_CALENDAR_ID
  || 'en.canadian#holiday@group.v.calendar.google.com';

/** The calendar the meeting is CREATED on. Always the RUBIES identity. */
const ORGANIZER_CALENDAR_ID = process.env.ORGANIZER_CALENDAR_ID || 'jamie@rubyshines.com';

/** All three calendars report America/Toronto, so this is their native zone. */
const BUSINESS_TIMEZONE = 'America/Toronto';

let cachedClient = null;

/**
 * The OAuth *app* credentials — shared with Gmail, same Google Cloud project.
 * Resolved INDEPENDENTLY of the token: this machine holds credentials in
 * GMAIL_CREDENTIALS_JSON while the calendar token is still a local file, and an
 * all-or-nothing env check made that combination unloadable.
 */
function loadCredentials() {
  const raw = process.env.GOOGLE_CALENDAR_CREDENTIALS_JSON || process.env.GMAIL_CREDENTIALS_JSON;
  if (raw) return JSON.parse(raw);
  if (fs.existsSync(CREDENTIALS_PATH)) return JSON.parse(fs.readFileSync(CREDENTIALS_PATH));
  throw new Error(
    `Google OAuth credentials not found.\n`
    + `Looked for GMAIL_CREDENTIALS_JSON / GOOGLE_CALENDAR_CREDENTIALS_JSON in the environment, `
    + `and a file at ${CREDENTIALS_PATH}.`
  );
}

/** The calendar token. Never the Gmail one. */
function loadToken() {
  if (process.env.GOOGLE_CALENDAR_TOKEN_JSON) {
    return { token: JSON.parse(process.env.GOOGLE_CALENDAR_TOKEN_JSON), fromEnv: true };
  }
  if (fs.existsSync(TOKEN_PATH)) {
    return { token: JSON.parse(fs.readFileSync(TOKEN_PATH)), fromEnv: false };
  }
  throw new Error(
    `Calendar access is not set up yet — no token found.\n`
    + `Run:  node scripts/authGoogleCalendar.js\n`
    + `(Looked for GOOGLE_CALENDAR_TOKEN_JSON in the environment and a file at ${TOKEN_PATH}. `
    + `This is a SEPARATE token from the Gmail one — do not reuse gmail-token.json.)`
  );
}

function loadAuthMaterial() {
  const credentials = loadCredentials();
  const { token, fromEnv } = loadToken();
  return { credentials, token, fromEnv };
}

async function getCalendar() {
  if (cachedClient) return cachedClient;

  const { credentials, token, fromEnv } = loadAuthMaterial();
  const app = credentials.installed || credentials.web;
  if (!app) throw new Error('OAuth credentials JSON has neither an "installed" nor a "web" client');
  const { client_id, client_secret, redirect_uris } = app;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
  oAuth2Client.setCredentials(token);

  if (!fromEnv) {
    oAuth2Client.on('tokens', (newTokens) => {
      const merged = { ...token, ...newTokens };
      fs.writeFileSync(TOKEN_PATH, JSON.stringify(merged, null, 2));
    });
  }

  cachedClient = google.calendar({ version: 'v3', auth: oAuth2Client });
  return cachedClient;
}

/**
 * Confirm every calendar we intend to treat as busy is actually reachable by
 * THIS token. Re-authing from a different Google identity silently drops the
 * two non-RUBIES calendars from the list, and freebusy would then report those
 * hours as free — the exact silent-wrong-answer failure this codebase keeps
 * relearning. Throws with the missing IDs named.
 */
async function assertCalendarsResolve(calendarIds = BUSY_CALENDAR_IDS) {
  const cal = await getCalendar();
  const seen = new Set();
  let pageToken;
  do {
    const res = await cal.calendarList.list({ maxResults: 250, pageToken });
    for (const item of res.data.items || []) seen.add(item.id);
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  const missing = calendarIds.filter(id => !seen.has(id));
  if (missing.length) {
    throw new Error(
      `Calendar(s) not on this token's calendar list: ${missing.join(', ')}.\n`
      + `Visible: ${[...seen].join(', ') || '(none)'}\n`
      + 'The token was probably minted from the wrong Google account. Busy times '
      + 'from a missing calendar would be invisible, so this fails rather than guessing.'
    );
  }
  return { ok: true, calendars: calendarIds };
}

module.exports = {
  getCalendar,
  assertCalendarsResolve,
  loadCredentials,
  loadToken,
  BUSY_CALENDAR_IDS,
  HOLIDAY_CALENDAR_ID,
  ORGANIZER_CALENDAR_ID,
  BUSINESS_TIMEZONE,
  SCOPES,
  TOKEN_PATH,
  CREDENTIALS_PATH,
};
