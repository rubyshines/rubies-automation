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
const ExcelJS = require('exceljs');
const { getSupabaseClient } = require('../../../shared/supabaseClient');
const { getSheetsClient } = require('../../../shared/googleSheetsClient');
const { getSupplierByName } = require('./supplierRegistry');
const { parseProductionSheet, parseProjectionReviewSheet, isSku } = require('./productionSheetParser');
const { nextProductionCode } = require('./productionCode');
const { runProjection, writeSalesDataSheet } = require('./inventoryProjection');
const { applyOrderRules, PER_SKU_FLOOR, ORDER_STEP } = require('./orderSpread');
const { fetchCurrentCosts, computePricing } = require('./pricingEstimate');
const { getGmail, createDraftWithAttachment } = require('../../../gmail-management/lib/gmailClient');
const { NUMERIC_SIZES, LETTER_SIZES, SIZE_ALIASES, parseSizeVariant } = require('../sizeUtils');

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

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
  return sheetId;
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

const sizeFromSku = (sku) => String(sku || '').split('-').slice(2).join('-');

// Coarse product category for the tab descriptor.
const CATEGORY_ORDER = ['Swim', 'Underwear', 'Bras', 'Accessories'];
function categoryOf(productName) {
  const n = String(productName || '').toLowerCase();
  if (/bikini|tankini|swim/.test(n)) return 'Swim';
  if (/bra\b|bralette/.test(n)) return 'Bras';
  if (/underwear|boxer|shorty|gaff|brief/.test(n)) return 'Underwear';
  if (/pad|earring|flag|pin\b|sticker|gel/.test(n)) return 'Accessories';
  return 'Other';
}

function joinAnd(arr) {
  if (arr.length <= 1) return arr[0] || '';
  return `${arr.slice(0, -1).join(', ')} and ${arr[arr.length - 1]}`;
}

// Short descriptor of what's in an order: a single product → its (title-cased) name;
// multiple → the distinct recognized categories present, e.g. "Swim and Underwear".
// Unrecognized ("Other") products are omitted rather than shown as a noisy bucket.
function orderDescriptor(items) {
  const names = [...new Set((items || []).map((i) => i.product_name).filter(Boolean))];
  if (names.length === 1) return titleCase(names[0].replace(/^the\s+/i, ''));
  return joinAnd(CATEGORY_ORDER.filter((c) => names.some((n) => categoryOf(n) === c)));
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
async function draftProductionOrder({ supplier, review_tab, today, spreadsheetId, planningSheetId, costOverrides = {} }) {
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

  const warnings = [...parsed.warnings];

  // Dedupe duplicate SKU rows (e.g. a paste artifact) — keep first, flag the rest.
  const seen = new Set();
  const items = [];
  const dups = [];
  for (const it of parsed.items) {
    if (seen.has(it.sku)) { dups.push(it.sku); continue; }
    seen.add(it.sku);
    items.push(it);
  }
  if (dups.length) warnings.push(`Dropped ${dups.length} duplicate SKU row(s): ${[...new Set(dups)].join(', ')}`);

  // Floor / step sanity-check on the founder's edits (warn, don't block).
  const belowFloor = items.filter((it) => it.qty < PER_SKU_FLOOR);
  if (belowFloor.length) warnings.push(`${belowFloor.length} line(s) below the ${PER_SKU_FLOOR}-unit floor: ${belowFloor.map((i) => `${i.sku}=${i.qty}`).join(', ')}`);
  const offStep = items.filter((it) => it.qty % ORDER_STEP !== 0);
  if (offStep.length) warnings.push(`${offStep.length} line(s) not a multiple of ${ORDER_STEP}: ${offStep.map((i) => `${i.sku}=${i.qty}`).join(', ')}`);

  // Clean order tab + separate pricing companion. Write pricing first so the
  // order tab lands at the front (index 0).
  const descriptor = orderDescriptor(items);
  const tabName = `${date} - ${sup.name}${descriptor ? ` ${descriptor}` : ''}`;
  const pricing = await writePricingTab({ sheets, spreadsheetId: sheetId, orderTabName: tabName, items, costOverrides });
  await writeOrderTab({ sheets, spreadsheetId: sheetId, tabName, items });

  return { supplier: sup.name, tabName, pricingTabName: pricing.tabName,
    skuCount: items.length, totalUnits: items.reduce((s, it) => s + (Number(it.qty) || 0), 0),
    url: `https://docs.google.com/spreadsheets/d/${sheetId}/edit`, sourceTab: review_tab, warnings,
    pricing: { ...pricing.grand, missing: pricing.missing } };
}

// --- GO: read back + create -------------------------------------------------
async function createOrderFromTab({ supplier, tab_name, spreadsheetId, ...opts }) {
  const sheetId = spreadsheetId || SHEET_ID;
  const sup = await getSupplierByName(supplier);
  if (!sup) throw new Error(`supplier "${supplier}" not found`);
  const sheets = await getSheetsClient();
  // FORMULA render so the subtotal/grand cells carry through as live "=SUM(...)"
  // formulas into the supplier .xlsx (same row positions = refs stay valid). Data
  // cells come back as plain numbers, so parseProductionSheet still reads qtys.
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: `'${tab_name}'!A:B`, valueRenderOption: 'FORMULA' });
  const sheetRows = res.data.values || [];
  const parsed = parseProductionSheet(sheetRows);
  if (!parsed.items.length) throw new Error(`no SKU rows parsed from tab "${tab_name}"`);
  const result = await createOrderFromParsed({ sup, parsed, sheetRows, ...opts });

  // Create a Gmail DRAFT to the supplier with the order .xlsx attached (not sent —
  // Jamie reviews + sends). Fail-soft: the order is already recorded; the draft is
  // a convenience, so a Gmail hiccup or a missing supplier email never fails the GO.
  const subject = `New Production Order - ${sup.name}`;
  let draft = { created: false };
  try {
    if (!sup.email) {
      draft = { created: false, reason: 'no email on file for supplier' };
    } else {
      const gmail = await getGmail();
      const d = await createDraftWithAttachment(gmail, {
        to: sup.email,
        subject,
        bodyText: `Hi ${sup.name},\n\nPlease find attached our new production order (${result.production_code}). Let me know if you have any questions.\n\nThank you`,
        attachment: { filename: result.xlsx_filename, mimeType: XLSX_MIME, content: result.xlsx_buffer },
      });
      draft = { created: true, to: sup.email, subject, draftId: d.draftId };
    }
  } catch (e) {
    draft = { created: false, error: e.message };
  }

  // GO is committed — the planning pricing tab is no longer needed.
  let pricingRemoved = false;
  try {
    pricingRemoved = await removePricingTab(sheets, sheetId, tab_name);
  } catch (e) { /* non-fatal: leave the pricing tab if cleanup fails */ }
  return { ...result, draft, pricingRemoved };
}

