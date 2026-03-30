#!/usr/bin/env node

/**
 * RUBIES — Daily Shipping Delay Alerts
 *
 * Scans all in-transit Nitro orders and flags:
 *   1. OVERDUE — outside expected delivery window for their zone
 *   2. STALE — no tracking update in 7+ days
 *   3. EXCEPTION — carrier reported a problem (action required, customs hold, etc.)
 *   4. RETURNED — package being sent back
 *   5. ACTION REQUIRED — customer needs to do something (customs payment, pickup, etc.)
 *
 * Sends a rich HTML email via SendGrid. Designed to run as part of daily-sync-all.js.
 *
 * Notes system (like unfulfilled-orders-report):
 *   --note 28868 "delivered per Passport tracking"
 *   --resolve 28868 "confirmed delivered"
 *   --unresolve 28868 "customer says not received"
 *   --show-resolved
 *
 * Usage:
 *   node customer-service/alerts/dailyShippingAlerts.js
 *   npm run cs-shipping-alerts
 */

const path = require('path');
if (!process.env.SUPABASE_URL) {
  require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
}

const { getSupabaseClient } = require('../../shared/supabaseClient');
const { getSendgridClient } = require('../../shared/sendgridClient');
const { shopifyGraphQL } = require('../lib/shopify');

const SHOPIFY_STORE = 'rubies-active-wear';
const NITRO_LOCATION_ID = '105921249558';

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { showResolved: false, noteAction: null };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--show-resolved') {
      opts.showResolved = true;
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

async function handleNoteAction(supabase, action) {
  const { type, orderNumber, text } = action;

  if (type === 'note') {
    await supabase.from('shipping_delay_notes').insert({
      order_number: orderNumber, note: text, resolved: false, author: 'operator',
    });
    console.log(`Note added to #${orderNumber}: "${text}"`);
  } else if (type === 'resolve') {
    await supabase.from('shipping_delay_notes').insert({
      order_number: orderNumber, note: text, resolved: true, author: 'operator',
    });
    console.log(`#${orderNumber} resolved: "${text}"`);
  } else if (type === 'unresolve') {
    await supabase.from('shipping_delay_notes').insert({
      order_number: orderNumber, note: text, resolved: false, author: 'operator',
    });
    console.log(`#${orderNumber} unresolved: "${text}"`);
  }
}

// Delivery windows by zone (business days) — matches analyzer.js
const DELIVERY_WINDOWS = {
  us:     { min: 2, max: 7 },
  canada: { min: 5, max: 10 },
  ddp:    { min: 5, max: 14 },
  ddu:    { min: 5, max: 14 },
};

// Action-required patterns in tracking events
const ACTION_REQUIRED_PATTERNS = [
  /action required/i,
  /customer.*collect/i,
  /pickup.*available/i,
  /held.*customs/i,
  /customs.*payment/i,
  /import.*charges/i,
  /pay.*dut/i,
  /addressee.*unknown/i,
  /address.*incorrect/i,
  /delivery.*attempt.*fail/i,
  /notice.*left/i,
  /awaiting.*collection/i,
  /return.*sender/i,
  /refused/i,
  /undeliverable/i,
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function businessDaysSince(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d)) return null;
  let count = 0;
  const cursor = new Date(d);
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  while (cursor < now) {
    cursor.setDate(cursor.getDate() + 1);
    if (cursor.getDay() !== 0 && cursor.getDay() !== 6) count++;
  }
  return count;
}

function calendarDaysSince(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d)) return null;
  return Math.round((Date.now() - d.getTime()) / 86400000);
}

function daysSinceLastEvent(events) {
  if (!Array.isArray(events) || events.length === 0) return null;
  const latest = events[0];
  const ts = latest.timestamp || `${latest.date} ${latest.time || ''}`.trim();
  let d = new Date(ts);
  if (isNaN(d) && latest.date) {
    d = new Date(`${latest.date} ${new Date().getFullYear()}`);
  }
  if (isNaN(d)) return null;
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days < 0 || days > 365) return null;
  return days;
}

function detectActionRequired(events) {
  if (!Array.isArray(events)) return null;
  const recent = events.slice(0, 5);
  for (const evt of recent) {
    const desc = evt.description || '';
    for (const pattern of ACTION_REQUIRED_PATTERNS) {
      if (pattern.test(desc)) return desc;
    }
  }
  return null;
}

