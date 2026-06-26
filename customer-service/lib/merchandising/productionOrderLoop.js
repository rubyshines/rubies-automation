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
const { parseProductionSheet } = require('./productionSheetParser');
const { nextProductionCode } = require('./productionCode');
const { NUMERIC_SIZES, LETTER_SIZES, SIZE_ALIASES, parseSizeVariant } = require('../sizeUtils');

const SHEET_ID = process.env.PRODUCTION_SHEET_ID || '1kMZ-thv7pmBEvudlT_Ujw1z1wb-2zwjV5vT_TuNm87w';

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

  const out = [];
  let grand = 0;
  for (const g of sorted) {
    out.push([g.color ? `${g.product_name} - ${g.color}` : g.product_name]);
    let sub = 0;
    for (const it of g.items.sort((a, b) => sizeSort(a.size) - sizeSort(b.size))) {
      out.push([it.sku, it.qty_to_order]);
      sub += it.qty_to_order;
    }
    out.push(['', sub]);
    out.push([]);
    grand += sub;
  }
  out.push(['TOTAL', grand]);
  return { rows: out, grand };
}

async function fetchProjections(supplierId) {
  const sb = getSupabaseClient();
  const { data, error } = await sb.from('inventory_projections')
    .select('sku, product_name, color, size, qty_to_order, priority')
    .eq('supplier_id', supplierId).gt('qty_to_order', 0).order('sku');
  if (error) throw new Error(`fetchProjections: ${error.message}`);
  return data || [];
}

// --- Draft -----------------------------------------------------------------
async function draftProductionOrder({ supplier, today, spreadsheetId }) {
  const sheetId = spreadsheetId || SHEET_ID;
  const sup = await getSupplierByName(supplier);
  if (!sup) throw new Error(`supplier "${supplier}" not found`);
  const rows = await fetchProjections(sup.id);
  if (!rows.length) return { empty: true, supplier: sup.name };

  const date = today || new Date().toISOString().slice(0, 10);
  const tabName = `DRAFT ${sup.name} ${date}`;
  const { rows: sheetRows, grand } = buildSheetRows(rows);

  const sheets = await getSheetsClient();
  // create the tab (ignore if it already exists)
  try {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: tabName } } }] },
    });
  } catch (e) { if (!/already exists/i.test(e.message)) throw e; }
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${tabName}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: sheetRows },
  });

  return { supplier: sup.name, tabName, skuCount: rows.length, totalUnits: grand,
    url: `https://docs.google.com/spreadsheets/d/${sheetId}/edit` };
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

module.exports = { buildSheetRows, draftProductionOrder, createOrderFromTab, createOrderFromParsed, SHEET_ID };
