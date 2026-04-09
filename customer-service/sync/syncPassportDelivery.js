#!/usr/bin/env node

/**
 * Sync Passport Delivery — batch scrape Passport tracking pages for Nitro
 * orders missing deliveredAt.
 *
 * Two-pool strategy:
 *   BACKFILL — orders never scraped before, oldest first. One-time scrape to
 *              capture historical delivery dates regardless of age.
 *   UPDATES  — orders previously scraped but not yet delivered, oldest scrape
 *              first (most stale gets priority). Only re-checks orders fulfilled
 *              within the last 45 days — older ones are presumed lost/stale.
 *
 * Each run splits its limit between both pools (half/half by default).
 *
 * For each order:
 *   1. Scrape Passport tracking page (Puppeteer)
 *   2. Parse deterministically (fallback to Sonnet if needed)
 *   3. If delivered: patch deliveredAt into order fulfillments JSONB
 *   4. Upsert tracking_snapshots
 *
 * Usage:
 *   node customer-service/sync/syncPassportDelivery.js
 *   node customer-service/sync/syncPassportDelivery.js --limit 100
 *   node customer-service/sync/syncPassportDelivery.js --full   (ignore cooldown)
 */

if (!process.env.SUPABASE_URL) require('dotenv').config();

const { getSupabaseClient } = require('../../shared/supabaseClient');
const { getSendgridClient } = require('../../shared/sendgridClient');
const { shopifyGraphQL } = require('../lib/shopify');
const { scrapeTracking, closeBrowser } = require('../lib/tracking/scraper');
const { parsePassportPage } = require('../lib/tracking/passportParser');
let parseTrackingPage; // lazy-loaded Sonnet fallback

const NITRO_LOCATION_ID = '105921249558';
const SCRAPE_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours
const DELAY_BETWEEN_REQUESTS_MS = 5000;
const MAX_CONSECUTIVE_ERRORS = 5;
const UPDATE_MAX_AGE_DAYS = 45; // stop re-checking in-transit orders older than this

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Push a DELIVERED event to Shopify so deliveredAt is set on the fulfillment.
 * Passport doesn't do this automatically, so we do it from our scrape data.
 */
async function pushDeliveryToShopify(shopifyOrderId, trackingNumber, deliveredAt) {
  if (!shopifyOrderId || !deliveredAt) return false;

  // Skip Shopify push for deliveries older than 2 days — pushing old delivery
  // events triggers Shopify's "Shipment delivered" notification, which would
  // confuse customers. We still store the date in Supabase.
  const deliveredDate = new Date(deliveredAt);
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  if (deliveredDate < twoDaysAgo) return false;

  try {
    // Look up the fulfillment GID from Shopify
    const orderResult = await shopifyGraphQL(`{
      order(id: "${shopifyOrderId}") {
        fulfillments {
          id
          deliveredAt
          trackingInfo { number }
        }
      }
    }`);

    const fulfillment = (orderResult.order?.fulfillments || []).find(f =>
      f.trackingInfo?.some(t => t.number === trackingNumber)
    );
    if (!fulfillment) return false;

    // Skip if Shopify already has deliveredAt
    if (fulfillment.deliveredAt) return true;

    const result = await shopifyGraphQL(`
      mutation {
        fulfillmentEventCreate(fulfillmentEvent: {
          fulfillmentId: "${fulfillment.id}"
          status: DELIVERED
          happenedAt: "${deliveredAt}"
        }) {
          fulfillmentEvent { id status }
          userErrors { field message }
        }
      }
    `);

    const errors = result.fulfillmentEventCreate?.userErrors || [];
    if (errors.length > 0) {
      console.warn(`  #${trackingNumber}: Shopify event error: ${errors[0].message}`);
      return false;
    }
    return true;
  } catch (e) {
    console.warn(`  Shopify push failed for ${trackingNumber}: ${e.message}`);
    return false;
  }
}

/**
 * Infer a full timestamp from a yearless event date like "Jan 12 22:49".
 * Try fulfillment year first, then +1. Pick whichever falls between
 * fulfilledAt and now. Never return a future date.
 */