// Shift every cell row-reference in a formula by `off` rows (e.g. "SUM(B2:B9)" ->
// "SUM(B4:B11)"). Whole-column refs like "B:B" have no row number and are untouched.
function shiftFormula(formula, off) {
  return String(formula).replace(/(\$?[A-Z]{1,3}\$?)(\d+)/g, (_, col, n) => `${col}${parseInt(n, 10) + off}`);
}

// Prepend a title line (+ a blank row) to the order rows, shifting all formula
// row-references down by 2 so the live subtotals/grand still point at the right cells.
function prependTitle(rows, title) {
  const OFFSET = 2;
  const shifted = (rows || []).map((row) => (row || []).map((cell) => (
    typeof cell === 'string' && cell.startsWith('=') ? `=${shiftFormula(cell.slice(1), OFFSET)}` : cell
  )));
  return [[title], [], ...shifted];
}

// A row is bold in the supplier .xlsx if it's a product header (label in A, no qty),
// a subtotal (no label, value/formula in B), or the grand total ("TOTAL").
function isBoldRow(row) {
  const a = String((row && row[0]) != null ? row[0] : '').trim();
  const hasB = !!(row && row[1] != null && row[1] !== '');
  if (a && !isSku(a)) return true;
  if (!a && hasB) return true;
  return false;
}

// Build an exceljs workbook from [colA, colB] rows. "=..." strings become live
// formulas; rows in boldSet (or detected via isBoldRow when boldSet is null) are
// bolded. Reproduces the production order sheet (layout + bold + formulas).
async function buildOrderWorkbook(rows, boldSet) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Order');
  rows.forEach((row, i) => {
    const wsRow = ws.getRow(i + 1);
    (row || []).forEach((cell, ci) => {
      const c = wsRow.getCell(ci + 1);
      if (typeof cell === 'string' && cell.startsWith('=')) c.value = { formula: cell.slice(1) };
      else if (cell !== '' && cell != null) c.value = cell;
    });
    if (boldSet ? boldSet.has(i) : isBoldRow(row)) wsRow.font = { bold: true };
  });
  ws.getColumn(1).width = 46;
  ws.getColumn(2).width = 10;
  return wb;
}

