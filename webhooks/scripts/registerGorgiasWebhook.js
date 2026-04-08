#!/usr/bin/env node

/**
 * Register Gorgias webhook for ticket-message-created events
 *
 * Usage:
 *   node webhooks/scripts/registerGorgiasWebhook.js             # register
 *   node webhooks/scripts/registerGorgiasWebhook.js --list       # list existing
 *   node webhooks/scripts/registerGorgiasWebhook.js --delete     # delete all
 *   node webhooks/scripts/registerGorgiasWebhook.js --dev        # use tunnel URL
 *
 * Requires WEBHOOK_BASE_URL env var (or --dev with DEV_TUNNEL_URL)
 * and GORGIAS_WEBHOOK_SECRET for the shared signing secret.
 */

const path = require('path');
if (!process.env.SUPABASE_URL) {
  require('dotenv').config({ path: path.resolve(__dirname, '../..', '.env') });
}

const GORGIAS_DOMAIN = process.env.GORGIAS_DOMAIN;
const GORGIAS_API_KEY = process.env.GORGIAS_API_KEY;
const GORGIAS_EMAIL = process.env.GORGIAS_EMAIL;

if (!GORGIAS_DOMAIN || !GORGIAS_API_KEY || !GORGIAS_EMAIL) {
  console.error('Missing GORGIAS_DOMAIN, GORGIAS_API_KEY, or GORGIAS_EMAIL');
  process.exit(1);
}

const BASE = `https://${GORGIAS_DOMAIN}.gorgias.com/api`;
const AUTH = Buffer.from(`${GORGIAS_EMAIL}:${GORGIAS_API_KEY}`).toString('base64');

async function gorgiasAPI(method, endpoint, body) {
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Basic ${AUTH}`,
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(`${BASE}${endpoint}`, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gorgias API ${method} ${endpoint}: ${res.status} ${text}`);
  }
  return res.json();
}

async function listWebhooks() {
  const data = await gorgiasAPI('GET', '/integrations/webhooks?per_page=50');
  const hooks = data.data || [];
  if (!hooks.length) {
    console.log('No Gorgias webhooks found.');
    return hooks;
  }
  console.log(`Found ${hooks.length} webhook(s):\n`);
  for (const h of hooks) {
    console.log(`  ID: ${h.id}`);
    console.log(`  Event: ${h.event_type || h.trigger || 'unknown'}`);
    console.log(`  URL: ${h.url}`);
    console.log();
  }
  return hooks;
}

async function registerWebhook(baseUrl, eventType = 'ticket-message-created') {
  const paths = {
    'ticket-message-created': '/webhooks/gorgias',
    'ticket-updated': '/webhooks/gorgias/ticket-updated',
  };
  const callbackUrl = `${baseUrl}${paths[eventType] || '/webhooks/gorgias'}`;
  const secret = process.env.GORGIAS_WEBHOOK_SECRET;

  if (!secret) {
    console.error('Set GORGIAS_WEBHOOK_SECRET env var for webhook signing');
    process.exit(1);
  }

  console.log(`Registering Gorgias webhook: ${eventType} → ${callbackUrl}\n`);

  const result = await gorgiasAPI('POST', '/integrations/webhooks', {
    url: callbackUrl,
    event_type: eventType,
    secret,
  });

  console.log(`Registered! ID: ${result.id}`);
  console.log(`Event: ${result.event_type}`);
  console.log(`URL: ${result.url}`);
}

async function deleteAllWebhooks() {
  const hooks = await listWebhooks();
  if (!hooks.length) return;

  console.log(`\nDeleting ${hooks.length} webhook(s)...\n`);
  for (const h of hooks) {
    try {
      await gorgiasAPI('DELETE', `/integrations/webhooks/${h.id}`);
      console.log(`  Deleted: ${h.id}`);
    } catch (err) {
      console.error(`  Failed to delete ${h.id}: ${err.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

(async () => {
  const args = process.argv.slice(2);
  const isDev = args.includes('--dev');
  const isList = args.includes('--list');
  const isDelete = args.includes('--delete');

  if (isList) {
    await listWebhooks();
    return;
  }

  if (isDelete) {
    await deleteAllWebhooks();
    return;
  }

  const baseUrl = isDev
    ? (process.env.DEV_TUNNEL_URL || 'http://localhost:3000')
    : process.env.WEBHOOK_BASE_URL;

  if (!baseUrl) {
    console.error('Set WEBHOOK_BASE_URL env var (or use --dev with DEV_TUNNEL_URL)');
    process.exit(1);
  }

  const eventType = args.includes('--ticket-updated') ? 'ticket-updated' : 'ticket-message-created';
  await registerWebhook(baseUrl.replace(/\/$/, ''), eventType);
})().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