function inferTimestamp(evt, fulfilledAt) {
  const date = (evt.date || '').trim();
  const time = (evt.time || '').trim();
  if (!date || !fulfilledAt) return `${date} ${time}`.trim();
  const now = new Date();
  const fulfDate = new Date(fulfilledAt);
  const fulfYear = fulfDate.getFullYear();
  const candidates = [fulfYear, fulfYear + 1];
  for (const year of candidates) {
    const d = new Date(`${date}, ${year}${time ? ' ' + time : ''}`);
    if (isNaN(d.getTime())) continue;
    if (d >= fulfDate && d <= now) return d.toISOString();
  }
  // Fallback: use fulfillment year even if slightly before fulfilledAt
  // (same-day events where time is earlier)
  const fallback = new Date(`${date}, ${fulfYear}${time ? ' ' + time : ''}`);
  if (!isNaN(fallback.getTime()) && fallback <= now) return fallback.toISOString();
  return `${date} ${time}`.trim();
}

// ---------------------------------------------------------------------------
// Find Passport orders missing deliveredAt
// ---------------------------------------------------------------------------

async function findPassportOrdersMissingDelivery(supabase) {
  const allOrders = [];
  let offset = 0;

  while (true) {
    const { data: orders, error } = await supabase
      .from('orders')
      .select('order_number, shopify_order_id, fulfillments, shipping_address, fulfilled_at')
      .eq('fulfillment_status', 'FULFILLED')
      .not('fulfilled_at', 'is', null)
      .is('cancelled_at', null)
      .order('order_number', { ascending: false })
      .range(offset, offset + 999);

    if (error) throw new Error(`Query failed: ${error.message}`);
    if (!orders || orders.length === 0) break;
    offset += orders.length;

    for (const o of orders) {
      const fulfillments = o.fulfillments || [];
      const isNitro = fulfillments.some(f => String(f.locationId) === NITRO_LOCATION_ID);
      if (!isNitro) continue;

      const hasDeliveredAt = fulfillments.some(f => f.deliveredAt);
      if (hasDeliveredAt) continue;

      const passportFulfillment = fulfillments.find(f =>
        (f.trackingUrl || '').includes('passport') && f.trackingNumber
      );
      if (!passportFulfillment) continue;

      allOrders.push({
        order_number: o.order_number,
        shopify_order_id: o.shopify_order_id,
        tracking_number: passportFulfillment.trackingNumber,
        tracking_url: passportFulfillment.trackingUrl,
        fulfilled_at: o.fulfilled_at,
        fulfillments,
        country_code: o.shipping_address?.countryCode || null,
      });
    }
  }

  return allOrders;
}

// ---------------------------------------------------------------------------
// Build two pools: backfill (never scraped) + updates (scraped, not delivered)
// ---------------------------------------------------------------------------

async function buildPools(supabase, candidates, full) {
  // Load existing snapshots
  const snapMap = {}; // tracking_number -> { scraped_at, status }
  const trackingNumbers = candidates.map(o => o.tracking_number);

  for (let i = 0; i < trackingNumbers.length; i += 500) {
    const batch = trackingNumbers.slice(i, i + 500);
    const { data: snapshots } = await supabase
      .from('tracking_snapshots')
      .select('tracking_number, scraped_at, current_status, raw_events')
      .in('tracking_number', batch);

    for (const s of (snapshots || [])) {
      snapMap[s.tracking_number] = {
        scrapedAt: s.scraped_at,
        status: s.current_status,
        eventCount: Array.isArray(s.raw_events) ? s.raw_events.length : 0,
      };
    }
  }

  const now = Date.now();
  const updateCutoff = now - (UPDATE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000);
  const backfill = [];
  const updates = [];
  let expiredSkipped = 0;
  let cooldownSkipped = 0;
  let tooOldSkipped = 0;

  for (const order of candidates) {
    const snap = snapMap[order.tracking_number];

    if (!snap) {
      // Never scraped — backfill pool (oldest order first)
      backfill.push(order);
      continue;
    }

    // Skip expired pages permanently — tracking data is gone
    if (snap.status === 'expired') { expiredSkipped++; continue; }

    // parse_error = temporary failure (403, bad parse, etc.) — retry via update pool
    if (snap.status === 'parse_error') {
      order._scrapedAt = snap.scrapedAt;
      updates.push(order);
      continue;
    }

    // Skip delivered (shouldn't be in candidates, but defensive)
    if (snap.status === 'delivered') continue;

    // Bad data (unknown status, CAPTCHA, no events) — treat as backfill, needs re-scrape
    if (snap.status === 'unknown' || (snap.status === 'pre_transit' && snap.eventCount === 0)) {
      backfill.push(order);
      continue;
    }

    // Update pool — previously scraped with real data, not delivered
    // Only re-check if fulfilled within the last 45 days.
    // (Backfill always gets one scrape regardless of age — this cutoff
    // only stops RE-checking orders that already have good tracking data.)
    const fulfilledAt = new Date(order.fulfilled_at).getTime();
    if (fulfilledAt < updateCutoff) { tooOldSkipped++; continue; }

    // Respect cooldown unless --full
    if (!full) {
      const age = now - new Date(snap.scrapedAt).getTime();
      if (age < SCRAPE_COOLDOWN_MS) { cooldownSkipped++; continue; }
    }

    // Attach scraped_at for sorting
    order._scrapedAt = snap.scrapedAt;
    updates.push(order);
  }

  // Sort backfill: oldest order first (ascending order_number)
  backfill.sort((a, b) => a.order_number - b.order_number);

  // Sort updates: oldest scrape first (most stale gets priority)
  updates.sort((a, b) => new Date(a._scrapedAt) - new Date(b._scrapedAt));

  return { backfill, updates, snapMap, expiredSkipped, cooldownSkipped, tooOldSkipped };
}

