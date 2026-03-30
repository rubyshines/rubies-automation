#!/usr/bin/env node

/**
 * RUBIES — Daily Shipping Delay Alerts + Passport Claims
 *
 * Scans in-transit orders, detects delays, and:
 *   1. Auto-creates Passport claims for urgent international issues
 *   2. Auto-emails Passport support (grouped) for investigation
 *   3. Auto-emails DDU customers stuck in customs (once per order)
 *   4. Sends daily HTML alert email to Jamie
 *
 * CLI:
 *   --note ORDER "text"           Add a note to a shipping delay
 *   --resolve ORDER "text"        Resolve (hide from alerts)
 *   --unresolve ORDER "text"      Unresolve
 *   --claim-delivered ORDER "text" Mark Passport claim as delivered
 *   --claim-lost ORDER "text"     Mark claim as lost (need reimbursement)
 *   --claim-resolved ORDER "text"  Mark claim as resolved (reimbursed/written off)
 *   --claim-note ORDER "text"     Add note to claim
 *   --show-resolved               Include resolved in report
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
const { businessDaysSince: sharedBusinessDaysSince } = require('../../shared/businessDays');

const SHOPIFY_STORE = 'rubies-active-wear';

// Delivery windows by zone (business days)
const DELIVERY_WINDOWS = {
  us:     { min: 2, max: 7 },
  canada: { min: 5, max: 10 },
  ddp:    { min: 5, max: 14 },
  ddu:    { min: 5, max: 14 },
};

const ACTION_REQUIRED_PATTERNS = [
  /action required/i, /customer.*collect/i, /pickup.*available/i,
  /held.*customs/i, /customs.*payment/i, /import.*charges/i, /pay.*dut/i,
  /addressee.*unknown/i, /address.*incorrect/i, /delivery.*attempt.*fail/i,
  /notice.*left/i, /awaiting.*collection/i, /return.*sender/i,
  /refused/i, /undeliverable/i,
];

const SHOPIFY_EVENT_ACTION_PATTERNS = [
  /delivery attempt.*fail/i, /notice left/i, /return(?:ed)? to sender/i,
  /addressee.*unknown/i, /address.*incorrect/i, /refused/i,
  /undeliverable/i, /unclaimed/i, /insufficient address/i, /no such/i,
];

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { showResolved: false, action: null };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--show-resolved') {
      opts.showResolved = true;
    } else if (['--note', '--resolve', '--unresolve'].includes(args[i]) && args[i + 1] && args[i + 2]) {
      opts.action = { type: args[i].replace('--', ''), orderNumber: parseInt(args[i + 1], 10), text: args[i + 2] };
      i += 2;
    } else if (['--claim-delivered', '--claim-lost', '--claim-resolved', '--claim-note'].includes(args[i]) && args[i + 1]) {
      const claimStatus = args[i].replace('--claim-', '');
      opts.action = { type: 'claim', claimStatus, orderNumber: parseInt(args[i + 1], 10), text: args[i + 2] || '' };
      i += 2;
    }
  }
  return opts;
}

async function handleAction(supabase, action) {
  if (action.type === 'claim') {
    const { claimStatus, orderNumber, text } = action;
    if (claimStatus === 'note') {
      const today = new Date().toISOString().split('T')[0];
      const { data: claim } = await supabase.from('passport_claims').select('resolution').eq('order_number', orderNumber).maybeSingle();
      if (!claim) { console.log(`No claim found for #${orderNumber}`); return; }
      const updated = claim.resolution ? `${claim.resolution}\n[${today}] ${text}` : `[${today}] ${text}`;
      await supabase.from('passport_claims').update({ resolution: updated }).eq('order_number', orderNumber);
      console.log(`Note added to claim #${orderNumber}: "${text}"`);
    } else {
      await supabase.from('passport_claims').update({
        status: claimStatus === 'resolved' ? 'resolved' : claimStatus,
        resolution: text || null,
        resolution_date: new Date().toISOString(),
      }).eq('order_number', orderNumber);
      console.log(`Claim #${orderNumber} → ${claimStatus}: "${text}"`);
    }
  } else {
    const resolved = action.type === 'resolve';
    await supabase.from('shipping_delay_notes').insert({
      order_number: action.orderNumber, note: action.text, resolved, author: 'operator',
    });
    console.log(`#${action.orderNumber} ${action.type}d: "${action.text}"`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function businessDaysSince(dateStr) {
  return sharedBusinessDaysSince(dateStr);
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
  if (isNaN(d) && latest.date) d = new Date(`${latest.date} ${new Date().getFullYear()}`);
  if (isNaN(d)) return null;
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days < 0 || days > 365) return null;
  return days;
}

function detectActionRequired(events) {
  if (!Array.isArray(events)) return null;
  for (const evt of events.slice(0, 5)) {
    const desc = evt.description || '';
    for (const p of ACTION_REQUIRED_PATTERNS) { if (p.test(desc)) return desc; }
  }
  return null;
}

function lastEventDescription(events) {
  if (!Array.isArray(events) || events.length === 0) return null;
  const latest = events[0];
  return latest.date ? `${latest.date}: ${latest.description || ''}` : latest.description || '';
}

function shopifyAdminUrl(shopifyOrderId) {
  if (!shopifyOrderId) return null;
  return `https://admin.shopify.com/store/${SHOPIFY_STORE}/orders/${String(shopifyOrderId).replace(/\D/g, '')}`;
}

// ---------------------------------------------------------------------------
// Shopify fulfillment events (for orders without tracking snapshots)
// ---------------------------------------------------------------------------

async function fetchShopifyFulfillmentEvents(orderNumbers) {
  const eventMap = {};
  const BATCH = 10;
  for (let i = 0; i < orderNumbers.length; i += BATCH) {
    const batch = orderNumbers.slice(i, i + BATCH);
    const nameQuery = batch.map(n => 'name:#' + n).join(' OR ');
    try {
      const data = await shopifyGraphQL(`{
        orders(first: ${BATCH}, query: "${nameQuery}") {
          edges { node { name fulfillments {
            status deliveredAt trackingInfo { company }
            events(first: 10, sortKey: HAPPENED_AT, reverse: true) {
              edges { node { happenedAt status message } }
            }
          } } }
        }
      }`);
      for (const edge of data.orders.edges) {
        const orderNum = parseInt(edge.node.name.replace('#', ''));
        const f = edge.node.fulfillments?.[0];
        if (!f) continue;
        const events = (f.events?.edges || []).map(e => e.node);
        let lastEventDays = null;
        if (events.length > 0) lastEventDays = Math.floor((Date.now() - new Date(events[0].happenedAt).getTime()) / 86400000);
        let currentStatus = 'unknown';
        if (f.deliveredAt) currentStatus = 'delivered';
        else if (events.length > 0) {
          const s = events[0].status;
          if (s === 'OUT_FOR_DELIVERY') currentStatus = 'out_for_delivery';
          else if (s === 'FAILURE') currentStatus = 'exception';
          else if (s === 'ATTEMPTED_DELIVERY') currentStatus = 'exception';
          else currentStatus = 'in_transit';
        }
        let actionRequired = null;
        for (const ev of events.slice(0, 5)) {
          for (const p of SHOPIFY_EVENT_ACTION_PATTERNS) { if (p.test(ev.message || '')) { actionRequired = ev.message; break; } }
          if (actionRequired) break;
        }
        eventMap[orderNum] = {
          carrier: f.trackingInfo?.[0]?.company || '?', currentStatus, events, lastEventDays, actionRequired,
          lastEventDesc: events.length > 0 ? `${events[0].happenedAt?.split('T')[0]}: ${events[0].message || events[0].status}` : null,
        };
      }
    } catch (e) { console.warn(`  Warning: Shopify events fetch failed: ${e.message}`); }
  }
  return eventMap;
}

// ---------------------------------------------------------------------------
// Main analysis
// ---------------------------------------------------------------------------

async function checkShippingDelays({ showResolved = false } = {}) {
  const supabase = getSupabaseClient();
  const alerts = [];

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - 45);
  const cutoff = cutoffDate.toISOString();

  // Fetch all in-transit orders
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
      if (!(o.fulfillments || []).some(f => f.deliveredAt)) allOrders.push(o);
    }
  }

  console.log(`Found ${allOrders.length} in-transit orders`);
  if (allOrders.length === 0) {
    return { alerts: [], passportClaims: [], customsAlerts: [], summary: 'No in-transit orders.', totalInTransit: 0 };
  }

  const orderNums = allOrders.map(o => o.order_number);

  // Load tracking snapshots
  const snapMap = {};
  for (let i = 0; i < orderNums.length; i += 500) {
    const batch = orderNums.slice(i, i + 500);
    const { data } = await supabase.from('tracking_snapshots')
      .select('order_number, carrier, current_status, raw_events, last_location, local_carrier, customs_cleared, estimated_delivery, scraped_at')
      .in('order_number', batch);
    for (const s of (data || [])) snapMap[s.order_number] = s;
  }

  // Load existing notes
  const noteMap = {};
  try {
    const { data } = await supabase.rpc('get_latest_shipping_notes', { order_numbers: orderNums });
    for (const n of (data || [])) noteMap[n.order_number] = n;
  } catch (e) { /* table may not exist */ }

  // Load existing Passport claims
  const claimMap = {};
  try {
    const { data } = await supabase.from('passport_claims')
      .select('*')
      .in('order_number', orderNums);
    for (const c of (data || [])) claimMap[c.order_number] = c;
  } catch (e) { /* table may not exist */ }

  // Fetch Shopify events for orders without snapshots
  const needsShopify = orderNums.filter(n => !snapMap[n]);
  console.log(`Fetching Shopify events for ${needsShopify.length} orders without tracking snapshots...`);
  const shopifyEventMap = needsShopify.length > 0 ? await fetchShopifyFulfillmentEvents(needsShopify) : {};

  // Load line items
  const itemMap = {};
  for (let i = 0; i < orderNums.length; i += 500) {
    const batch = orderNums.slice(i, i + 500);
    const { data } = await supabase.from('order_line_items')
      .select('order_number, title, variant_title, quantity')
      .in('order_number', batch);
    for (const li of (data || [])) {
      if (!itemMap[li.order_number]) itemMap[li.order_number] = [];
      itemMap[li.order_number].push(li);
    }
  }

  // Track new claims and customs notifications to send
  const newClaims = [];
  const customsAlerts = [];

  // Analyze each order
  for (const order of allOrders) {
    const addr = order.shipping_address || {};
    const cc = addr.countryCode || '?';
    const zone = cc === 'US' ? 'us' : cc === 'CA' ? 'canada' : 'ddp';
    const bizDays = businessDaysSince(order.fulfilled_at);
    const calDays = calendarDaysSince(order.fulfilled_at);
    const snap = snapMap[order.order_number];
    const shopifyEvt = shopifyEventMap[order.order_number];
    const window = DELIVERY_WINDOWS[zone] || DELIVERY_WINDOWS.ddu;

    if (snap?.current_status === 'delivered') continue;
    if (shopifyEvt?.currentStatus === 'delivered') continue;

    const trackingFulfillment = (order.fulfillments || []).find(f => f.trackingUrl);
    const isPassport = (trackingFulfillment?.trackingUrl || '').includes('passport');
    const carrierName = snap?.carrier || shopifyEvt?.carrier || (isPassport ? 'passport' : '?');
    const currentStatus = snap?.current_status || shopifyEvt?.currentStatus || 'unknown';
    const lastEvent = snap?.raw_events ? lastEventDescription(snap.raw_events) : shopifyEvt?.lastEventDesc || null;

    // Determine shipping zone more precisely
    let shippingZone = zone;
    if (isPassport && zone !== 'us') {
      // Check if DDU via shipping_zones table or fallback
      // DDP countries have duties prepaid; DDU don't
      // For simplicity, use 'ddp' as default for non-US/CA (most intl is DDP)
      shippingZone = zone;
    }

    const alert = {
      order_number: order.order_number,
      shopify_order_id: order.shopify_order_id,
      customer_email: order.customer_email,
      order_date: order.created_at?.split('T')[0],
      ship_date: order.fulfilled_at?.split('T')[0],
      total_price: order.total_price,
      currency: order.shop_currency || 'CAD',
      country: cc, province: addr.provinceCode || '', city: addr.city || '',
      destination: [addr.city, addr.provinceCode, cc].filter(Boolean).join(', '),
      zone: shippingZone,
      business_days: bizDays, calendar_days: calDays,
      carrier: carrierName, local_carrier: snap?.local_carrier || null,
      tracking_url: trackingFulfillment?.trackingUrl || null,
      tracking_number: trackingFulfillment?.trackingNumber || null,
      status: currentStatus, last_location: snap?.last_location || null,
      last_event: lastEvent, customs_cleared: snap?.customs_cleared,
      isPassport,
      items: (itemMap[order.order_number] || []).map(li => {
        const qty = li.quantity > 1 ? `${li.quantity}x ` : '';
        return `${qty}${li.title}${li.variant_title ? ' / ' + li.variant_title : ''}`;
      }),
      issues: [], severity: 'info', claimReason: null,
    };

    // --- Exception / returned ---
    if (currentStatus === 'exception') {
      const msg = shopifyEvt?.events?.[0]?.message || 'Carrier reported an exception';
      alert.issues.push(`Exception: ${msg}`);
      alert.severity = 'high';
      alert.claimReason = 'exception';
    }
    if (currentStatus === 'returned') {
      alert.issues.push('Package being returned to sender');
      alert.severity = 'high';
      alert.claimReason = 'returned';
    }

    // --- Action required ---
    if (snap?.raw_events) {
      const actionDesc = detectActionRequired(snap.raw_events);
      if (actionDesc) {
        const isCustomsHold = /held.*customs|customs.*payment|customs.*hold/i.test(actionDesc);
        if (!isCustomsHold || !snap.customs_cleared) {
          alert.issues.push(`Action required: ${actionDesc}`);
          alert.severity = 'high';
          if (!alert.claimReason) alert.claimReason = isCustomsHold ? 'customs_hold' : 'exception';
        }
      }
    }
    if (shopifyEvt?.actionRequired) {
      alert.issues.push(`Action required: ${shopifyEvt.actionRequired}`);
      alert.severity = 'high';
      if (!alert.claimReason) alert.claimReason = 'exception';
    }

    // --- Stale tracking ---
    let staleDays = null;
    if (snap?.raw_events) staleDays = daysSinceLastEvent(snap.raw_events);
    else if (shopifyEvt?.lastEventDays != null) staleDays = shopifyEvt.lastEventDays;

    if (staleDays !== null && staleDays >= 14) {
      alert.issues.push(`No tracking update in ${staleDays} days — likely lost`);
      alert.severity = 'high';
      if (!alert.claimReason) alert.claimReason = 'likely_lost';
    } else if (staleDays !== null && staleDays >= 7) {
      alert.issues.push(`No tracking update in ${staleDays} days`);
      if (alert.severity !== 'high') alert.severity = 'medium';
    }

    // --- Overdue (only if tracking data confirms stale) ---
    if (bizDays !== null && bizDays > window.max) {
      if (staleDays === null) {
        // No tracking data — don't flag
      } else if (staleDays <= 4) {
        // Still moving — don't flag
      } else {
        alert.issues.push(`${bizDays} business days in transit (expected ${window.min}–${window.max})`);
        if (alert.severity === 'info') alert.severity = 'medium';
      }
    }

    // --- Customs hold (early warning for DDU at 5bd) ---
    if (snap?.customs_cleared === false && bizDays > 5 && zone !== 'us' && isPassport) {
      // Check if this is a DDU zone
      const existingClaim = claimMap[order.order_number];
      if (!existingClaim?.customer_customs_notified_at) {
        customsAlerts.push(alert);
      }
      if (bizDays > 10) {
        alert.issues.push(`Customs not cleared after ${bizDays} business days`);
        if (alert.severity === 'info') alert.severity = 'medium';
      }
    }

    if (alert.issues.length === 0) continue;

    // --- Check if this should be a new Passport claim ---
    if (alert.severity === 'high' && isPassport && !claimMap[order.order_number]) {
      newClaims.push(alert);
    }

    alert.note = noteMap[order.order_number] || null;
    alert.claim = claimMap[order.order_number] || null;
    alerts.push(alert);
  }

  // --- Create new Passport claims ---
  if (newClaims.length > 0) {
    console.log(`Creating ${newClaims.length} new Passport claims...`);
    // Load shipping costs for claims
    const claimNums = newClaims.map(a => a.order_number);
    const costMap = {};
    try {
      const { data } = await supabase.from('order_fulfillment_costs')
        .select('order_number, shipping_fee_usd, ddp_total_usd')
        .in('order_number', claimNums);
      for (const c of (data || [])) costMap[c.order_number] = c;
    } catch (e) { /* table may not exist */ }

    for (const alert of newClaims) {
      const costs = costMap[alert.order_number] || {};
      const claim = {
        order_number: alert.order_number,
        tracking_number: alert.tracking_number,
        country_code: alert.country,
        destination: alert.destination,
        customer_email: alert.customer_email,
        shipping_zone: alert.zone,
        status: 'open',
        claim_reason: alert.claimReason,
        emailed_at: new Date().toISOString(),
        shipping_fee_usd: costs.shipping_fee_usd || null,
        ddp_total_usd: costs.ddp_total_usd || null,
      };

      const { error } = await supabase.from('passport_claims').upsert(claim, { onConflict: 'order_number' });
      if (error) console.error(`  Failed to create claim for #${alert.order_number}: ${error.message}`);
      else {
        claimMap[alert.order_number] = claim;
        alert.claim = claim;
      }
    }

    // Send grouped email to Passport
    await sendPassportEmail(newClaims);
  }

  // --- Send customs notification emails ---
  if (customsAlerts.length > 0) {
    for (const alert of customsAlerts) {
      if (!alert.customer_email) continue;
      await sendCustomsNotificationEmail(supabase, alert);
    }
  }

  // --- Categorize alerts (resolved first, then bucket the rest) ---
  const resolved = alerts.filter(a => a.note?.resolved || a.claim?.status === 'delivered' || a.claim?.status === 'resolved');
  const resolvedSet = new Set(resolved.map(a => a.order_number));
  const active = alerts.filter(a => !resolvedSet.has(a.order_number));

  const passportPending = active.filter(a => a.claim?.status === 'open');
  const passportLost = active.filter(a => a.claim?.status === 'lost');
  const urgentNonPassport = active.filter(a => a.severity === 'high' && !a.claim);
  const delayed = active.filter(a => a.severity === 'medium' && !a.claim);

  const sortFn = (a, b) => (b.business_days || 0) - (a.business_days || 0);
  passportPending.sort(sortFn);
  passportLost.sort(sortFn);
  urgentNonPassport.sort(sortFn);
  delayed.sort(sortFn);

  const summary = [
    `${active.length} alerts`,
    urgentNonPassport.length ? `${urgentNonPassport.length} urgent` : null,
    passportPending.length ? `${passportPending.length} Passport claims` : null,
    passportLost.length ? `${passportLost.length} lost` : null,
    delayed.length ? `${delayed.length} delayed` : null,
    resolved.length ? `${resolved.length} resolved` : null,
    `${allOrders.length} in transit`,
  ].filter(Boolean).join(', ');

  console.log(summary);

  return {
    alerts: active,
    urgentNonPassport, passportPending, passportLost, customsAlerts, delayed,
    resolved: showResolved ? resolved : [],
    summary, totalInTransit: allOrders.length, resolvedCount: resolved.length,
    newClaimsCount: newClaims.length,
  };
}

