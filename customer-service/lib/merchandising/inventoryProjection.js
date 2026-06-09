/**
 * Inventory Projection Engine
 *
 * Computes OOS-adjusted velocity per SKU and projects weeks-until-stockout,
 * qty-to-order, and priority. Writes results to `inventory_projections` table.
 *
 * Data sources:
 *   - Supabase: product_variants, products, order_line_items, orders, inventory_snapshots
 *   - Google Sheets: pre-order spreadsheet (1m2efAIbrV_...) for incoming inventory
 *
 * OOS adjustment:
 *   - Post-March 2026: count days where inventory_snapshots.inventory_quantity <= 0
 *   - Pre-March 2026: detect periods from order_line_items.custom_attributes pre-order flags
 */

const { getSupabaseClient } = require('../../../shared/supabaseClient');
const { shouldExcludeSku, getSupplierBySku } = require('./supplierRegistry');

// The pre-order incoming spreadsheet (tabs named us-YYYY-MM-DD)
const PRE_ORDER_SHEET_ID = process.env.PRE_ORDER_SHEET_ID || '1m2efAIbrV_fSYhJEfyAghROwJb7_3Fm5PuwR6GYjLwo';

const ADULT_SIZES = new Set(['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL',
  '18', '20', '22', '24', '26', 'XXS', 'XS1', '1X', '2X', '3X', '4X']);

// ---------------------------------------------------------------------------
// Date utilities (no moment dependency)
// ---------------------------------------------------------------------------

function isoDate(date) {
  return date instanceof Date ? date.toISOString().split('T')[0] : String(date).split('T')[0];
}

function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return isoDate(d);
}

function daysBetween(startStr, endStr) {
  const s = new Date(startStr + 'T00:00:00Z');
  const e = new Date(endStr + 'T00:00:00Z');
  return Math.max(0, Math.round((e - s) / 86400000));
}

// ISO week start (Monday) for a given date string
function weekStart(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const dow = d.getUTCDay(); // 0=Sun
  const diff = dow === 0 ? -6 : 1 - dow;
  d.setUTCDate(d.getUTCDate() + diff);
  return isoDate(d);
}

// ---------------------------------------------------------------------------
// Fetch active variants with product info
// ---------------------------------------------------------------------------

async function fetchActiveVariants() {
  const supabase = getSupabaseClient();

  const [{ data: products }, { data: variants }] = await Promise.all([
    supabase.from('products').select('shopify_product_id, handle, title').eq('status', 'ACTIVE'),
    supabase.from('product_variants').select('sku, inventory_quantity, shopify_product_id').not('sku', 'is', null).neq('sku', ''),
  ]);

  const productMap = new Map((products || []).map(p => [p.shopify_product_id, p]));

  return (variants || [])
    .filter(v => productMap.has(v.shopify_product_id))
    .map(v => {
      const p = productMap.get(v.shopify_product_id);
      return {
        sku: v.sku,
        inventory_quantity: v.inventory_quantity || 0,
        product_handle: p.handle,
        product_name: p.title,
      };
    });
}

// ---------------------------------------------------------------------------
// Fetch order velocity data: units sold per SKU in the window
// ---------------------------------------------------------------------------

async function fetchOrderData(startDate, endDate) {
  const supabase = getSupabaseClient();

  // Step 1: collect order IDs in window (not cancelled), paginated
  const orderIds = [];
  let page = 0;
  while (true) {
    const { data, error } = await supabase
      .from('orders')
      .select('shopify_order_id')
      .gte('created_at', startDate)
      .lt('created_at', endDate)
      .is('cancelled_at', null)
      .range(page * 1000, page * 1000 + 999);
    if (error) throw new Error(`fetchOrderData orders: ${error.message}`);
    if (!data?.length) break;
    for (const o of data) orderIds.push(o.shopify_order_id);
    if (data.length < 1000) break;
    page++;
  }

  if (!orderIds.length) return new Map();

  // Step 2: aggregate line item quantities by SKU, in batches
  const unitsBySku = new Map();
  const BATCH = 100;
  for (let i = 0; i < orderIds.length; i += BATCH) {
    const batch = orderIds.slice(i, i + BATCH);
    let p2 = 0;
    while (true) {
      const { data, error } = await supabase
        .from('order_line_items')
        .select('sku, quantity, refunded_quantity')
        .in('shopify_order_id', batch)
        .not('sku', 'is', null)
        .range(p2 * 1000, p2 * 1000 + 999);
      if (error) throw new Error(`fetchOrderData line_items: ${error.message}`);
      if (!data?.length) break;
      for (const row of data) {
        if (!row.sku) continue;
        const sold = (row.quantity || 0) - (row.refunded_quantity || 0);
        if (sold <= 0) continue;
        unitsBySku.set(row.sku, (unitsBySku.get(row.sku) || 0) + sold);
      }
      if (data.length < 1000) break;
      p2++;
    }
  }

  return unitsBySku;
}

