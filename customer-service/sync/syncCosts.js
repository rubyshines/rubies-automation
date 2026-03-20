#!/usr/bin/env node

/**
 * Sync COGS data from Google Sheets → Supabase product_costs table.
 *
 * Reads the supplier pricing spreadsheet (SUPPLIER_PRICING_SHEET_ID env var),
 * compares with current costs in Supabase, and inserts new rows only when
 * values have changed (or for new SKU prefixes).
 *
 * Usage: npm run cs-sync-costs
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../..', '.env') });

const { getSheetsClient } = require('../../shared/googleSheetsClient');
const { getSupabaseClient } = require('../../shared/supabaseClient');

async function main() {
  const sheetId = process.env.SUPPLIER_PRICING_SHEET_ID;
  if (!sheetId) {
    console.error('Error: SUPPLIER_PRICING_SHEET_ID not set in .env');
    process.exit(1);
  }

  console.log('Fetching COGS data from Google Sheets...');
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: 'A2:G100', // Skip header row; cols A-G
  });

  const rows = res.data.values || [];
  if (!rows.length) {
    console.log('No data found in spreadsheet.');
    return;
  }

  // Parse spreadsheet rows
  const sheetCosts = [];
  for (const row of rows) {
    const skuPrefix = (row[0] || '').trim();
    if (!skuPrefix) continue;

    sheetCosts.push({
      sku_prefix: skuPrefix,
      product_name: (row[1] || '').trim(),
      unit_cost: parseDecimal(row[2]),
      freight: parseDecimal(row[3]),
      duties_rate: parseDecimal(row[4]),
      duties_amount: parseDecimal(row[5]),
      total_landed_cost: parseDecimal(row[6]),
    });
  }

  console.log(`Parsed ${sheetCosts.length} rows from spreadsheet.`);

  // Fetch current costs from Supabase
  const supabase = getSupabaseClient();
  const { data: currentCosts, error } = await supabase.rpc('get_current_costs');
  if (error) throw new Error(`Failed to fetch current costs: ${error.message}`);

  const currentMap = new Map();
  for (const c of (currentCosts || [])) {
    currentMap.set(c.sku_prefix, c);
  }

  // Compare and insert only changed/new rows
  const toInsert = [];
  for (const sc of sheetCosts) {
    const existing = currentMap.get(sc.sku_prefix);
    if (existing && !hasChanged(existing, sc)) {
      continue; // No changes, skip
    }
    toInsert.push({
      ...sc,
      effective_date: new Date().toISOString().split('T')[0],
    });
  }

  if (!toInsert.length) {
    console.log('No cost changes detected. Nothing to insert.');
    return;
  }

  console.log(`Inserting ${toInsert.length} cost rows (new or changed)...`);
  const { error: insertError } = await supabase
    .from('product_costs')
    .upsert(toInsert, { onConflict: 'sku_prefix,effective_date' });

  if (insertError) throw new Error(`Insert failed: ${insertError.message}`);

  console.log(`Done. ${toInsert.length} rows synced to product_costs.`);
}

function parseDecimal(val) {
  if (!val) return 0;
  const cleaned = String(val).replace(/[^0-9.\-]/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : Math.round(num * 100) / 100;
}

function hasChanged(existing, incoming) {
  return (
    Number(existing.unit_cost) !== incoming.unit_cost ||
    Number(existing.freight) !== incoming.freight ||
    Number(existing.duties_rate) !== incoming.duties_rate ||
    Number(existing.duties_amount) !== incoming.duties_amount ||
    Number(existing.total_landed_cost) !== incoming.total_landed_cost
  );
}

main().catch(err => {
  console.error('Sync failed:', err.message);
  process.exit(1);
});
