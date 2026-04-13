/**
 * Webhook Receiver — Express server for Shopify + Gorgias webhooks
 *
 * Deployed on Railway. Receives real-time events and upserts to Supabase.
 * Daily sync remains as reconciliation for missed webhooks.
 *
 * Usage:
 *   npm run webhook-server
 *   PORT=3000 (default, Railway injects automatically)
 */

const path = require('path');
if (!process.env.SUPABASE_URL) {
  require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
}

const express = require('express');
const { verifyShopifyHmac } = require('./lib/hmac');
const { verifyGorgiasSecret } = require('./lib/gorgiasAuth');
const { verifyGmailPush } = require('./lib/gmailPushAuth');
const { logEvent, enqueueDeadLetter } = require('./lib/deadLetter');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

// Shopify needs raw body for HMAC verification.
// JSON parser for everything else, but MUST skip Shopify webhook routes.
app.use('/webhooks/shopify', express.raw({ type: '*/*' }));
app.use((req, res, next) => {
  // Skip JSON parsing for Shopify routes (already handled by express.raw above)
  if (req.path.startsWith('/webhooks/shopify')) return next();
  express.json()(req, res, next);
});

// Request logger (helps debug webhook delivery issues)
app.use('/webhooks', (req, _res, next) => {
  const bodyType = Buffer.isBuffer(req.body) ? `Buffer(${req.body.length})` : typeof req.body;
  console.log(`[webhook] ${req.method} ${req.path} from ${req.ip} — body: ${bodyType}, hmac: ${req.get('X-Shopify-Hmac-Sha256') ? 'present' : 'absent'}`);
  next();
});

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------
// Temporary debug endpoint — remove after Shopify webhooks confirmed working
app.post('/webhooks/debug', (req, res) => {
  const crypto = require('crypto');
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  const hmacHeader = req.get('X-Shopify-Hmac-Sha256') || 'none';
  const isBuffer = Buffer.isBuffer(req.body);
  const bodyStr = isBuffer ? req.body.toString() : JSON.stringify(req.body);
  const computed = isBuffer
    ? crypto.createHmac('sha256', secret).update(req.body).digest('base64')
    : 'not-a-buffer';

  const info = {
    bodyIsBuffer: isBuffer,
    bodyLength: req.body?.length,
    bodyPreview: bodyStr?.substring(0, 100),
    hmacHeader,
    computedHmac: computed,
    match: hmacHeader === computed,
    secretLength: secret?.length,
    secretPrefix: secret?.substring(0, 6),
  };
  console.log('[debug]', JSON.stringify(info));
  res.json(info);
});

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    commit: process.env.RAILWAY_GIT_COMMIT_SHA?.substring(0, 7) || 'local',
    deployed: process.env.RAILWAY_DEPLOYMENT_ID || null,
  });
});

// ---------------------------------------------------------------------------
// Shopify webhook routes
// ---------------------------------------------------------------------------
const SHOPIFY_HANDLERS = {
  'orders-create':      () => require('./handlers/shopifyOrders'),
  'orders-updated':     () => require('./handlers/shopifyOrders'),
  'customers-update':   () => require('./handlers/shopifyCustomers'),
  'inventory-levels-update': () => require('./handlers/shopifyInventory'),
  'fulfillments-create': () => require('./handlers/shopifyFulfillments'),
  'fulfillments-update': () => require('./handlers/shopifyFulfillments'),
  'products-create':    () => require('./handlers/shopifyProducts'),
  'products-update':    () => require('./handlers/shopifyProducts'),
};

app.post('/webhooks/shopify/:topic', verifyShopifyHmac, async (req, res) => {
  const topic = req.params.topic;
  const loaderFn = SHOPIFY_HANDLERS[topic];

  if (!loaderFn) {
    console.warn(`[webhook] Unknown Shopify topic: ${topic}`);
    return res.status(404).json({ error: 'unknown topic' });
  }

  // Respond immediately — Shopify retries on timeout
  res.status(200).json({ received: true });

  const start = Date.now();
  const payload = JSON.parse(req.body.toString());
  const payloadId = String(payload.id || payload.inventory_item_id || '');

  try {
    const handler = loaderFn();
    await handler.handle(topic, payload);
    await logEvent('shopify', topic, payloadId, 'processed', Date.now() - start);
    console.log(`[webhook] shopify/${topic} #${payloadId} processed in ${Date.now() - start}ms`);
  } catch (err) {
    console.error(`[webhook] shopify/${topic} #${payloadId} failed:`, err.message);
    await logEvent('shopify', topic, payloadId, 'failed', Date.now() - start, err.message);
    await enqueueDeadLetter('shopify', topic, payload, err.message);
  }
});