// ---------------------------------------------------------------------------
// Fetch inventory snapshots in window
// ---------------------------------------------------------------------------

async function fetchInventorySnapshots(startDate) {
  const supabase = getSupabaseClient();
  const snapshotsBySku = new Map();
  let page = 0;
  while (true) {
    const { data, error } = await supabase
      .from('inventory_snapshots')
      .select('sku, date, inventory_quantity')
      .gte('date', startDate)
      .not('sku', 'is', null)
      .neq('sku', '')
      .order('sku')
      .order('date')
      .range(page * 1000, page * 1000 + 999);
    if (error) throw new Error(`fetchInventorySnapshots: ${error.message}`);
    if (!data?.length) break;
    for (const row of data) {
      if (!row.sku) continue;
      if (!snapshotsBySku.has(row.sku)) snapshotsBySku.set(row.sku, []);
      snapshotsBySku.get(row.sku).push({ date: row.date, inventory_quantity: row.inventory_quantity });
    }
    if (data.length < 1000) break;
    page++;
  }
  return snapshotsBySku;
}

// ---------------------------------------------------------------------------
// Detect OOS days from pre-order markers (pre-snapshot period only)
// Adapted from detectOutOfStockPeriods() in rubies-utilities/inventory-planning.js
// ---------------------------------------------------------------------------

function isPreOrderItem(customAttributes) {
  if (!Array.isArray(customAttributes)) return false;
  return customAttributes.some(a => a.key && a.key.toLowerCase() === 'pre-order');
}

function detectOosDaysFromPreorders(events, endDate) {
  if (!events.length) return 0;

  const sorted = [...events].sort((a, b) => a.orderDate.localeCompare(b.orderDate));

  const periods = [];
  let oosStart = null;
  let inOos = false;

  for (const evt of sorted) {
    const ws = weekStart(evt.orderDate);
    if (evt.isPreOrder) {
      if (!inOos) { oosStart = ws; inOos = true; }
    } else {
      if (inOos && oosStart) {
        const periodEnd = addDays(ws, -1);
        if (oosStart <= periodEnd) periods.push({ start: oosStart, end: periodEnd });
        inOos = false; oosStart = null;
      }
    }
  }
  if (inOos && oosStart) periods.push({ start: oosStart, end: endDate });

  // Merge periods within 21 days (3 weeks), matching the original script
  const sortedPeriods = [...periods].sort((a, b) => a.start.localeCompare(b.start));
  const merged = [];
  let cur = null;
  for (const p of sortedPeriods) {
    if (!cur) { cur = { ...p }; continue; }
    if (daysBetween(cur.end, p.start) <= 21) {
      if (p.end > cur.end) cur.end = p.end;
    } else {
      merged.push(cur);
      cur = { ...p };
    }
  }
  if (cur) merged.push(cur);

  return merged.reduce((sum, p) => sum + daysBetween(p.start, p.end), 0);
}

