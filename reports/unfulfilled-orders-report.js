#!/usr/bin/env node

/**
 * RUBIES Unfulfilled Orders Report
 *
 * Surfaces unfulfilled orders with reasons (Warehance holds, out of stock,
 * pre-order, etc.), operator notes, and resolved status.
 *
 * Usage:
 *   node reports/unfulfilled-orders-report.js
 *   node reports/unfulfilled-orders-report.js --note 24501 "confirming with customer"
 *   node reports/unfulfilled-orders-report.js --resolve 24501 "customer wants to wait"
 *   node reports/unfulfilled-orders-report.js --unresolve 24501 "customer changed mind"
 *   node reports/unfulfilled-orders-report.js --show-resolved
 *   node reports/unfulfilled-orders-report.js --json
 */

const path = require('path');
if (!process.env.SUPABASE_URL) {
  require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
}

const { getSupabaseClient } = require('../shared/supabaseClient');
const { getSendgridClient } = require('../shared/sendgridClient');
const { fetchUnfulfilledOrders, getHoldReasons, warehanceOrderUrl, cancelOrder } = require('./lib/warehanceClient');
const { resolveAddressHolds } = require('./lib/addressHoldResolver');

const SHOPIFY_STORE = 'rubies-active-wear';
const PRE_ORDER_TAG_RE = /pre-?order|backorder|coming soon/i;
const KNOWN_BUNDLE_IDS = new Set(['27324', '27097', '37526', '39799', '27022', '27019']);

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { showResolved: false, json: false, noteAction: null };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--show-resolved') {
      opts.showResolved = true;
    } else if (args[i] === '--json') {
      opts.json = true;
    } else if (args[i] === '--note' && args[i + 1] && args[i + 2]) {
      opts.noteAction = { type: 'note', orderNumber: parseInt(args[i + 1], 10), text: args[i + 2] };
      i += 2;
    } else if (args[i] === '--resolve' && args[i + 1] && args[i + 2]) {
      opts.noteAction = { type: 'resolve', orderNumber: parseInt(args[i + 1], 10), text: args[i + 2] };
      i += 2;
    } else if (args[i] === '--unresolve' && args[i + 1] && args[i + 2]) {
      opts.noteAction = { type: 'unresolve', orderNumber: parseInt(args[i + 1], 10), text: args[i + 2] };
      i += 2;
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function shopifyAdminUrl(shopifyOrderId) {
  // GID format: gid://shopify/Order/123456789 -> numeric ID
  const numericId = String(shopifyOrderId).replace(/.*\//, '');
  return `https://admin.shopify.com/store/${SHOPIFY_STORE}/orders/${numericId}`;
}

function businessDaysSince(dateStr) {
  const orderDate = new Date(dateStr);
  const now = new Date();
  let bd = 0;
  const d = new Date(orderDate);
  while (d < now) {
    d.setDate(d.getDate() + 1);
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) bd++;
  }
  return bd;
}

function hoursSince(dateStr) {
  return (Date.now() - new Date(dateStr).getTime()) / 3600000;
}

function isPreOrderByTags(tags) {
  if (!tags || !Array.isArray(tags)) return false;
  return tags.some(t => PRE_ORDER_TAG_RE.test(t));
}

// ---------------------------------------------------------------------------
// Phase 1: Fetch unfulfilled orders from Supabase
// ---------------------------------------------------------------------------

async function fetchUnfulfilledFromSupabase(supabase) {
  const { data, error } = await supabase
    .from('orders')
    .select('*, order_line_items(*)')
    .in('fulfillment_status', ['UNFULFILLED', 'PARTIALLY_FULFILLED'])
    .not('financial_status', 'in', '("REFUNDED","VOIDED")')
    .is('cancelled_at', null)
    .is('closed_at', null)
    .gt('total_price', 0)
    .order('created_at', { ascending: true });

  if (error) throw new Error(`Orders query failed: ${error.message}`);
  return data || [];
}

// ---------------------------------------------------------------------------
// Phase 2: Pre-order detection (tags + line item properties via Shopify)
// ---------------------------------------------------------------------------

async function fetchLineItemProperties(orders) {
  // Fetch customAttributes for unfulfilled orders from Shopify GraphQL
  // Batch 50 at a time
  let shopifyModule;
  try {
    shopifyModule = require('../customer-service/lib/shopify');
  } catch {
    console.warn('  Could not load Shopify GraphQL client, skipping line item property check');
    return new Map();
  }

  const propsMap = new Map(); // shopify_order_id -> [{key, value, variantId}]
  const orderIds = orders.map(o => o.shopify_order_id).filter(Boolean);

  for (let i = 0; i < orderIds.length; i += 20) {
    const batch = orderIds.slice(i, i + 20);
    const idFilter = batch.map(id => {
      const numId = String(id).replace(/.*\//, '');
      return `id:${numId}`;
    }).join(' OR ');

    const query = `{
      orders(first: 20, query: "${idFilter}") {
        edges {
          node {
            id
            lineItems(first: 50) {
              edges {
                node {
                  variant { id }
                  customAttributes { key value }
                }
              }
            }
          }
        }
      }
    }`;

    try {
      const data = await shopifyModule.shopifyGraphQL(query);
      for (const edge of (data.orders?.edges || [])) {
        const orderId = edge.node.id;
        const attrs = [];
        for (const liEdge of (edge.node.lineItems?.edges || [])) {
          for (const attr of (liEdge.node.customAttributes || [])) {
            attrs.push({
              key: attr.key,
              value: attr.value,
              variantId: liEdge.node.variant?.id,
            });
          }
        }
        propsMap.set(orderId, attrs);
      }
    } catch (err) {
      console.warn(`  Shopify batch query error (batch ${i}): ${err.message}`);
    }

    // Rate limit courtesy
    if (i + 20 < orderIds.length) await new Promise(r => setTimeout(r, 500));
  }

  return propsMap;
}

function classifyPreOrder(order, propsMap) {
  // Check order-level tags
  const orderIsPreOrder = isPreOrderByTags(order.tags);

  // Check line item properties
  const props = propsMap.get(order.shopify_order_id) || [];
  const hasPreOrderProp = props.some(p => p.key?.toLowerCase() === 'pre-order');
  const hasBundleId = props.some(p =>
    p.key === '_cs_bundle_id' && KNOWN_BUNDLE_IDS.has(String(p.value))
  );

  return orderIsPreOrder || hasPreOrderProp || hasBundleId;
}

// ---------------------------------------------------------------------------
// Phase 3: Inventory check
// ---------------------------------------------------------------------------

async function getInventoryMap(supabase, variantIds) {
  if (!variantIds.length) return new Map();

  // Get the latest snapshot date
  const { data: latestRow } = await supabase
    .from('inventory_snapshots')
    .select('date')
    .order('date', { ascending: false })
    .limit(1);

  if (!latestRow?.length) return new Map();
  const latestDate = latestRow[0].date;

  // Fetch inventory for the variants we care about
  // variant_id in inventory_snapshots may be numeric string
  const cleanIds = variantIds.map(v => String(v).replace(/.*\//, ''));

  const { data, error } = await supabase
    .from('inventory_snapshots')
    .select('variant_id, inventory_quantity, sku, product_handle')
    .eq('date', latestDate)
    .in('variant_id', cleanIds);

  if (error) {
    console.warn(`  Inventory query error: ${error.message}`);
    return new Map();
  }

  const map = new Map();
  for (const row of (data || [])) {
    map.set(String(row.variant_id), row);
  }
  return { map, snapshotDate: latestDate };
}

// ---------------------------------------------------------------------------
// Phase 4: Operator notes
// ---------------------------------------------------------------------------

async function handleNoteAction(supabase, action) {
  if (!action) return;
  const resolved = action.type === 'resolve' ? true : action.type === 'unresolve' ? false : null;

  const row = {
    order_number: action.orderNumber,
    note: action.text,
    author: 'operator',
  };
  if (resolved !== null) row.resolved = resolved;

  const { error } = await supabase
    .from('unfulfilled_order_notes')
    .insert(row);

  if (error) {
    console.error(`Failed to save note for #${action.orderNumber}: ${error.message}`);
  } else {
    const tag = action.type === 'resolve' ? ' (resolved)' : action.type === 'unresolve' ? ' (re-opened)' : '';
    console.log(`Note saved for #${action.orderNumber}${tag}: "${action.text}"`);
  }
}

async function fetchNotes(supabase, orderNumbers) {
  if (!orderNumbers.length) return new Map();

  const { data, error } = await supabase.rpc('get_latest_order_notes', {
    order_numbers: orderNumbers,
  });

  if (error) {
    // If RPC doesn't exist yet (table not created), fall back to direct query
    console.warn(`  Notes RPC error (run schema SQL?): ${error.message}`);
    return new Map();
  }

  const map = new Map();
  for (const row of (data || [])) {
    map.set(row.order_number, row);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Phase 5: Reason classification
// ---------------------------------------------------------------------------

function classifyOrder(order, whOrder, inventoryInfo, bd) {
  const holds = getHoldReasons(whOrder);

  // Priority-ordered classification
  if (bd < 1 && hoursSince(order.created_at) < 24) {
    return { reason: 'recently_placed', severity: 'normal', detail: null };
  }

  if (holds.includes('address_hold')) {
    return { reason: 'address_hold', severity: 'urgent', detail: 'Address flagged by warehouse' };
  }
  if (holds.includes('fraud_hold')) {
    return { reason: 'fraud_hold', severity: 'urgent', detail: 'Flagged for fraud review' };
  }
  if (holds.includes('payment_hold')) {
    return { reason: 'payment_hold', severity: 'attention', detail: 'Payment hold' };
  }
  if (holds.includes('warehouse_hold')) {
    return { reason: 'warehouse_hold', severity: 'attention', detail: 'Warehouse hold' };
  }
  if (holds.includes('allocation_hold')) {
    return { reason: 'allocation_hold', severity: 'attention', detail: 'Allocation hold' };
  }
  if (holds.includes('store_hold')) {
    return { reason: 'store_hold', severity: 'attention', detail: 'Store hold' };
  }

  // Check out of stock
  const oosItems = [];
  for (const li of (order.order_line_items || [])) {
    if (!li.shopify_variant_id) continue;
    const vid = String(li.shopify_variant_id).replace(/.*\//, '');
    const inv = inventoryInfo?.map?.get(vid);
    if (inv && inv.inventory_quantity <= 0) {
      oosItems.push(`${li.title} / ${li.variant_title || li.sku} (${inv.inventory_quantity} in stock)`);
    }
  }
  if (oosItems.length > 0) {
    return { reason: 'awaiting_stock', severity: 'urgent', detail: oosItems.join('; ') };
  }

  // Warehance status checks
  if (whOrder) {
    if (whOrder.fulfillment_status === 'in_progress') {
      return { reason: 'in_progress', severity: 'normal', detail: 'Being picked/packed at warehouse' };
    }
    if (whOrder.ready_to_ship) {
      return {
        reason: 'ready_to_ship',
        severity: 'normal',
        detail: 'Ready to ship — will go out next',
      };
    }
    // In Warehance but no holds and not ready
    if (whOrder.not_ready_to_ship_types) {
      const types = Object.entries(whOrder.not_ready_to_ship_types)
        .filter(([, v]) => v)
        .map(([k]) => k)
        .join(', ');
      if (types) {
        return { reason: 'not_ready', severity: 'attention', detail: `Not ready: ${types}` };
      }
    }
    return {
      reason: 'at_warehouse',
      severity: bd > 3 ? 'attention' : 'normal',
      detail: 'In Warehance, no holds detected',
    };
  }

  // Not found in Warehance
  if (bd > 2) {
    return { reason: 'not_in_warehouse', severity: 'urgent', detail: 'Not found in Warehance' };
  }

  return { reason: 'unknown', severity: bd > 5 ? 'urgent' : bd > 2 ? 'attention' : 'normal', detail: null };
}

// ---------------------------------------------------------------------------
// Phase 6: Output formatting
// ---------------------------------------------------------------------------

function formatConsole(results, opts) {
  const today = new Date().toISOString().split('T')[0];

  const preOrders = results.filter(r => r.isPreOrder);
  const resolved = results.filter(r => !r.isPreOrder && r.note?.resolved);
  const actionable = results.filter(r => !r.isPreOrder && !r.note?.resolved);

  // Orders with an active note (not resolved) go to "Waiting on Response"
  const waiting = actionable.filter(r => r.note && !r.note.resolved);
  const noNote = actionable.filter(r => !r.note || r.note.resolved);

  const autoResolved = noNote.filter(r => r.classification.severity === 'auto_resolved');
  const rest = noNote.filter(r => r.classification.severity !== 'auto_resolved');

  const urgent = rest.filter(r => r.classification.severity === 'urgent');
  const attention = rest.filter(r => r.classification.severity === 'attention');
  const normal = rest.filter(r => r.classification.severity === 'normal');

  const lines = [];
  lines.push(`\n=== RUBIES Unfulfilled Orders Report -- ${today} ===\n`);
  lines.push(`Total unfulfilled: ${results.length} | Pre-order: ${preOrders.length} | Auto-resolved: ${autoResolved.length} | Waiting: ${waiting.length} | Normal: ${normal.length} | Resolved: ${resolved.length} | Needs attention: ${urgent.length + attention.length}\n`);

  function printSection(title, orders) {
    if (!orders.length) return;
    lines.push(`\n--- ${title} (${orders.length} orders) ---`);
    for (const r of orders) {
      const date = r.order.created_at?.split('T')[0] || '?';
      const email = (r.order.customer_email || '?').padEnd(30);
      const reason = r.classification.reason.padEnd(20);
      const items = (r.order.order_line_items || [])
        .map(li => `${li.title}${li.variant_title ? ' / ' + li.variant_title : ''}`)
        .join(', ');
      const truncItems = items.length > 60 ? items.slice(0, 57) + '...' : items;

      lines.push(`#${String(r.order.order_number).padEnd(7)} ${date}  ${String(r.businessDays) + 'bd'}  ${email} ${reason} ${truncItems}`);

      if (r.classification.detail) {
        lines.push(`  Detail: ${r.classification.detail}`);
      }

      // Links
      lines.push(`  Shopify: ${r.shopifyUrl}`);
      if (r.warehanceUrl) {
        lines.push(`  Warehance: ${r.warehanceUrl}`);
      }

      // Note
      if (r.note) {
        const noteDate = r.note.created_at?.split('T')[0] || '?';
        const resolvedTag = r.note.resolved ? ' [RESOLVED]' : '';
        lines.push(`  Note [${noteDate}]: ${r.note.note} -- ${r.note.author}${resolvedTag}`);
      }
    }
  }

  printSection('URGENT', urgent);
  printSection('ATTENTION', attention);
  printSection('AUTO-RESOLVED (review)', autoResolved);
  printSection('WAITING ON RESPONSE', waiting);

  if (normal.length > 0) {
    lines.push(`\n--- NORMAL (${normal.length} orders, recently placed or in progress -- not shown) ---`);
  }

  // Stock issues summary
  const stockIssues = new Map();
  for (const r of actionable) {
    if (r.classification.reason !== 'awaiting_stock') continue;
    for (const li of (r.order.order_line_items || [])) {
      if (!li.shopify_variant_id) continue;
      const vid = String(li.shopify_variant_id).replace(/.*\//, '');
      const inv = r.inventoryInfo?.map?.get(vid);
      if (inv && inv.inventory_quantity <= 0) {
        const key = li.sku || `${li.title}/${li.variant_title}`;
        const existing = stockIssues.get(key) || {
          sku: li.sku || '-',
          product: li.title,
          variant: li.variant_title || '-',
          inventory: inv.inventory_quantity,
          ordersWaiting: 0,
        };
        existing.ordersWaiting++;
        stockIssues.set(key, existing);
      }
    }
  }

  if (stockIssues.size > 0) {
    lines.push('\n--- STOCK ISSUES ---');
    lines.push(`${'SKU'.padEnd(18)} ${'Product'.padEnd(25)} ${'Variant'.padEnd(15)} ${'Inv'.padStart(4)}  ${'Orders'.padStart(6)}`);
    for (const s of stockIssues.values()) {
      lines.push(`${s.sku.padEnd(18)} ${s.product.slice(0, 25).padEnd(25)} ${(s.variant || '-').slice(0, 15).padEnd(15)} ${String(s.inventory).padStart(4)}  ${String(s.ordersWaiting).padStart(6)}`);
    }
  }

  // Pre-orders (shown with full details)
  printSection('PRE-ORDER (customer informed)', preOrders);

  // Resolved
  if (resolved.length > 0) {
    if (opts.showResolved) {
      printSection('RESOLVED', resolved);
    } else {
      lines.push(`\n--- RESOLVED (${resolved.length} orders, use --show-resolved to see details) ---`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// HTML email formatting
// ---------------------------------------------------------------------------

function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

/** Shorten product names for email display (e.g. "THE AJ NO-TUCK SHAPING UNDERWEAR" → "AJ No-Tuck Underwear") */
function shortProductName(title) {
  if (!title) return '';
  return title
    .replace(/^THE\s+/i, '')
    .replace(/\s+SHAPING\s+/i, ' ')
    .replace(/\s+EXTRA CUTE\s+/i, ' ')
    .replace(/\s+EXTRA STRENGTH\s+/i, ' ')
    .replace(/\s+HIGH WAISTED\s+/i, ' ')
    .replace(/\s+SEAMLESS\s+/i, ' ')
    .replace(/MAGICAL SHAPING GEL CHEST PADS/i, 'Gel Chest Pads');
}

function formatEmailHtml(results, summary, errors = []) {
  const today = new Date().toISOString().split('T')[0];
  const preOrders = results.filter(r => r.isPreOrder);
  const resolved = results.filter(r => !r.isPreOrder && r.note?.resolved);
  const actionable = results.filter(r => !r.isPreOrder && !r.note?.resolved);

  const waiting = actionable.filter(r => r.note && !r.note.resolved);
  const noNote = actionable.filter(r => !r.note || r.note.resolved);

  const autoResolved = noNote.filter(r => r.classification.severity === 'auto_resolved');
  const rest = noNote.filter(r => r.classification.severity !== 'auto_resolved');

  const urgent = rest.filter(r => r.classification.severity === 'urgent');
  const attention = rest.filter(r => r.classification.severity === 'attention');
  const normal = rest.filter(r => r.classification.severity === 'normal');

  const severityColor = { urgent: '#dc2626', attention: '#f59e0b', normal: '#22c55e', info: '#6366f1', auto_resolved: '#0891b2' };

  function orderRow(r) {
    const date = r.order.created_at?.split('T')[0] || '?';
    const email = r.order.customer_email || '?';
    const itemLines = (r.order.order_line_items || [])
      .map(li => {
        const qty = li.quantity > 1 ? `${li.quantity} x ` : '';
        return `${qty}${esc(shortProductName(li.title))}${li.variant_title ? ' / ' + esc(li.variant_title) : ''}`;
      });
    const color = severityColor[r.classification.severity] || '#6b7280';
    const reasonLabel = r.classification.reason.replace(/_/g, ' ');

    let links = `<a href="${esc(r.shopifyUrl)}" style="color:#2563eb;">Shopify</a>`;
    if (r.warehanceUrl) {
      links += ` &middot; <a href="${esc(r.warehanceUrl)}" style="color:#2563eb;">Warehance</a>`;
    }

    let noteHtml = '';
    if (r.note) {
      const noteDate = r.note.created_at?.split('T')[0] || '?';
      const tag = r.note.resolved ? ' <span style="color:#22c55e;">[RESOLVED]</span>' : '';
      noteHtml = `<br><span style="color:#6b7280;font-size:12px;">Note [${esc(noteDate)}]: ${esc(r.note.note)} &mdash; ${esc(r.note.author)}${tag}</span>`;
    }

    return `<tr style="border-bottom:1px solid #e5e7eb;">
      <td style="padding:6px 10px;font-weight:bold;vertical-align:top;">#${r.order.order_number}</td>
      <td style="padding:6px 10px;vertical-align:top;">${esc(date)}</td>
      <td style="padding:6px 10px;vertical-align:top;">${r.businessDays}bd</td>
      <td style="padding:6px 10px;vertical-align:top;"><span style="background:${color};color:#fff;padding:2px 8px;border-radius:4px;font-size:12px;">${esc(reasonLabel)}</span></td>
      <td style="padding:6px 10px;font-size:13px;vertical-align:top;">${esc(email)}</td>
      <td style="padding:6px 10px;font-size:13px;vertical-align:top;">
        ${itemLines.join('<br>')}
        ${r.classification.detail ? `<br><span style="color:#6b7280;font-size:12px;">${esc(r.classification.detail)}</span>` : ''}
        <br>${links}${noteHtml}
      </td>
    </tr>`;
  }

  function section(title, orders, color) {
    if (!orders.length) return '';
    return `
      <h3 style="margin:24px 0 8px;color:${color};">${esc(title)} (${orders.length})</h3>
      <table style="border-collapse:collapse;font-size:13px;white-space:nowrap;">
        <tr style="background:#f9fafb;border-bottom:2px solid #e5e7eb;">
          <th style="padding:6px 10px;text-align:left;">Order</th>
          <th style="padding:6px 10px;text-align:left;">Date</th>
          <th style="padding:6px 10px;text-align:left;">Age</th>
          <th style="padding:6px 10px;text-align:left;">Reason</th>
          <th style="padding:6px 10px;text-align:left;">Customer</th>
          <th style="padding:6px 10px;text-align:left;">Items</th>
        </tr>
        ${orders.map(orderRow).join('\n')}
      </table>`;
  }

  // Stock issues table
  let stockHtml = '';
  const stockIssues = new Map();
  for (const r of actionable) {
    if (r.classification.reason !== 'awaiting_stock') continue;
    for (const li of (r.order.order_line_items || [])) {
      if (!li.shopify_variant_id) continue;
      const vid = String(li.shopify_variant_id).replace(/.*\//, '');
      const inv = r.inventoryInfo?.map?.get(vid);
      if (inv && inv.inventory_quantity <= 0) {
        const key = li.sku || `${li.title}/${li.variant_title}`;
        const existing = stockIssues.get(key) || {
          sku: li.sku || '-', product: li.title, variant: li.variant_title || '-',
          inventory: inv.inventory_quantity, ordersWaiting: 0,
        };
        existing.ordersWaiting++;
        stockIssues.set(key, existing);
      }
    }
  }
  if (stockIssues.size > 0) {
    stockHtml = `
      <h3 style="margin:24px 0 8px;color:#dc2626;">Stock Issues</h3>
      <table style="width:100%;border-collapse:collapse;font-family:monospace,monospace;font-size:13px;">
        <tr style="background:#f9fafb;border-bottom:2px solid #e5e7eb;">
          <th style="padding:8px;text-align:left;">SKU</th>
          <th style="padding:8px;text-align:left;">Product</th>
          <th style="padding:8px;text-align:left;">Variant</th>
          <th style="padding:8px;text-align:right;">Inventory</th>
          <th style="padding:8px;text-align:right;">Orders Waiting</th>
        </tr>
        ${[...stockIssues.values()].map(s => `
          <tr style="border-bottom:1px solid #e5e7eb;">
            <td style="padding:8px;">${esc(s.sku)}</td>
            <td style="padding:8px;">${esc(s.product)}</td>
            <td style="padding:8px;">${esc(s.variant)}</td>
            <td style="padding:8px;text-align:right;color:#dc2626;font-weight:bold;">${s.inventory}</td>
            <td style="padding:8px;text-align:right;">${s.ordersWaiting}</td>
          </tr>
        `).join('')}
      </table>`;
  }

  const needsAttention = urgent.length + attention.length + autoResolved.length > 0;
  const hasErrors = errors.length > 0;
  const statusEmoji = hasErrors ? '\u274c' : needsAttention ? '\u26a0\ufe0f' : '\u2705';

  return {
    subject: `${statusEmoji} Unfulfilled Orders Report \u2014 ${today} \u2014 ${summary.urgent + summary.attention} need attention${summary.urgent > 0 ? ` (${summary.urgent} urgent)` : ''}`,
    html: `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:900px;margin:0 auto;">
        <h2 style="margin-bottom:4px;">Unfulfilled Orders Report \u2014 ${today}</h2>
        <p style="color:#6b7280;margin-top:0;">
          Total: ${summary.total} &middot;
          Pre-order: ${summary.preOrder} &middot;
          Auto-resolved: ${autoResolved.length} &middot;
          Waiting: ${waiting.length} &middot;
          Normal: ${summary.normal} &middot;
          Resolved: ${summary.resolved} &middot;
          <strong>Needs attention: ${summary.urgent + summary.attention}</strong>
          (${summary.urgent} urgent, ${summary.attention} attention)
        </p>

        ${section('Urgent', urgent, '#dc2626')}
        ${section('Attention', attention, '#f59e0b')}
        ${stockHtml}
        ${section('Auto-Resolved (review)', autoResolved, '#0891b2')}
        ${section('Waiting on Response', waiting, '#f97316')}
        ${section('Pre-Order (customer informed)', preOrders, '#6366f1')}

        ${normal.length > 0 ? `<p style="color:#6b7280;margin-top:24px;">Normal: ${normal.length} orders (recently placed or in progress &mdash; not shown)</p>` : ''}
        ${resolved.length > 0 ? section('Resolved', resolved, '#9ca3af') : ''}
        ${errors.length > 0 ? `
          <h3 style="margin:24px 0 8px;color:#dc2626;">Errors</h3>
          <ul style="font-size:13px;color:#dc2626;">
            ${errors.map(e => `<li>${esc(e)}</li>`).join('\n')}
          </ul>
        ` : ''}
      </div>`,
  };
}

async function sendEmail(results, summary, errors = []) {
  const sgMail = getSendgridClient();
  if (!sgMail) {
    console.warn('SendGrid not configured (SENDGRID_API_KEY missing), skipping email');
    return;
  }

  const { subject, html } = formatEmailHtml(results, summary, errors);

  try {
    await sgMail.send({
      to: 'jamie@rubyshines.com',
      from: 'pipeline@rubyshines.com',
      subject,
      html,
      trackingSettings: {
        clickTracking: { enable: false, enableText: false },
      },
    });
    console.log('Email sent to jamie@rubyshines.com');
  } catch (err) {
    console.error('Failed to send email:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run() {
  const opts = parseArgs();
  const supabase = getSupabaseClient();

  // Handle note/resolve/unresolve action first
  if (opts.noteAction) {
    await handleNoteAction(supabase, opts.noteAction);
    console.log('');
  }

  console.log('RUBIES Unfulfilled Orders Report -- fetching data...\n');

  // Track errors for the email
  const errors = [];

  // Phase 0: Sync orders from Shopify so Supabase is fresh
  console.log('  [0/6] Syncing orders from Shopify...');
  try {
    const { runOrders } = require('../customer-service/sync/syncAll');
    const result = await runOrders();
    const rows = result?.sources?.orders?.rowsWritten || 0;
    console.log(`  Synced ${rows} orders`);
  } catch (err) {
    console.warn(`  Order sync error: ${err.message} -- continuing with existing data`);
    errors.push(`Shopify order sync: ${err.message}`);
  }

  // Phase 1: Fetch unfulfilled orders from Supabase
  console.log('  [1/6] Fetching unfulfilled orders from Supabase...');
  const orders = await fetchUnfulfilledFromSupabase(supabase);
  console.log(`  Found ${orders.length} unfulfilled orders`);

  if (!orders.length) {
    console.log('\nNo unfulfilled orders found. All clear!');
    return { results: [], summary: { total: 0 } };
  }

  // Phase 2: Pre-order detection
  console.log('  [2/6] Checking pre-order status...');
  const propsMap = await fetchLineItemProperties(orders);

  // Phase 3: Warehance enrichment
  console.log('  [3/6] Fetching Warehance order data...');
  let whOrders = new Map();
  try {
    whOrders = await fetchUnfulfilledOrders();
    console.log(`  Got ${whOrders.size} unfulfilled orders from Warehance`);
  } catch (err) {
    console.warn(`  Warehance API error: ${err.message} -- continuing without warehouse data`);
    errors.push(`Warehance API: ${err.message}`);
  }

  // Phase 3b: Cross-reference Warehance holds on Shopify-fulfilled orders
  // Find orders that Warehance thinks are unfulfilled/held but Shopify already fulfilled
  const autoCancelledOrders = [];
  if (whOrders.size > 0) {
    console.log('  [3b] Checking for Warehance holds on Shopify-fulfilled orders...');
    const whOrderNumbers = [...whOrders.keys()];

    // Query Supabase for orders that are FULFILLED in Shopify but unfulfilled in Warehance
    const { data: fulfilledInShopify } = await supabase
      .from('orders')
      .select('order_number, shopify_order_id, fulfillment_status, customer_email, created_at, total_price, shipping_address, order_line_items(*)')
      .in('order_number', whOrderNumbers.map(Number).filter(n => !isNaN(n)))
      .eq('fulfillment_status', 'FULFILLED')
      .is('cancelled_at', null);

    const staleWhOrders = (fulfilledInShopify || []).filter(o => {
      const whOrder = whOrders.get(String(o.order_number));
      return whOrder && ['unfulfilled', 'partially_fulfilled'].includes(whOrder.fulfillment_status);
    });

    if (staleWhOrders.length > 0) {
      console.log(`  Found ${staleWhOrders.length} orders fulfilled in Shopify but unfulfilled in Warehance`);

      for (const o of staleWhOrders) {
        const whOrder = whOrders.get(String(o.order_number));
        const hasHold = whOrder.has_hold;
        const holdReasons = getHoldReasons(whOrder);
        const noneShipped = (whOrder.order_items || []).every(i => (i.quantity_shipped || 0) === 0);

        if (noneShipped) {
          const reason = `Cancelled in Warehance: already fulfilled in Shopify${hasHold ? ' (had ' + holdReasons.join(', ') + ')' : ''}`;
          try {
            await cancelOrder(whOrder.id);
            console.log(`  Cancelled #${o.order_number} in Warehance`);

            await supabase.from('unfulfilled_order_notes').insert({
              order_number: o.order_number,
              note: `Auto: ${reason}`,
              resolved: true,
              author: 'auto',
            });

            // Track for report output
            autoCancelledOrders.push({
              order: o,
              isPreOrder: false,
              businessDays: businessDaysSince(o.created_at),
              classification: { reason: 'auto_cancelled', severity: 'auto_resolved', detail: reason },
              note: null,
              shopifyUrl: shopifyAdminUrl(o.shopify_order_id),
              warehanceUrl: warehanceOrderUrl(whOrder),
              inventoryInfo: null,
            });

            whOrders.delete(String(o.order_number));
          } catch (err) {
            console.warn(`  Failed to cancel #${o.order_number} in Warehance: ${err.message}`);
          }
        } else {
          console.log(`  Skipping #${o.order_number} — has shipped items in Warehance, needs manual review`);
        }
      }
    } else {
      console.log('  No stale Warehance orders found');
    }
  }

  // Phase 4: Inventory check
  console.log('  [4/6] Checking inventory levels...');
  const allVariantIds = [];
  for (const o of orders) {
    for (const li of (o.order_line_items || [])) {
      if (li.shopify_variant_id) allVariantIds.push(li.shopify_variant_id);
    }
  }
  const inventoryInfo = await getInventoryMap(supabase, allVariantIds);
  if (inventoryInfo.snapshotDate) {
    console.log(`  Inventory snapshot date: ${inventoryInfo.snapshotDate}`);
  }

  // Phase 5: Operator notes
  console.log('  [5/6] Loading operator notes...');
  const orderNumbers = orders.map(o => o.order_number);
  const notesMap = await fetchNotes(supabase, orderNumbers);
  console.log(`  Found notes for ${notesMap.size} orders`);

  // Phase 6: Classify and build results
  console.log('  [6/7] Classifying orders...');
  const results = orders.map(order => {
    const isPreOrder = classifyPreOrder(order, propsMap);
    const whOrder = whOrders.get(String(order.order_number));
    const bd = businessDaysSince(order.created_at);
    const classification = isPreOrder
      ? { reason: 'pre_order', severity: 'info', detail: 'Customer informed at purchase' }
      : classifyOrder(order, whOrder, inventoryInfo, bd);
    const note = notesMap.get(order.order_number) || null;

    return {
      order,
      isPreOrder,
      businessDays: bd,
      classification,
      note,
      shopifyUrl: shopifyAdminUrl(order.shopify_order_id),
      warehanceUrl: whOrder ? warehanceOrderUrl(whOrder) : null,
      inventoryInfo,
    };
  });

  // Phase 7: Auto-resolve address holds
  const addressHeldOrders = results.filter(r =>
    r.classification.reason === 'address_hold' && !r.note?.resolved
  );
  if (addressHeldOrders.length > 0) {
    console.log(`  [7/7] Auto-resolving ${addressHeldOrders.length} address hold(s)...`);
    const autoResults = await resolveAddressHolds(supabase, addressHeldOrders, whOrders);
    for (const ar of autoResults) {
      const r = results.find(x => x.order.order_number === ar.orderNumber);
      if (r && ar.autoResolved) {
        r.classification = {
          reason: 'auto_resolved',
          severity: 'auto_resolved',
          detail: `Address hold released — ${ar.reason}`,
        };
        r.autoResolveRule = ar.rule;
      }
    }
  } else {
    console.log('  [7/7] No address holds to auto-resolve');
  }

  // Merge auto-cancelled Warehance orders into results
  if (autoCancelledOrders.length > 0) {
    results.push(...autoCancelledOrders);
    console.log(`  Added ${autoCancelledOrders.length} auto-cancelled Warehance orders to report`);
  }
  console.log('');

  // Output
  if (opts.json) {
    const jsonOutput = results.map(r => ({
      order_number: r.order.order_number,
      created_at: r.order.created_at,
      customer_email: r.order.customer_email,
      business_days: r.businessDays,
      is_pre_order: r.isPreOrder,
      classification: r.classification,
      note: r.note,
      shopify_url: r.shopifyUrl,
      warehance_url: r.warehanceUrl,
      items: (r.order.order_line_items || []).map(li => ({
        title: li.title,
        variant: li.variant_title,
        sku: li.sku,
        quantity: li.quantity,
      })),
    }));
    console.log(JSON.stringify(jsonOutput, null, 2));
  } else {
    console.log(formatConsole(results, opts));
  }

  const actionable = results.filter(r => !r.isPreOrder && !r.note?.resolved);
  const summary = {
    total: results.length,
    preOrder: results.filter(r => r.isPreOrder).length,
    resolved: results.filter(r => !r.isPreOrder && r.note?.resolved).length,
    actionable: actionable.length,
    urgent: actionable.filter(r => r.classification.severity === 'urgent').length,
    attention: actionable.filter(r => r.classification.severity === 'attention').length,
    normal: actionable.filter(r => r.classification.severity === 'normal').length,
  };

  // Send email (unless --json mode or --note-only action)
  if (!opts.json) {
    await sendEmail(results, summary, errors);
  }

  return { results, summary };
}

module.exports = { run };

if (require.main === module) {
  run().catch(err => {
    console.error('FATAL:', err.message);
    process.exit(1);
  });
}
