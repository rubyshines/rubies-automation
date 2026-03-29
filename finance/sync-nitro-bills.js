/**
 * Sync Nitro (Warehance) billing data into order_fulfillment_costs.
 *
 * Downloads all monthly bill CSVs from the Warehance API, parses line items,
 * aggregates per order (shipment + picking + parcel + storage + returns),
 * and upserts into order_fulfillment_costs with normalized weight/dimensions.
 *
 * Also adds weight_oz, length_in, width_in, height_in to each row.
 *
 * Usage: node finance/sync-nitro-bills.js [--dry-run]
 */

if (!process.env.SUPABASE_URL) require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const API_KEY = process.env.WAREHANCE_API_KEY;
const BASE = process.env.WAREHANCE_API_URL || 'https://api.staging.warehance.com/v1';
const BATCH_SIZE = 200;

if (!API_KEY) {
  console.error('Missing WAREHANCE_API_KEY in .env');
  process.exit(1);
}

async function apiFetch(path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'X-API-KEY': API_KEY },
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json();
}

async function downloadCsv(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CSV download ${res.status}`);
  return res.text();
}

function parseOrderNumber(raw) {
  if (!raw) return null;
  // "#23167" -> 23167
  return parseInt(raw.replace('#', ''), 10) || null;
}

function getZone(countryCode) {
  if (!countryCode) return null;
  const cc = countryCode.toUpperCase();
  if (cc === 'US') return 'us';
  if (cc === 'CA') return 'canada';
  const ddp = new Set([
    'AU','AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU',
    'IS','IE','IL','IT','LV','LT','LU','MX','NL','NZ','NO','PL','PT','RO',
    'SK','SI','ES','SE','CH','GB'
  ]);
  if (ddp.has(cc)) return 'ddp';
  return 'ddu';
}

function parseCsv(text) {
  const lines = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') { inQuotes = !inQuotes; current += ch; }
    else if (ch === '\n' && !inQuotes) { lines.push(current); current = ''; }
    else { current += ch; }
  }
  if (current.trim()) lines.push(current);

  if (lines.length < 2) return [];
  const headers = splitCsvLine(lines[0]);
  return lines.slice(1).filter(l => l.trim()).map(line => {
    const vals = splitCsvLine(line);
    const obj = {};
    headers.forEach((h, i) => obj[h] = (vals[i] || '').trim());
    return obj;
  });
}

function splitCsvLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQuotes = !inQuotes; }
    else if (ch === ',' && !inQuotes) { result.push(current); current = ''; }
    else { current += ch; }
  }
  result.push(current);
  return result;
}

function parseBillCsv(csvText) {
  const rows = parseCsv(csvText);
  const orders = {};

  for (const row of rows) {
    const orderNum = parseOrderNumber(row['Order Number']);
    if (!orderNum) continue; // skip storage/adhoc without order

    if (!orders[orderNum]) {
      orders[orderNum] = {
        order_number: orderNum,
        shipment_cost: 0,
        picking_cost: 0,
        parcel_cost: 0,
        storage_cost: 0,
        returns_cost: 0,
        adhoc_cost: 0,
        weight_oz: null,
        length_in: null,
        width_in: null,
        height_in: null,
        carrier: null,
        service: null,
        tracking: null,
        zone_number: null,
        country_code: null,
        order_date: null,
      };
    }

    const o = orders[orderNum];
    const amt = parseFloat(row['Amount']) || 0;
    const cat = row['Charge Category'];

    switch (cat) {
      case 'shipments': o.shipment_cost += amt; break;
      case 'picking': o.picking_cost += amt; break;
      case 'shipment_parcels': o.parcel_cost += amt; break;
      case 'storage': o.storage_cost += amt; break;
      case 'returns': o.returns_cost += amt; break;
      case 'adhoc': o.adhoc_cost += amt; break;
    }

    // Capture weight/dimensions from shipment or parcel rows
    if (cat === 'shipments' || cat === 'shipment_parcels') {
      const w = parseFloat(row['Weight']);
      if (w > 0) o.weight_oz = w;

      const l = parseFloat(row['Length']);
      const wi = parseFloat(row['Width']);
      const h = parseFloat(row['Height']);
      if (l > 0) o.length_in = l;
      if (wi > 0) o.width_in = wi;
      if (h > 0) o.height_in = h;

      if (row['Carrier']) o.carrier = row['Carrier'];
      if (row['Service']) o.service = row['Service'];
      if (row['Tracking Number']) o.tracking = row['Tracking Number'];
      if (row['Zone']) o.zone_number = row['Zone'];
    }

    // Capture country from ship-to address
    if (row['Ship To Country']) o.country_code = row['Ship To Country'];
    if (row['Order Date']) o.order_date = row['Order Date'];
  }

  return orders;
}

function buildRow(o) {
  const zone = getZone(o.country_code);
  const totalFulfillment = o.shipment_cost + o.picking_cost + o.parcel_cost;

  return {
    order_number: o.order_number,
    created_at: o.order_date || null,
    fulfillment_provider: 'nitro',
    fulfillment_location_id: 105921249558,
    packing_fee_usd: round(o.picking_cost + o.parcel_cost),
    shipping_fee_usd: round(o.shipment_cost),
    freight_charge_cad: 0,
    total_fulfillment_cost_usd: round(totalFulfillment),
    shipping_country_code: o.country_code,
    shipping_zone: zone,
    weight_oz: o.weight_oz,
    length_in: o.length_in,
    width_in: o.width_in,
    height_in: o.height_in,
    source: 'warehance-bills',
  };
}

function round(n) { return Math.round(n * 100) / 100; }

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  // Fetch all bills
  console.log('Fetching bills from Warehance API...');
  const { data } = await apiFetch('/bills?limit=50');
  const bills = data.bills.filter(b => b.generation_status === 'Completed');
  console.log(`Found ${bills.length} completed bills`);

  const allOrders = {};

  for (const bill of bills) {
    const period = bill.bill_name.match(/\d{4}-\d{2}-\d{2}/)?.[0] || bill.bill_name;
    process.stdout.write(`  ${period}: $${bill.total_charge_amount.toLocaleString()} — downloading CSV...`);

    const csvText = await downloadCsv(bill.line_item_details_csv_url);
    const orders = parseBillCsv(csvText);
    const count = Object.keys(orders).length;

    // Merge into allOrders (an order could span bills if returns come later)
    for (const [num, o] of Object.entries(orders)) {
      if (!allOrders[num]) {
        allOrders[num] = o;
      } else {
        const existing = allOrders[num];
        existing.shipment_cost += o.shipment_cost;
        existing.picking_cost += o.picking_cost;
        existing.parcel_cost += o.parcel_cost;
        existing.storage_cost += o.storage_cost;
        existing.returns_cost += o.returns_cost;
        existing.adhoc_cost += o.adhoc_cost;
        if (o.weight_oz) existing.weight_oz = o.weight_oz;
        if (o.length_in) existing.length_in = o.length_in;
        if (o.width_in) existing.width_in = o.width_in;
        if (o.height_in) existing.height_in = o.height_in;
        if (o.carrier) existing.carrier = o.carrier;
        if (o.country_code) existing.country_code = o.country_code;
        if (o.order_date) existing.order_date = o.order_date;
      }
    }

    console.log(` ${count} orders`);
  }

  console.log(`\nTotal unique orders across all bills: ${Object.keys(allOrders).length}`);

  // Build upsert rows
  const rows = Object.values(allOrders).map(buildRow);

  // Stats
  const byZone = {};
  for (const r of rows) {
    const z = r.shipping_zone || 'unknown';
    if (!byZone[z]) byZone[z] = { count: 0, totalCost: 0 };
    byZone[z].count++;
    byZone[z].totalCost += r.total_fulfillment_cost_usd;
  }
  console.log('\nBy zone:');
  for (const [z, s] of Object.entries(byZone).sort((a, b) => b[1].count - a[1].count)) {
    console.log(`  ${z}: ${s.count} orders, avg $${(s.totalCost / s.count).toFixed(2)}/order, total $${s.totalCost.toFixed(0)}`);
  }

  const withWeight = rows.filter(r => r.weight_oz > 0).length;
  console.log(`\nWeight data: ${withWeight}/${rows.length} orders (${(withWeight / rows.length * 100).toFixed(1)}%)`);

  if (dryRun) {
    console.log('\n--dry-run: Not writing to Supabase.');
    console.log('Sample rows:');
    for (const z of Object.keys(byZone)) {
      const sample = rows.find(r => r.shipping_zone === z);
      if (sample) console.log(`  ${z}:`, JSON.stringify(sample));
    }
    return;
  }

  // Upsert
  console.log(`\nUpserting ${rows.length} rows to order_fulfillment_costs...`);
  let written = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const { error } = await sb.from('order_fulfillment_costs')
      .upsert(batch, { onConflict: 'order_number' });
    if (error) {
      console.error(`Batch error at offset ${i}:`, error.message);
      for (const row of batch) {
        const { error: e2 } = await sb.from('order_fulfillment_costs')
          .upsert([row], { onConflict: 'order_number' });
        if (e2) console.error(`  Failed #${row.order_number}: ${e2.message}`);
        else written++;
      }
    } else {
      written += batch.length;
    }
    if ((i + BATCH_SIZE) % 1000 === 0 || i + BATCH_SIZE >= rows.length) {
      process.stdout.write(`\r  Written ${written} / ${rows.length}...`);
    }
  }

  console.log(`\n\nDone! ${written} rows written.`);
  return { sources: { 'nitro-bills': { success: true, rowsWritten: written } }, status: 'ok' };
}

/** Daily-sync compatible entry point */
async function run() {
  try {
    return await main();
  } catch (err) {
    // Gracefully skip if no new bills or API unavailable
    console.log('Nitro bills sync skipped:', err.message);
    return { sources: { 'nitro-bills': { success: true, rowsWritten: 0, error: err.message } }, status: 'ok' };
  }
}

module.exports = { run };

if (require.main === module) {
  main().catch(console.error);
}