function lastEventDescription(events) {
  if (!Array.isArray(events) || events.length === 0) return null;
  const latest = events[0];
  const date = latest.date || '';
  const desc = latest.description || '';
  return date ? `${date}: ${desc}` : desc;
}

function shopifyAdminUrl(shopifyOrderId) {
  if (!shopifyOrderId) return null;
  const numericId = String(shopifyOrderId).replace(/\D/g, '');
  return `https://admin.shopify.com/store/${SHOPIFY_STORE}/orders/${numericId}`;
}

// ---------------------------------------------------------------------------
// Shopify fulfillment events (for US orders without tracking snapshots)
// ---------------------------------------------------------------------------

const SHOPIFY_EVENT_ACTION_PATTERNS = [
  /delivery attempt.*fail/i,
  /notice left/i,
  /return(?:ed)? to sender/i,
  /addressee.*unknown/i,
  /address.*incorrect/i,
  /refused/i,
  /undeliverable/i,
  /unclaimed/i,
  /insufficient address/i,
  /no such/i,
];

/**
 * Fetch fulfillment events from Shopify for a batch of orders.
 * Returns map: orderNumber -> { status, events[], lastEvent, daysSinceLastEvent }
 */
async function fetchShopifyFulfillmentEvents(orderNumbers) {
  const eventMap = {};
  const BATCH = 10;

  for (let i = 0; i < orderNumbers.length; i += BATCH) {
    const batch = orderNumbers.slice(i, i + BATCH);
    const nameQuery = batch.map(n => 'name:#' + n).join(' OR ');

    try {
      const data = await shopifyGraphQL(`{
        orders(first: ${BATCH}, query: "${nameQuery}") {
          edges {
            node {
              name
              fulfillments {
                status
                deliveredAt
                trackingInfo { company }
                events(first: 10, sortKey: HAPPENED_AT, reverse: true) {
                  edges {
                    node {
                      happenedAt
                      status
                      message
                    }
                  }
                }
              }
            }
          }
        }
      }`);

      for (const edge of data.orders.edges) {
        const orderNum = parseInt(edge.node.name.replace('#', ''));
        const fulfillment = edge.node.fulfillments?.[0];
        if (!fulfillment) continue;

        const events = (fulfillment.events?.edges || []).map(e => e.node);
        const carrier = fulfillment.trackingInfo?.[0]?.company || '?';

        // Convert to same format as tracking_snapshots
        let lastEventDays = null;
        if (events.length > 0) {
          const latest = new Date(events[0].happenedAt);
          lastEventDays = Math.floor((Date.now() - latest.getTime()) / 86400000);
        }

        // Map Shopify status to our status format
        let currentStatus = 'unknown';
        if (fulfillment.deliveredAt) currentStatus = 'delivered';
        else if (events.length > 0) {
          const latestStatus = events[0].status;
          if (latestStatus === 'OUT_FOR_DELIVERY') currentStatus = 'out_for_delivery';
          else if (latestStatus === 'IN_TRANSIT') currentStatus = 'in_transit';
          else if (latestStatus === 'CONFIRMED') currentStatus = 'pre_transit';
          else if (latestStatus === 'FAILURE') currentStatus = 'exception';
          else if (latestStatus === 'ATTEMPTED_DELIVERY') currentStatus = 'exception';
          else currentStatus = 'in_transit';
        }

        // Check for action-required events
        let actionRequired = null;
        for (const ev of events.slice(0, 5)) {
          const msg = ev.message || '';
          for (const pattern of SHOPIFY_EVENT_ACTION_PATTERNS) {
            if (pattern.test(msg)) { actionRequired = msg; break; }
          }
          if (actionRequired) break;
        }

        eventMap[orderNum] = {
          carrier,
          currentStatus,
          events,
          lastEventDays,
          actionRequired,
          lastEventDesc: events.length > 0
            ? `${events[0].happenedAt?.split('T')[0]}: ${events[0].message || events[0].status}`
            : null,
        };
      }
    } catch (e) {
      console.warn(`  Warning: failed to fetch Shopify events for batch: ${e.message}`);
    }
  }

  return eventMap;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function checkShippingDelays({ showResolved = false } = {}) {
  const supabase = getSupabaseClient();
  const alerts = [];

  // Get recent in-transit orders (fulfilled in last 45 days, not delivered)
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - 45);
  const cutoff = cutoffDate.toISOString();

  // All current fulfillment goes through Nitro — include all fulfilled, undelivered orders
  let allOrders = [];
  let offset = 0;
  while (true) {
    const { data: orders } = await supabase
      .from('orders')
      .select('order_number, shopify_order_id, created_at, fulfilled_at, fulfillments, shipping_address, customer_email, total_price, shop_currency')
      .eq('fulfillment_status', 'FULFILLED')
      .not('fulfilled_at', 'is', null)
      .is('cancelled_at', null)
      .gte('fulfilled_at', cutoff)
      .order('order_number', { ascending: false })
      .range(offset, offset + 999);

    if (!orders || orders.length === 0) break;
    offset += orders.length;

    for (const o of orders) {
      const hasDeliveredAt = (o.fulfillments || []).some(f => f.deliveredAt);
      if (!hasDeliveredAt) allOrders.push(o);
    }
  }

  console.log(`Found ${allOrders.length} in-transit Nitro orders`);

  if (allOrders.length === 0) {
    return { alerts: [], summary: 'No in-transit orders to check.', totalInTransit: 0 };
  }

  // Get tracking snapshots
  const orderNums = allOrders.map(o => o.order_number);
  const snapMap = {};
  for (let i = 0; i < orderNums.length; i += 500) {
    const batch = orderNums.slice(i, i + 500);
    const { data: snaps } = await supabase
      .from('tracking_snapshots')
      .select('order_number, carrier, current_status, raw_events, last_location, local_carrier, customs_cleared, estimated_delivery, scraped_at, summary')
      .in('order_number', batch);
    for (const s of (snaps || [])) snapMap[s.order_number] = s;
  }

  // Get notes for these orders
  const noteMap = {};
  try {
    const { data: notes } = await supabase.rpc('get_latest_shipping_notes', {
      order_numbers: orderNums,
    });
    for (const n of (notes || [])) noteMap[n.order_number] = n;
  } catch (e) {
    // Table may not exist yet — continue without notes
  }

  // Fetch Shopify fulfillment events for orders without tracking snapshots
  const ordersNeedingShopifyEvents = orderNums.filter(n => !snapMap[n]);
  console.log(`Fetching Shopify events for ${ordersNeedingShopifyEvents.length} orders without tracking snapshots...`);
  const shopifyEventMap = ordersNeedingShopifyEvents.length > 0
    ? await fetchShopifyFulfillmentEvents(ordersNeedingShopifyEvents)
    : {};

  // Get line items for context
  const itemMap = {};
  for (let i = 0; i < orderNums.length; i += 500) {
    const batch = orderNums.slice(i, i + 500);
    const { data: items } = await supabase
      .from('order_line_items')
      .select('order_number, title, variant_title, quantity')
      .in('order_number', batch);
    for (const li of (items || [])) {
      if (!itemMap[li.order_number]) itemMap[li.order_number] = [];
      itemMap[li.order_number].push(li);
    }
  }

  // Analyze each order
  for (const order of allOrders) {
    const addr = order.shipping_address || {};
    const cc = addr.countryCode || '?';
    const zone = cc === 'US' ? 'us' : cc === 'CA' ? 'canada' : 'ddp';
    const window = DELIVERY_WINDOWS[zone] || DELIVERY_WINDOWS.ddu;
    const bizDays = businessDaysSince(order.fulfilled_at);
    const calDays = calendarDaysSince(order.fulfilled_at);
    const snap = snapMap[order.order_number];
    const shopifyEvt = shopifyEventMap[order.order_number];

    // Skip if delivered (from snapshot or Shopify events)
    if (snap?.current_status === 'delivered') continue;
    if (shopifyEvt?.currentStatus === 'delivered') continue;

    // Get tracking URL from fulfillments
    const trackingFulfillment = (order.fulfillments || []).find(f => f.trackingUrl);
    const isPassport = (trackingFulfillment?.trackingUrl || '').includes('passport');

    // Determine carrier and status from best available source
    const carrierName = snap?.carrier || shopifyEvt?.carrier || (isPassport ? 'passport' : '?');
    const currentStatus = snap?.current_status || shopifyEvt?.currentStatus || 'unknown';
    const lastEvent = snap?.raw_events
      ? lastEventDescription(snap.raw_events)
      : shopifyEvt?.lastEventDesc || null;

    const alert = {
      order_number: order.order_number,
      shopify_order_id: order.shopify_order_id,
      customer_email: order.customer_email,
      order_date: order.created_at?.split('T')[0],
      ship_date: order.fulfilled_at?.split('T')[0],
      total_price: order.total_price,
      currency: order.shop_currency || 'CAD',
      country: cc,
      province: addr.provinceCode || '',
      city: addr.city || '',
      destination: [addr.city, addr.provinceCode, cc].filter(Boolean).join(', '),
      zone,
      business_days: bizDays,
      calendar_days: calDays,
      carrier: carrierName,
      local_carrier: snap?.local_carrier || null,
      tracking_url: trackingFulfillment?.trackingUrl || null,
      tracking_number: trackingFulfillment?.trackingNumber || null,
      status: currentStatus,
      last_location: snap?.last_location || null,
      last_event: lastEvent,
      customs_cleared: snap?.customs_cleared,
      items: (itemMap[order.order_number] || []).map(li => {
        const qty = li.quantity > 1 ? `${li.quantity}x ` : '';
        return `${qty}${li.title}${li.variant_title ? ' / ' + li.variant_title : ''}`;
      }),
      issues: [],
      severity: 'info',
    };

    // --- Exception / returned checks (from either source) ---
    if (currentStatus === 'exception') {
      const msg = shopifyEvt?.events?.[0]?.message || 'Carrier reported an exception';
      alert.issues.push(`Exception: ${msg}`);
      alert.severity = 'high';
    }
    if (currentStatus === 'returned') {
      alert.issues.push('Package being returned to sender');
      alert.severity = 'high';
    }

    // --- Action required (from tracking snapshots or Shopify events) ---
    if (snap?.raw_events) {
      const actionDesc = detectActionRequired(snap.raw_events);
      if (actionDesc) {
        // Don't flag customs hold if customs already cleared
        const isCustomsHold = /held.*customs|customs.*payment|customs.*hold/i.test(actionDesc);
        if (!isCustomsHold || !snap.customs_cleared) {
          alert.issues.push(`Action required: ${actionDesc}`);
          alert.severity = 'high';
        }
      }
    }
    if (shopifyEvt?.actionRequired) {
      alert.issues.push(`Action required: ${shopifyEvt.actionRequired}`);
      alert.severity = 'high';
    }

    // --- Stale tracking (from either source) ---
    let staleDays = null;
    if (snap?.raw_events) {
      staleDays = daysSinceLastEvent(snap.raw_events);
    } else if (shopifyEvt?.lastEventDays != null) {
      staleDays = shopifyEvt.lastEventDays;
    }

    if (staleDays !== null && staleDays >= 14) {
      alert.issues.push(`No tracking update in ${staleDays} days — likely lost`);
      alert.severity = 'high';
    } else if (staleDays !== null && staleDays >= 7) {
      alert.issues.push(`No tracking update in ${staleDays} days`);
      if (alert.severity !== 'high') alert.severity = 'medium';
    }

    // --- Overdue (but only if we have tracking data to confirm it's stuck) ---
    if (bizDays !== null && bizDays > window.max) {
      if (staleDays === null) {
        // No tracking data at all — don't flag, we can't confirm it's stuck
      } else if (staleDays <= 4) {
        // Tracking updated in last ~3 business days — still moving, don't flag
      } else {
        // Overdue AND tracking is stale — flag it
        alert.issues.push(`${bizDays} business days in transit (expected ${window.min}–${window.max})`);
        if (alert.severity === 'info') alert.severity = 'medium';
      }
    }

    // --- Customs hold ---
    if (snap?.customs_cleared === false && bizDays > 10 && zone !== 'us') {
      alert.issues.push(`Customs not cleared after ${bizDays} business days`);
      if (alert.severity === 'info') alert.severity = 'medium';
    }

    if (alert.issues.length > 0) {
      alert.note = noteMap[order.order_number] || null;
      alerts.push(alert);
    }
  }

  // Separate resolved from active
  const resolved = alerts.filter(a => a.note?.resolved);
  const active = alerts.filter(a => !a.note?.resolved);

  // Sort: high first, then by business days desc
  const severityOrder = { high: 0, medium: 1, info: 2 };
  const sortFn = (a, b) =>
    (severityOrder[a.severity] || 9) - (severityOrder[b.severity] || 9)
    || (b.business_days || 0) - (a.business_days || 0);

  active.sort(sortFn);
  resolved.sort(sortFn);

  const high = active.filter(a => a.severity === 'high').length;
  const medium = active.filter(a => a.severity === 'medium').length;
  const summary = `${active.length} delays (${high} urgent, ${medium} delayed), ${resolved.length} resolved — ${allOrders.length} in transit`;
  console.log(summary);

  return { alerts: active, resolved: showResolved ? resolved : [], summary, totalInTransit: allOrders.length, resolvedCount: resolved.length };
}