async function fetchPreOrderEvents(startDate, snapshotStartDate) {
  if (!snapshotStartDate || startDate >= snapshotStartDate) return new Map();
  const supabase = getSupabaseClient();

  // Orders in the pre-snapshot window
  const orderMap = new Map();
  let page = 0;
  while (true) {
    const { data, error } = await supabase
      .from('orders')
      .select('shopify_order_id, created_at')
      .gte('created_at', startDate)
      .lt('created_at', snapshotStartDate)
      .is('cancelled_at', null)
      .range(page * 1000, page * 1000 + 999);
    if (error) throw new Error(`fetchPreOrderEvents orders: ${error.message}`);
    if (!data?.length) break;
    for (const o of data) orderMap.set(o.shopify_order_id, o.created_at);
    if (data.length < 1000) break;
    page++;
  }

  if (!orderMap.size) return new Map();

  const orderIds = Array.from(orderMap.keys());
  const eventsBySku = new Map();

  const BATCH = 100;
  for (let i = 0; i < orderIds.length; i += BATCH) {
    const batch = orderIds.slice(i, i + BATCH);
    let p2 = 0;
    while (true) {
      const { data, error } = await supabase
        .from('order_line_items')
        .select('sku, shopify_order_id, custom_attributes')
        .in('shopify_order_id', batch)
        .not('sku', 'is', null)
        .range(p2 * 1000, p2 * 1000 + 999);
      if (error) throw new Error(`fetchPreOrderEvents line_items: ${error.message}`);
      if (!data?.length) break;

      for (const item of data) {
        if (!item.sku) continue;
        const orderCreatedAt = orderMap.get(item.shopify_order_id);
        if (!orderCreatedAt) continue;
        if (!eventsBySku.has(item.sku)) eventsBySku.set(item.sku, []);
        eventsBySku.get(item.sku).push({
          orderDate: isoDate(orderCreatedAt),
          isPreOrder: isPreOrderItem(item.custom_attributes),
        });
      }

      if (data.length < 1000) break;
      p2++;
    }
  }

  return eventsBySku;
}

// ---------------------------------------------------------------------------
// Fetch incoming orders from Google Sheets (us-YYYY-MM-DD tabs)
// ---------------------------------------------------------------------------

async function fetchIncomingOrders() {
  let sheets;
  try {
    const { getSheetsClient } = require('../../../shared/googleSheetsClient');
    sheets = await getSheetsClient();
  } catch (err) {
    console.warn(`fetchIncomingOrders: Google Sheets unavailable — ${err.message}. Continuing without incoming inventory.`);
    return new Map();
  }

  let spreadsheet;
  try {
    const res = await sheets.spreadsheets.get({
      spreadsheetId: PRE_ORDER_SHEET_ID,
      fields: 'sheets.properties.title',
    });
    spreadsheet = res.data;
  } catch (err) {
    console.warn(`fetchIncomingOrders: failed to list sheets — ${err.message}`);
    return new Map();
  }

  const incomingBySku = new Map();

  for (const sheet of spreadsheet.sheets || []) {
    const title = sheet.properties.title;
    const match = title.match(/^us-(\d{4}-\d{2}-\d{2})$/);
    if (!match) continue;
    const date = match[1];

    try {
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: PRE_ORDER_SHEET_ID,
        range: `'${title}'!A:B`,
      });
      const rows = res.data.values || [];
      if (rows.length < 2) continue;

      // Find header columns
      const headers = (rows[0] || []).map(h => (h || '').toLowerCase().trim());
      const skuCol = headers.indexOf('sku');
      const incomingCol = headers.indexOf('incoming');
      if (skuCol === -1 || incomingCol === -1) continue;

      for (let i = 1; i < rows.length; i++) {
        const sku = (rows[i][skuCol] || '').trim();
        const qty = parseInt((rows[i][incomingCol] || '0').toString().trim(), 10);
        if (!sku || !qty || isNaN(qty) || qty <= 0) continue;

        if (!incomingBySku.has(sku)) incomingBySku.set(sku, { incoming: [], total: 0 });
        const entry = incomingBySku.get(sku);
        entry.incoming.push({ date, quantity: qty });
        entry.total += qty;
      }
    } catch (err) {
      console.warn(`fetchIncomingOrders: error reading sheet "${title}" — ${err.message}`);
    }
  }

  return incomingBySku;
}

// ---------------------------------------------------------------------------
// Priority label from weeks-until-no-stock
// ---------------------------------------------------------------------------