// ---------------------------------------------------------------------------
// Scrape a single order — returns result category
// ---------------------------------------------------------------------------

async function scrapeOrder(supabase, order, snapMap) {
  const { carrier, rawText } = await scrapeTracking(
    order.tracking_url,
    order.tracking_number,
  );

  // Captcha check
  if (/confirm you are human|captcha|challenge-platform/i.test(rawText) && rawText.length < 500) {
    return 'captcha';
  }

  // Temporary failure check — 403s, 5xx, etc. are retryable, not expired
  if (/^(403 Forbidden|5\d{2}\s|Service Unavailable)/i.test(rawText.trim()) && rawText.length < 200) {
    console.warn(`  #${order.order_number}: scrape_error — ${rawText.trim().substring(0, 50)}`);
    await supabase.from('tracking_snapshots').upsert({
      tracking_number: order.tracking_number,
      order_number: order.order_number,
      carrier,
      tracking_url: order.tracking_url,
      destination_country: order.country_code,
      raw_text: rawText || null,
      current_status: 'parse_error',
      scraped_at: new Date().toISOString(),
    }, { onConflict: 'tracking_number' });
    return 'parse_error';
  }

  // "Can't find" on recent orders is retryable — Passport may not have ingested yet
  const cantFind = /can.t find the tracking number/i.test(rawText);
  const fulfilledDaysAgo = (Date.now() - new Date(order.fulfilled_at).getTime()) / (1000 * 60 * 60 * 24);
  if (cantFind && fulfilledDaysAgo < 45) {
    console.warn(`  #${order.order_number}: can't find tracking — retryable (${Math.round(fulfilledDaysAgo)}d old)`);
    await supabase.from('tracking_snapshots').upsert({
      tracking_number: order.tracking_number,
      order_number: order.order_number,
      carrier,
      tracking_url: order.tracking_url,
      destination_country: order.country_code,
      raw_text: rawText || null,
      current_status: 'parse_error',
      scraped_at: new Date().toISOString(),
    }, { onConflict: 'tracking_number' });
    return 'parse_error';
  }

  // Expired page check — only for old orders where tracking is genuinely gone
  const isExpired = cantFind
    || (/mistyped/i.test(rawText) && rawText.length < 400)
    || (/track\.passportglobal\.com/i.test(rawText) && rawText.length < 200)
    || (rawText.length < 100 && !/delivered|in transit|current status/i.test(rawText));
  if (isExpired) {
    await supabase.from('tracking_snapshots').upsert({
      tracking_number: order.tracking_number,
      order_number: order.order_number,
      carrier,
      tracking_url: order.tracking_url,
      destination_country: order.country_code,
      raw_text: rawText || null,
      current_status: 'expired',
      scraped_at: new Date().toISOString(),
    }, { onConflict: 'tracking_number' });
    return 'expired';
  }

  // Quick check for updates: if already scraped with a known status and page
  // still doesn't say "delivered", just bump timestamp
  const existing = snapMap[order.tracking_number];
  const textSaysDelivered = /delivered|has arrived|returned to shipper|returned to sender/i.test(rawText);
  if (existing && existing.status !== 'unknown' && !textSaysDelivered) {
    await supabase.from('tracking_snapshots')
      .update({ scraped_at: new Date().toISOString(), raw_text: rawText || null })
      .eq('tracking_number', order.tracking_number);
    return 'unchanged';
  }

  // Parse
  let parsed = parsePassportPage(rawText, order.fulfilled_at);
  if (parsed.parse_failed) {
    try {
      if (!parseTrackingPage) parseTrackingPage = require('../lib/tracking/analyzer').parseTrackingPage;
      parsed = await parseTrackingPage(rawText, carrier);
      console.warn(`  #${order.order_number}: deterministic parse failed, used Sonnet fallback (status: ${parsed.current_status})`);
    } catch (aiErr) {
      console.warn(`  #${order.order_number}: both parsers failed — ${aiErr.message}`);
    }
  }

  // Determine shipping zone
  let shippingZone = null;
  const cc = order.country_code;
  if (cc === 'US') shippingZone = 'us';
  else if (cc === 'CA') shippingZone = 'canada';
  else {
    const { data: zoneRow } = await supabase
      .from('shipping_zones')
      .select('zone')
      .eq('country_code', cc)
      .maybeSingle();
    shippingZone = zoneRow?.zone || 'ddu';
  }

  // Upsert snapshot
  const { error: upsertError } = await supabase.from('tracking_snapshots').upsert({
    tracking_number: order.tracking_number,
    order_number: order.order_number,
    carrier,
    tracking_url: order.tracking_url,
    destination_country: order.country_code,
    shipping_zone: shippingZone,
    raw_events: parsed.events || [],
    raw_text: rawText || null,
    summary: parsed.status_description || null,
    current_status: parsed.current_status || 'unknown',
    estimated_delivery: parsed.estimated_delivery && !isNaN(new Date(parsed.estimated_delivery)) ? parsed.estimated_delivery : null,
    last_location: parsed.last_location || null,
    local_carrier: parsed.local_carrier || null,
    local_tracking_number: parsed.local_tracking_number || null,
    customs_cleared: parsed.customs_cleared || false,
    scraped_at: new Date().toISOString(),
  }, { onConflict: 'tracking_number' });
  if (upsertError) {
    console.error(`  #${order.order_number}: upsert failed — ${upsertError.message}`);
  }

  // If delivered, extract and validate deliveredAt before patching
  if (parsed.current_status === 'delivered') {
    const now = new Date();
    const fulfDate = new Date(order.fulfilled_at);

    // --- Validate event timestamps before using them ---
    // If any event has a future timestamp, the year inference failed
    const hasFutureEvent = (parsed.events || []).some(e =>
      e.timestamp && new Date(e.timestamp) > now
    );
    if (hasFutureEvent) {
      console.warn(`  #${order.order_number}: date_error — delivered but event timestamps are in the future (year inference failed)`);
      await supabase.from('tracking_snapshots')
        .update({ current_status: 'parse_error' })
        .eq('tracking_number', order.tracking_number);
      return 'parse_error';
    }

    // --- Extract delivery date ---
    let deliveredAt = null;
    const events = (parsed.events || []).slice().reverse();
    for (const evt of events) {
      if (/deliver/i.test(evt.description || '')) {
        const ts = evt.timestamp || inferTimestamp(evt, order.fulfilled_at);
        const d = new Date(ts);
        if (!isNaN(d.getTime()) && d > fulfDate && d <= now) {
          deliveredAt = d.toISOString();
          break;
        }
      }
    }

    if (!deliveredAt && parsed.events?.length) {
      const lastEvent = parsed.events[0];
      const ts = lastEvent.timestamp || inferTimestamp(lastEvent, order.fulfilled_at);
      const d = new Date(ts);
      if (!isNaN(d.getTime()) && d > fulfDate && d <= now) deliveredAt = d.toISOString();
    }

    if (deliveredAt) {
      // Push to Shopify (only for recent deliveries — older ones skip to
      // avoid triggering Shopify's "Shipment delivered" customer notification)
      await pushDeliveryToShopify(order.shopify_order_id, order.tracking_number, deliveredAt);

      // Always patch Supabase fulfillments
      const updatedFulfillments = order.fulfillments.map(f => {
        if (f.trackingNumber === order.tracking_number) {
          return { ...f, deliveredAt };
        }
        return f;
      });

      await supabase.from('orders')
        .update({ fulfillments: updatedFulfillments })
        .eq('order_number', order.order_number);
    } else {
      console.warn(`  #${order.order_number}: date_error — page says delivered but could not extract a valid delivery date`);
      await supabase.from('tracking_snapshots')
        .update({ current_status: 'parse_error' })
        .eq('tracking_number', order.tracking_number);
      return 'parse_error';
    }

    return 'delivered';
  }

  // Distinguish real in-transit from parse failures
  const status = parsed.current_status || 'unknown';
  if (status === 'unknown' || status === 'pre_transit') {
    const rawStatus = parsed.raw_current_status || '(not found)';
    console.warn(`  #${order.order_number}: parse_error — scraped ${rawText.length} chars, status=${status}, page says: "${rawStatus}"`);
    // Save as parse_error so it won't retry (use --retry-errors after fixing parser)
    await supabase.from('tracking_snapshots')
      .update({ current_status: 'parse_error' })
      .eq('tracking_number', order.tracking_number);
    return { type: 'parse_error', rawStatus };
  }

  return 'in_transit';
}

