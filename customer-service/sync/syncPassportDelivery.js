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
 * Infer a full timestamp from a yearless event date like "Jan 12 22:49".
 */
function inferTimestamp(evt, fulfilledAt) {
  const date = (evt.date || '').trim();
  const time = (evt.time || '').trim();
  if (!date || !fulfilledAt) return `${date} ${time}`.trim();
  const fulfYear = new Date(fulfilledAt).getFullYear();
  let d = new Date(`${date}, ${fulfYear}${time ? ' ' + time : ''}`);
  if (isNaN(d.getTime())) return `${date} ${time}`.trim();
  if (d < new Date(fulfilledAt)) {
    d = new Date(`${date}, ${fulfYear + 1}${time ? ' ' + time : ''}`);
  }
  return d.toISOString();
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
      .select('order_number, fulfillments, shipping_address, fulfilled_at')
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

    // Skip expired pages permanently
    if (snap.status === 'expired') { expiredSkipped++; continue; }

    // Skip delivered (shouldn't be in candidates, but defensive)
    if (snap.status === 'delivered') continue;

    // Bad data (unknown status, CAPTCHA, no events) — treat as backfill, needs re-scrape
    if (snap.status === 'unknown' || (snap.status === 'pre_transit' && snap.eventCount === 0)) {
      backfill.push(order);
      continue;
    }

    // Update pool — previously scraped with real data, not delivered
    // Only re-check if fulfilled within the last 45 days
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

  // Expired page check — includes redirect stubs (passportglobal.com) and "can't find" pages
  const isExpired = /can.t find the tracking number/i.test(rawText)
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
  let parsed = parsePassportPage(rawText);
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
  await supabase.from('tracking_snapshots').upsert({
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
    estimated_delivery: parsed.estimated_delivery || null,
    last_location: parsed.last_location || null,
    local_carrier: parsed.local_carrier || null,
    local_tracking_number: parsed.local_tracking_number || null,
    customs_cleared: parsed.customs_cleared || false,
    scraped_at: new Date().toISOString(),
  }, { onConflict: 'tracking_number' });

  // If delivered, patch deliveredAt into order fulfillments
  if (parsed.current_status === 'delivered') {
    let deliveredAt = null;
    const events = (parsed.events || []).slice().reverse();
    for (const evt of events) {
      if (/deliver/i.test(evt.description || '')) {
        const ts = evt.timestamp || inferTimestamp(evt, order.fulfilled_at);
        const d = new Date(ts);
        if (!isNaN(d.getTime()) && d.getFullYear() > 2020) {
          deliveredAt = d.toISOString();
          break;
        }
      }
    }

    if (!deliveredAt && parsed.events?.length) {
      const lastEvent = parsed.events[0];
      const ts = lastEvent.timestamp || inferTimestamp(lastEvent, order.fulfilled_at);
      const d = new Date(ts);
      if (!isNaN(d.getTime()) && d.getFullYear() > 2020) deliveredAt = d.toISOString();
    }

    if (deliveredAt) {
      const updatedFulfillments = order.fulfillments.map(f => {
        if (f.trackingNumber === order.tracking_number) {
          return { ...f, deliveredAt };
        }
        return f;
      });

      await supabase.from('orders')
        .update({ fulfillments: updatedFulfillments })
        .eq('order_number', order.order_number);
    }

    return 'delivered';
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
    backfill: { scraped: 0, delivered: 0, inTransit: 0 },
    updates: { scraped: 0, delivered: 0, inTransit: 0, unchanged: 0 },
    expired: 0,
    captcha: 0,
    errors: 0,
  };
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

      switch (result) {
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
      }
    } catch (err) {
      counts.errors++;
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
      console.log(`  Progress: ${i + 1}/${allWork.length} — backfill: ${b.delivered}d/${b.scraped}s, updates: ${u.delivered}d/${u.scraped}s, ${counts.expired} expired, ${counts.errors} errors`);
    }

    if (i < allWork.length - 1) await sleep(DELAY_BETWEEN_REQUESTS_MS);
  }

  await closeBrowser();

  const totalEligible = backfill.length + updates.length;
  const result = { backfill: counts.backfill, updates: counts.updates, expired: counts.expired, captcha: counts.captcha, errors: counts.errors };

  const b = counts.backfill;
  const u = counts.updates;
  console.log(`Passport sync complete:`);
  console.log(`  Backfill: ${b.scraped} scraped, ${b.delivered} delivered, ${b.inTransit} in transit`);
  console.log(`  Updates:  ${u.scraped} scraped, ${u.delivered} delivered, ${u.inTransit} in transit, ${u.unchanged || 0} unchanged`);
  console.log(`  Expired: ${counts.expired}, CAPTCHA: ${counts.captcha}, Errors: ${counts.errors}`);

  const totalProcessed = b.scraped + u.scraped + counts.expired + counts.captcha;
  const totalBatch = backfillBatch.length + updateBatch.length;
  const blocked = totalBatch - totalProcessed;

  await sendRunSummary(result, { backfillTotal: backfill.length, updatesTotal: updates.length, tooOldSkipped, blocked });
  return result;
}