function getPriority(weeks) {
  if (!isFinite(weeks) || weeks >= 78) return 'FULL_STOCK';
  if (weeks >= 52) return 'GOOD';
  if (weeks >= 39) return 'OK';
  if (weeks >= 26) return 'WATCH';
  if (weeks >= 13) return 'NEEDS_ATTENTION';
  return 'URGENT';
}

// ---------------------------------------------------------------------------
// Fetch first sale date for SKUs that don't yet have one stored.
// Queries ALL orders (no date window) — runs once per SKU, then stored forever.
// ---------------------------------------------------------------------------

async function fetchFirstSaleDatesForSkus(skuList) {
  if (!skuList.length) return new Map();
  const supabase = getSupabaseClient();

  // Step 1: get all order_line_items for these SKUs (no date filter)
  const orderIdsBySku = new Map();
  const BATCH = 100;
  for (let i = 0; i < skuList.length; i += BATCH) {
    const batch = skuList.slice(i, i + BATCH);
    let page = 0;
    while (true) {
      const { data, error } = await supabase
        .from('order_line_items')
        .select('sku, shopify_order_id')
        .in('sku', batch)
        .range(page * 1000, page * 1000 + 999);
      if (error) throw new Error(`fetchFirstSaleDatesForSkus items: ${error.message}`);
      if (!data?.length) break;
      for (const row of data) {
        if (!row.sku || !row.shopify_order_id) continue;
        if (!orderIdsBySku.has(row.sku)) orderIdsBySku.set(row.sku, new Set());
        orderIdsBySku.get(row.sku).add(row.shopify_order_id);
      }
      if (data.length < 1000) break;
      page++;
    }
  }

  // Step 2: resolve order dates (non-cancelled only)
  const allOrderIds = Array.from(new Set([...orderIdsBySku.values()].flatMap(s => [...s])));
  const orderDates = new Map();
  for (let i = 0; i < allOrderIds.length; i += BATCH) {
    const batch = allOrderIds.slice(i, i + BATCH);
    const { data, error } = await supabase
      .from('orders')
      .select('shopify_order_id, created_at')
      .in('shopify_order_id', batch)
      .is('cancelled_at', null);
    if (error) throw new Error(`fetchFirstSaleDatesForSkus orders: ${error.message}`);
    for (const o of (data || [])) {
      if (o.created_at) orderDates.set(o.shopify_order_id, o.created_at.slice(0, 10));
    }
  }

  // Step 3: find min date per SKU
  const firstSaleBySku = new Map();
  for (const [sku, orderIds] of orderIdsBySku) {
    for (const orderId of orderIds) {
      const date = orderDates.get(orderId);
      if (!date) continue;
      const existing = firstSaleBySku.get(sku);
      if (!existing || date < existing) firstSaleBySku.set(sku, date);
    }
  }

  return firstSaleBySku;
}

// ---------------------------------------------------------------------------
// Main: run projection and upsert to inventory_projections
// ---------------------------------------------------------------------------

