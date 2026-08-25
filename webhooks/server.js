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

// Auto follow-ups are now event-driven off Gorgias snooze expiry webhooks
// (handled in webhooks/handlers/gorgiasTicketUpdated.js). No polling timer needed.

// Warehouse-hold backstop: the synchronous auto-hold at intake fails when the
// order isn't yet in Warehance (ingestion lag right after the customer orders).
// There's no Warehance "order ingested" webhook to hang this on, so a short
// poll places any hold the advisor proposed but intake couldn't land. Cheap
// (DB query + a Warehance call per outstanding candidate, normally zero) and
// idempotent. See customer-service/lib/holdReconcile.js.
const { reconcilePendingHolds } = require('../customer-service/lib/holdReconcile');
const HOLD_SWEEP_MS = 3 * 60 * 1000;
let holdSweepRunning = false;
const holdSweepTimer = setInterval(async () => {
  if (holdSweepRunning) return; // never overlap a slow sweep with the next tick
  holdSweepRunning = true;
  try {
    await reconcilePendingHolds();
  } catch (e) {
    console.error(`[hold-reconcile] sweep error: ${e.message}`);
  } finally {
    holdSweepRunning = false;
  }
}, HOLD_SWEEP_MS);
holdSweepTimer.unref(); // don't keep the process alive for the timer alone

// Unnotified pre-order outreach: a customer can buy an out-of-stock "continue
// selling" variant without ever being told it's a pre-order. Warehance
// allocates within minutes when stock exists, so an order still unallocated an
// hour after purchase is a genuine shortage and the customer should hear about
// it that hour — not on the next daily report. This sweep is the ONLY writer of
// those drafts (the daily report just reads the notes it leaves), so there is
// no second caller to race on the read-then-seed. Normally a no-op: leaks are
// rare. See reports/lib/unnotifiedPreOrder.js.
const { sweepUnnotifiedPreOrders, SWEEP_MS: PREORDER_SWEEP_MS } = require('../reports/lib/unnotifiedPreOrder');
let preOrderSweepRunning = false;
const preOrderSweepTimer = setInterval(async () => {
  if (preOrderSweepRunning) return; // never overlap a slow sweep with the next tick
  preOrderSweepRunning = true;
  try {
    const { drafted } = await sweepUnnotifiedPreOrders({ write: true });
    const seeded = drafted.filter(d => d.status === 'drafted');
    for (const d of seeded) {
      console.log(`[unnotified-preorder] drafted #${d.order_number} (Case ${d.case}) → cs_ticket ${d.cs_ticket_id}`);
    }
    for (const d of drafted.filter(d => d.status === 'failed')) {
      console.error(`[unnotified-preorder] seed FAILED for #${d.order_number}: ${d.error}`);
    }
  } catch (e) {
    console.error(`[unnotified-preorder] sweep error: ${e.message}`);
  } finally {
    preOrderSweepRunning = false;
  }
}, PREORDER_SWEEP_MS);
preOrderSweepTimer.unref();

// De-allocation watch: the OTHER route to "waiting on an item nobody told me
// about". The sweep above catches a line that was never allocated, which is
// visible at order time. This one catches a line that WAS allocated and stopped
// being — a stock recount comes up short and the warehouse hands the unit back —
// which has no signal at order time at all and routinely lands after the sweep's
// 14-day window has closed (found via #32951, de-allocated on day 16, never
// contacted). It is a transition, so it needs the previous observation:
// order_line_allocation_state. Hourly rather than every ten minutes because
// reconstructing the whole open book costs a stock call per distinct SKU and the
// customer has already been waiting days. See reports/lib/deallocationWatch.js.
const { sweepDeallocations } = require('../reports/lib/unnotifiedPreOrder');
const { WATCH_MS: DEALLOC_WATCH_MS } = require('../reports/lib/deallocationWatch');
let deallocSweepRunning = false;
const deallocSweepTimer = setInterval(async () => {
  if (deallocSweepRunning) return; // never overlap a slow sweep with the next tick
  deallocSweepRunning = true;
  try {
    const { drafted, flips, untrustedSkus, skipped } = await sweepDeallocations({ write: true });
    if (skipped) {
      console.warn(`[dealloc-watch] ${skipped}`);
      return;
    }
    for (const f of (flips || [])) {
      console.log(`[dealloc-watch] #${f.orderNumber} lost allocation on ${f.sku} (on_hand ${f.onHandBefore} -> ${f.onHandAfter})`);
    }
    // Reported, not silent: a SKU whose reconstruction doesn't tie back to
    // Warehance's counters is one we deliberately refuse to raise flips on, so
    // it is a blind spot for as long as it lasts.
    if (untrustedSkus?.length) {
      console.warn(`[dealloc-watch] ${untrustedSkus.length} SKU(s) excluded from flip detection (reconstruction disagrees with Warehance counters): ${untrustedSkus.join(', ')}`);
    }
    for (const d of (drafted || []).filter(d => d.status === 'drafted')) {
      console.log(`[dealloc-watch] drafted #${d.order_number} (Case ${d.case}) → cs_ticket ${d.cs_ticket_id}`);
    }
    for (const d of (drafted || []).filter(d => d.status === 'failed')) {
      console.error(`[dealloc-watch] seed FAILED for #${d.order_number}: ${d.error}`);
    }
  } catch (e) {
    console.error(`[dealloc-watch] sweep error: ${e.message}`);
  } finally {
    deallocSweepRunning = false;
  }
}, DEALLOC_WATCH_MS);
deallocSweepTimer.unref();

// Stranded intake claims: the atomic draft claim is taken BEFORE the advisor
// call, so a worker that dies mid-draft (a Railway redeploy is the realistic
// case) leaves a claim nothing fills in. The takeover inside claimDraftSlot only
// fires if Gorgias redelivers that same message, which it doesn't once the
// original webhook was ACKed — so without this sweep the claim suppresses one
// customer's message permanently, and invisibly, since a claim row is
// 'superseded' and never renders in the dashboard queues. Normally a no-op.
// See customer-service/intake/processGorgiasTickets.js.
const { sweepStaleDraftClaims } = require('../customer-service/intake/processGorgiasTickets');
const CLAIM_SWEEP_MS = 5 * 60 * 1000;
let claimSweepRunning = false;
const claimSweepTimer = setInterval(async () => {
  if (claimSweepRunning) return; // never overlap a slow sweep with the next tick
  claimSweepRunning = true;
  try {
    await sweepStaleDraftClaims({ write: true });
  } catch (e) {
    console.error(`[claim-sweep] sweep error: ${e.message}`);
  } finally {
    claimSweepRunning = false;
  }
}, CLAIM_SWEEP_MS);
claimSweepTimer.unref();

// Graceful shutdown
function shutdown(signal) {
  console.log(`[webhook] ${signal} received, shutting down...`);
  server.close(() => {
    console.log('[webhook] Server closed');
    process.exit(0);
  });
  // Force exit after 10s if connections don't close
  setTimeout(() => process.exit(1), 10000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