// ---------------------------------------------------------------------------
// HTML email formatting — matches unfulfilled-orders-report style
// ---------------------------------------------------------------------------

function formatAlertHtml(result) {
  const { alerts, resolved, summary, totalInTransit, resolvedCount } = result;
  const today = new Date().toISOString().split('T')[0];

  const high = alerts.filter(a => a.severity === 'high');
  const medium = alerts.filter(a => a.severity === 'medium');

  const severityColor = { high: '#dc2626', medium: '#f59e0b' };
  const severityLabel = { high: 'urgent', medium: 'delayed' };

  function alertRow(a) {
    const color = severityColor[a.severity] || '#6b7280';
    const shopifyUrl = shopifyAdminUrl(a.shopify_order_id);

    let links = '';
    if (shopifyUrl) links += `<a href="${esc(shopifyUrl)}" style="color:#2563eb;text-decoration:none;">Shopify</a>`;
    if (a.tracking_url) {
      if (links) links += ' &middot; ';
      links += `<a href="${esc(a.tracking_url)}" style="color:#2563eb;text-decoration:none;">Track</a>`;
    }

    const carrierText = [a.carrier, a.local_carrier].filter(Boolean).join(' → ');
    const itemsHtml = a.items.length > 0
      ? a.items.map(i => esc(i)).join('<br>')
      : '<span style="color:#9ca3af;">—</span>';

    const issuesHtml = a.issues
      .map(i => `<span style="color:${color};">▸ ${esc(i)}</span>`)
      .join('<br>');

    const lastEventHtml = a.last_event
      ? `<br><span style="color:#6b7280;font-size:11px;">Last event: ${esc(a.last_event)}</span>`
      : '';

    let noteHtml = '';
    if (a.note) {
      const noteDate = a.note.created_at?.split('T')[0] || '?';
      const tag = a.note.resolved ? ' <span style="color:#22c55e;">[RESOLVED]</span>' : '';
      noteHtml = `<br><span style="color:#6b7280;font-size:11px;">Note [${esc(noteDate)}]: ${esc(a.note.note)} — ${esc(a.note.author)}${tag}</span>`;
    }

    return `<tr style="border-bottom:1px solid #e5e7eb;">
      <td style="padding:8px 10px;font-weight:bold;vertical-align:top;">
        #${a.order_number}<br>
        <span style="font-weight:normal;font-size:12px;color:#6b7280;">${links}</span>
      </td>
      <td style="padding:8px 10px;vertical-align:top;font-size:13px;">
        ${esc(a.customer_email || '?')}<br>
        <span style="color:#6b7280;font-size:12px;">${esc(a.destination)}</span>
      </td>
      <td style="padding:8px 10px;vertical-align:top;font-size:13px;">
        Ordered: ${esc(a.order_date || '?')}<br>
        Shipped: ${esc(a.ship_date || '?')}<br>
        <strong>${a.business_days}bd</strong> <span style="color:#6b7280;">(${a.calendar_days}d)</span>
      </td>
      <td style="padding:8px 10px;vertical-align:top;font-size:13px;">
        ${esc(carrierText || '?')}<br>
        <span style="background:${color};color:#fff;padding:2px 8px;border-radius:4px;font-size:11px;">${esc(severityLabel[a.severity] || a.severity)}</span>
      </td>
      <td style="padding:8px 10px;vertical-align:top;font-size:12px;">
        ${issuesHtml}${lastEventHtml}${noteHtml}
      </td>
      <td style="padding:8px 10px;vertical-align:top;font-size:12px;">
        ${itemsHtml}
      </td>
    </tr>`;
  }

  function section(title, orders, color) {
    if (!orders.length) return '';
    return `
      <h3 style="margin:24px 0 8px;color:${color};">${esc(title)} (${orders.length})</h3>
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <tr style="background:#f9fafb;border-bottom:2px solid #e5e7eb;">
          <th style="padding:6px 10px;text-align:left;">Order</th>
          <th style="padding:6px 10px;text-align:left;">Customer</th>
          <th style="padding:6px 10px;text-align:left;">Dates</th>
          <th style="padding:6px 10px;text-align:left;">Carrier</th>
          <th style="padding:6px 10px;text-align:left;">Issues</th>
          <th style="padding:6px 10px;text-align:left;">Items</th>
        </tr>
        ${orders.map(alertRow).join('\n')}
      </table>`;
  }

  return {
    subject: `${high.length > 0 ? '\u26A0\uFE0F' : '\uD83D\uDCE6'} Shipping Alerts \u2014 ${today} \u2014 ${alerts.length} delays${high.length > 0 ? ` (${high.length} urgent)` : ''}`,
    html: `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:1000px;margin:0 auto;">
        <h2 style="margin-bottom:4px;">Shipping Delay Alerts \u2014 ${today}</h2>
        <p style="color:#6b7280;margin-top:0;">
          In transit: ${totalInTransit} &middot;
          <strong style="color:#dc2626;">Urgent: ${high.length}</strong> &middot;
          <span style="color:#f59e0b;">Delayed: ${medium.length}</span> &middot;
          Resolved: ${resolvedCount || 0} &middot;
          On track: ${totalInTransit - alerts.length - (resolvedCount || 0)}
        </p>

        ${alerts.length === 0 ? '<p style="color:#22c55e;font-weight:bold;">All clear \u2014 no shipping delays detected.</p>' : ''}
        ${section('Urgent \u2014 Action Needed', high, '#dc2626')}
        ${section('Delayed \u2014 Monitor', medium, '#f59e0b')}
        ${resolved.length > 0 ? section('Resolved (ignored)', resolved, '#9ca3af') : ''}
        ${resolvedCount > 0 && resolved.length === 0 ? `<p style="color:#9ca3af;margin-top:16px;">${resolvedCount} resolved orders not shown (use --show-resolved)</p>` : ''}
      </div>`,
  };
}