// ---------------------------------------------------------------------------
// Email summary (temporary — remove when backlog is cleared)
// ---------------------------------------------------------------------------

async function sendRunSummary(result, { backfillTotal, updatesTotal, tooOldSkipped, blocked }) {
  const sgMail = getSendgridClient();
  if (!sgMail) return;

  const { backfill: b, updates: u, expired, captcha, errors } = result;
  const totalDelivered = b.delivered + u.delivered;

  const subject = `Passport Sync: ${totalDelivered} delivered (${b.delivered} backfill + ${u.delivered} updates)${blocked > 0 ? `, ${blocked} blocked` : ''}`;
  const lines = [
    `Passport Tracking Sync Run — ${new Date().toISOString()}`,
    '',
    `BACKFILL (never scraped, oldest first)`,
    `  Pool:       ${backfillTotal} remaining`,
    `  Scraped:    ${b.scraped}`,
    `  Delivered:  ${b.delivered}`,
    `  In Transit: ${b.inTransit}`,
    '',
    `UPDATES (in-transit, most stale first)`,
    `  Pool:       ${updatesTotal} active`,
    `  Scraped:    ${u.scraped}`,
    `  Delivered:  ${u.delivered}`,
    `  In Transit: ${u.inTransit}`,
    `  Unchanged:  ${u.unchanged || 0}`,
    '',
    `Expired:      ${expired} (Passport purged tracking page)`,
    `Errors:       ${errors}`,
  ];
  if (captcha > 0 || blocked > 0) {
    lines.push('');
    lines.push(`⚠ BLOCKED`);
    if (captcha > 0) lines.push(`  CAPTCHA hits: ${captcha} (Cloudflare blocked this IP)`);
    if (blocked > 0) lines.push(`  Not processed: ${blocked} orders skipped due to early stop`);
    lines.push(`  These orders need a local run (residential IP) to process.`);
  }
  if (tooOldSkipped > 0) {
    lines.push(`Too old:      ${tooOldSkipped} (fulfilled >45 days ago, no longer re-checking)`);
  }
  lines.push('', `Remaining backfill: ~${backfillTotal - b.scraped - expired}`);
  const text = lines.join('\n');

  try {
    await sgMail.send({
      to: 'jamie@rubyshines.com',
      from: 'pipeline@rubyshines.com',
      subject,
      text,
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

if (require.main === module) {
  const args = process.argv.slice(2);
  const full = args.includes('--full');
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : 0;

  if (full) console.log('Running full scan (ignoring cooldown)...');
  if (limit) console.log(`Limit: ${limit} orders per run`);
  syncPassportDelivery({ full, limit })
    .then(r => console.log('Done:', JSON.stringify(r)))
    .catch(e => { console.error('Error:', e.message); process.exit(1); });
}

module.exports = { syncPassportDelivery, run };
