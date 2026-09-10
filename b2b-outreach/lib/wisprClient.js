/**
 * wisprClient.js — the server's own connection to Wispr Flow's remote MCP.
 *
 * Meeting notes used to reach the record only when a Claude session read them
 * through its own Wispr connector and called a tool by hand. Jamie wanted them
 * to arrive by themselves (2026-09-10): nightly, and the moment a call is
 * marked held. So the server holds its own OAuth grant and speaks MCP to
 * https://api.wisprflow.ai/connect/mcp directly.
 *
 * Auth (verified against the published discovery metadata, 2026-09-10): the
 * authorization server at mcp-auth.wisprflow.com offers dynamic client
 * registration, the authorization_code and refresh_token grants, and the
 * offline_access scope. `scripts/authWispr.js` does the one-time browser
 * approval and writes the token. Wispr's help pages describe only the
 * browser sign-in that clients like Claude do; this is the same flow held by
 * a server, and the manual path (a session reading Wispr and calling
 * b2b_meeting_notes) stays as the fallback if it ever stops working.
 *
 * Token storage, in order: the `oauth_tokens` Supabase row (the live copy —
 * refreshes may rotate the refresh token and a Railway env var cannot be
 * rewritten by the app), then WISPR_TOKEN_JSON (bootstrap), then the local
 * token file beside the calendar token. Every refresh writes back to the row
 * and to the file when present.
 *
 * Usage:
 *   const wispr = require('./wisprClient');
 *   if (await wispr.isConfigured()) { const m = await wispr.meetingByCalendarId(id); }
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const MCP_URL = process.env.WISPR_MCP_URL || 'https://api.wisprflow.ai/connect/mcp';
const TOKEN_KEY = 'wispr';
const REFRESH_SKEW_MS = 60 * 1000;

function tokenPath() {
  if (process.env.WISPR_TOKEN_PATH) return process.env.WISPR_TOKEN_PATH;
  // Beside the calendar token, wherever that convention put it (.creds next to
  // .env, or rubies-utilities/creds) — see googleCalendarClient for why.
  try {
    const { TOKEN_PATH } = require('../../shared/googleCalendarClient');
    return path.join(path.dirname(TOKEN_PATH), 'wispr-token.json');
  } catch {
    return path.join(process.cwd(), '.creds', 'wispr-token.json');
  }
}

function sbClient() {
  try { return require('../../shared/supabaseClient').getSupabaseClient(); } catch { return null; }
}

// ── token store ─────────────────────────────────────────────────────────────

let cached = null;

async function loadFromRow() {
  const sb = sbClient();
  if (!sb) return null;
  try {
    const { data, error } = await sb.from('oauth_tokens').select('token').eq('key', TOKEN_KEY).maybeSingle();
    if (error) return null; // table not applied yet: fall through to env/file
    return data?.token || null;
  } catch { return null; }
}

function loadFromEnv() {
  if (!process.env.WISPR_TOKEN_JSON) return null;
  try { return JSON.parse(process.env.WISPR_TOKEN_JSON); } catch { return null; }
}

function loadFromFile() {
  const p = tokenPath();
  try { return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null; } catch { return null; }
}

async function loadToken() {
  if (cached) return cached;
  cached = (await loadFromRow()) || loadFromEnv() || loadFromFile();
  return cached;
}

async function saveToken(token) {
  cached = token;
  const sb = sbClient();
  if (sb) {
    try {
      await sb.from('oauth_tokens').upsert({ key: TOKEN_KEY, token, updated_at: new Date().toISOString() }, { onConflict: 'key' });
    } catch (err) { console.warn(`[wispr] token row write failed: ${err.message}`); }
  }
  const p = tokenPath();
  try {
    if (fs.existsSync(path.dirname(p))) fs.writeFileSync(p, JSON.stringify(token, null, 2));
  } catch (err) { console.warn(`[wispr] token file write failed: ${err.message}`); }
}

async function isConfigured() {
  const t = await loadToken();
  return !!(t && t.refresh_token && t.token_endpoint && t.client_id);
}

/** Refresh the access token if it is within a minute of expiring. */
async function getAccessToken({ force = false } = {}) {
  const t = await loadToken();
  if (!t) throw new Error('Wispr is not connected — run `node scripts/authWispr.js` once and set WISPR_TOKEN_JSON on Railway');
  if (!force && t.access_token && t.expires_at && t.expires_at - Date.now() > REFRESH_SKEW_MS) return t.access_token;
  if (!t.refresh_token) throw new Error('Wispr token has no refresh_token — re-run scripts/authWispr.js');

  const form = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: t.client_id });
  if (t.client_secret) form.set('client_secret', t.client_secret);
  if (t.resource) form.set('resource', t.resource);
  const res = await fetch(t.token_endpoint, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: form,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Error(`Wispr token refresh failed (${res.status}): ${body.error_description || body.error || 'no access_token'} — re-run scripts/authWispr.js`);
  }
  const next = {
    ...t,
    access_token: body.access_token,
    // A server that rotates refresh tokens hands a new one back; keep it.
    refresh_token: body.refresh_token || t.refresh_token,
    expires_at: Date.now() + (Number(body.expires_in) || 3600) * 1000,
    scope: body.scope || t.scope,
    refreshed_at: new Date().toISOString(),
  };
  await saveToken(next);
  return next.access_token;
}