// ---------------------------------------------------------------------------
// Email to Passport support
// ---------------------------------------------------------------------------

async function sendPassportEmail(claims) {
  const sgMail = getSendgridClient();
  if (!sgMail || claims.length === 0) return;

  const lines = ['Hi,', '', 'The following packages shipped but tracking has not updated. Can you please investigate?', ''];

  for (const a of claims) {
    lines.push(`Order #${a.order_number} — Tracking: ${a.tracking_number || '?'} — Destination: ${a.destination}`);
    lines.push(`  Shipped: ${a.ship_date || '?'} — Last update: ${a.business_days} business days ago`);
    if (a.claimReason === 'returned') lines.push(`  Status: Package being returned to sender`);
    if (a.claimReason === 'exception') lines.push(`  Status: Carrier exception reported`);
    lines.push('');
  }

  lines.push('Thanks,', 'Jamie');

  try {
    await sgMail.send({
      to: 'partners@passportglobal.com',
      from: { email: 'jamie@rubyshines.com', name: 'Jamie Alexander' },
      cc: ['jamie@rubyshines.com'],
      replyTo: 'jamie@rubyshines.com',
      subject: `RUBIES — Shipping Investigation Request — ${claims.length} package${claims.length > 1 ? 's' : ''}`,
      text: lines.join('\n'),
      trackingSettings: { clickTracking: { enable: false, enableText: false } },
    });
    console.log(`Passport email sent (${claims.length} claims)`);
  } catch (e) {
    console.error('Failed to send Passport email:', e.message);
  }
}

