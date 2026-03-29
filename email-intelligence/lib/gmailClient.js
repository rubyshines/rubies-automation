/**
 * Gmail OAuth2 Client
 *
 * Reuses credentials from rubies-utilities/creds/.
 * Tokens are read from the file initially, then auto-refreshed via googleapis.
 *
 * Usage:
 *   const { getGmail } = require('./gmailClient');
 *   const gmail = await getGmail();
 *   const profile = await gmail.users.getProfile({ userId: 'me' });
 */

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const UTILITIES_ROOT = path.join(__dirname, '..', '..', '..', 'rubies-utilities');
const GMAIL_CREDENTIALS_PATH = process.env.GMAIL_CREDENTIALS_PATH
  || path.join(UTILITIES_ROOT, 'creds', 'gmail-credentials.json');
const GMAIL_TOKEN_PATH = process.env.GMAIL_TOKEN_PATH
  || path.join(UTILITIES_ROOT, 'creds', 'gmail-token.json');

const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];

let cachedClient = null;

async function getGmail() {
  if (cachedClient) return cachedClient;

  if (!fs.existsSync(GMAIL_CREDENTIALS_PATH)) {
    throw new Error(
      `Gmail credentials not found at ${GMAIL_CREDENTIALS_PATH}\n` +
      'Set GMAIL_CREDENTIALS_PATH env var or ensure rubies-utilities/creds/gmail-credentials.json exists'
    );
  }
  if (!fs.existsSync(GMAIL_TOKEN_PATH)) {
    throw new Error(
      `Gmail token not found at ${GMAIL_TOKEN_PATH}\n` +
      'Run the auth flow in rubies-utilities first, or set GMAIL_TOKEN_PATH'
    );
  }

  const credentials = JSON.parse(fs.readFileSync(GMAIL_CREDENTIALS_PATH));
  const { client_id, client_secret, redirect_uris } = credentials.installed;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

  const token = JSON.parse(fs.readFileSync(GMAIL_TOKEN_PATH));
  oAuth2Client.setCredentials(token);

  // Auto-save refreshed tokens back to the file
  oAuth2Client.on('tokens', (newTokens) => {
    const merged = { ...token, ...newTokens };
    fs.writeFileSync(GMAIL_TOKEN_PATH, JSON.stringify(merged, null, 2));
  });

  cachedClient = google.gmail({ version: 'v1', auth: oAuth2Client });
  return cachedClient;
}

module.exports = { getGmail };