// ---------------------------------------------------------------------------
// Main sync
// ---------------------------------------------------------------------------

async function syncPassportDelivery({ full = false, limit = 0 } = {}) {
  const supabase = getSupabaseClient();

  console.log('Finding Passport orders missing deliveredAt...');
  const candidates = await findPassportOrdersMissingDelivery(supabase);
  console.log(`Found ${candidates.length} Passport orders without delivery confirmation`);

  if (candidates.length === 0) {
    return { backfill: { scraped: 0, delivered: 0 }, updates: { scraped: 0, delivered: 0 }, expired: 0, captcha: 0, errors: 0 };
  }

  const { backfill, updates, snapMap, expiredSkipped, cooldownSkipped, tooOldSkipped } = await buildPools(supabase, candidates, full);

  console.log(`Pools: ${backfill.length} backfill (never scraped), ${updates.length} updates (in-transit)`);
  if (expiredSkipped) console.log(`  Skipped: ${expiredSkipped} expired`);
  if (cooldownSkipped) console.log(`  Skipped: ${cooldownSkipped} on cooldown`);
  if (tooOldSkipped) console.log(`  Skipped: ${tooOldSkipped} older than ${UPDATE_MAX_AGE_DAYS} days (no longer re-checking)`);

  // Split limit between pools (half each, remainder to whichever has more)
  let backfillLimit, updateLimit;
  if (limit > 0) {
    backfillLimit = Math.min(backfill.length, Math.ceil(limit / 2));
    updateLimit = Math.min(updates.length, limit - backfillLimit);
    // If one pool is smaller than its half, give the slack to the other
    if (backfillLimit < Math.ceil(limit / 2)) {
      updateLimit = Math.min(updates.length, limit - backfillLimit);
    }
    if (updateLimit < Math.floor(limit / 2)) {
      backfillLimit = Math.min(backfill.length, limit - updateLimit);
    }
  } else {
    backfillLimit = backfill.length;
    updateLimit = updates.length;
  }

  const backfillBatch = backfill.slice(0, backfillLimit);
  const updateBatch = updates.slice(0, updateLimit);

  console.log(`This run: ${backfillBatch.length} backfill + ${updateBatch.length} updates = ${backfillBatch.length + updateBatch.length} total`);

  // Process both pools: updates first (recent orders, status changing),
  // then backfill (old orders, one-time capture)
  const allWork = [
    ...updateBatch.map(o => ({ ...o, _pool: 'updates' })),
    ...backfillBatch.map(o => ({ ...o, _pool: 'backfill' })),
  ];

  const counts = {
    backfill: { scraped: 0, delivered: 0, inTransit: 0, parseErrors: 0 },
    updates: { scraped: 0, delivered: 0, inTransit: 0, unchanged: 0, parseErrors: 0 },
    expired: 0,
    captcha: 0,
    errors: 0,
  };
  const orderResults = []; // per-order results for email report
  let consecutiveErrors = 0;

  for (let i = 0; i < allWork.length; i++) {
    const order = allWork[i];
    const pool = order._pool;

    if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      console.log(`  Stopping early — ${MAX_CONSECUTIVE_ERRORS} consecutive errors.`);
      break;
    }

    try {
      const result = await scrapeOrder(supabase, order, snapMap);
      consecutiveErrors = 0;

      const resultType = typeof result === 'object' ? result.type : result;
      const rawStatus = typeof result === 'object' ? result.rawStatus : null;

      orderResults.push({
        order_number: order.order_number,
        pool,
        country: order.country_code || '?',
        tracking: order.tracking_number,
        fulfilled_at: order.fulfilled_at?.split('T')[0] || '?',
        result: resultType,
        parseOk: !['captcha', 'expired', 'parse_error'].includes(resultType),
        rawStatus,
      });

      switch (resultType) {
        case 'captcha':
          counts.captcha++;
          if (counts.captcha >= 3) {
            console.log(`  Stopping early — ${counts.captcha} CAPTCHA blocks.`);
            i = allWork.length; // break outer loop
          }
          break;
        case 'expired':
          counts.expired++;
          break;
        case 'unchanged':
          counts[pool].unchanged = (counts[pool].unchanged || 0) + 1;
          counts[pool].scraped++;
          break;
        case 'delivered':
          counts[pool].delivered++;
          counts[pool].scraped++;
          break;
        case 'in_transit':
          counts[pool].inTransit++;
          counts[pool].scraped++;
          break;
        case 'parse_error':
          counts[pool].parseErrors++;
          counts[pool].scraped++;
          break;
      }
    } catch (err) {
      counts.errors++;
      orderResults.push({
        order_number: order.order_number,
        pool,
        country: order.country_code || '?',
        tracking: order.tracking_number,
        fulfilled_at: order.fulfilled_at?.split('T')[0] || '?',
        result: 'error',
        parseOk: false,
      });
      const isBrowserCrash = /context.*destroy|connection closed|protocol error|target closed/i.test(err.message);
      if (isBrowserCrash) {
        console.error(`  Browser crash on #${order.order_number}, recycling...`);
        await closeBrowser();
      } else {
        consecutiveErrors++;
        if (consecutiveErrors <= 2) {
          console.error(`  Error scraping #${order.order_number}: ${err.message}`);
        }
      }
    }

    // Progress log
    if ((i + 1) % 25 === 0 || i + 1 === allWork.length) {
      const b = counts.backfill;
      const u = counts.updates;
      console.log(`  Progress: ${i + 1}/${allWork.length} — backfill: ${b.delivered}d/${b.parseErrors}err/${b.scraped}s, updates: ${u.delivered}d/${u.parseErrors}err/${u.scraped}s, ${counts.expired} expired`);
    }

    if (i < allWork.length - 1) await sleep(DELAY_BETWEEN_REQUESTS_MS);
  }

  await closeBrowser();

  const totalEligible = backfill.length + updates.length;
  const result = { backfill: counts.backfill, updates: counts.updates, expired: counts.expired, captcha: counts.captcha, errors: counts.errors };

  const b = counts.backfill;
  const u = counts.updates;
  console.log(`Passport sync complete:`);
  console.log(`  Backfill: ${b.scraped} scraped, ${b.delivered} delivered, ${b.inTransit} in transit, ${b.parseErrors} parse errors`);
  console.log(`  Updates:  ${u.scraped} scraped, ${u.delivered} delivered, ${u.inTransit} in transit, ${u.unchanged || 0} unchanged, ${u.parseErrors} parse errors`);
  console.log(`  Expired: ${counts.expired}, CAPTCHA: ${counts.captcha}, Errors: ${counts.errors}`);

  const totalProcessed = b.scraped + u.scraped + counts.expired + counts.captcha;
  const totalBatch = backfillBatch.length + updateBatch.length;
  const blocked = totalBatch - totalProcessed;

  await sendRunSummary(result, { backfillTotal: backfill.length, updatesTotal: updates.length, tooOldSkipped, blocked, orderResults });
  return result;
}

