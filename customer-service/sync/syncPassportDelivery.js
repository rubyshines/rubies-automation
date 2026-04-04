#!/usr/bin/env node

/**
 * Sync Passport Delivery — batch scrape Passport tracking pages for Nitro
 * orders missing deliveredAt.
 *
 * For each undelivered Passport order:
 *   1. Scrape Passport tracking page (simple HTTP fetch)
 *   2. Parse with Sonnet to extract events + delivery status
 *   3. If delivered: patch deliveredAt into order fulfillments JSONB
 *   4. Upsert tracking_snapshots (enables Passport leg analysis)
 *
 * Skips orders already scraped within the last 24 hours (cooldown).
 * Runs incrementally — only processes orders still missing deliveredAt.
 *
 * Usage:
 *   node customer-service/sync/syncPassportDelivery.js
 *   node customer-service/sync/syncPassportDelivery.js --full   (ignore cooldown)
 *   npm run cs-sync-passport-delivery
 */

if (!process.env.SUPABASE_URL) require('dotenv').config();

const { getSupabaseClient } = require('../../shared/supabaseClient');
const { scrapeTracking, closeBrowser } = require('../lib/tracking/scraper');
const { parsePassportPage } = require('../lib/tracking/passportParser');
let parseTrackingPage; // lazy-loaded Sonnet fallback

const NITRO_LOCATION_ID = '105921249558';
const SCRAPE_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours
const DELAY_BETWEEN_REQUESTS_MS = 5000; // 5 seconds between scrapes
const MAX_CONSECUTIVE_ERRORS = 5; // stop after 5 consecutive errors (rate limit likely)

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Infer a full timestamp from a yearless event date like "Jan 12 22:49".
 * Uses the fulfillment date's year. If the resulting date is before fulfillment,
 * it's likely the next calendar year (e.g. fulfilled Dec, delivered Jan).
 */