// ---------------------------------------------------------------------------
// Customs notification email to customer
// ---------------------------------------------------------------------------

async function sendCustomsNotificationEmail(supabase, alert) {
  const sgMail = getSendgridClient();
  if (!sgMail) return;

  const countryName = alert.destination?.split(',').pop()?.trim() || alert.country;
  const trackingLink = alert.tracking_url || '';

  const text = `Hi,

Just a quick heads up — your RUBIES order #${alert.order_number} is currently going through customs in ${countryName}. This is normal for international shipments but sometimes customs requires a small payment before they release the package.

If you receive a notice from your local post office or customs authority asking for a payment, please go ahead and pay it. Send us the receipt and we'll reimburse you.

${trackingLink ? `You can track your package here: ${trackingLink}\n\n` : ''}If you have any questions, just reply to this email.

Thanks,
Jamie Alexander
RUBIES Founder`;

  try {
    await sgMail.send({
      to: alert.customer_email,
      from: { email: 'jamie@rubyshines.com', name: 'Jamie Alexander' },
      cc: ['jamie@rubyshines.com'],
      replyTo: 'jamie@rubyshines.com',
      subject: `Your RUBIES order #${alert.order_number} — customs update`,
      text,
      trackingSettings: { clickTracking: { enable: false, enableText: false } },
    });

    // Mark as notified so we don't email again
    await supabase.from('passport_claims').upsert({
      order_number: alert.order_number,
      tracking_number: alert.tracking_number,
      country_code: alert.country,
      destination: alert.destination,
      customer_email: alert.customer_email,
      shipping_zone: alert.zone,
      status: 'open',
      claim_reason: 'customs_hold',
      customer_customs_notified_at: new Date().toISOString(),
    }, { onConflict: 'order_number' });

    console.log(`  Customs email sent to ${alert.customer_email} for #${alert.order_number}`);
  } catch (e) {
    console.error(`  Failed to send customs email for #${alert.order_number}: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// HTML email formatting
// ---------------------------------------------------------------------------

function formatAlertHtml(result) {
  const { urgentNonPassport, passportPending, passportLost, delayed, resolved,
          summary, totalInTransit, resolvedCount } = result;
  const today = new Date().toISOString().split('T')[0];

  const severityColor = { high: '#dc2626', medium: '#f59e0b', claim_open: '#0891b2', claim_lost: '#dc2626' };
  const severityLabel = { high: 'urgent', medium: 'delayed', claim_open: 'claim open', claim_lost: 'lost' };

  function alertRow(a, overrideColor, overrideLabel) {
    const color = overrideColor || severityColor[a.severity] || '#6b7280';
    const label = overrideLabel || severityLabel[a.severity] || a.severity;
    const shopifyUrl = shopifyAdminUrl(a.shopify_order_id);

    let links = '';
    if (shopifyUrl) links += `<a href="${esc(shopifyUrl)}" style="color:#2563eb;text-decoration:none;">Shopify</a>`;
    if (a.tracking_url) {
      if (links) links += ' &middot; ';
      links += `<a href="${esc(a.tracking_url)}" style="color:#2563eb;text-decoration:none;">Track</a>`;
    }

    const carrierText = [a.carrier, a.local_carrier].filter(Boolean).join(' \u2192 ');
    const issuesHtml = a.issues.map(i => `<span style="color:${color};">\u25B8 ${esc(i)}</span>`).join('<br>');
    const lastEventHtml = a.last_event ? `<br><span style="color:#6b7280;font-size:11px;">Last: ${esc(a.last_event)}</span>` : '';

    let noteHtml = '';
    if (a.note) {
      const bg = a.note.resolved ? '#f0fdf4' : '#fffbeb';
      const border = a.note.resolved ? '#22c55e' : '#f59e0b';
      const textColor = a.note.resolved ? '#166534' : '#92400e';
      const tag = a.note.resolved ? ' [RESOLVED]' : '';
      noteHtml = `<br><span style="display:inline-block;margin-top:4px;padding:3px 8px;background:${bg};border-left:3px solid ${border};font-size:11px;color:${textColor};">Note: ${esc(a.note.note)}${tag}</span>`;
    }
    if (a.claim?.customer_customs_notified_at) {
      const notifiedDate = a.claim.customer_customs_notified_at.split('T')[0];
      noteHtml += `<br><span style="display:inline-block;margin-top:4px;padding:3px 8px;background:#f0fdfa;border-left:3px solid #0891b2;font-size:11px;color:#0891b2;">Customer emailed about customs: ${esc(notifiedDate)}</span>`;
    }
    if (a.claim?.emailed_at) {
      const claimDate = a.claim.emailed_at.split('T')[0];
      noteHtml += `<br><span style="display:inline-block;margin-top:4px;padding:3px 8px;background:#f0fdfa;border-left:3px solid #0891b2;font-size:11px;color:#0891b2;">Passport notified: ${esc(claimDate)}</span>`;
    }
    if (a.claim?.resolution) {
      noteHtml += `<br><span style="display:inline-block;margin-top:4px;padding:3px 8px;background:#f0fdf4;border-left:3px solid #22c55e;font-size:11px;color:#166534;">Claim: ${esc(a.claim.resolution)}</span>`;
    }

    return `<tr style="border-bottom:1px solid #e5e7eb;">
      <td style="padding:8px 10px;font-weight:bold;vertical-align:top;">#${a.order_number}<br><span style="font-weight:normal;font-size:12px;color:#6b7280;">${links}</span></td>
      <td style="padding:8px 10px;vertical-align:top;font-size:13px;">${esc(a.customer_email || '?')}<br><span style="color:#6b7280;font-size:12px;">${esc(a.destination)}</span></td>
      <td style="padding:8px 10px;vertical-align:top;font-size:13px;">Ordered: ${esc(a.order_date || '?')}<br>Shipped: ${esc(a.ship_date || '?')}<br><strong>${a.business_days}bd</strong> <span style="color:#6b7280;">(${a.calendar_days}d)</span></td>
      <td style="padding:8px 10px;vertical-align:top;font-size:13px;">${esc(carrierText || '?')}<br><span style="background:${color};color:#fff;padding:2px 8px;border-radius:4px;font-size:11px;">${esc(label)}</span></td>
      <td style="padding:8px 10px;vertical-align:top;font-size:12px;">${issuesHtml}${lastEventHtml}${noteHtml}</td>
    </tr>`;
  }

  function section(title, orders, color, rowColor, rowLabel) {
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
        </tr>
        ${orders.map(a => alertRow(a, rowColor, rowLabel)).join('\n')}
      </table>`;
  }

  const totalAlerts = urgentNonPassport.length + passportPending.length + passportLost.length + delayed.length;
  const hasUrgent = urgentNonPassport.length > 0 || passportLost.length > 0;

  return {
    subject: `${hasUrgent ? '\u26A0\uFE0F' : '\uD83D\uDCE6'} Shipping Alerts \u2014 ${today} \u2014 ${totalAlerts} issue${totalAlerts !== 1 ? 's' : ''}${passportPending.length ? ` \u2014 ${passportPending.length} Passport claim${passportPending.length !== 1 ? 's' : ''}` : ''}`,
    html: `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:1000px;margin:0 auto;">
        <h2 style="margin-bottom:4px;">Shipping Alerts \u2014 ${today}</h2>
        <p style="color:#6b7280;margin-top:0;">
          In transit: ${totalInTransit}
          ${urgentNonPassport.length ? ` &middot; <strong style="color:#dc2626;">Urgent: ${urgentNonPassport.length}</strong>` : ''}
          ${passportPending.length ? ` &middot; <span style="color:#0891b2;">Passport claims: ${passportPending.length}</span>` : ''}
          ${passportLost.length ? ` &middot; <strong style="color:#dc2626;">Lost: ${passportLost.length}</strong>` : ''}
          ${delayed.length ? ` &middot; <span style="color:#f59e0b;">Delayed: ${delayed.length}</span>` : ''}
          ${resolvedCount ? ` &middot; Resolved: ${resolvedCount}` : ''}
        </p>

        ${totalAlerts === 0 ? '<p style="color:#22c55e;font-weight:bold;">All clear \u2014 no shipping issues detected.</p>' : ''}
        ${section('Urgent \u2014 Action Needed', urgentNonPassport, '#dc2626')}
        ${section('Passport Claims \u2014 Pending', passportPending, '#0891b2', '#0891b2', 'claim open')}
        ${section('Passport Claims \u2014 Lost', passportLost, '#dc2626', '#dc2626', 'lost')}
        ${section('Delayed \u2014 Monitor', delayed, '#f59e0b')}
        ${resolved.length > 0 ? section('Resolved', resolved, '#9ca3af', '#9ca3af', 'resolved') : ''}
        ${resolvedCount > 0 && resolved.length === 0 ? `<p style="color:#9ca3af;margin-top:16px;">${resolvedCount} resolved not shown (use --show-resolved)</p>` : ''}
      </div>`,
  };
}

// ---------------------------------------------------------------------------
// Pipeline run()
// ---------------------------------------------------------------------------

async function run() {
  try {
    const result = await checkShippingDelays();
    const { subject, html } = formatAlertHtml(result);
    console.log(`\n${result.summary}`);

    const totalAlerts = (result.urgentNonPassport?.length || 0) + (result.passportPending?.length || 0)
      + (result.passportLost?.length || 0) + (result.delayed?.length || 0);

    if (totalAlerts > 0) {
      const sgMail = getSendgridClient();
      if (sgMail) {
        await sgMail.send({
          to: 'jamie@rubyshines.com', from: 'pipeline@rubyshines.com',
          subject, html,
          trackingSettings: { clickTracking: { enable: false, enableText: false } },
        });
        console.log('Alert email sent.');
      }
    } else {
      console.log('No issues — skipping email.');
    }

    return {
      sources: { shipping_alerts: { success: true, rowsWritten: totalAlerts, detail: result.summary } },
      status: 'ok',
    };
  } catch (e) {
    console.error('Shipping alerts error:', e.message);
    return { sources: { shipping_alerts: { success: false, rowsWritten: 0, error: e.message } }, status: 'error' };
  }
}

// ---------------------------------------------------------------------------
// Standalone
// ---------------------------------------------------------------------------

if (require.main === module) {
  (async () => {
    const opts = parseArgs();
    const supabase = getSupabaseClient();

    if (opts.action) {
      await handleAction(supabase, opts.action);
      return;
    }

    const result = await checkShippingDelays({ showResolved: opts.showResolved });
    const { subject, html } = formatAlertHtml(result);
    console.log(`\n${result.summary}`);

    const totalAlerts = (result.urgentNonPassport?.length || 0) + (result.passportPending?.length || 0)
      + (result.passportLost?.length || 0) + (result.delayed?.length || 0);

    if (totalAlerts > 0) {
      const sgMail = getSendgridClient();
      if (sgMail) {
        await sgMail.send({
          to: 'jamie@rubyshines.com', from: 'pipeline@rubyshines.com',
          subject, html,
          trackingSettings: { clickTracking: { enable: false, enableText: false } },
        });
        console.log('Alert email sent.');
      }
    } else {
      console.log('No issues — skipping email.');
    }
  })().catch(e => { console.error('Error:', e.message); process.exit(1); });
}

module.exports = { checkShippingDelays, run };