// ---------------------------------------------------------------------------
// Gorgias webhook route
// ---------------------------------------------------------------------------
app.post('/webhooks/gorgias', verifyGorgiasSecret, async (req, res) => {
  // Respond immediately — Gorgias has a 10s timeout
  res.status(200).json({ received: true });

  const start = Date.now();
  const payload = req.body;
  const ticketId = String(payload?.ticket?.id || '');

  try {
    const handler = require('./handlers/gorgiasTickets');
    await handler.handle(payload);
    await logEvent('gorgias', 'ticket-message-created', ticketId, 'processed', Date.now() - start);
    console.log(`[webhook] gorgias/ticket #${ticketId} processed in ${Date.now() - start}ms`);
  } catch (err) {
    console.error(`[webhook] gorgias/ticket #${ticketId} failed:`, err.message);
    await logEvent('gorgias', 'ticket-message-created', ticketId, 'failed', Date.now() - start, err.message);
    await enqueueDeadLetter('gorgias', 'ticket-message-created', payload, err.message);
  }
});

// Gorgias ticket-updated (status changes — close/reopen)
app.post('/webhooks/gorgias/ticket-updated', verifyGorgiasSecret, async (req, res) => {
  res.status(200).json({ received: true });

  const start = Date.now();
  const payload = req.body;
  const ticketId = String(payload?.ticket?.id || '');

  try {
    const handler = require('./handlers/gorgiasTicketUpdated');
    await handler.handle(payload);
    await logEvent('gorgias', 'ticket-updated', ticketId, 'processed', Date.now() - start);
  } catch (err) {
    console.error(`[webhook] gorgias/ticket-updated #${ticketId} failed:`, err.message);
    await logEvent('gorgias', 'ticket-updated', ticketId, 'failed', Date.now() - start, err.message);
  }
});

// ---------------------------------------------------------------------------
// Gmail push notification route (Google Cloud Pub/Sub)
// ---------------------------------------------------------------------------
app.post('/webhooks/gmail', verifyGmailPush, async (req, res) => {
  // Respond immediately — Pub/Sub requires fast ACK
  res.status(200).json({ received: true });

  const start = Date.now();
  const gmailPush = req.gmailPush;
  const historyId = gmailPush?.historyId || 'unknown';

  try {
    const handler = require('./handlers/gmailPush');
    const result = await handler.handle(req.body, gmailPush);
    await logEvent('gmail', 'push-notification', String(historyId), 'processed', Date.now() - start);
    if (result.processed > 0) {
      console.log(`[webhook] gmail push: ${result.processed} messages, ${result.routed} routed (${Date.now() - start}ms)`);
    }
  } catch (err) {
    console.error(`[webhook] gmail push failed:`, err.message);
    await logEvent('gmail', 'push-notification', String(historyId), 'failed', Date.now() - start, err.message);
    await enqueueDeadLetter('gmail', 'push-notification', req.body, err.message);
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const server = app.listen(PORT, () => {
  console.log(`[webhook] Server listening on port ${PORT}`);
});

// ---------------------------------------------------------------------------
// Auto follow-up timer (every 4 hours)
// ---------------------------------------------------------------------------
const FOLLOW_UP_INTERVAL = 4 * 60 * 60 * 1000;
let followUpTimer;

async function runAutoFollowUps() {
  try {
    const { processAutoFollowUps } = require('../customer-service/lib/tools/csAdmin');
    const result = await processAutoFollowUps();
    if (result.stage1Sent > 0 || result.stage2Sent > 0) {
      console.log(`[follow-up] Stage 1: ${result.stage1Sent} sent, Stage 2: ${result.stage2Sent} sent, ${result.skipped} skipped`);
    }
  } catch (err) {
    console.error(`[follow-up] Auto follow-up check failed: ${err.message}`);
  }
}

// DISABLED: Auto follow-ups have a dedup bug that causes repeat sends.
// Re-enable after fixing the follow-up state tracking.
// setTimeout(() => {
//   runAutoFollowUps();
//   followUpTimer = setInterval(runAutoFollowUps, FOLLOW_UP_INTERVAL);
// }, 30_000);

// Graceful shutdown
function shutdown(signal) {
  console.log(`[webhook] ${signal} received, shutting down...`);
  if (followUpTimer) clearInterval(followUpTimer);
  server.close(() => {
    console.log('[webhook] Server closed');
    process.exit(0);
  });
  // Force exit after 10s if connections don't close
  setTimeout(() => process.exit(1), 10000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
