#!/usr/bin/env node
/**
 * authGoogleCalendar.js — mint the Google Calendar OAuth token.
 *
 * ONE-TIME SETUP. Run:  node scripts/authGoogleCalendar.js
 *
 * This writes a token that is SEPARATE from the Gmail one. It must be, because
 * the Gmail token carries `gmail.modify` and is what CS intake and every
 * outbound B2B email depend on — re-minting that token with calendar scopes
 * risks it coming back without gmail.modify and breaking intake silently.
 * Nothing here reads or writes gmail-token.json.
 *
 * Sign in as the Google account that owns the calendar list containing all
 * three calendars. Signing in as a different identity produces a token that
 * cannot see two of them, and the script verifies exactly that before finishing.
 *
 * Afterwards, for Railway: print the token as one line with --print-env and set
 * it as GOOGLE_CALENDAR_TOKEN_JSON.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { google } = require('googleapis');
const {
  SCOPES, TOKEN_PATH, BUSY_CALENDAR_IDS, loadCredentials,
} = require('../shared/googleCalendarClient');

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, a => { rl.close(); resolve(a.trim()); }));
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--print-env')) {
    if (!fs.existsSync(TOKEN_PATH)) {
      console.error(`No token at ${TOKEN_PATH}. Run without --print-env first.`);
      process.exit(1);
    }
    console.log('GOOGLE_CALENDAR_TOKEN_JSON=' + JSON.stringify(JSON.parse(fs.readFileSync(TOKEN_PATH))));
    return;
  }

  if (fs.existsSync(TOKEN_PATH) && !args.includes('--force')) {
    console.log(`A calendar token already exists at ${TOKEN_PATH}.`);
    console.log('Re-run with --force to replace it, or --print-env to print it for Railway.');
    return;
  }

  const credentials = loadCredentials();
  const app = credentials.installed || credentials.web;
  const oAuth2Client = new google.auth.OAuth2(app.client_id, app.client_secret, app.redirect_uris[0]);

  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent', // force a refresh_token even on a re-auth
    scope: SCOPES,
  });

  console.log('\nSign in as the account that owns all three calendars:');
  console.log(`  ${BUSY_CALENDAR_IDS.join('\n  ')}\n`);
  console.log('Authorize calendar access by visiting this URL:\n');
  console.log(authUrl);
  console.log('\nThen paste the code below.\n');

  const code = await ask('Enter the code: ');
  const { tokens } = await oAuth2Client.getToken(code);
  oAuth2Client.setCredentials(tokens);

  if (!tokens.refresh_token) {
    console.warn('\n⚠️  No refresh_token returned — the token will expire in an hour.');
    console.warn('   Re-run with --force to retry (prompt=consent should produce one).');
  }

  fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true });
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
  console.log(`\nToken written to ${TOKEN_PATH}`);

  // Verify the identity is the right one BEFORE declaring success — a token
  // that cannot see two of the calendars would report those hours as free.
  const cal = google.calendar({ version: 'v3', auth: oAuth2Client });
  const seen = new Set();
  let pageToken;
  do {
    const res = await cal.calendarList.list({ maxResults: 250, pageToken });
    for (const item of res.data.items || []) seen.add(item.id);
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  const missing = BUSY_CALENDAR_IDS.filter(id => !seen.has(id));
  console.log('\nCalendars visible to this token:');
  for (const id of seen) console.log(`  ${BUSY_CALENDAR_IDS.includes(id) ? '✓' : ' '} ${id}`);

  if (missing.length) {
    console.error(`\n❌ Missing: ${missing.join(', ')}`);
    console.error('   You signed in as the wrong Google account, or those calendars are not');
    console.error('   on its calendar list. Busy times from a missing calendar are INVISIBLE.');
    console.error('   Re-run with --force and sign in as the right account.');
    process.exit(1);
  }

  console.log('\n✅ All three calendars resolve. Calendar access is ready.');
  console.log('   For Railway: node scripts/authGoogleCalendar.js --print-env');
}

main().catch(e => { console.error(e.message); process.exit(1); });
