/**
 * Backfill order_fulfillment_costs from local Shopify order JSON files.
 *
 * Reads 28K+ order files from ~/Documents/shopifyOrderData, extracts:
 *   - 3PL costs (freight_charge_cad, logistics_data.3pl)
 *   - DDP costs (logistics_data.passport)
 *   - COGS (logistics_data.cogs)
 *   - Customer shipping charge
 *   - Provider identification via fulfillment location_id
 *
 * Provider mapping (by location_id):
 *   34617753685  -> 'chit-chats' (before 2023-03), 'manual' (after)
 *   78665285910  -> 'think-logistics'
 *   105921249558 -> 'nitro'
 *
 * Usage: node finance/backfill-fulfillment-costs.js [--dry-run]
 */

if (!process.env.SUPABASE_URL) require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const ORDERS_DIR = '/Users/jamiealexander/Documents/shopifyOrderData';
const BATCH_SIZE = 200;
const CAD_TO_USD = 1 / 1.38; // approximate

const LOCATION_PROVIDERS = {
  34617753685: (date) => date < '2023-03-01' ? 'chit-chats' : 'manual',
  78665285910: () => 'think-logistics',
  105921249558: () => 'nitro',
};

// Shipping zone lookup (simplified — matches shipping_zones table)
function getZone(countryCode) {
  if (countryCode === 'US') return 'us';
  if (countryCode === 'CA') return 'canada';
  // DDP countries (from shipping_zones table, 31 countries)
  const ddpCountries = new Set([
    'AU','AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU',
    'IS','IE','IL','IT','LV','LT','LU','MX','NL','NZ','NO','PL','PT','RO',
    'SK','SI','ES','SE','CH','GB'
  ]);
  if (ddpCountries.has(countryCode)) return 'ddp';
  return 'ddu';
}

function determineProvider(order) {
  const fulfillments = order.fulfillments || [];
  const date = (order.created_at || '').slice(0, 10);
  const locations = new Set();

  for (const ful of fulfillments) {
    if (ful.location_id && ful.status === 'success') {
      locations.add(ful.location_id);
    }
  }

  if (locations.size === 0) {
    // Fall back to logistics_data source
    const src = order.logistics_data?.['3pl']?.source;
    if (src === '3pl-expenses') return { provider: 'nitro', locationId: 105921249558 };
    if (src === 'think-logistics') return { provider: 'think-logistics', locationId: 78665285910 };
    return { provider: 'unknown', locationId: null };
  }

  if (locations.size === 1) {
    const locId = [...locations][0];
    const resolver = LOCATION_PROVIDERS[locId];
    const provider = resolver ? resolver(date) : 'unknown';
    return { provider, locationId: locId };
  }

  // Multiple locations — pick the primary (non-manual) one
  for (const locId of [105921249558, 78665285910]) {
    if (locations.has(locId)) {
      return { provider: LOCATION_PROVIDERS[locId](date), locationId: locId };
    }
  }
  return { provider: 'mixed', locationId: [...locations][0] };
}

