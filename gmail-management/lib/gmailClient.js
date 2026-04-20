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

const SCOPES = ['https://www.googleapis.com/auth/gmail.modify'];

let cachedClient = null;

async function getGmail() {
  if (cachedClient) return cachedClient;

  let credentials, token;

  // Support env vars for Railway deployment (no local files available)
  if (process.env.GMAIL_CREDENTIALS_JSON && process.env.GMAIL_TOKEN_JSON) {
    credentials = JSON.parse(process.env.GMAIL_CREDENTIALS_JSON);
    token = JSON.parse(process.env.GMAIL_TOKEN_JSON);
  } else {
    if (!fs.existsSync(GMAIL_CREDENTIALS_PATH)) {
      throw new Error(
        `Gmail credentials not found at ${GMAIL_CREDENTIALS_PATH}\n` +
        'Set GMAIL_CREDENTIALS_PATH or GMAIL_CREDENTIALS_JSON env var'
      );
    }
    if (!fs.existsSync(GMAIL_TOKEN_PATH)) {
      throw new Error(
        `Gmail token not found at ${GMAIL_TOKEN_PATH}\n` +
        'Run the auth flow first, or set GMAIL_TOKEN_JSON env var'
      );
    }
    credentials = JSON.parse(fs.readFileSync(GMAIL_CREDENTIALS_PATH));
    token = JSON.parse(fs.readFileSync(GMAIL_TOKEN_PATH));
  }

  const { client_id, client_secret, redirect_uris } = credentials.installed;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
  oAuth2Client.setCredentials(token);

  // Auto-save refreshed tokens back to the file (only when using file-based auth)
  if (!process.env.GMAIL_TOKEN_JSON) {
    oAuth2Client.on('tokens', (newTokens) => {
      const merged = { ...token, ...newTokens };
      fs.writeFileSync(GMAIL_TOKEN_PATH, JSON.stringify(merged, null, 2));
    });
  }

  cachedClient = google.gmail({ version: 'v1', auth: oAuth2Client });
  return cachedClient;
}

// ---------------------------------------------------------------------------
// Label helpers (require gmail.modify scope)
// ---------------------------------------------------------------------------

let _labelCache = null;

/**
 * Get or create a Gmail label by name.
 * Returns the label ID.
 */
async function getOrCreateLabel(gmail, name) {
  if (!_labelCache) {
    const res = await gmail.users.labels.list({ userId: 'me' });
    _labelCache = new Map((res.data.labels || []).map(l => [l.name, l.id]));
  }

  if (_labelCache.has(name)) return _labelCache.get(name);

  const res = await gmail.users.labels.create({
    userId: 'me',
    requestBody: {
      name,
      labelListVisibility: 'labelShow',
      messageListVisibility: 'show',
    },
  });
  _labelCache.set(name, res.data.id);
  return res.data.id;
}

/**
 * Add a label to a message (without archiving).
 */
async function labelMessage(gmail, messageId, labelId) {
  await gmail.users.messages.modify({
    userId: 'me',
    id: messageId,
    requestBody: { addLabelIds: [labelId] },
  });
}

/**
 * Add a label to a message and remove from INBOX (archive).
 */
async function labelAndArchive(gmail, messageId, labelId) {
  await gmail.users.messages.modify({
    userId: 'me',
    id: messageId,
    requestBody: {
      addLabelIds: [labelId],
      removeLabelIds: ['INBOX'],
    },
  });
}

/**
 * Mark a message as spam in Gmail.
 * Adds SPAM label, removes INBOX — trains Google's spam filter.
 */
async function markAsSpam(gmail, messageId) {
  await gmail.users.messages.modify({
    userId: 'me',
    id: messageId,
    requestBody: {
      addLabelIds: ['SPAM'],
      removeLabelIds: ['INBOX'],
    },
  });
}

/**
 * Move a message to the trash.
 * Trashed messages are permanently deleted after 30 days by Gmail.
 */
async function trashMessage(gmail, messageId) {
  await gmail.users.messages.trash({ userId: 'me', id: messageId });
}

// ---------------------------------------------------------------------------
// Attachment helpers
// ---------------------------------------------------------------------------

/**
 * Download an attachment from a Gmail message.
 * Returns { data: Buffer, filename, mimeType }.
 */
async function downloadAttachment(gmail, messageId, attachmentId, filename, mimeType) {
  const res = await gmail.users.messages.attachments.get({
    userId: 'me',
    messageId,
    id: attachmentId,
  });
  // Gmail returns base64url-encoded data
  const data = Buffer.from(res.data.data, 'base64url');
  return { data, filename, mimeType };
}

module.exports = { getGmail, getOrCreateLabel, labelMessage, labelAndArchive, markAsSpam, trashMessage, downloadAttachment };