// ---------------------------------------------------------------------------
// Email summary (temporary — remove when backlog is cleared)
// ---------------------------------------------------------------------------

async function sendRunSummary(result, { backfillTotal, updatesTotal, tooOldSkipped, blocked, orderResults }) {
  const sgMail = getSendgridClient();
  if (!sgMail) return;

  // Skip email if nothing was processed
  if (orderResults.length === 0) return;

  const { backfill: b, updates: u, expired, captcha, errors } = result;
  const totalDelivered = b.delivered + u.delivered;
  const totalParsed = orderResults.filter(r => r.parseOk).length;

  const subject = `Passport Sync: ${totalParsed}/${orderResults.length} scraped OK, ${totalDelivered} delivered`;

  const backfillRows = orderResults.filter(r => r.pool === 'backfill');
  const updateRows = orderResults.filter(r => r.pool === 'updates');

  const statusColor = (s) => {
    if (s === 'delivered') return '#16a34a';
    if (s === 'in_transit') return '#2563eb';
    if (s === 'captcha' || s === 'error') return '#dc2626';
    if (s === 'expired' || s === 'parse_error') return '#d97706';
    return '#6b7280';
  };

  function buildTableHtml(rows) {
    if (rows.length === 0) return '<p style="color:#9ca3af;font-size:13px;">None this run</p>';
    const header = `<tr style="background:#f9fafb;border-bottom:2px solid #e5e7eb;">
      <th style="padding:6px 10px;text-align:left;font-size:12px;">Order</th>
      <th style="padding:6px 10px;text-align:left;font-size:12px;">Country</th>
      <th style="padding:6px 10px;text-align:left;font-size:12px;">Fulfilled</th>
      <th style="padding:6px 10px;text-align:left;font-size:12px;">Status</th>
      <th style="padding:6px 10px;text-align:center;font-size:12px;">Parsed</th>
      <th style="padding:6px 10px;text-align:left;font-size:12px;">Tracking</th>
    </tr>`;
    const trs = rows.map((r, i) => {
      const bg = i % 2 === 0 ? '#ffffff' : '#f9fafb';
      const link = `https://track.passportshipping.com/${r.tracking}`;
      const check = r.parseOk ? '&#10003;' : '&#10007;';
      const checkColor = r.parseOk ? '#16a34a' : '#dc2626';
      const rawStatusNote = r.rawStatus
        ? `<br><span style="font-size:11px;color:#991b1b;">Page says: "${r.rawStatus}"</span>`
        : '';
      return `<tr style="background:${bg};border-bottom:1px solid #e5e7eb;">
        <td style="padding:5px 10px;font-size:13px;font-weight:600;">#${r.order_number}</td>
        <td style="padding:5px 10px;font-size:13px;">${r.country || '?'}</td>
        <td style="padding:5px 10px;font-size:13px;color:#6b7280;">${r.fulfilled_at || '?'}</td>
        <td style="padding:5px 10px;font-size:13px;"><span style="color:${statusColor(r.result)};font-weight:600;">${r.result}</span>${rawStatusNote}</td>
        <td style="padding:5px 10px;font-size:15px;text-align:center;color:${checkColor};">${check}</td>
        <td style="padding:5px 10px;font-size:12px;"><a href="${link}" style="color:#2563eb;">${r.tracking}</a></td>
      </tr>`;
    });
    return `<table style="width:100%;border-collapse:collapse;margin-bottom:8px;">${header}${trs.join('')}</table>`;
  }

  const backfillParsed = backfillRows.filter(r => r.parseOk).length;
  const updateParsed = updateRows.filter(r => r.parseOk).length;

  // Summary badges
  const badge = (label, value, color) =>
    `<span style="display:inline-block;padding:4px 12px;margin:0 6px 6px 0;background:${color};color:#fff;border-radius:12px;font-size:12px;font-weight:600;">${label}: ${value}</span>`;

  const badges = [
    badge('Delivered', totalDelivered, '#16a34a'),
    badge('In Transit', b.inTransit + u.inTransit, '#2563eb'),
    expired > 0 ? badge('Expired', expired, '#d97706') : '',
    captcha > 0 ? badge('CAPTCHA', captcha, '#dc2626') : '',
    errors > 0 ? badge('Errors', errors, '#dc2626') : '',
    blocked > 0 ? badge('Blocked', blocked, '#991b1b') : '',
  ].filter(Boolean).join('');

  const html = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:900px;margin:0 auto;">
  <h2 style="margin-bottom:4px;">Passport Tracking Sync</h2>
  <p style="color:#6b7280;margin-top:0;font-size:13px;">${new Date().toISOString()}</p>

  <div style="margin:16px 0;">${badges}</div>

  <h3 style="margin:20px 0 8px;color:#1e293b;">Backfill <span style="font-weight:normal;color:#6b7280;">(${backfillTotal} remaining, oldest first)</span></h3>
  <p style="font-size:13px;color:#374151;margin:0 0 8px;">${backfillRows.length} processed, ${backfillParsed} scraped OK</p>
  ${buildTableHtml(backfillRows)}

  <h3 style="margin:20px 0 8px;color:#1e293b;">Updates <span style="font-weight:normal;color:#6b7280;">(${updatesTotal} active, most stale first)</span></h3>
  <p style="font-size:13px;color:#374151;margin:0 0 8px;">${updateRows.length} processed, ${updateParsed} scraped OK</p>
  ${buildTableHtml(updateRows)}

  <hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0;">
  <p style="font-size:12px;color:#9ca3af;">Remaining backfill: ~${backfillTotal - b.scraped - expired}</p>
</div>`;

  try {
    await sgMail.send({
      to: 'jamie@rubyshines.com',
      from: 'pipeline@rubyshines.com',
      subject,
      html,
      trackingSettings: { clickTracking: { enable: false, enableText: false } },
    });
  } catch (e) {
    console.error('Failed to send summary email:', e.message);
  }
}

// ---------------------------------------------------------------------------
// Pipeline-compatible run() for daily-sync-all.js
// ---------------------------------------------------------------------------

async function run() {
  try {
    const result = await syncPassportDelivery();
    const totalDelivered = result.backfill.delivered + result.updates.delivered;
    const totalScraped = result.backfill.scraped + result.updates.scraped;
    return {
      sources: {
        passport_delivery: {
          success: true,
          rowsWritten: totalDelivered,
          detail: `${totalScraped} scraped (${result.backfill.scraped} backfill + ${result.updates.scraped} updates), ${totalDelivered} delivered`,
        },
      },
      status: 'ok',
    };
  } catch (e) {
    console.error('Passport delivery sync error:', e.message);
    return {
      sources: {
        passport_delivery: { success: false, rowsWritten: 0, error: e.message },
      },
      status: 'error',
    };
  }
}

async function retryParseErrors() {
  const supabase = getSupabaseClient();
  const { data: errorSnaps } = await supabase.from('tracking_snapshots')
    .select('tracking_number, order_number')
    .eq('current_status', 'parse_error');

  if (!errorSnaps?.length) {
    console.log('No parse_error snapshots to retry.');
    return;
  }

  console.log(`Retrying ${errorSnaps.length} parse_error snapshots...`);

  // Reset them to unknown so buildPools picks them up as backfill
  for (const s of errorSnaps) {
    await supabase.from('tracking_snapshots')
      .update({ current_status: 'unknown' })
      .eq('tracking_number', s.tracking_number);
  }

  console.log('Reset to unknown. Running sync...');
  await syncPassportDelivery({ full: true, limit: errorSnaps.length });
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const full = args.includes('--full');
  const retryErrors = args.includes('--retry-errors');
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : 0;

  if (retryErrors) {
    retryParseErrors()
      .then(() => console.log('Done'))
      .catch(e => { console.error('Error:', e.message); process.exit(1); });
  } else {
    if (full) console.log('Running full scan (ignoring cooldown)...');
    if (limit) console.log(`Limit: ${limit} orders per run`);
    syncPassportDelivery({ full, limit })
      .then(r => console.log('Done:', JSON.stringify(r)))
      .catch(e => { console.error('Error:', e.message); process.exit(1); });
  }
}

module.exports = { syncPassportDelivery, run };
