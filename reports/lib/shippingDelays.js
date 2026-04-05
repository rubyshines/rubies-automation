/**
 * Shipping Delays Analysis Module
 *
 * Extracted from customer-service/alerts/dailyShippingAlerts.js for use by dailyOrderAlerts.js.
 * Scans in-transit orders, detects delays, auto-creates Passport claims,
 * sends Passport investigation emails, and notifies DDU customers about customs.
 *
 * Exports: checkShippingDelays() — returns structured results.
 */

const { getSupabaseClient } = require('../../shared/supabaseClient');
const { getSendgridClient } = require('../../shared/sendgridClient');
const { shopifyGraphQL } = require('../../customer-service/lib/shopify');
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

// Patterns that indicate a package is actually held at or being checked by customs
const CUSTOMS_HOLD_EVENT_PATTERNS = [
  /held at customs/i,
  /parcel is being checked by customs/i,
  /customs clearance in progress/i,
  /customs.*payment/i,
  /import.*charges/i,
];

// Patterns that indicate customs has been cleared (package moved past customs)
const CUSTOMS_CLEARED_EVENT_PATTERNS = [
  /customs cleared/i,
  /passed customs/i,
  /released from customs/i,
  /released by import customs/i,
  /destination customs.*released/i,
];

/**
 * Check if tracking events show the package is currently held at customs.
 * Returns the customs hold event description if found, null otherwise.
 * Does NOT trigger if customs has already been cleared after the hold.
 */
function detectCustomsHold(events) {
  if (!events || !events.length) return null;
  // Events are most-recent-first
  let holdEvent = null;
  for (const evt of events) {
    const desc = evt.description || '';
    // If we see a cleared event before a hold event, customs is already resolved
    if (CUSTOMS_CLEARED_EVENT_PATTERNS.some(p => p.test(desc))) return null;
    if (!holdEvent && CUSTOMS_HOLD_EVENT_PATTERNS.some(p => p.test(desc))) {
      holdEvent = desc;
    }
  }
  return holdEvent;
}

const SHOPIFY_EVENT_ACTION_PATTERNS = [
  /delivery attempt.*fail/i, /notice left/i, /return(?:ed)? to sender/i,
  /addressee.*unknown/i, /address.*incorrect/i, /refused/i,
  /undeliverable/i, /unclaimed/i, /insufficient address/i, /no such/i,
];

// Exceptions that are customer-initiated — not actionable, skip alerting
const BENIGN_EXCEPTION_PATTERNS = [
  /held at post office.*at customer request/i,
  /customer requested.*hold/i,
  /hold for pickup.*requested/i,
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
    if (BENIGN_EXCEPTION_PATTERNS.some(p => p.test(desc))) continue;
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
    } catch (e) { console.warn(`  [Shipping] Shopify events fetch failed: ${e.message}`); }
  }
  return eventMap;
}

// ---------------------------------------------------------------------------
// Passport investigation email
// ---------------------------------------------------------------------------

