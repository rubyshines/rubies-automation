/**
 * Production-order draft -> edit-in-sheet -> GO loop.
 *
 *  draftProductionOrder(supplier): write an editable tab to the "2026 Production Numbers"
 *    Google Sheet from the supplier's current projections (qty_to_order > 0).
 *  createOrderFromTab(supplier, tabName, opts): read the (edited) tab back as canonical,
 *    parse it, mint a production_code, insert production_orders + items + payments, and
 *    emit a supplier-ready .xlsx. Record-only — does NOT email the supplier.
 *
 * Reuses: parseProductionSheet, nextProductionCode, getSheetsClient, getSupplierByName,
 * sizeUtils (size ordering), xlsx (SheetJS). Supabase is the source of truth; the sheet is
 * the human edit/view surface.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const XLSX = require('xlsx');
const { getSupabaseClient } = require('../../../shared/supabaseClient');
const { getSheetsClient } = require('../../../shared/googleSheetsClient');
const { getSupplierByName } = require('./supplierRegistry');
const { parseProductionSheet, parseProjectionReviewSheet } = require('./productionSheetParser');
const { nextProductionCode } = require('./productionCode');
const { runProjection, writeSalesDataSheet } = require('./inventoryProjection');
const { applyOrderRules, PER_SKU_FLOOR, ORDER_STEP } = require('./orderSpread');
const { fetchCurrentCosts, computePricing } = require('./pricingEstimate');
const { NUMERIC_SIZES, LETTER_SIZES, SIZE_ALIASES, parseSizeVariant } = require('../sizeUtils');

// Recency guard: reuse a recent projection, else recompute so a draft is never stale.
async function ensureFreshProjection({ date, maxAgeDays, forceRefresh }) {
  const sb = getSupabaseClient();
  const { data } = await sb.from('inventory_projections')
    .select('run_date').order('run_date', { ascending: false }).limit(1);
  const runDate = data && data[0] ? data[0].run_date : null;
  const ageDays = runDate ? Math.round((Date.parse(date) - Date.parse(runDate)) / 86400000) : null;
  const stale = forceRefresh || runDate == null || ageDays > maxAgeDays;
  if (stale) {
    await runProjection();
    return { run_date: date, refreshed: true, reason: forceRefresh ? 'forced' : runDate == null ? 'none existed' : `was ${ageDays}d old`, previous_run_date: runDate };
  }
  return { run_date: runDate, refreshed: false, age_days: ageDays };
}

const SHEET_ID = process.env.PRODUCTION_SHEET_ID || '1kMZ-thv7pmBEvudlT_Ujw1z1wb-2zwjV5vT_TuNm87w';
const PLANNING_SHEET_ID = process.env.INVENTORY_PLANNING_SHEET_ID;

// Create a tab at the front (index 0) of a sheet, write values, and bold the
// given rows (0-based). Clears the tab first if it already exists so stale rows
// from a previous run don't linger.
async function writeTabAtFront(sheets, spreadsheetId, tabName, values, boldRows = [], numCols = 2) {
  let sheetId = null;
  try {
    const res = await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: tabName, index: 0 } } }] },
    });
    sheetId = res.data.replies[0].addSheet.properties.sheetId;
  } catch (e) {
    if (!/already exists/i.test(e.message)) throw e;
    const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties(sheetId,title)' });
    const existing = (meta.data.sheets || []).find((s) => s.properties.title === tabName);
    sheetId = existing ? existing.properties.sheetId : null;
    await sheets.spreadsheets.values.clear({ spreadsheetId, range: `'${tabName}'` });
  }
  await sheets.spreadsheets.values.update({
    spreadsheetId, range: `'${tabName}'!A1`, valueInputOption: 'USER_ENTERED', requestBody: { values },
  });
  if (sheetId != null && boldRows.length) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: boldRows.map((ri) => ({
          repeatCell: {
            range: { sheetId, startRowIndex: ri, endRowIndex: ri + 1, startColumnIndex: 0, endColumnIndex: numCols },
            cell: { userEnteredFormat: { textFormat: { bold: true } } },
            fields: 'userEnteredFormat.textFormat.bold',
          },
        })),
      },
    });
  }
}

function sizeSort(size) {
  const { base, modifier } = parseSizeVariant(String(size || '').toUpperCase());
  const canonical = (base && (SIZE_ALIASES[base] || base)) || String(size || '').toUpperCase();
  const isTall = modifier === 'Tall';
  const ni = NUMERIC_SIZES.indexOf(canonical);
  if (ni !== -1) return isTall ? 50 + ni : ni;
  const li = LETTER_SIZES.indexOf(canonical);
  if (li !== -1) return isTall ? 200 + li : 100 + li;
  return 999;
}

// Product titles are stored ALL CAPS; render them mixed (title) case for the order
// sheet. Brand acronyms in KEEP_UPPER stay uppercase (e.g. "AJ", not "Aj").
const KEEP_UPPER = new Set(['AJ', 'BB']);
function titleCase(name) {
  return String(name || '')
    .split(/\s+/)
    .map((w) => (KEEP_UPPER.has(w.toUpperCase()) ? w.toUpperCase() : w.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase())))
    .join(' ');
}

// Group projection rows into the production-sheet layout: header, sku/qty rows, subtotal, blank.
function buildSheetRows(rows) {
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.product_name}|||${r.color || ''}`;
    if (!groups.has(key)) groups.set(key, { product_name: r.product_name, color: r.color || '', items: [] });
    groups.get(key).items.push(r);
  }
  const sorted = Array.from(groups.values()).sort((a, b) => {
    const pa = (a.items[0]?.sku || '').split('-')[0], pb = (b.items[0]?.sku || '').split('-')[0];
    return pa !== pb ? pa.localeCompare(pb) : (a.color || '').localeCompare(b.color || '');
  });

  // Totals are live formulas, not hardcoded sums (sheet has no header row, so
  // outputRows[j] is sheet row j+1). Qty lives in column B. `boldRows` collects the
  // 0-based indices of the rows to bold: each product-name header, each subtotal,
  // and the grand total.
  const out = [];
  let grand = 0;
  const boldRows = [];
  for (const g of sorted) {
    const name = titleCase(g.product_name);
    boldRows.push(out.length);
    out.push([g.color ? `${name} - ${g.color}` : name]);
    const firstDataRow = out.length + 1;
    let sub = 0;
    for (const it of g.items.sort((a, b) => sizeSort(a.size) - sizeSort(b.size))) {
      out.push([it.sku, it.qty_to_order]);
      sub += it.qty_to_order;
    }
    const lastDataRow = firstDataRow + g.items.length - 1;
    boldRows.push(out.length);
    out.push(['', `=SUM(B${firstDataRow}:B${lastDataRow})`]);
    out.push([]);
    grand += sub;
  }
  // Resilient grand total: sum every SKU-row qty — a SKU row has a non-blank,
  // non-"TOTAL" label in col A and the qty in col B. Subtotal rows (blank col A)
  // and this row itself ("TOTAL") are excluded, so it never double-counts, and
  // adding or removing product rows never breaks it (no hardcoded cell list).
  boldRows.push(out.length);
  out.push(['TOTAL', '=SUMIFS(B:B,A:A,"<>",A:A,"<>TOTAL")']);
  return { rows: out, grand, boldRows };
}

// All projection rows for a supplier, full columns, for the review sheet.
async function fetchSupplierProjection(supplierId) {
  const sb = getSupabaseClient();
  const { data, error } = await sb.from('inventory_projections')
    .select('*').eq('supplier_id', supplierId).order('sku');
  if (error) throw new Error(`fetchSupplierProjection: ${error.message}`);
  return data || [];
}

// --- Stage 1: projection review ---------------------------------------------
// Pull the supplier's projection, apply the order rules (founder overrides + the
// 20-unit floor + multiples of 10) to the Qty to Order column, and write an
// editable review tab to the inventory-projections sheet. The founder edits the
// quantities there, then calls draft_production_order with that tab name.
async function draftOrderReview({ supplier, today, maxAgeDays = 3, forceRefresh = false, overrides = {} }) {
  const sup = await getSupplierByName(supplier);
  if (!sup) throw new Error(`supplier "${supplier}" not found`);
  if (!PLANNING_SHEET_ID) throw new Error('INVENTORY_PLANNING_SHEET_ID is not set');
  const date = today || new Date().toISOString().slice(0, 10);

  // Ensure the projection backing this review is recent enough (auto-refresh if stale).
  const projection = await ensureFreshProjection({ date, maxAgeDays, forceRefresh });
  const raw = await fetchSupplierProjection(sup.id);
  if (!raw.length) return { empty: true, supplier: sup.name, projection };

  // Order rules drive the editable Qty to Order column; context columns are untouched.
  const { rows, warnings } = applyOrderRules(raw, { overrides });

  const growthFactor = raw[0].growth_factor || 1.3;
  const targetWeeks = raw[0].target_weeks || 78;
  const runDate = projection.run_date || date;
  const written = await writeSalesDataSheet(rows, null, runDate, growthFactor, targetWeeks, `${sup.name} ORDER`, false);
  if (!written || !written.tabName) {
    throw new Error('failed to write the review tab — is INVENTORY_PLANNING_SHEET_ID set and shared with the service account?');
  }

  const ordered = rows.filter((r) => r.qty_to_order > 0);
  return {
    supplier: sup.name, tabName: written.tabName,
    skuCount: ordered.length, totalUnits: ordered.reduce((s, r) => s + r.qty_to_order, 0),
    url: `https://docs.google.com/spreadsheets/d/${written.sheetId}/edit`,
    projection, overrides: Object.keys(overrides || {}), warnings,
  };
}

// --- Stage 2: build the production tab from the edited review tab ------------
// Read the founder-edited Qty to Order from the inventory-projections review tab
// and write the supplier-format draft tab to the 2026 Production Numbers sheet.
async function draftProductionOrder({ supplier, review_tab, today, spreadsheetId, planningSheetId }) {
  const sheetId = spreadsheetId || SHEET_ID;
  const planId = planningSheetId || PLANNING_SHEET_ID;
  if (!review_tab) throw new Error('review_tab is required (the tab from draft_order_review you edited)');
  if (!planId) throw new Error('INVENTORY_PLANNING_SHEET_ID is not set');
  const sup = await getSupplierByName(supplier);
  if (!sup) throw new Error(`supplier "${supplier}" not found`);
  const date = today || new Date().toISOString().slice(0, 10);

  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: planId, range: `'${review_tab}'!A:Z` });
  const parsed = parseProjectionReviewSheet(res.data.values || []);
  if (!parsed.items.length) throw new Error(`no order lines (Qty to Order > 0) in review tab "${review_tab}"`);

  // Floor / step sanity-check on the founder's edits (warn, don't block).
  const warnings = [...parsed.warnings];
  const belowFloor = parsed.items.filter((it) => it.qty < PER_SKU_FLOOR);
  if (belowFloor.length) warnings.push(`${belowFloor.length} line(s) below the ${PER_SKU_FLOOR}-unit floor: ${belowFloor.map((i) => `${i.sku}=${i.qty}`).join(', ')}`);
  const offStep = parsed.items.filter((it) => it.qty % ORDER_STEP !== 0);
  if (offStep.length) warnings.push(`${offStep.length} line(s) not a multiple of ${ORDER_STEP}: ${offStep.map((i) => `${i.sku}=${i.qty}`).join(', ')}`);

  const rows = parsed.items.map((it) => ({ sku: it.sku, product_name: it.product_name, color: it.color, size: it.size, qty_to_order: it.qty }));
  const tabName = `DRAFT ${sup.name} ${date}`;
  const { rows: sheetRows, grand, boldRows } = buildSheetRows(rows);
  await writeTabAtFront(sheets, sheetId, tabName, sheetRows, boldRows);

  // Pricing estimate alongside the order (separate tab).
  const pricing = await writePricingTab({ sheets, spreadsheetId: sheetId, supplier: sup.name, date, items: parsed.items });

  return { supplier: sup.name, tabName, skuCount: rows.length, totalUnits: grand,
    url: `https://docs.google.com/spreadsheets/d/${sheetId}/edit`, sourceTab: review_tab, warnings,
    pricing: { tabName: pricing.tabName, ...pricing.grand, missing: pricing.missing } };
}

// --- GO: read back + create -------------------------------------------------
async function createOrderFromTab({ supplier, tab_name, spreadsheetId, ...opts }) {
  const sheetId = spreadsheetId || SHEET_ID;
  const sup = await getSupplierByName(supplier);
  if (!sup) throw new Error(`supplier "${supplier}" not found`);
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: `${tab_name}!A:B` });
  const parsed = parseProductionSheet(res.data.values || []);
  if (!parsed.items.length) throw new Error(`no SKU rows parsed from tab "${tab_name}"`);
  return createOrderFromParsed({ sup, parsed, ...opts });
}

// Business logic: turn parsed items into a persisted order + payments + supplier .xlsx.
// Sheet-free so it's testable without Google Sheets access.
async function createOrderFromParsed({ sup, parsed, expected_ship_date, expected_delivery_date, notes, today }) {
  const sb = getSupabaseClient();
  const date = today || new Date().toISOString().slice(0, 10);
  const { data: existing } = await sb.from('production_orders').select('production_code').not('production_code', 'is', null);
  const code = nextProductionCode(sup.name, date, (existing || []).map(r => r.production_code));

  const { data: order, error: oErr } = await sb.from('production_orders').insert({
    supplier_id: sup.id, status: 'placed', placed_date: date, production_code: code,
    expected_ship_date: expected_ship_date || null, expected_delivery_date: expected_delivery_date || null,
    notes: notes || null,
  }).select('id').single();
  if (oErr) throw new Error(`insert production_orders: ${oErr.message}`);

  const items = parsed.items.map(it => ({ production_order_id: order.id, sku: it.sku, qty_ordered: it.qty }));
  const { error: iErr } = await sb.from('production_order_items').insert(items);
  if (iErr) throw new Error(`insert items: ${iErr.message}`);

  // payments from the supplier's terms
  let payments = [];
  if (Array.isArray(sup.payment_terms) && sup.payment_terms.length) {
    payments = sup.payment_terms.map(t => ({
      production_order_id: order.id, type: t.type || 'other', pct: t.pct ?? null,
      due_event: t.due || null, status: 'due',
    }));
    const { error: pErr } = await sb.from('production_payments').insert(payments);
    if (pErr) throw new Error(`insert payments: ${pErr.message}`);
  }

  // supplier-ready .xlsx
  const aoa = [[`Production Order — ${sup.name} — ${code} — ${date}`], []];
  for (const it of parsed.items) aoa.push([it.product_name, it.color, it.sku, it.qty]);
  aoa.push([], ['TOTAL', '', '', parsed.grand_total]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Order');
  const xlsxPath = path.join(os.homedir(), 'Downloads', `production-order-${sup.name.toLowerCase().replace(/\W+/g, '-')}-${code}.xlsx`);
  XLSX.writeFile(wb, xlsxPath);

  return { order_id: order.id, production_code: code, supplier: sup.name,
    sku_count: parsed.items.length, total_units: parsed.grand_total,
    payments: payments.length, warnings: parsed.warnings, xlsx_path: xlsxPath };
}

// --- Pricing estimate -------------------------------------------------------
// Lay out the pricing tab: per product group, extended COGS / shipping / taxes /
// landed, with formula subtotals + a resilient grand total (same pattern as the
// order tab). boldRows = column header, each product header, each subtotal, grand.
function buildPricingRows(pricing) {
  const out = [];
  const boldRows = [];
  boldRows.push(out.length);
  out.push(['Product / SKU', 'Qty', 'COGS $', 'Shipping $', 'Taxes $', 'Landed $']);

  for (const g of pricing.groups) {
    const name = titleCase(g.product_name);
    boldRows.push(out.length);
    out.push([g.color ? `${name} - ${g.color}` : name]);
    const first = out.length + 1;
    for (const l of g.lines) out.push([l.sku, l.qty, l.cogs, l.freight, l.duty, l.landed]);
    const last = first + g.lines.length - 1;
    boldRows.push(out.length);
    out.push(['', `=SUM(B${first}:B${last})`, `=SUM(C${first}:C${last})`, `=SUM(D${first}:D${last})`, `=SUM(E${first}:E${last})`, `=SUM(F${first}:F${last})`]);
    out.push([]);
  }

  // Resilient grand total — sum SKU rows only (col A non-blank, not "TOTAL").
  boldRows.push(out.length);
  out.push([
    'TOTAL',
    '=SUMIFS(B:B,A:A,"<>",A:A,"<>TOTAL")',
    '=SUMIFS(C:C,A:A,"<>",A:A,"<>TOTAL")',
    '=SUMIFS(D:D,A:A,"<>",A:A,"<>TOTAL")',
    '=SUMIFS(E:E,A:A,"<>",A:A,"<>TOTAL")',
    '=SUMIFS(F:F,A:A,"<>",A:A,"<>TOTAL")',
  ]);

  out.push([]);
  out.push(['Estimate uses current product_costs per SKU prefix: COGS (goods) + Shipping (freight) + Taxes (duties) = Landed.']);
  if (pricing.missing.length) {
    out.push([`No cost on file for: ${pricing.missing.join(', ')} — shown as 0, exclude from totals manually.`]);
  }
  return { rows: out, boldRows };
}

// Write a PRICING tab for the given order items (one per supplier+date).
// `costOverrides` (prefix -> cost row) lets an estimate stand in for a stale/missing
// product_costs row without touching the canonical table (e.g. a new product whose
// real supplier cost isn't locked yet).
async function writePricingTab({ sheets, spreadsheetId, supplier, date, items, costOverrides = {} }) {
  const costMap = await fetchCurrentCosts();
  for (const [prefix, cost] of Object.entries(costOverrides)) costMap.set(String(prefix).toUpperCase(), cost);
  const pricing = computePricing(items, costMap);
  const { rows, boldRows } = buildPricingRows(pricing);
  const tabName = `PRICING ${supplier} ${date}`;
  await writeTabAtFront(sheets, spreadsheetId, tabName, rows, boldRows, 6);
  return { tabName, grand: pricing.grand, missing: pricing.missing };
}

module.exports = { buildSheetRows, buildPricingRows, draftOrderReview, draftProductionOrder, writePricingTab, createOrderFromTab, createOrderFromParsed, SHEET_ID };