function buildRow(order) {
  const { provider, locationId } = determineProvider(order);
  const countryCode = order.shipping_address?.country_code || null;
  const zone = countryCode ? getZone(countryCode) : null;
  const log = order.logistics_data || {};
  const tpl = log['3pl'] || {};
  const passport = log.passport || {};
  const cogs = log.cogs || {};

  // 3PL costs
  const packingUsd = parseFloat(tpl.packing_fee_usd) || 0;
  let shippingUsd = parseFloat(tpl.shipping_fee_usd) || 0;
  const freightCad = parseFloat(order.freight_charge_cad) || 0;

  // If we have freight_charge_cad but no shipping_fee_usd, convert
  if (shippingUsd === 0 && freightCad > 0) {
    shippingUsd = freightCad * CAD_TO_USD;
  }

  // DDP costs
  const ddpTax = parseFloat(passport.tax_usd) || 0;
  const ddpDuty = parseFloat(passport.duty_usd) || 0;
  const ddpClearance = parseFloat(passport.clearance_usd) || 0;
  const ddpTotal = ddpTax + ddpDuty + ddpClearance;

  // COGS
  const cogsUnit = parseFloat(cogs.unitCost) || 0;
  const cogsFreight = parseFloat(cogs.freight) || 0;
  const cogsDuties = parseFloat(cogs.duties) || 0;
  const cogsTotal = parseFloat(cogs.total) || 0;

  // Customer shipping
  const custShipUsd = parseFloat(order.shipping_lines?.[0]?.price) || 0;

  // Weight normalization — Think uses grams (total_weight), Nitro uses oz (logistics_data)
  const logWeightOz = parseFloat(tpl.shipping_weight_oz) || null;
  const orderWeightGrams = order.total_weight; // Shopify stores in grams
  const weightOz = logWeightOz || (orderWeightGrams > 0 ? round(orderWeightGrams / 28.3495) : null);

  // Dimensions from logistics_data (Nitro has these, Think generally doesn't)
  const lengthIn = parseFloat(tpl.length_in) || null;
  const widthIn = parseFloat(tpl.width_in) || null;
  const heightIn = parseFloat(tpl.height_in) || null;

  // Totals
  const totalFulfillment = packingUsd + shippingUsd + ddpTotal;
  const totalLanded = totalFulfillment + cogsTotal;
  const shippingNet = custShipUsd - totalFulfillment;

  // Skip if we have zero cost data
  if (packingUsd === 0 && shippingUsd === 0 && freightCad === 0 && ddpTotal === 0) {
    return null;
  }

  return {
    order_number: order.order_number,
    shopify_order_id: order.id,
    created_at: order.created_at,
    fulfillment_provider: provider,
    fulfillment_location_id: locationId,
    packing_fee_usd: round(packingUsd),
    shipping_fee_usd: round(shippingUsd),
    freight_charge_cad: round(freightCad),
    ddp_tax_usd: round(ddpTax),
    ddp_duty_usd: round(ddpDuty),
    ddp_clearance_usd: round(ddpClearance),
    ddp_total_usd: round(ddpTotal),
    cogs_unit_cost_usd: round(cogsUnit),
    cogs_freight_usd: round(cogsFreight),
    cogs_duties_usd: round(cogsDuties),
    cogs_total_usd: round(cogsTotal),
    total_fulfillment_cost_usd: round(totalFulfillment),
    total_landed_cost_usd: round(totalLanded),
    customer_shipping_usd: round(custShipUsd),
    shipping_net_usd: round(shippingNet),
    shipping_country_code: countryCode,
    shipping_zone: zone,
    weight_oz: weightOz,
    length_in: lengthIn,
    width_in: widthIn,
    height_in: heightIn,
    source: 'backfill-local-json',
  };
}

function round(n) { return Math.round(n * 100) / 100; }

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  console.log(`Reading order files from ${ORDERS_DIR}...`);
  const files = fs.readdirSync(ORDERS_DIR)
    .filter(f => f.endsWith('.json') && f !== 'last_sync.json');
  console.log(`Found ${files.length} order files`);

  const rows = [];
  const stats = { total: 0, withData: 0, skipped: 0, byProvider: {} };

  for (const f of files) {
    try {
      const order = JSON.parse(fs.readFileSync(path.join(ORDERS_DIR, f), 'utf8'));
      stats.total++;
      const row = buildRow(order);
      if (row) {
        rows.push(row);
        stats.withData++;
        stats.byProvider[row.fulfillment_provider] = (stats.byProvider[row.fulfillment_provider] || 0) + 1;
      } else {
        stats.skipped++;
      }
    } catch (e) { /* skip corrupt files */ }

    if (stats.total % 5000 === 0) {
      process.stdout.write(`\rProcessed ${stats.total} files, ${stats.withData} with cost data...`);
    }
  }

  console.log(`\n\nProcessing complete:`);
  console.log(`  Total files: ${stats.total}`);
  console.log(`  With cost data: ${stats.withData}`);
  console.log(`  Skipped (no cost data): ${stats.skipped}`);
  console.log(`  By provider:`, stats.byProvider);

  if (dryRun) {
    console.log('\n--dry-run: Not writing to Supabase.');
    // Show a few samples
    for (const provider of Object.keys(stats.byProvider)) {
      const sample = rows.find(r => r.fulfillment_provider === provider);
      console.log(`\nSample (${provider}):`, JSON.stringify(sample, null, 2));
    }
    return;
  }

  // Upsert in batches
  console.log(`\nUpserting ${rows.length} rows to order_fulfillment_costs...`);
  let written = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const { error } = await sb.from('order_fulfillment_costs')
      .upsert(batch, { onConflict: 'order_number' });
    if (error) {
      console.error(`Batch error at offset ${i}:`, error.message);
      // Try one by one to find problem rows
      for (const row of batch) {
        const { error: e2 } = await sb.from('order_fulfillment_costs')
          .upsert([row], { onConflict: 'order_number' });
        if (e2) console.error(`  Failed order #${row.order_number}: ${e2.message}`);
        else written++;
      }
    } else {
      written += batch.length;
    }
    if ((i + BATCH_SIZE) % 2000 === 0 || i + BATCH_SIZE >= rows.length) {
      process.stdout.write(`\r  Written ${written} / ${rows.length}...`);
    }
  }

  console.log(`\n\nDone! ${written} rows written to order_fulfillment_costs.`);
}

main().catch(console.error);