async function runProjection({ growthFactor = 1.3, targetWeeks = 78, lookbackDays = 365, writeSheets = false, skuPrefixes = null } = {}) {
  const supabase = getSupabaseClient();
  const endDate = isoDate(new Date());
  const startDate = isoDate(new Date(Date.now() - lookbackDays * 86400000));

  console.log(`[projection] window: ${startDate} → ${endDate}`);

  // Detect snapshot start date (earliest snapshot in DB)
  const { data: earliestSnap } = await supabase
    .from('inventory_snapshots')
    .select('date')
    .order('date', { ascending: true })
    .limit(1);
  const snapshotStartDate = earliestSnap?.[0]?.date || null;
  console.log(`[projection] snapshot start: ${snapshotStartDate || 'none'}`);

  // Load all data sources in parallel
  console.log('[projection] loading data...');
  const [variants, unitsBySku, snapshotsBySku, incomingBySku, preOrderEventsBySku] = await Promise.all([
    fetchActiveVariants(),
    fetchOrderData(startDate, endDate),
    fetchInventorySnapshots(startDate),
    fetchIncomingOrders(),
    fetchPreOrderEvents(startDate, snapshotStartDate),
  ]);

  // Optional prefix filter for testing
  const filteredVariants = skuPrefixes
    ? variants.filter(v => skuPrefixes.includes((v.sku || '').split('-')[0]))
    : variants;

  console.log(`[projection] ${filteredVariants.length} variants (${skuPrefixes ? skuPrefixes.join(',') + ' only' : 'all'}), ${unitsBySku.size} skus with sales, ${incomingBySku.size} skus with incoming`);

  // Fetch stored first_sale_date values; compute and store for any SKU missing one
  const { data: storedDates } = await supabase
    .from('inventory_projections')
    .select('sku, first_sale_date')
    .not('first_sale_date', 'is', null)
    .in('sku', filteredVariants.map(v => v.sku));

  const firstSaleDateBySku = new Map((storedDates || []).map(r => [r.sku, r.first_sale_date]));

  const skusNeedingDate = filteredVariants
    .map(v => v.sku)
    .filter(sku => !shouldExcludeSku(sku) && !firstSaleDateBySku.has(sku));

  if (skusNeedingDate.length > 0) {
    console.log(`[projection] computing first_sale_date for ${skusNeedingDate.length} new SKUs...`);
    const computed = await fetchFirstSaleDatesForSkus(skusNeedingDate);
    for (const [sku, date] of computed) firstSaleDateBySku.set(sku, date);
  }

  // Pre-load all suppliers (caches on first call)
  const projectionRows = [];

  for (const variant of filteredVariants) {
    const { sku, inventory_quantity, product_handle, product_name } = variant;
    if (shouldExcludeSku(sku)) continue;

    const unitsSold = unitsBySku.get(sku) || 0;
    const snapshots = snapshotsBySku.get(sku) || [];
    const incoming = incomingBySku.get(sku) || { total: 0 };
    const preOrderEvents = preOrderEventsBySku.get(sku) || [];

    // Use first_sale_date as floor for the lookback window (new products only use their actual selling period)
    const firstSaleDate = firstSaleDateBySku.get(sku) || startDate;
    const skuStart = firstSaleDate > startDate ? firstSaleDate : startDate;
    const periodDays = daysBetween(skuStart, endDate);

    // OOS days from snapshots (inventory_quantity <= 0, within the sku's effective window)
    const oosDaysFromSnapshots = snapshots.filter(s => s.date >= skuStart && s.inventory_quantity <= 0).length;

    // OOS days from pre-order markers (pre-snapshot period only)
    const oosDaysFromPreorders = detectOosDaysFromPreorders(preOrderEvents, snapshotStartDate || skuStart);

    const oosDays = oosDaysFromSnapshots + oosDaysFromPreorders;
    const effectiveSellingDays = Math.max(0, periodDays - oosDays);
    const effectiveSellingWeeks = effectiveSellingDays / 7;

    // Velocity: OOS-adjusted, fallback to simple average if near-zero selling time
    const salesPerWeek = effectiveSellingWeeks > 4
      ? unitsSold / effectiveSellingWeeks
      : unitsSold / (periodDays / 7);

    // Current inventory: latest snapshot preferred, fall back to product_variants value
    const currentInventory = snapshots.length > 0
      ? snapshots[snapshots.length - 1].inventory_quantity
      : inventory_quantity;

    const totalIncoming = incoming.total;
    const totalInventory = currentInventory + totalIncoming;

    const weeksUntilNoStock = salesPerWeek > 0
      ? totalInventory / (salesPerWeek * growthFactor)
      : Infinity;

    const weeksUntilNoStockDb = isFinite(weeksUntilNoStock) ? Math.round(weeksUntilNoStock * 10) / 10 : 9999.0;

    const qtyToOrder = salesPerWeek > 0 && isFinite(weeksUntilNoStock)
      ? Math.round(Math.max(0, (targetWeeks - weeksUntilNoStock) * salesPerWeek * growthFactor) / 10) * 10
      : 0;

    const priority = getPriority(weeksUntilNoStockDb);

    // SKU structure: PREFIX-COLOR-SIZE
    const parts = sku.split('-');
    const color = parts[1] || null;
    const size = parts[2] || null;
    const ageRange = size && ADULT_SIZES.has(size.toUpperCase()) ? 'adults' : 'youth';

    const supplier = await getSupplierBySku(sku);

    projectionRows.push({
      run_date: endDate,
      sku,
      product_handle,
      product_name,
      color,
      size,
      age_range: ageRange,
      current_inventory: currentInventory,
      total_incoming: totalIncoming,
      total_inventory: totalInventory,
      units_sold_year: unitsSold,
      sales_per_week: Math.round(salesPerWeek * 100) / 100,
      weeks_until_no_stock: weeksUntilNoStockDb,
      priority,
      qty_to_order: qtyToOrder,
      weeks_unavailable: Math.round(oosDays / 7),
      oos_periods: null,
      first_sale_date: firstSaleDateBySku.get(sku) || null,
      growth_factor: growthFactor,
      target_weeks: targetWeeks,
      supplier_id: supplier?.id || null,
      updated_at: new Date().toISOString(),
    });
  }

  // Upsert all projection rows
  if (projectionRows.length > 0) {
    const UPSERT_BATCH = 200;
    for (let i = 0; i < projectionRows.length; i += UPSERT_BATCH) {
      const batch = projectionRows.slice(i, i + UPSERT_BATCH);
      const { error } = await supabase
        .from('inventory_projections')
        .upsert(batch, { onConflict: 'sku' });
      if (error) throw new Error(`upsert inventory_projections: ${error.message}`);
    }
  }

  if (writeSheets) {
    await writeSalesDataSheet(projectionRows);
  }

  const atRiskCount = projectionRows.filter(r => r.weeks_until_no_stock < 26).length;
  const totalUnitsToOrder = projectionRows.reduce((s, r) => s + r.qty_to_order, 0);

  console.log(`[projection] done: ${projectionRows.length} SKUs, ${atRiskCount} at risk, ${totalUnitsToOrder} units to order`);

  return {
    run_date: endDate,
    sku_count: projectionRows.length,
    at_risk_count: atRiskCount,
    total_units_to_order: totalUnitsToOrder,
  };
}