// ── MCP calls ───────────────────────────────────────────────────────────────

/**
 * One connected client per call batch. Calls are rare (a nightly pass, a Held
 * click), so the cost of connecting each time is nothing next to a long-lived
 * session whose token silently expires underneath it.
 */
async function withClient(fn, { retryAuth = true } = {}) {
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const token = await getAccessToken();
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'rubies-automations', version: '1.0.0' });
  try {
    await client.connect(transport);
    return await fn(client);
  } catch (err) {
    // A 401 on a token we believed valid: refresh once and go again.
    if (retryAuth && /401|unauthorized|invalid[_ ]token/i.test(String(err && err.message))) {
      await getAccessToken({ force: true });
      return withClient(fn, { retryAuth: false });
    }
    throw err;
  } finally {
    try { await client.close(); } catch { /* already closed */ }
  }
}

/** Parse an MCP tool result: JSON in the first text block, or the raw text. */
function parseResult(result) {
  const text = (result?.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  if (result?.isError) {
    const err = new Error(text || 'Wispr tool error');
    err.wisprError = true;
    throw err;
  }
  try { return JSON.parse(text); } catch { return { text }; }
}

async function callTool(client, name, args) {
  const result = await client.callTool({ name, arguments: args || {} });
  return parseResult(result);
}

const NO_RECORDING = /no recording is linked|not found|no meeting/i;

/**
 * The recording for a Google Calendar event, or null when Wispr has none
 * linked to it (a recording Jamie started by hand has no calendar link — see
 * meetingNotes.findRecording for the time+title fallback).
 */
async function meetingByCalendarId(calendarId, { transcript = false } = {}) {
  return withClient(async client => {
    try {
      const m = await callTool(client, 'get_meeting_by_calendar_id', {
        calendar_id: calendarId,
        ...(transcript ? { view_transcript: { char_limit: 40000 } } : {}),
      });
      return transcript ? await withFullTranscript(client, m) : m;
    } catch (err) {
      if (err.wisprError && NO_RECORDING.test(err.message)) return null;
      throw err;
    }
  });
}

/** Recent recordings, newest first. `since`/`until` filter on modified time. */
async function searchMeetings({ query, since, until, limit = 50 } = {}) {
  return withClient(async client => {
    const r = await callTool(client, 'search_meetings', {
      ...(query ? { query, field: 'title' } : {}), ...(since ? { since } : {}), ...(until ? { until } : {}), limit,
    });
    return r?.meetings || [];
  });
}

async function getMeeting(meetingId, { transcript = false } = {}) {
  return withClient(async client => {
    const m = await callTool(client, 'get_meeting', {
      meeting_id: meetingId, ...(transcript ? { view_transcript: { char_limit: 40000 } } : {}),
    });
    return transcript ? await withFullTranscript(client, m) : m;
  });
}

/**
 * Transcripts come back in bounded ranges with a continuation marker. Page
 * until the marker stops appearing (capped, so a runaway never loops).
 */
async function withFullTranscript(client, meeting) {
  let text = typeof meeting?.transcript === 'string' ? meeting.transcript : '';
  let pages = 0;
  let m = /start_char[^0-9]*(\d+)/i.exec(text.slice(-400));
  while (m && pages < 8) {
    const offset = Number(m[1]);
    const more = await callTool(client, 'get_meeting', { meeting_id: meeting.id, view_transcript: { start_char: offset, char_limit: 40000 } });
    const chunk = typeof more?.transcript === 'string' ? more.transcript : '';
    if (!chunk) break;
    text = text.replace(/\n?\[[^\]]*start_char[^\]]*\]\s*$/i, '') + chunk;
    m = /start_char[^0-9]*(\d+)/i.exec(chunk.slice(-400));
    pages += 1;
  }
  return { ...meeting, transcript: text || null };
}

module.exports = {
  MCP_URL, TOKEN_KEY, tokenPath,
  loadToken, saveToken, isConfigured, getAccessToken,
  withClient, callTool, parseResult,
  meetingByCalendarId, searchMeetings, getMeeting,
};
