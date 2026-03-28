/**
 * QuickBooks Online OAuth 2.0 Manager
 *
 * Two modes:
 *   1. Interactive auth (one-time): `node finance/lib/oauthManager.js --auth`
 *      Spins up localhost:3847, opens Intuit consent screen, captures tokens.
 *   2. Runtime: getAccessToken() — reads from Supabase, auto-refreshes if expired.
 *
 * Tokens are stored in Supabase `qbo_oauth_tokens` (single row, id='singleton').
 * Refresh tokens rotate on every refresh — the new one MUST be persisted immediately.
 */

const path = require('path');
const http = require('http');
const { URL } = require('url');

// Lazy dotenv — works standalone or from runner
if (!process.env.SUPABASE_URL) {
  require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
}

const { getSupabaseClient } = require('../../shared/supabaseClient');

const INTUIT_AUTH_URL = 'https://appcenter.intuit.com/connect/oauth2';
const INTUIT_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const REDIRECT_URI = 'https://developer.intuit.com/v2/OAuth2Playground/RedirectUrl';
const SCOPES = 'com.intuit.quickbooks.accounting';
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000; // refresh 5 min before expiry

function getOAuthConfig() {
  const clientId = process.env.QBO_CLIENT_ID;
  const clientSecret = process.env.QBO_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('QBO_CLIENT_ID and QBO_CLIENT_SECRET must be set in .env');
  }
  return { clientId, clientSecret };
}

// ---------------------------------------------------------------------------
// Token storage (Supabase)
// ---------------------------------------------------------------------------

async function loadTokens() {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('qbo_oauth_tokens')
    .select('*')
    .eq('id', 'singleton')
    .single();
  if (error && error.code !== 'PGRST116') throw error; // PGRST116 = no rows
  return data || null;
}