// ---------------------------------------------------------------------------
// Optional: write "Sales Data by SKU" sheet to Google Sheets
// ---------------------------------------------------------------------------

async function writeSalesDataSheet(rows) {
  let sheets;
  try {
    const { getSheetsClient } = require('../../../shared/googleSheetsClient');
    sheets = await getSheetsClient();
  } catch (err) {
    console.warn(`writeSalesDataSheet: Google Sheets unavailable — ${err.message}`);
    return;
  }

  const SALES_SHEET_ID = process.env.INVENTORY_PLANNING_SHEET_ID;
  if (!SALES_SHEET_ID) {
    console.warn('writeSalesDataSheet: INVENTORY_PLANNING_SHEET_ID not set, skipping');
    return;
  }

  const headers = ['SKU', 'Product', 'Color', 'Size', 'Age Range', 'Current Inventory',
    'Total Incoming', 'Total Inventory', 'Units Sold (Year)', 'Sales/Week',
    'Weeks Until Stockout', 'Qty to Order', 'Priority', 'Weeks Unavailable', 'Supplier'];

  const rowsData = rows.map(r => [
    r.sku, r.product_name, r.color || '', r.size || '', r.age_range || '',
    r.current_inventory, r.total_incoming, r.total_inventory,
    r.units_sold_year, r.sales_per_week,
    r.weeks_until_no_stock === 9999 ? '∞' : r.weeks_until_no_stock,
    r.qty_to_order, r.priority, r.weeks_unavailable, '',
  ]);

  try {
    // Clear and rewrite the Sales Data by SKU sheet
    await sheets.spreadsheets.values.clear({
      spreadsheetId: SALES_SHEET_ID,
      range: 'Sales Data by SKU',
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SALES_SHEET_ID,
      range: 'Sales Data by SKU!A1',
      valueInputOption: 'RAW',
      requestBody: { values: [headers, ...rowsData] },
    });
    console.log(`[projection] wrote ${rowsData.length} rows to Google Sheets`);
  } catch (err) {
    console.warn(`writeSalesDataSheet: failed — ${err.message}`);
  }
}

module.exports = { runProjection };