// Business logic: turn parsed items into a persisted order + payments + supplier .xlsx.
// Sheet-free so it's testable without Google Sheets access.
async function createOrderFromParsed({ sup, parsed, sheetRows, expected_ship_date, expected_delivery_date, notes, today }) {
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

  // supplier-ready .xlsx — an EXACT mirror of the production order sheet: same row
  // order + groupings, bold headers/subtotals/grand, and LIVE formulas. Prefer the
  // sheet's own rows (FORMULA-rendered, so "=SUM(...)" cells carry through and, since
  // we keep the same row positions, still reference the right cells); fall back to
  // rebuilding the layout from items.
  const baseRows = (sheetRows && sheetRows.length) ? sheetRows : buildSheetRows(parsed.items, { formulas: true }).rows;
  const titledRows = prependTitle(baseRows, `Production Order: ${sup.name} (${code}) ${date}`);
  const wb = await buildOrderWorkbook(titledRows, null);
  const xlsxFilename = `production-order-${sup.name.toLowerCase().replace(/\W+/g, '-')}-${code}.xlsx`;
  const xlsxPath = path.join(os.homedir(), 'Downloads', xlsxFilename);
  await wb.xlsx.writeFile(xlsxPath);
  const xlsxBuffer = await wb.xlsx.writeBuffer();

  return { order_id: order.id, production_code: code, supplier: sup.name,
    sku_count: parsed.items.length, total_units: parsed.grand_total,
    payments: payments.length, warnings: parsed.warnings, xlsx_path: xlsxPath,
    xlsx_filename: xlsxFilename, xlsx_buffer: xlsxBuffer };
}

// Group items by product+color; sort groups by SKU prefix then color, and lines
// by size within each group.
function groupItems(items) {
  const groups = new Map();
  for (const it of items) {
    // Callers that pass bare {sku, qty} (order rewrites from DB rows) still get
    // correct product-color grouping + size sort — derive both from the SKU.
    // Without this, every line keyed to "undefined" and the whole order came
    // out in one jumbled group.
    const segs = String(it.sku || '').split('-');
    const name = it.product_name || segs[0] || '';
    const color = it.color || (segs.length > 2 ? segs[1] : '');
    const key = `${name}|||${color}`;
    if (!groups.has(key)) groups.set(key, { product_name: name, color, lines: [] });
    groups.get(key).lines.push(it);
  }
  const arr = [...groups.values()];
  for (const g of arr) g.lines.sort((a, b) => sizeSort(sizeFromSku(a.sku)) - sizeSort(sizeFromSku(b.sku)));
  arr.sort((a, b) => {
    const pa = String(a.lines[0]?.sku || '').split('-')[0], pb = String(b.lines[0]?.sku || '').split('-')[0];
    return pa !== pb ? pa.localeCompare(pb) : (a.color || '').localeCompare(b.color || '');
  });
  return arr;
}

// Clean ORDER layout (supplier-facing): just SKU + Qty, with product headers,
// subtotals, and a grand total. boldRows = headers/subtotals/grand. Totals are
// live formulas for the editable Google Sheet (formulas:true, default); the
// supplier .xlsx uses computed numbers (formulas:false) — same layout either way.
function buildSheetRows(items, { formulas = true } = {}) {
  const out = [];
  const boldRows = [];
  let grand = 0;
  for (const g of groupItems(items)) {
    const name = titleCase(g.product_name);
    boldRows.push(out.length);
    out.push([g.color ? `${name} - ${g.color}` : name]);
    const first = out.length + 1;
    let sub = 0;
    for (const l of g.lines) { out.push([l.sku, l.qty]); sub += Number(l.qty) || 0; grand += Number(l.qty) || 0; }
    const last = first + g.lines.length - 1;
    boldRows.push(out.length);
    out.push(['', formulas ? `=SUM(B${first}:B${last})` : sub]);
    out.push([]);
  }
  boldRows.push(out.length);
  out.push(['TOTAL', formulas ? '=SUMIFS(B:B,A:A,"<>",A:A,"<>TOTAL")' : grand]);
  return { rows: out, grand, boldRows };
}

