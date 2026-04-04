#!/usr/bin/env node

/**
 * Sync Delivery Times — compute transit times from fulfilled Nitro orders.
 *
 * Uses Shopify's fulfillment.deliveredAt as the authoritative delivery timestamp.
 * For each delivered Nitro order:
 *   transit_days = deliveredAt - fulfilled_at  (calendar days)
 *
 * For international Passport orders with tracking_snapshots:
 *   leg1 = fulfilled_at -> passport_received_at
 *   leg2 = passport_received_at -> delivered_at
 *
 * Runs incrementally (only new orders) or full backfill with --full flag.
 * For backfill, fetches deliveredAt directly from Shopify since existing
 * Supabase orders may not have it in the fulfillments JSONB yet.
 *
 * Usage:
 *   node customer-service/sync/syncDeliveryTimes.js
 *   node customer-service/sync/syncDeliveryTimes.js --full
 *   npm run cs-sync-delivery-times
 */

if (!process.env.SUPABASE_URL) require('dotenv').config();

const { getSupabaseClient } = require('../../shared/supabaseClient');
const { businessDaysBetween } = require('../../shared/businessDays');

const NITRO_LOCATION_ID = '105921249558';

// Quality filter: max transit days by zone
const MAX_TRANSIT_DAYS = { us: 21, canada: 30, ddp: 90, ddu: 90 };
const MIN_TRANSIT_DAYS = { us: 1, canada: 2, ddp: 3, ddu: 3 };
const MAX_PROCESSING_DAYS = 14;
const MIN_PROCESSING_DAYS = 0;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function businessDays(start, end) {
  return businessDaysBetween(start, end);
}

function calendarDays(start, end) {
  const ms = new Date(end) - new Date(start);
  return Math.round(ms / (1000 * 60 * 60 * 24));
}

function isNitroFulfillment(fulfillments) {
  if (!Array.isArray(fulfillments)) return false;
  return fulfillments.some(f => String(f.locationId) === NITRO_LOCATION_ID);
}

/** Get the earliest deliveredAt from the fulfillments JSONB */
function getDeliveredAt(fulfillments) {
  if (!Array.isArray(fulfillments)) return null;
  const dates = fulfillments
    .filter(f => f.deliveredAt)
    .map(f => new Date(f.deliveredAt));
  if (dates.length === 0) return null;
  return new Date(Math.min(...dates)).toISOString();
}

function findPassportReceivedAt(rawEvents) {
  if (!Array.isArray(rawEvents) || rawEvents.length === 0) return null;

  const sorted = [...rawEvents].sort((a, b) => {
    const da = new Date(a.timestamp || `${a.date} ${a.time || ''}`);
    const db = new Date(b.timestamp || `${b.date} ${b.time || ''}`);
    return da - db;
  });

  const receivePatterns = [
    /received/i, /picked up/i, /shipment accepted/i,
    /acceptance/i, /origin.*scan/i, /facility.*received/i,
  ];

  for (const event of sorted) {
    const desc = event.description || '';
    if (receivePatterns.some(p => p.test(desc))) {
      const ts = event.timestamp || `${event.date} ${event.time || ''}`;
      const d = new Date(ts);
      if (!isNaN(d.getTime())) return d.toISOString();
    }
  }

  // Fallback: earliest event timestamp
  for (const event of sorted) {
    const ts = event.timestamp || `${event.date} ${event.time || ''}`;
    const d = new Date(ts);
    if (!isNaN(d.getTime())) return d.toISOString();
  }

  return null;
}

// ---------------------------------------------------------------------------
// Main sync
// ---------------------------------------------------------------------------