// ---------------------------------------------------------------------------
// Pipeline-compatible run() for daily-sync-all.js
// ---------------------------------------------------------------------------

async function run() {
  try {
    const result = await checkShippingDelays();
    const { subject, html } = formatAlertHtml(result);

    // Console summary
    console.log(`\n${result.summary}`);

    // Send email if there are alerts
    if (result.alerts.length > 0) {
      const sgMail = getSendgridClient();
      if (sgMail) {
        await sgMail.send({
          to: 'jamie@rubyshines.com',
          from: 'pipeline@rubyshines.com',
          subject,
          html,
          trackingSettings: { clickTracking: { enable: false, enableText: false } },
        });
        console.log('Alert email sent.');
      }
    } else {
      console.log('No delays — skipping email.');
    }

    return {
      sources: {
        shipping_alerts: {
          success: true,
          rowsWritten: result.alerts.length,
          detail: result.summary,
        },
      },
      status: 'ok',
    };
  } catch (e) {
    console.error('Shipping alerts error:', e.message);
    return {
      sources: {
        shipping_alerts: { success: false, rowsWritten: 0, error: e.message },
      },
      status: 'error',
    };
  }
}

if (require.main === module) {
  (async () => {
    const opts = parseArgs();
    const supabase = getSupabaseClient();

    // Handle note/resolve/unresolve action — then exit (no report/email)
    if (opts.noteAction) {
      await handleNoteAction(supabase, opts.noteAction);
      return;
    }

    // Run the alert check + send email
    const result = await checkShippingDelays({ showResolved: opts.showResolved });
    const { subject, html } = formatAlertHtml(result);
    console.log(`\n${result.summary}`);

    if (result.alerts.length > 0) {
      const sgMail = getSendgridClient();
      if (sgMail) {
        await sgMail.send({
          to: 'jamie@rubyshines.com',
          from: 'pipeline@rubyshines.com',
          subject,
          html,
          trackingSettings: { clickTracking: { enable: false, enableText: false } },
        });
        console.log('Alert email sent.');
      }
    } else {
      console.log('No delays — skipping email.');
    }
  })().catch(e => { console.error('Error:', e.message); process.exit(1); });
}

module.exports = { checkShippingDelays, run };