// PRICING tab (companion, planning only): per line the unit cost components AND
// the extended totals. Columns: SKU, Qty, Unit COGS/Ship/Tax/Landed, then ext
// COGS/Ship/Tax/Landed. Subtotals + grand on Qty and the extended columns only
// (summing per-unit costs is meaningless, so the unit columns are blank there).
function buildPricingRows(pricing) {
  const out = [];
  const boldRows = [];
  boldRows.push(out.length);
  out.push(['Product / SKU', 'Qty', 'Unit COGS', 'Unit Ship', 'Unit Tax', 'Unit Landed', 'COGS $', 'Shipping $', 'Taxes $', 'Landed $']);

  for (const g of pricing.groups) {
    const name = titleCase(g.product_name);
    boldRows.push(out.length);
    out.push([g.color ? `${name} - ${g.color}` : name]);
    const first = out.length + 1;
    const lines = [...g.lines].sort((a, b) => sizeSort(sizeFromSku(a.sku)) - sizeSort(sizeFromSku(b.sku)));
    for (const l of lines) out.push([l.sku, l.qty, l.unit_cogs, l.unit_freight, l.unit_duty, l.unit_landed, l.cogs, l.freight, l.duty, l.landed]);
    const last = first + lines.length - 1;
    boldRows.push(out.length);
    out.push(['', `=SUM(B${first}:B${last})`, '', '', '', '', `=SUM(G${first}:G${last})`, `=SUM(H${first}:H${last})`, `=SUM(I${first}:I${last})`, `=SUM(J${first}:J${last})`]);
    out.push([]);
  }

  boldRows.push(out.length);
  out.push([
    'TOTAL', '=SUMIFS(B:B,A:A,"<>",A:A,"<>TOTAL")', '', '', '', '',
    '=SUMIFS(G:G,A:A,"<>",A:A,"<>TOTAL")', '=SUMIFS(H:H,A:A,"<>",A:A,"<>TOTAL")',
    '=SUMIFS(I:I,A:A,"<>",A:A,"<>TOTAL")', '=SUMIFS(J:J,A:A,"<>",A:A,"<>TOTAL")',
  ]);

  out.push([]);
  out.push(['Unit + extended cost from current product_costs per SKU prefix: COGS (goods) + Shipping (freight) + Taxes (duties) = Landed.']);
  if (pricing.missing.length) {
    out.push([`No cost on file for: ${pricing.missing.join(', ')} — shown as 0, exclude from totals manually.`]);
  }
  return { rows: out, boldRows };
}

// Write the clean ORDER tab. Tab name passed in (e.g. "2026-06-29 - Kali Swim and Underwear").
async function writeOrderTab({ sheets, spreadsheetId, tabName, items }) {
  const { rows, boldRows } = buildSheetRows(items);
  await writeTabAtFront(sheets, spreadsheetId, tabName, rows, boldRows, 2);
  return { tabName };
}

// Write the PRICING companion tab named "<orderTabName> (Pricing)". `costOverrides`
// (prefix -> cost row) lets an estimate stand in for a stale/missing product_costs
// row without touching the canonical table.
async function writePricingTab({ sheets, spreadsheetId, orderTabName, items, costOverrides = {} }) {
  const costMap = await fetchCurrentCosts();
  for (const [prefix, cost] of Object.entries(costOverrides)) costMap.set(String(prefix).toUpperCase(), cost);
  const pricing = computePricing(items, costMap);
  const { rows, boldRows } = buildPricingRows(pricing);
  const tabName = `${orderTabName} (Pricing)`;
  const sheetId = await writeTabAtFront(sheets, spreadsheetId, tabName, rows, boldRows, 10);
  if (sheetId != null) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } },
          { repeatCell: { range: { sheetId, startRowIndex: 1, startColumnIndex: 2, endColumnIndex: 10 }, cell: { userEnteredFormat: { numberFormat: { type: 'CURRENCY', pattern: '$#,##0.00' } } }, fields: 'userEnteredFormat.numberFormat' } },
        ],
      },
    });
  }
  return { tabName, grand: pricing.grand, missing: pricing.missing };
}

// Remove the pricing companion tab for an order tab (called at GO/submit).
async function removePricingTab(sheets, spreadsheetId, orderTabName) {
  const name = `${orderTabName} (Pricing)`;
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties(sheetId,title)' });
  const p = (meta.data.sheets || []).find((s) => s.properties.title === name);
  if (p) await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: [{ deleteSheet: { sheetId: p.properties.sheetId } }] } });
  return !!p;
}

module.exports = { buildSheetRows, buildPricingRows, buildOrderWorkbook, prependTitle, writeOrderTab, writePricingTab, orderDescriptor, draftOrderReview, draftProductionOrder, createOrderFromTab, createOrderFromParsed, SHEET_ID };