async function syncDeliveryTimes({ full = false } = {}) {
  const supabase = getSupabaseClient();
  let totalWritten = 0;
  let totalSkipped = 0;
  let totalFiltered = 0;
  let totalNoDelivery = 0;

  // Load region map once
  const { data: regions } = await supabase
    .from('shipping_regions')
    .select('country_code, province_code, region');

  const regionMap = {};
  for (const r of (regions || [])) {
    regionMap[`${r.country_code}:${r.province_code}`] = r.region;
  }

  const PAGE_SIZE = 1000;
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    let query = supabase
      .from('orders')
      .select(`
        order_number,
        created_at,
        fulfilled_at,
        fulfillment_status,
        fulfillments,
        shipping_address
      `)
      .eq('fulfillment_status', 'FULFILLED')
      .not('fulfilled_at', 'is', null)
      .is('cancelled_at', null)
      .order('order_number', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);

    const { data: orders, error: ordersErr } = await query;
    if (ordersErr) throw new Error(`Orders query failed: ${ordersErr.message}`);
    if (!orders || orders.length === 0) break;
    hasMore = orders.length === PAGE_SIZE;
    offset += orders.length;

    // If incremental, filter out orders already in order_delivery_times
    let candidateOrders = orders;
    if (!full) {
      const orderNums = orders.map(o => o.order_number);
      const { data: existing } = await supabase
        .from('order_delivery_times')
        .select('order_number')
        .in('order_number', orderNums);

      const existingSet = new Set((existing || []).map(e => e.order_number));
      candidateOrders = orders.filter(o => !existingSet.has(o.order_number));
    }

    if (candidateOrders.length === 0) continue;

    const orderNums = candidateOrders.map(o => o.order_number);

    // Get Nitro provider info from order_fulfillment_costs (fallback)
    const { data: costRows } = await supabase
      .from('order_fulfillment_costs')
      .select('order_number, fulfillment_provider, shipping_zone')
      .in('order_number', orderNums);

    const costMap = {};
    for (const c of (costRows || [])) {
      costMap[c.order_number] = c;
    }

    // Get tracking snapshots for Passport enrichment
    const { data: snapshots } = await supabase
      .from('tracking_snapshots')
      .select('order_number, carrier, local_carrier, raw_events, customs_cleared')
      .in('order_number', orderNums);

    const snapMap = {};
    for (const s of (snapshots || [])) {
      snapMap[s.order_number] = s;
    }

    // Process each order
    const rows = [];
    for (const order of candidateOrders) {
      // Determine if Nitro
      const isNitro = isNitroFulfillment(order.fulfillments)
        || costMap[order.order_number]?.fulfillment_provider === 'nitro';

      if (!isNitro) {
        totalSkipped++;
        continue;
      }

      // Get deliveredAt from fulfillments JSONB
      const deliveredAt = getDeliveredAt(order.fulfillments);
      if (!deliveredAt) {
        totalNoDelivery++;
        continue;
      }

      const addr = order.shipping_address || {};
      const countryCode = addr.countryCode || null;
      const provinceCode = addr.provinceCode || null;

      const zone = costMap[order.order_number]?.shipping_zone
        || (countryCode === 'US' ? 'us'
          : countryCode === 'CA' ? 'canada'
          : null);

      const transitDays = calendarDays(order.fulfilled_at, deliveredAt);

      // Quality filter
      const maxDays = MAX_TRANSIT_DAYS[zone] || 90;
      const minDays = MIN_TRANSIT_DAYS[zone] || 1;
      if (transitDays < minDays || transitDays > maxDays) {
        totalFiltered++;
        continue;
      }

      const region = regionMap[`${countryCode}:${provinceCode}`]
        || regionMap[`${countryCode}:*`]
        || zone
        || null;

      // Passport leg enrichment
      const snap = snapMap[order.order_number];
      let passportReceivedAt = null;
      let leg1 = null;
      let leg2 = null;
      let localCarrier = null;
      let carrier = null;

      if (snap) {
        carrier = snap.carrier;
        localCarrier = snap.local_carrier;

        if (snap.carrier === 'passport' && snap.raw_events) {
          passportReceivedAt = findPassportReceivedAt(snap.raw_events);
          if (passportReceivedAt) {
            leg1 = calendarDays(order.fulfilled_at, passportReceivedAt);
            leg2 = calendarDays(passportReceivedAt, deliveredAt);
            if (leg1 < 0 || leg2 < 0) {
              passportReceivedAt = null;
              leg1 = null;
              leg2 = null;
            }
          }
        }
      }

      // Processing time (order placed -> fulfilled)
      let orderedAt = order.created_at || null;
      let processingDays = null;
      if (orderedAt) {
        processingDays = calendarDays(orderedAt, order.fulfilled_at);
        if (processingDays < MIN_PROCESSING_DAYS || processingDays > MAX_PROCESSING_DAYS) {
          processingDays = null; // outlier — keep transit data, null out processing
        }
      }

      rows.push({
        order_number: order.order_number,
        country_code: countryCode,
        province_code: provinceCode,
        region,
        shipping_zone: zone,
        fulfillment_provider: 'nitro',
        ordered_at: orderedAt,
        fulfilled_at: order.fulfilled_at,
        delivered_at: deliveredAt,
        processing_days: processingDays,
        transit_days: transitDays,
        transit_business_days: businessDays(order.fulfilled_at, deliveredAt),
        passport_received_at: passportReceivedAt,
        leg1_days: leg1,
        leg2_days: leg2,
        local_carrier: localCarrier,
        carrier,
        computed_at: new Date().toISOString(),
      });
    }

    if (rows.length > 0) {
      const { error: upsertErr } = await supabase
        .from('order_delivery_times')
        .upsert(rows, { onConflict: 'order_number' });

      if (upsertErr) throw new Error(`Upsert failed: ${upsertErr.message}`);
      totalWritten += rows.length;
    }

    console.log(`  Batch: ${orders.length} orders, ${rows.length} written, ${totalSkipped} non-Nitro, ${totalNoDelivery} no deliveredAt, ${totalFiltered} filtered`);
  }

  console.log(`Delivery times sync complete: ${totalWritten} written, ${totalSkipped} non-Nitro, ${totalNoDelivery} awaiting delivery, ${totalFiltered} outliers filtered`);
  return { totalWritten, totalSkipped, totalFiltered, totalNoDelivery };
}

// ---------------------------------------------------------------------------
// Pipeline-compatible run() for daily-sync-all.js
// ---------------------------------------------------------------------------

async function run() {
  try {
    const result = await syncDeliveryTimes();
    return {
      sources: {
        delivery_times: { success: true, rowsWritten: result.totalWritten },
      },
      status: 'ok',
    };
  } catch (e) {
    console.error('Delivery times sync error:', e.message);
    return {
      sources: {
        delivery_times: { success: false, rowsWritten: 0, error: e.message },
      },
      status: 'error',
    };
  }
}

if (require.main === module) {
  const full = process.argv.includes('--full');
  if (full) console.log('Running full backfill...');
  syncDeliveryTimes({ full })
    .then(r => console.log('Done:', JSON.stringify(r)))
    .catch(e => { console.error('Error:', e.message); process.exit(1); });
}

module.exports = { syncDeliveryTimes, run };