function inferTimestamp(evt, fulfilledAt) {
  const date = (evt.date || '').trim();   // e.g. "Jan 12"
  const time = (evt.time || '').trim();   // e.g. "22:49"
  if (!date || !fulfilledAt) return `${date} ${time}`.trim();
  const fulfYear = new Date(fulfilledAt).getFullYear();
  // Format: "Jan 12, 2026 22:49"
  let d = new Date(`${date}, ${fulfYear}${time ? ' ' + time : ''}`);
  if (isNaN(d.getTime())) return `${date} ${time}`.trim();
  // If the inferred date is before fulfillment, bump to next year
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

      // Find Passport tracking info
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
// Main sync
// ---------------------------------------------------------------------------

async function syncPassportDelivery({ full = false, limit = 0 } = {}) {
  const supabase = getSupabaseClient();

  console.log('Finding Passport orders missing deliveredAt...');
  const candidates = await findPassportOrdersMissingDelivery(supabase);
  console.log(`Found ${candidates.length} Passport orders without delivery confirmation`);

  if (candidates.length === 0) return { scraped: 0, delivered: 0, inTransit: 0, errors: 0 };

  // Check scrape cooldown + existing snapshots for skip logic
  let toScrape = candidates;
  const existingSnapshots = {}; // tracking_number -> { scraped_at, current_status, raw_events_length }

  if (!full) {
    const trackingNumbers = candidates.map(o => o.tracking_number);
    const recentSnapshots = new Set();
    for (let i = 0; i < trackingNumbers.length; i += 500) {
      const batch = trackingNumbers.slice(i, i + 500);
      const { data: snapshots } = await supabase
        .from('tracking_snapshots')
        .select('tracking_number, scraped_at, current_status, raw_events')
        .in('tracking_number', batch);

      for (const s of (snapshots || [])) {
        existingSnapshots[s.tracking_number] = {
          scrapedAt: s.scraped_at,
          status: s.current_status,
          eventCount: Array.isArray(s.raw_events) ? s.raw_events.length : 0,
        };
        const age = Date.now() - new Date(s.scraped_at).getTime();
        if (age < SCRAPE_COOLDOWN_MS) recentSnapshots.add(s.tracking_number);
      }
    }

    toScrape = candidates.filter(o => !recentSnapshots.has(o.tracking_number));
    const skipped = candidates.length - toScrape.length;
    if (skipped > 0) console.log(`Skipping ${skipped} orders scraped within last 24h`);
  }

  // Apply limit if set
  if (limit > 0 && toScrape.length > limit) {
    console.log(`Limiting to ${limit} orders (${toScrape.length} eligible)`);
    toScrape = toScrape.slice(0, limit);
  }

  console.log(`Scraping ${toScrape.length} Passport tracking pages...`);

  let scraped = 0;
  let delivered = 0;
  let inTransit = 0;
  let errors = 0;
  let consecutiveErrors = 0;

  for (let i = 0; i < toScrape.length; i++) {
    const order = toScrape[i];

    // Stop early if rate-limited
    if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      console.log(`  Stopping early — ${MAX_CONSECUTIVE_ERRORS} consecutive errors (likely rate-limited). Will resume tomorrow.`);
      break;
    }

    try {
      // 1. Scrape tracking page (HTTP only, no AI cost)
      const { carrier, rawText } = await scrapeTracking(
        order.tracking_url,
        order.tracking_number,
      );

      // 2. Quick check: if already scraped with a known status and page still doesn't
      //    say "delivered", skip parse — just bump scraped_at ($0)
      const existing = existingSnapshots[order.tracking_number];
      const textSaysDelivered = /delivered|has arrived|returned to shipper|returned to sender/i.test(rawText);
      if (existing && existing.status !== 'unknown' && !textSaysDelivered) {
        // Still in transit — just update timestamp, no AI needed
        await supabase.from('tracking_snapshots')
          .update({ scraped_at: new Date().toISOString() })
          .eq('tracking_number', order.tracking_number);
        inTransit++;
        consecutiveErrors = 0;
        if ((i + 1) % 50 === 0 || i + 1 === toScrape.length) {
          console.log(`  Progress: ${i + 1}/${toScrape.length} — ${delivered} delivered, ${inTransit} in transit, ${errors} errors (${scraped} parsed)`);
        }
        if (i < toScrape.length - 1) await sleep(DELAY_BETWEEN_REQUESTS_MS);
        continue;
      }

      // 3. Parse deterministically (no AI cost)
      let parsed = parsePassportPage(rawText);

      // Fallback to Sonnet if deterministic parse failed
      if (parsed.parse_failed) {
        try {
          if (!parseTrackingPage) parseTrackingPage = require('../lib/tracking/analyzer').parseTrackingPage;
          parsed = await parseTrackingPage(rawText, carrier);
          console.warn(`  #${order.order_number}: deterministic parse failed, used Sonnet fallback (status: ${parsed.current_status})`);
        } catch (aiErr) {
          console.warn(`  #${order.order_number}: both parsers failed — ${aiErr.message}`);
        }
      }
      scraped++;

      // 3. Determine shipping zone
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

      // 4. Upsert tracking snapshot
      await supabase.from('tracking_snapshots').upsert({
        tracking_number: order.tracking_number,
        order_number: order.order_number,
        carrier,
        tracking_url: order.tracking_url,
        destination_country: order.country_code,
        shipping_zone: shippingZone,
        raw_events: parsed.events || [],
        summary: parsed.status_description || null,
        current_status: parsed.current_status || 'unknown',
        estimated_delivery: parsed.estimated_delivery || null,
        last_location: parsed.last_location || null,
        local_carrier: parsed.local_carrier || null,
        local_tracking_number: parsed.local_tracking_number || null,
        customs_cleared: parsed.customs_cleared || false,
        scraped_at: new Date().toISOString(),
      }, { onConflict: 'tracking_number' });

      // 5. If delivered, find delivery timestamp and patch into order
      consecutiveErrors = 0; // reset on success

      if (parsed.current_status === 'delivered') {
        delivered++;

        // Find delivery event timestamp
        let deliveredAt = null;
        const events = (parsed.events || []).slice().reverse(); // oldest first
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

        // Fallback: last event timestamp
        if (!deliveredAt && parsed.events?.length) {
          const lastEvent = parsed.events[0]; // most recent first
          const ts = lastEvent.timestamp || inferTimestamp(lastEvent, order.fulfilled_at);
          const d = new Date(ts);
          if (!isNaN(d.getTime()) && d.getFullYear() > 2020) deliveredAt = d.toISOString();
        }

        if (deliveredAt) {
          // Patch deliveredAt into the fulfillments JSONB
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
      } else {
        inTransit++;
      }

    } catch (err) {
      errors++;
      const isBrowserCrash = /context.*destroy|connection closed|protocol error|target closed/i.test(err.message);
      if (isBrowserCrash) {
        // Browser died — force recycle, don't count as consecutive
        console.error(`  Browser crash on #${order.order_number}, recycling...`);
        await closeBrowser();
      } else {
        consecutiveErrors++;
        if (consecutiveErrors <= 2) {
          console.error(`  Error scraping #${order.order_number} (${order.tracking_number}): ${err.message}`);
        }
      }
    }

    // Progress log
    if ((i + 1) % 50 === 0 || i + 1 === toScrape.length) {
      console.log(`  Progress: ${i + 1}/${toScrape.length} — ${delivered} delivered, ${inTransit} in transit, ${errors} errors`);
    }

    // Rate limit
    if (i < toScrape.length - 1) await sleep(DELAY_BETWEEN_REQUESTS_MS);
  }

  await closeBrowser();
  console.log(`Passport sync complete: ${scraped} scraped, ${delivered} delivered, ${inTransit} in transit, ${errors} errors`);
  return { scraped, delivered, inTransit, errors };
}

// ---------------------------------------------------------------------------
// Pipeline-compatible run() for daily-sync-all.js
// ---------------------------------------------------------------------------

async function run() {
  try {
    const result = await syncPassportDelivery();
    return {
      sources: {
        passport_delivery: {
          success: true,
          rowsWritten: result.delivered,
          detail: `${result.scraped} scraped, ${result.delivered} delivered, ${result.inTransit} in transit`,
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