async function saveTokens({ realmId, accessToken, refreshToken, accessExpiresAt, refreshExpiresAt }) {
  const supabase = getSupabaseClient();
  const row = {
    id: 'singleton',
    realm_id: realmId,
    access_token: accessToken,
    refresh_token: refreshToken,
    access_token_expires_at: accessExpiresAt,
    refresh_token_expires_at: refreshExpiresAt,
    updated_at: new Date().toISOString(),
  };
  const { error } = await supabase
    .from('qbo_oauth_tokens')
    .upsert(row, { onConflict: 'id' });
  if (error) throw new Error(`Failed to save tokens: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Token exchange & refresh
// ---------------------------------------------------------------------------

async function exchangeCodeForTokens(code, realmId) {
  const { clientId, clientSecret } = getOAuthConfig();
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const res = await fetch(INTUIT_TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  const now = Date.now();

  await saveTokens({
    realmId,
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    accessExpiresAt: new Date(now + data.expires_in * 1000).toISOString(),
    refreshExpiresAt: new Date(now + data.x_refresh_token_expires_in * 1000).toISOString(),
  });

  return data;
}

async function refreshAccessToken(currentTokens) {
  const { clientId, clientSecret } = getOAuthConfig();
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const res = await fetch(INTUIT_TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: currentTokens.refresh_token,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  const now = Date.now();

  // CRITICAL: Save new refresh token BEFORE returning access token
  await saveTokens({
    realmId: currentTokens.realm_id,
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    accessExpiresAt: new Date(now + data.expires_in * 1000).toISOString(),
    refreshExpiresAt: new Date(now + data.x_refresh_token_expires_in * 1000).toISOString(),
  });

  console.error('[QBO OAuth] Tokens refreshed successfully');
  return data.access_token;
}

// ---------------------------------------------------------------------------
// Public: get a valid access token (auto-refresh if needed)
// ---------------------------------------------------------------------------

async function getAccessToken() {
  const tokens = await loadTokens();
  if (!tokens) {
    throw new Error('No QBO OAuth tokens found. Run `npm run finance-auth` first.');
  }

  const expiresAt = new Date(tokens.access_token_expires_at).getTime();
  const now = Date.now();

  if (now < expiresAt - TOKEN_REFRESH_BUFFER_MS) {
    return { accessToken: tokens.access_token, realmId: tokens.realm_id };
  }

  // Refresh needed
  console.error('[QBO OAuth] Access token expired or expiring soon, refreshing...');
  const newAccessToken = await refreshAccessToken(tokens);
  return { accessToken: newAccessToken, realmId: tokens.realm_id };
}

function getRealmId() {
  return process.env.QBO_REALM_ID || null;
}

// ---------------------------------------------------------------------------
// Interactive auth flow (one-time setup)
// ---------------------------------------------------------------------------

async function runInteractiveAuth() {
  const { clientId } = getOAuthConfig();
  const realmIdFromEnv = process.env.QBO_REALM_ID;
  const readline = require('readline');

  const authUrl = `${INTUIT_AUTH_URL}?client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=${encodeURIComponent(SCOPES)}&state=rubies-finance`;

  console.log('\n=== QuickBooks Online — OAuth Setup ===\n');
  console.log('1. Open this URL in your browser:\n');
  console.log(authUrl);
  console.log('\n2. Authorize the app in QuickBooks.');
  console.log('3. You\'ll be redirected to the Intuit OAuth Playground.');
  console.log('4. Copy the FULL redirect URL from your browser\'s address bar.');
  console.log('   It will look like: https://developer.intuit.com/v2/OAuth2Playground/RedirectUrl?code=ABC123&realmId=12345&state=rubies-finance\n');

  // Try to open the URL automatically
  try {
    const { exec } = require('child_process');
    exec(`open "${authUrl}"`);
  } catch (_) {
    // Ignore — user can open manually
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  return new Promise((resolve, reject) => {
    rl.question('Paste the full redirect URL here: ', async (input) => {
      rl.close();

      try {
        const redirectUrl = new URL(input.trim());
        const code = redirectUrl.searchParams.get('code');
        const realmId = redirectUrl.searchParams.get('realmId') || realmIdFromEnv;

        const errorParam = redirectUrl.searchParams.get('error');
        if (errorParam) {
          throw new Error(`Auth denied: ${errorParam}`);
        }

        if (!code) {
          throw new Error('No authorization code found in URL. Make sure you pasted the full redirect URL.');
        }

        if (!realmId) {
          throw new Error('No realmId found. Set QBO_REALM_ID in .env or ensure it\'s in the redirect URL.');
        }

        console.log(`\nAuth code received. Realm ID: ${realmId}`);
        console.log('Exchanging code for tokens...');

        const tokenData = await exchangeCodeForTokens(code, realmId);

        console.log('\nTokens saved to Supabase successfully!');
        console.log(`Realm ID: ${realmId}`);
        console.log(`Access token expires in: ${tokenData.expires_in}s`);
        console.log(`Refresh token expires in: ${Math.round(tokenData.x_refresh_token_expires_in / 86400)} days`);

        if (!realmIdFromEnv) {
          console.log(`\nAdd this to your .env file:\n  QBO_REALM_ID=${realmId}\n`);
        }

        resolve(tokenData);
      } catch (err) {
        reject(err);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  getAccessToken,
  getRealmId,
  loadTokens,
  saveTokens,
  refreshAccessToken,
};

// ---------------------------------------------------------------------------
// Standalone: interactive auth
// ---------------------------------------------------------------------------

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--auth')) {
    runInteractiveAuth()
      .then(() => process.exit(0))
      .catch(err => {
        console.error('Auth failed:', err.message);
        process.exit(1);
      });
  } else {
    // Quick token check
    getAccessToken()
      .then(({ realmId }) => {
        console.log(`QBO tokens OK. Realm ID: ${realmId}`);
      })
      .catch(err => {
        console.error('Token check failed:', err.message);
        process.exit(1);
      });
  }
}
