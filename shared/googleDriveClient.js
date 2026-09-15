require('dotenv').config();
const { google } = require('googleapis');

/**
 * Read-only Drive access for the same service account the Sheets client uses.
 * Separate module because the scope is different: `drive.readonly` has to be
 * granted on the folders we read (the Pigeons & Thread tech-pack folders are
 * shared with the service account), and we never want write scope here.
 */
async function getDriveClient() {
  const keyFile = process.env.SERVICE_ACCOUNT_KEY_PATH;
  if (!keyFile) throw new Error('SERVICE_ACCOUNT_KEY_PATH must be set for Google Drive');
  const auth = new google.auth.GoogleAuth({ keyFile, scopes: ['https://www.googleapis.com/auth/drive.readonly'] });
  return google.drive({ version: 'v3', auth: await auth.getClient() });
}

async function getDriveAccessToken() {
  const keyFile = process.env.SERVICE_ACCOUNT_KEY_PATH;
  if (!keyFile) throw new Error('SERVICE_ACCOUNT_KEY_PATH must be set for Google Drive');
  const auth = new google.auth.GoogleAuth({ keyFile, scopes: ['https://www.googleapis.com/auth/drive.readonly'] });
  const client = await auth.getClient();
  const { token } = await client.getAccessToken();
  if (!token) throw new Error('could not mint a Drive access token');
  return token;
}

/** Drive file id out of a Docs/Sheets/Drive URL (or an id passed through). */
function driveIdFromUrl(url) {
  const s = String(url || '').trim();
  if (!s) return null;
  const m = s.match(/\/d\/([A-Za-z0-9_-]{20,})/) || s.match(/[?&]id=([A-Za-z0-9_-]{20,})/);
  if (m) return m[1];
  return /^[A-Za-z0-9_-]{20,}$/.test(s) ? s : null;
}

/** Follow a Drive shortcut to the file it points at (ids of real files pass through). */
async function resolveShortcut(drive, fileId) {
  const { data } = await drive.files.get({ fileId, fields: 'id, name, mimeType, shortcutDetails', supportsAllDrives: true });
  if (data.shortcutDetails && data.shortcutDetails.targetId) {
    return { id: data.shortcutDetails.targetId, name: data.name, viaShortcut: fileId };
  }
  return { id: data.id, name: data.name, mimeType: data.mimeType };
}

/**
 * Export a whole Google Sheet as .xlsx.
 *
 * `files.export` refuses over ~10MB and most tech packs are 25-45MB as Sheets,
 * but a Sheet's stored size is not its export size (drawings and revision
 * history dominate the former): the same tech packs come back as 6-8MB of xlsx
 * through the per-document export endpoint, which has no such cap.
 */
async function exportSheetXlsx(spreadsheetId) {
  const token = await getDriveAccessToken();
  const res = await fetch(`https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=xlsx`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`xlsx export failed: HTTP ${res.status} ${res.statusText}`);
  const type = res.headers.get('content-type') || '';
  if (type.includes('html')) throw new Error('xlsx export returned an HTML page — the file is probably not shared with the service account');
  return Buffer.from(await res.arrayBuffer());
}

module.exports = { getDriveClient, getDriveAccessToken, driveIdFromUrl, resolveShortcut, exportSheetXlsx };
