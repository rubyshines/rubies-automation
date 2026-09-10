#!/usr/bin/env node
/**
 * authWispr.js — connect the server to Wispr Flow, once.
 *
 * ONE-TIME SETUP. Run:  node scripts/authWispr.js
 *
 * Registers this app with Wispr's authorization server (dynamic client
 * registration), opens the browser for Jamie to approve, catches the redirect
 * on a local port, exchanges the code for tokens with offline_access (a refresh
 * token), verifies the connection by listing one recording, and saves the token
 * to the `oauth_tokens` Supabase row and the local token file.
 *
 * Afterwards, for Railway: `node scripts/authWispr.js --print-env` prints the
 * token as one line to set as WISPR_TOKEN_JSON (the bootstrap copy — the live
 * copy is the Supabase row, which refreshes rewrite).
 */
require('dotenv').config();
const crypto = require('crypto');
const http = require('http');
const { execFile } = require('child_process');
const wispr = require('../b2b-outreach/lib/wisprClient');

const RESOURCE = wispr.MCP_URL;
const SCOPE = 'openid offline_access';

async function fetchJson(url, init) {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${url} → ${res.status}: ${body.error_description || body.error || JSON.stringify(body).slice(0, 200)}`);
  return body;
}

/** RFC 9728 → RFC 8414: the resource names its auth server, which names its endpoints. */
async function discover() {
  const origin = new URL(RESOURCE).origin;
  const resourcePath = new URL(RESOURCE).pathname;
  let pr;
  try { pr = await fetchJson(`${origin}/.well-known/oauth-protected-resource${resourcePath}`); } catch { pr = await fetchJson(`${origin}/.well-known/oauth-protected-resource`); }
  const issuer = (pr.authorization_servers || [])[0];
  if (!issuer) throw new Error('protected resource metadata names no authorization server');
  const as = await fetchJson(`${issuer.replace(/\/$/, '')}/.well-known/oauth-authorization-server`);
  for (const k of ['authorization_endpoint', 'token_endpoint', 'registration_endpoint']) {
    if (!as[k]) throw new Error(`authorization server metadata has no ${k}`);
  }
  return { issuer, ...as };
}

function b64url(buf) { return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--print-env')) {
    const t = await wispr.loadToken();
    if (!t) { console.error('No Wispr token yet. Run without --print-env first.'); process.exit(1); }
    console.log('WISPR_TOKEN_JSON=' + JSON.stringify(t));
    return;
  }

  if (await wispr.isConfigured() && !args.includes('--force')) {
    console.log('Wispr is already connected. Re-run with --force to replace the token, or --print-env to print it for Railway.');
    try {
      const [m] = await wispr.searchMeetings({ limit: 1 });
      console.log(m ? `Verified: newest recording is "${m.title}".` : 'Verified: connected, no recordings yet.');
    } catch (err) { console.log(`(verification failed: ${err.message})`); }
    return;
  }

  const meta = await discover();
  console.log(`Authorization server: ${meta.issuer}`);

  // Loopback redirect on a free port.
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  const reg = await fetchJson(meta.registration_endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_name: 'RUBIES automations',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: SCOPE,
    }),
  });
  console.log(`Registered client ${reg.client_id}`);

  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));
  const authUrl = new URL(meta.authorization_endpoint);
  for (const [k, v] of Object.entries({
    response_type: 'code', client_id: reg.client_id, redirect_uri: redirectUri, scope: SCOPE,
    code_challenge: challenge, code_challenge_method: 'S256', state, resource: RESOURCE,
  })) authUrl.searchParams.set(k, v);

  console.log('\nApprove the connection in your browser. If it did not open, visit:\n' + authUrl.href + '\n');
  execFile('open', [authUrl.href], () => {});

  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for the browser approval (5 minutes)')), 5 * 60 * 1000);
    server.on('request', (req, res) => {
      const u = new URL(req.url, redirectUri);
      if (u.pathname !== '/callback') { res.writeHead(404); res.end(); return; }
      if (u.searchParams.get('state') !== state) { res.writeHead(400); res.end('state mismatch'); return; }
      const err = u.searchParams.get('error');
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(err ? `<p>Wispr said: ${err}. You can close this tab.</p>` : '<p>Connected. You can close this tab and return to the terminal.</p>');
      clearTimeout(timer);
      if (err) reject(new Error(`authorization refused: ${err}`)); else resolve(u.searchParams.get('code'));
    });
  }).finally(() => server.close());

  const tok = await fetchJson(meta.token_endpoint, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: reg.client_id,
      code_verifier: verifier, resource: RESOURCE,
    }),
  });
  if (!tok.refresh_token) throw new Error('no refresh_token came back — offline_access was not granted, so the server could not run unattended');

  const token = {
    issuer: meta.issuer,
    token_endpoint: meta.token_endpoint,
    resource: RESOURCE,
    client_id: reg.client_id,
    ...(reg.client_secret ? { client_secret: reg.client_secret } : {}),
    access_token: tok.access_token,
    refresh_token: tok.refresh_token,
    expires_at: Date.now() + (Number(tok.expires_in) || 3600) * 1000,
    scope: tok.scope || SCOPE,
    minted_at: new Date().toISOString(),
  };
  await wispr.saveToken(token);
  console.log(`Token saved (${wispr.tokenPath()} and the oauth_tokens row where the table exists).`);

  const [m] = await wispr.searchMeetings({ limit: 1 });
  console.log(m ? `Verified: newest recording is "${m.title}".` : 'Verified: connected, no recordings yet.');
  console.log('\nFor Railway, run:  node scripts/authWispr.js --print-env   and set WISPR_TOKEN_JSON on daily-sync-all and the webhook server.');
}

main().catch(err => { console.error(`authWispr: ${err.message}`); process.exit(1); });
