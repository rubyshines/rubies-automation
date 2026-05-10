/**
 * Resolve passport_invoices.shopify_order_number for every row.
 *
 * Resolution paths (in priority order):
 *   1. tracking          — passport_invoices.tracking_id matches order_fulfillment_costs.tracking_numbers
 *   2. shopify_order_id  — passport_invoices.order_id is "#NNNNN" form (older era)
 *   3. warehance_api     — passport_invoices.order_id is "WH-{warehance_order_id}-{hash}";
 *                          look up via Warehance API /orders/{id} -> order_number
 *
 * Idempotent — only resolves rows where shopify_order_number IS NULL.
 *
 * Usage:
 *   node finance/resolvePassportShopifyOrders.js              — resolve all unresolved
 *   node finance/resolvePassportShopifyOrders.js --reresolve  — re-run on every row
 */

if (!process.env.SUPABASE_URL) require('dotenv').config();
const { getSupabaseClient } = require('../shared/supabaseClient');

const WAREHANCE_API_KEY = process.env.WAREHANCE_API_KEY;
const WAREHANCE_BASE = process.env.WAREHANCE_API_URL || 'https://api.staging.warehance.com/v1';
const RATE_LIMIT_MS = 200; // ~5 req/sec

async function fetchWarehanceOrder(warehanceOrderId) {
  const res = await fetch(`${WAREHANCE_BASE}/orders/${warehanceOrderId}`, {
    headers: { 'X-API-KEY': WAREHANCE_API_KEY },
  });
  if (res.status === 200) {
    const j = await res.json();
    return j.data;
  }
  return null;
}

function parseShopifyOrderNum(s) {
  if (!s) return null;
  const m = String(s).replace('#', '').trim();
  const n = parseInt(m, 10);
  return Number.isFinite(n) ? n : null;
}

function parseWarehanceOrderId(orderIdField) {
  // "WH-231186112445-c59099de" -> 231186112445
  if (!orderIdField || !orderIdField.startsWith('WH-')) return null;
  const parts = orderIdField.split('-');
  if (parts.length < 2) return null;
  const n = parseInt(parts[1], 10);
  return Number.isFinite(n) ? n : null;
}

async function main() {
  const reresolve = process.argv.includes('--reresolve');
  const sb = getSupabaseClient();

  // 1. Pull rows to resolve
  let rows = [];
  let from = 0;
  while (true) {
    let q = sb.from('passport_invoices').select('id, tracking_id, order_id, shopify_order_number, resolution_method').range(from, from + 999);
    if (!reresolve) q = q.is('shopify_order_number', null);
    const { data, error } = await q;
    if (error) throw error;
    rows = rows.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }
  console.log(`Rows to resolve: ${rows.length}`);
  if (!rows.length) return;

  // 2. Build OFC tracking + order# lookup
  let ofcRows = [];
  from = 0;
  while (true) {
    const { data, error } = await sb.from('order_fulfillment_costs').select('order_number, tracking_numbers').range(from, from + 999);
    if (error) throw error;
    ofcRows = ofcRows.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }
  const trackingToOrder = {};
  const orderSet = new Set();
  for (const r of ofcRows) {
    orderSet.add(r.order_number);
    if (r.tracking_numbers) for (const tn of r.tracking_numbers) trackingToOrder[tn] = r.order_number;
  }
  console.log(`OFC orders: ${ofcRows.length}, distinct trackings: ${Object.keys(trackingToOrder).length}`);

  // 3. Resolve
  const stats = { tracking: 0, shopify_order_id: 0, warehance_api: 0, unresolved: 0 };
  const updates = []; // { id, shopify_order_number, resolution_method }
  const whCache = {};   // warehance_order_id -> shopify_order_number (or null)

  let i = 0;
  for (const r of rows) {
    i++;
    if (i % 100 === 0) process.stdout.write(`\r  Processed ${i}/${rows.length}...`);

    let resolved = null;
    let method = null;

    // Path 1: tracking
    if (r.tracking_id && trackingToOrder[r.tracking_id]) {
      resolved = trackingToOrder[r.tracking_id];
      method = 'tracking';
    }
    // Path 2: shopify order #
    else if (r.order_id?.startsWith('#')) {
      const n = parseShopifyOrderNum(r.order_id);
      if (n && orderSet.has(n)) {
        resolved = n;
        method = 'shopify_order_id';
      }
    }
    // Path 3: Warehance API
    else if (r.order_id?.startsWith('WH-')) {
      const whId = parseWarehanceOrderId(r.order_id);
      if (whId) {
        if (!(whId in whCache)) {
          const order = await fetchWarehanceOrder(whId);
          whCache[whId] = order?.order_number ? parseShopifyOrderNum(order.order_number) : null;
          await new Promise(rs => setTimeout(rs, RATE_LIMIT_MS));
        }
        if (whCache[whId]) {
          resolved = whCache[whId];
          method = 'warehance_api';
        }
      }
    }

    if (resolved) {
      stats[method]++;
      updates.push({ id: r.id, shopify_order_number: resolved, resolution_method: method });
    } else {
      stats.unresolved++;
    }
  }
  console.log(`\r  Processed ${rows.length}/${rows.length}            `);

  // 4. Bulk update
  console.log(`\nWriting ${updates.length} updates...`);
  const BATCH = 200;
  for (let i = 0; i < updates.length; i += BATCH) {
    const batch = updates.slice(i, i + BATCH);
    // Update each row individually since values differ
    for (const u of batch) {
      const { error } = await sb
        .from('passport_invoices')
        .update({ shopify_order_number: u.shopify_order_number, resolution_method: u.resolution_method })
        .eq('id', u.id);
      if (error) console.error(`  Failed id=${u.id}: ${error.message}`);
    }
    process.stdout.write(`\r  Written ${Math.min(i + BATCH, updates.length)}/${updates.length}...`);
  }
  console.log('');

  console.log('\n=== Resolution stats ===');
  console.log(`  via tracking:         ${stats.tracking}`);
  console.log(`  via shopify_order_id: ${stats.shopify_order_id}`);
  console.log(`  via warehance API:    ${stats.warehance_api}`);
  console.log(`  unresolved:           ${stats.unresolved}`);
  console.log(`  total:                ${rows.length}`);
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { main };