async function sendPassportEmail(claims) {
  const sgMail = getSendgridClient();
  if (!sgMail || claims.length === 0) return;

  const lines = ['Hi,', '', 'The following packages shipped but tracking has not updated. Can you please investigate?', ''];

  for (const a of claims) {
    lines.push(`Order #${a.order_number} - Tracking: ${a.tracking_number || '?'} - Destination: ${a.destination}`);
    lines.push(`  Shipped: ${a.ship_date || '?'} - Last update: ${a.business_days} business days ago`);
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
      subject: `RUBIES - Shipping Investigation Request - ${claims.length} package${claims.length > 1 ? 's' : ''}`,
      text: lines.join('\n'),
      trackingSettings: { clickTracking: { enable: false, enableText: false } },
    });
    console.log(`  [Shipping] Passport email sent (${claims.length} claims)`);
  } catch (e) {
    console.error('  [Shipping] Failed to send Passport email:', e.message);
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

Just a quick heads up - your RUBIES order #${alert.order_number} is currently going through customs in ${countryName}. This is normal for international shipments but sometimes customs requires a small payment before they release the package.

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
      subject: `Your RUBIES order #${alert.order_number} - customs update`,
      text,
      trackingSettings: { clickTracking: { enable: false, enableText: false } },
    });

    // Mark as notified
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

    console.log(`  [Shipping] Customs email sent to ${alert.customer_email} for #${alert.order_number}`);
  } catch (e) {
    console.error(`  [Shipping] Failed to send customs email for #${alert.order_number}: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Main analysis
// ---------------------------------------------------------------------------

/**
 * Analyze all in-transit orders and return structured results.
 * Also auto-creates Passport claims and sends investigation/customs emails.
 *
 * @param {{ showResolved?: boolean }} opts
 * @returns {{ alerts, urgentNonPassport, passportPending, passportLost, customsAlerts, delayed, resolved, summary, totalInTransit, resolvedCount, newClaimsCount }}
 */
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

  console.log(`  [Shipping] Found ${allOrders.length} in-transit orders`);
  if (allOrders.length === 0) {
    return { alerts: [], urgentNonPassport: [], passportPending: [], passportLost: [], customsAlerts: [], delayed: [], resolved: [], summary: 'No in-transit orders.', totalInTransit: 0, resolvedCount: 0, newClaimsCount: 0 };
  }

  const orderNums = allOrders.map(o => o.order_number);

  // Load shipping zones for accurate DDP/DDU classification
  const zoneMap = {};
  const { data: zones } = await supabase.from('shipping_zones').select('country_code, zone');
  for (const z of (zones || [])) zoneMap[z.country_code] = z.zone;

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
    const { data } = await supabase.rpc('get_latest_alert_notes', { order_numbers: orderNums });
    for (const n of (data || [])) noteMap[n.order_number] = n;
  } catch {
    try {
      const { data } = await supabase.rpc('get_latest_shipping_notes', { order_numbers: orderNums });
      for (const n of (data || [])) noteMap[n.order_number] = n;
    } catch { /* table may not exist */ }
  }

  // Load existing Passport claims
  const claimMap = {};
  try {
    const { data } = await supabase.from('passport_claims')
      .select('*')
      .in('order_number', orderNums);
    for (const c of (data || [])) claimMap[c.order_number] = c;
  } catch { /* table may not exist */ }

  // Fetch Shopify events for orders without snapshots
  const needsShopify = orderNums.filter(n => !snapMap[n]);
  console.log(`  [Shipping] Fetching Shopify events for ${needsShopify.length} orders without tracking snapshots...`);
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

  // Track new claims and customs notifications
  const newClaims = [];
  const customsAlerts = [];

  // Analyze each order
  for (const order of allOrders) {
    const addr = order.shipping_address || {};
    const cc = addr.countryCode || '?';
    const zone = cc === 'US' ? 'us' : cc === 'CA' ? 'canada' : (zoneMap[cc] || 'ddu');
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

    let shippingZone = zone;

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
      alertType: 'shipping',
    };

    // Exception / returned
    if (currentStatus === 'exception') {
      const msg = shopifyEvt?.events?.[0]?.message || 'Carrier reported an exception';
      const isBenign = BENIGN_EXCEPTION_PATTERNS.some(p => p.test(msg));
      if (!isBenign) {
        alert.issues.push(`Exception: ${msg}`);
        alert.severity = 'high';
        alert.claimReason = 'exception';
      }
    }
    if (currentStatus === 'returned') {
      alert.issues.push('Package being returned to sender');
      alert.severity = 'high';
      alert.claimReason = 'returned';
    }

    // Action required
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

    // Stale tracking
    let staleDays = null;
    if (snap?.raw_events) staleDays = daysSinceLastEvent(snap.raw_events);
    else if (shopifyEvt?.lastEventDays != null) staleDays = shopifyEvt.lastEventDays;

    if (staleDays !== null && staleDays >= 14) {
      alert.issues.push(`No tracking update in ${staleDays} days - likely lost`);
      alert.severity = 'high';
      if (!alert.claimReason) alert.claimReason = 'likely_lost';
    } else if (staleDays !== null && staleDays >= 7) {
      alert.issues.push(`No tracking update in ${staleDays} days`);
      if (alert.severity !== 'high') alert.severity = 'medium';
    }

    // Overdue (only if tracking data confirms stale)
    if (bizDays !== null && bizDays > window.max) {
      if (staleDays === null) {
        // No tracking data - don't flag
      } else if (staleDays <= 4) {
        // Still moving - don't flag
      } else {
        alert.issues.push(`${bizDays} business days in transit (expected ${window.min}-${window.max})`);
        if (alert.severity === 'info') alert.severity = 'medium';
      }
    }

    // Customs hold — only for DDP orders with actual customs hold event in tracking
    // Never for DDU (customer expects to pay duties themselves)
    if (zone === 'ddp' && isPassport && snap?.raw_events) {
      const customsHoldEvent = detectCustomsHold(snap.raw_events);
      if (customsHoldEvent) {
        const existingClaim = claimMap[order.order_number];
        if (!existingClaim?.customer_customs_notified_at) {
          customsAlerts.push(alert);
        }
        alert.issues.push(`Held at customs: ${customsHoldEvent}`);
        if (alert.severity === 'info') alert.severity = 'medium';
      }
    }

    if (alert.issues.length === 0) continue;

    // Check if this should be a new Passport claim
    if (alert.severity === 'high' && isPassport && !claimMap[order.order_number]) {
      newClaims.push(alert);
    }

    alert.note = noteMap[order.order_number] || null;
    alert.claim = claimMap[order.order_number] || null;
    alerts.push(alert);
  }

  // Create new Passport claims
  if (newClaims.length > 0) {
    console.log(`  [Shipping] Creating ${newClaims.length} new Passport claims...`);
    const claimNums = newClaims.map(a => a.order_number);
    const costMap = {};
    try {
      const { data } = await supabase.from('order_fulfillment_costs')
        .select('order_number, shipping_fee_usd, ddp_total_usd')
        .in('order_number', claimNums);
      for (const c of (data || [])) costMap[c.order_number] = c;
    } catch { /* table may not exist */ }

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
      if (error) console.error(`  [Shipping] Failed to create claim for #${alert.order_number}: ${error.message}`);
      else {
        claimMap[alert.order_number] = claim;
        alert.claim = claim;
      }
    }

    await sendPassportEmail(newClaims);
  }

  // Send customs notification emails
  if (customsAlerts.length > 0) {
    for (const alert of customsAlerts) {
      if (!alert.customer_email) continue;
      await sendCustomsNotificationEmail(supabase, alert);
    }
  }

  // Categorize alerts
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
    `${active.length} shipping alerts`,
    urgentNonPassport.length ? `${urgentNonPassport.length} urgent` : null,
    passportPending.length ? `${passportPending.length} Passport claims` : null,
    passportLost.length ? `${passportLost.length} lost` : null,
    delayed.length ? `${delayed.length} delayed` : null,
    resolved.length ? `${resolved.length} resolved` : null,
    `${allOrders.length} in transit`,
  ].filter(Boolean).join(', ');

  console.log(`  [Shipping] ${summary}`);

  return {
    alerts: active,
    urgentNonPassport, passportPending, passportLost, customsAlerts, delayed,
    resolved: showResolved ? resolved : [],
    summary, totalInTransit: allOrders.length, resolvedCount: resolved.length,
    newClaimsCount: newClaims.length,
  };
}

module.exports = { checkShippingDelays };
