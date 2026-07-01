/**
 * Inbound receiving — the "back side" of the merchandising pipeline.
 *
 * Front side (built): projection -> draft -> submit_production_order writes
 * production_orders + production_order_items (qty_ordered). This module covers what
 * happens when goods are made and delivered:
 *
 *   recordManualOrder / amendOrder  — ingest or top-up a production order WITHOUT a
 *      projection (one-off reorders typed straight into a sheet). Used to backfill the
 *      order a delivery belongs to when it predates the tooling.
 *   createInboundShipmentFromPackingList — parse a supplier packing/shipping list, map
 *      its supplier SKU codes to catalog SKUs, write inbound_shipments + _items, and set
 *      qty_produced on the matched order lines.
 *   reconcileProductionOrder — the 3-way ordered -> produced -> received per SKU, with
 *      short / over / missing / extra flags.
 *   uploadInboundToWarehance / pollInboundReceiving — POST the ASN to Warehance (Nitro)
 *      and pull receiving progress back into qty_received.
 *
 * Supabase is the source of truth. Sheets are read-only inputs; Warehance is the WMS.
 */

const { getSupabaseClient } = require('../../../shared/supabaseClient');
const { getSheetsClient } = require('../../../shared/googleSheetsClient');
const { getSupplierByName } = require('./supplierRegistry');
const { nextProductionCode } = require('./productionCode');
const { parseProductionSheet } = require('./productionSheetParser');
const { parsePackingList, applySkuRemap } = require('./packingListParser');
const { loadCatalogSkus, canonicalizeItems } = require('./skuCanonical');
const { buildReconcileRows } = require('./reconcileSheet');
const warehance = require('../../../reports/lib/warehanceClient');

const SHEET_ID = process.env.PRODUCTION_SHEET_ID || '1kMZ-thv7pmBEvudlT_Ujw1z1wb-2zwjV5vT_TuNm87w';
const DEFAULT_WAREHOUSE = process.env.WAREHANCE_WAREHOUSE_NAME || 'Nitro Logistics AMU';

// Merge duplicate SKUs across one or more {sku, qty} lists into a single list.
function mergeBySku(...lists) {
  const m = new Map();
  for (const list of lists) for (const it of list) m.set(it.sku, (m.get(it.sku) || 0) + Number(it.qty || 0));
  return [...m.entries()].map(([sku, qty]) => ({ sku, qty }));
}

async function resolveOrder(orderRef) {
  const sb = getSupabaseClient();
  let q = sb.from('production_orders').select('*');
  q = typeof orderRef === 'number' || /^\d+$/.test(String(orderRef)) ? q.eq('id', Number(orderRef)) : q.eq('production_code', orderRef);
  const { data, error } = await q.limit(1).maybeSingle();
  if (error) throw new Error(`resolveOrder: ${error.message}`);
  return data || null;
}

// --- Manual order ingest (no projection) ------------------------------------

/**
 * Read one or more tabs of the 2026 Production Numbers sheet into canonical
 * {sku, qty} lines (merged across tabs). Reuses the production-order sheet parser, so
 * the base order + any change tabs are read with the same logic as submit.
 */
async function readOrderTabs(tabNames, { spreadsheetId } = {}) {
  const sheets = await getSheetsClient();
  const id = spreadsheetId || SHEET_ID;
  const all = [];
  const warnings = [];
  for (const tab of tabNames) {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: id, range: `'${tab}'!A:B` });
    const parsed = parseProductionSheet(res.data.values || []);
    if (!parsed.items.length) warnings.push(`tab "${tab}" had no SKU rows`);
    for (const w of parsed.warnings) warnings.push(`[${tab}] ${w}`);
    all.push(...parsed.items.map((it) => ({ sku: it.sku, qty: it.qty })));
  }
  return { items: mergeBySku(all), warnings };
}

/**
 * Record a production order from explicit {sku, qty} lines — no projection involved.
 * For backfilling an order a delivery belongs to, or any one-off manual reorder.
 * @returns {Promise<{order_id, production_code, sku_count, total_units, warnings}>}
 */
async function recordManualOrder({ supplier, items, productionCode, placedDate, status = 'placed', notes }) {
  const sb = getSupabaseClient();
  const sup = await getSupplierByName(supplier);
  if (!sup) throw new Error(`supplier "${supplier}" not found`);
  const merged = mergeBySku(items.filter((it) => Number(it.qty) > 0));
  if (!merged.length) throw new Error('no order lines with qty > 0');
  const date = placedDate || new Date().toISOString().slice(0, 10);

  const warnings = [];
  const catalog = await loadCatalogSkus();
  const offCatalog = merged.filter((it) => !catalog.has(it.sku));
  if (offCatalog.length) warnings.push(`${offCatalog.length} order SKU(s) not in catalog (left as-is): ${offCatalog.map((i) => i.sku).join(', ')}`);

  let code = productionCode;
  if (!code) {
    const { data: existing } = await sb.from('production_orders').select('production_code').not('production_code', 'is', null);
    code = nextProductionCode(sup.name, date, (existing || []).map((r) => r.production_code));
  }

  const { data: order, error: oErr } = await sb.from('production_orders').insert({
    supplier_id: sup.id, status, placed_date: date, production_code: code, notes: notes || null,
  }).select('id').single();
  if (oErr) throw new Error(`insert production_orders: ${oErr.message}`);

  const rows = merged.map((it) => ({ production_order_id: order.id, sku: it.sku, qty_ordered: it.qty }));
  const { error: iErr } = await sb.from('production_order_items').insert(rows);
  if (iErr) throw new Error(`insert items: ${iErr.message}`);

  return { order_id: order.id, production_code: code, supplier: sup.name, sku_count: merged.length, total_units: merged.reduce((s, it) => s + it.qty, 0), warnings };
}

/**
 * Add / top up line items on an existing order (a change to a placed order). Existing
 * SKUs have their qty_ordered increased; new SKUs are inserted.
 */
async function amendOrder({ orderRef, items }) {
  const sb = getSupabaseClient();
  const order = await resolveOrder(orderRef);
  if (!order) throw new Error(`order "${orderRef}" not found`);
  const merged = mergeBySku(items.filter((it) => Number(it.qty) > 0));
  const { data: existing } = await sb.from('production_order_items').select('id, sku, qty_ordered').eq('production_order_id', order.id);
  const bySku = new Map((existing || []).map((r) => [r.sku, r]));
  const inserts = [];
  const changes = [];
  for (const it of merged) {
    const cur = bySku.get(it.sku);
    if (cur) {
      const next = (cur.qty_ordered || 0) + it.qty;
      const { error } = await sb.from('production_order_items').update({ qty_ordered: next }).eq('id', cur.id);
      if (error) throw new Error(`amend update ${it.sku}: ${error.message}`);
      changes.push({ sku: it.sku, from: cur.qty_ordered, to: next });
    } else {
      inserts.push({ production_order_id: order.id, sku: it.sku, qty_ordered: it.qty });
    }
  }
  if (inserts.length) {
    const { error } = await sb.from('production_order_items').insert(inserts);
    if (error) throw new Error(`amend insert: ${error.message}`);
  }
  return { order_id: order.id, production_code: order.production_code, added: inserts.length, increased: changes.length, changes, inserts: inserts.map((i) => ({ sku: i.sku, qty: i.qty_ordered })) };
}

// --- Inbound shipment from a packing list -----------------------------------

/**
 * Parse a supplier packing list, canonicalize SKUs, persist the inbound shipment, and
 * set qty_produced on the matched order lines. Idempotent on transfer_number.
 * @param {object} p
 * @param {string} p.packingListPath - path to the supplier .xlsx
 * @param {string|number} [p.orderRef] - production_code or order id this delivery fulfills
 * @param {string} [p.transferNumber] - unique shipment ref (defaults to <production_code>)
 * @param {string} [p.shipDate] / [p.expectedArrival] - YYYY-MM-DD
 */
async function createInboundShipmentFromPackingList({ packingListPath, orderRef, transferNumber, shipDate, expectedArrival, warehouse, remap, flag }) {
  const sb = getSupabaseClient();
  const parsed = parsePackingList(packingListPath);
  const { items: remappedItems, rewritten } = applySkuRemap(parsed.items, remap);
  const catalog = await loadCatalogSkus();
  const { items: canon, remapped, unknown } = canonicalizeItems(remappedItems, catalog);

  const order = orderRef != null ? await resolveOrder(orderRef) : null;
  if (orderRef != null && !order) throw new Error(`order "${orderRef}" not found`);
  const transfer = transferNumber || (order ? order.production_code : null);
  if (!transfer) throw new Error('transferNumber is required when no order is linked');

  // Idempotent header upsert by transfer_number.
  const header = {
    production_order_id: order ? order.id : null,
    transfer_number: transfer,
    warehouse: warehouse || DEFAULT_WAREHOUSE,
    status: 'draft',
    ship_date: shipDate || null,
    estimated_arrival_date: expectedArrival || null,
    updated_at: new Date().toISOString(),
  };
  const { data: ship, error: hErr } = await sb.from('inbound_shipments')
    .upsert(header, { onConflict: 'transfer_number' }).select('*').single();
  if (hErr) throw new Error(`upsert inbound_shipments: ${hErr.message}`);

  // Replace this shipment's lines idempotently (upsert by (shipment, sku)).
  const itemRows = canon.map((it) => ({ inbound_shipment_id: ship.id, sku: it.sku, qty: it.qty }));
  const { error: iErr } = await sb.from('inbound_shipment_items')
    .upsert(itemRows, { onConflict: 'inbound_shipment_id,sku' });
  if (iErr) throw new Error(`upsert inbound_shipment_items: ${iErr.message}`);

  // Orphan cleanup: drop any prior lines for this shipment no longer in the packing
  // list (e.g. after a corrected re-run where a SKU was remapped away). Scoped to this
  // shipment + a NOT IN the current set, so it's concurrency-safe (per technical rules).
  if (canon.length) {
    const keep = canon.map((it) => it.sku);
    const { error: dErr } = await sb.from('inbound_shipment_items')
      .delete().eq('inbound_shipment_id', ship.id)
      .not('sku', 'in', `(${keep.map((s) => `"${s}"`).join(',')})`);
    if (dErr) throw new Error(`orphan cleanup inbound_shipment_items: ${dErr.message}`);
  }

  // Record production LOTS for the shipped units (quality + disposition). Standard by
  // default; SKUs named in `flag.skus` become a flagged lot — e.g. the thin-black-fabric
  // pink-sticker test batch. Idempotent: replace this shipment's ship-lots.
  let lotSummary = { standard: 0, flagged: 0 };
  if (order) {
    const flagSet = new Set(((flag && flag.skus) || []).map((s) => String(s).toUpperCase()));
    const quality = (flag && flag.quality) || 'flagged';
    const marker = (flag && flag.marker) || null;
    await sb.from('production_lots').delete().eq('inbound_shipment_id', ship.id);
    const lotRows = canon.map((it) => {
      const isFlagged = flagSet.has(it.sku.toUpperCase());
      return {
        production_order_id: order.id, sku: it.sku, qty: it.qty,
        quality: isFlagged ? quality : 'standard', marker: isFlagged ? marker : null,
        disposition: 'ship', inbound_shipment_id: ship.id,
        notes: isFlagged && flag && flag.notes ? flag.notes : null,
      };
    });
    if (lotRows.length) {
      const { error: lErr } = await sb.from('production_lots').insert(lotRows);
      if (lErr) throw new Error(`insert production_lots: ${lErr.message}`);
    }
    lotSummary.flagged = lotRows.filter((l) => l.quality !== 'standard').length;
    lotSummary.standard = lotRows.length - lotSummary.flagged;
  }

  // Mirror produced qty onto matched order lines (qty_produced), for the 3-way view.
  let producedSet = 0;
  if (order) {
    const { data: orderItems } = await sb.from('production_order_items').select('id, sku').eq('production_order_id', order.id);
    const orderSku = new Map((orderItems || []).map((r) => [r.sku, r.id]));
    for (const it of canon) {
      const rowId = orderSku.get(it.sku);
      if (rowId) { await sb.from('production_order_items').update({ qty_produced: it.qty }).eq('id', rowId); producedSet++; }
    }
  }

  const reconciliation = order ? await reconcileProductionOrder(order.id) : null;
  return {
    inbound_shipment_id: ship.id,
    transfer_number: transfer,
    order: order ? { id: order.id, production_code: order.production_code } : null,
    packing: { ...parsed.totals, subtotal_units: parsed.subtotal_units },
    sections: parsed.sections,
    canonical_sku_count: canon.length,
    prefix_remapped: rewritten,
    lots: lotSummary,
    remapped,
    unknown,
    qty_produced_set: producedSet,
    parse_warnings: parsed.warnings,
    reconciliation,
  };
}

// Record hold_storage / remake_next_run lots (produced-but-not-shipped units from a
// production issue). Idempotent per (order, sku, disposition). lots = [{sku, qty,
// disposition, quality?, marker?, notes?}].
async function recordProductionLots({ orderRef, lots }) {
  const sb = getSupabaseClient();
  const order = await resolveOrder(orderRef);
  if (!order) throw new Error(`order "${orderRef}" not found`);
  const rows = (lots || []).filter((l) => Number(l.qty) > 0).map((l) => ({
    production_order_id: order.id, sku: l.sku, qty: Number(l.qty),
    quality: l.quality || 'flagged', marker: l.marker || null,
    disposition: l.disposition || 'hold_storage', inbound_shipment_id: null, notes: l.notes || null,
  }));
  for (const r of rows) {
    await sb.from('production_lots').delete()
      .eq('production_order_id', order.id).eq('sku', r.sku).eq('disposition', r.disposition).is('inbound_shipment_id', null);
  }
  if (rows.length) {
    const { error } = await sb.from('production_lots').insert(rows);
    if (error) throw new Error(`insert production_lots: ${error.message}`);
  }
  return { order_id: order.id, production_code: order.production_code, recorded: rows.length };
}

// --- 3-way reconciliation (+ lots) -------------------------------------------

/**
 * Compare ordered vs produced vs shipped vs received per SKU for an order, and surface
 * the lot disposition (standard / flagged, ship / hold / remake). When production_lots
 * exist they are authoritative for produced/shipped; otherwise falls back to the inbound
 * shipment quantities (orders received before lot tracking).
 */
async function reconcileProductionOrder(orderRef) {
  const sb = getSupabaseClient();
  const order = await resolveOrder(orderRef);
  if (!order) throw new Error(`order "${orderRef}" not found`);

  const { data: orderItems } = await sb.from('production_order_items').select('sku, qty_ordered').eq('production_order_id', order.id);
  const { data: ships } = await sb.from('inbound_shipments').select('id').eq('production_order_id', order.id);
  const shipIds = (ships || []).map((s) => s.id);
  let inbound = [];
  if (shipIds.length) {
    const { data } = await sb.from('inbound_shipment_items').select('sku, qty, qty_received').in('inbound_shipment_id', shipIds);
    inbound = data || [];
  }
  const { data: lotRows } = await sb.from('production_lots').select('sku, qty, quality, marker, disposition, inbound_shipment_id').eq('production_order_id', order.id);
  const haveLots = (lotRows || []).length > 0;

  const ordered = new Map(); for (const r of orderItems || []) ordered.set(r.sku, (ordered.get(r.sku) || 0) + (r.qty_ordered || 0));
  const received = new Map();
  for (const r of inbound) if (r.qty_received != null) received.set(r.sku, (received.get(r.sku) || 0) + r.qty_received);

  // produced (finished = ship + hold) and shipped, per SKU — from lots when present.
  const produced = new Map(); const shipped = new Map();
  const lotsBySku = new Map();
  if (haveLots) {
    for (const l of lotRows) {
      if (!lotsBySku.has(l.sku)) lotsBySku.set(l.sku, []);
      lotsBySku.get(l.sku).push(l);
      produced.set(l.sku, (produced.get(l.sku) || 0) + l.qty); // ship + hold both count as produced
      if (l.disposition === 'ship') shipped.set(l.sku, (shipped.get(l.sku) || 0) + l.qty);
    }
  } else {
    for (const r of inbound) { produced.set(r.sku, (produced.get(r.sku) || 0) + (r.qty || 0)); shipped.set(r.sku, (shipped.get(r.sku) || 0) + (r.qty || 0)); }
  }

  const skus = [...new Set([...ordered.keys(), ...produced.keys()])].sort();
  const lines = skus.map((sku) => {
    const o = ordered.get(sku) || 0;
    const p = produced.get(sku) || 0;
    const sh = shipped.get(sku) || 0;
    const rec = received.has(sku) ? received.get(sku) : null;
    const skuLots = lotsBySku.get(sku) || [];
    const flagged = skuLots.filter((l) => l.quality && l.quality !== 'standard');
    let flag = 'ok';
    if (o > 0 && p === 0) flag = 'missing';
    else if (o === 0 && p > 0) flag = 'extra';
    else if (p < o) flag = 'short';
    else if (p > o) flag = 'over';
    return {
      sku, ordered: o, produced: p, shipped: sh, received: rec, delta: p - o, flag,
      lots: skuLots.map((l) => ({ qty: l.qty, quality: l.quality, marker: l.marker, disposition: l.disposition })),
      flagged: flagged.length > 0,
      quality: flagged.length ? flagged[0].quality : null,
      marker: flagged.length ? flagged[0].marker : null,
    };
  });

  const sum = (m) => [...m.values()].reduce((a, b) => a + b, 0);
  const counts = lines.reduce((acc, l) => { acc[l.flag] = (acc[l.flag] || 0) + 1; return acc; }, {});
  return {
    order: { id: order.id, production_code: order.production_code, status: order.status },
    totals: { ordered: sum(ordered), produced: sum(produced), shipped: sum(shipped), received: sum(received), sku_count: lines.length },
    flag_counts: counts,
    has_lots: haveLots,
    lines,
  };
}

// --- Reconciliation view -> Google Sheet ------------------------------------

// Resolve each SKU to its {product title, color} for grouping. Titles come from the
// synced `products` table (via product_variants); SKUs not in the catalog (e.g. a
// pending SPB sports bra) fall back to the SKU prefix so they still group sensibly.
async function buildSkuResolver(skus) {
  const sb = getSupabaseClient();
  const { data: variants } = await sb.from('product_variants').select('sku, shopify_product_id').in('sku', skus);
  const pidBySku = new Map((variants || []).map((v) => [v.sku, v.shopify_product_id]));
  const pids = [...new Set((variants || []).map((v) => v.shopify_product_id).filter(Boolean))];
  const titleByPid = new Map();
  if (pids.length) {
    const { data: prods } = await sb.from('products').select('shopify_product_id, title').in('shopify_product_id', pids);
    for (const p of prods || []) titleByPid.set(p.shopify_product_id, p.title);
  }
  return (sku) => {
    const color = String(sku).split('-')[1] || '';
    const pid = pidBySku.get(sku);
    const product = (pid && titleByPid.get(pid)) || String(sku).split('-')[0];
    return { product, color };
  };
}

// Add (or clear + reuse) a tab at the front of the sheet, write the values as
// USER_ENTERED (so =SUM/=C-B formulas evaluate), then bold the header/subtotal rows and
// colour each Flag cell by severity.
async function writeReconcileTab(sheets, spreadsheetId, tabName, built) {
  let sheetId = null;
  try {
    const res = await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: [{ addSheet: { properties: { title: tabName, index: 0 } } }] } });
    sheetId = res.data.replies[0].addSheet.properties.sheetId;
  } catch (e) {
    if (!/already exists/i.test(e.message)) throw e;
    const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties(sheetId,title)' });
    const ex = (meta.data.sheets || []).find((s) => s.properties.title === tabName);
    sheetId = ex ? ex.properties.sheetId : null;
    await sheets.spreadsheets.values.clear({ spreadsheetId, range: `'${tabName}'` });
  }
  await sheets.spreadsheets.values.update({ spreadsheetId, range: `'${tabName}'!A1`, valueInputOption: 'USER_ENTERED', requestBody: { values: built.values } });
  if (sheetId == null) return;
  const requests = [{ updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 }, properties: { pixelSize: 340 }, fields: 'pixelSize' } }];
  const ncol = built.ncol || 8;
  for (const ri of built.boldRows) {
    requests.push({ repeatCell: { range: { sheetId, startRowIndex: ri, endRowIndex: ri + 1, startColumnIndex: 0, endColumnIndex: ncol }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: 'userEnteredFormat.textFormat.bold' } });
  }
  for (const fc of built.flagCells) {
    const c = built.flagColors[fc.flag];
    if (!c) continue;
    requests.push({ repeatCell: { range: { sheetId, startRowIndex: fc.row, endRowIndex: fc.row + 1, startColumnIndex: fc.col, endColumnIndex: fc.col + 1 }, cell: { userEnteredFormat: { backgroundColor: c } }, fields: 'userEnteredFormat.backgroundColor' } });
  }
  await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
}

/**
 * Reconcile an order and write the review tab to the 2026 Production Numbers sheet.
 * Rewrites the tab each call (produced now, received once Warehance receiving lands).
 */
async function writeReconciliationSheet({ orderRef, spreadsheetId, today }) {
  const reconcile = await reconcileProductionOrder(orderRef);
  const resolve = await buildSkuResolver(reconcile.lines.map((l) => l.sku));
  const catalog = await loadCatalogSkus();
  const dateStr = today || new Date().toISOString().slice(0, 10);
  const built = buildReconcileRows(reconcile, resolve, dateStr, { catalog });
  const sheetId = spreadsheetId || SHEET_ID;
  const tabName = `Reconcile — ${reconcile.order.production_code}`;
  const sheets = await getSheetsClient();
  await writeReconcileTab(sheets, sheetId, tabName, built);
  return {
    tab_name: tabName,
    url: `https://docs.google.com/spreadsheets/d/${sheetId}/edit`,
    order: reconcile.order, totals: reconcile.totals, flag_counts: reconcile.flag_counts,
    anomalies: built.anomalies,
  };
}

// --- Warehance upload / receiving poll --------------------------------------

/**
 * POST the inbound shipment to Warehance. Resolves each catalog SKU to a Warehance
 * product_id, sends the ASN, and stores the returned warehance_inbound_id.
 */
async function uploadInboundToWarehance(inboundShipmentId, { clientId } = {}) {
  const sb = getSupabaseClient();
  const { data: ship, error } = await sb.from('inbound_shipments').select('*').eq('id', inboundShipmentId).single();
  if (error) throw new Error(`load inbound: ${error.message}`);
  const { data: items } = await sb.from('inbound_shipment_items').select('sku, qty').eq('inbound_shipment_id', ship.id);
  if (!items || !items.length) throw new Error('inbound shipment has no items');

  const stock = await warehance.fetchSkuStockMany(items.map((i) => i.sku));
  const resolved = [];
  const unresolved = [];
  for (const it of items) {
    const p = stock.get(it.sku);
    if (p && p.id != null) resolved.push({ product_id: p.id, ordered: it.qty, sku: it.sku });
    else unresolved.push(it.sku);
  }
  if (!resolved.length) throw new Error(`no SKUs resolved to Warehance product ids (unresolved: ${unresolved.join(', ')})`);

  const warehouseId = await warehance.resolveWarehouseId(ship.warehouse);
  const res = await warehance.createInboundShipment({
    warehouseId,
    items: resolved.map(({ product_id, ordered }) => ({ product_id, ordered })),
    referenceNumber: ship.transfer_number,
    shipDate: ship.ship_date ? new Date(ship.ship_date).toISOString() : undefined,
    expectedDate: ship.estimated_arrival_date ? new Date(ship.estimated_arrival_date).toISOString() : undefined,
    clientId,
  });
  const whId = res.id != null ? String(res.id) : null;

  await sb.from('inbound_shipments').update({
    warehance_inbound_id: whId, warehance_response: res, status: 'uploaded',
    uploaded_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }).eq('id', ship.id);

  return { inbound_shipment_id: ship.id, warehance_inbound_id: whId, uploaded: resolved.length, unresolved };
}

/**
 * Pull receiving progress from Warehance into qty_received. Matches Warehance line
 * items back to our SKUs by product_id; falls back to leaving a line untouched if it
 * can't be matched, rather than guessing.
 */
async function pollInboundReceiving(inboundShipmentId) {
  const sb = getSupabaseClient();
  const { data: ship, error } = await sb.from('inbound_shipments').select('*').eq('id', inboundShipmentId).single();
  if (error) throw new Error(`load inbound: ${error.message}`);
  if (!ship.transfer_number) throw new Error('inbound shipment has no transfer_number to look up');

  const remote = await warehance.fetchInboundShipmentByReference(ship.transfer_number);
  if (!remote) return { inbound_shipment_id: ship.id, found: false };

  const { data: items } = await sb.from('inbound_shipment_items').select('sku, qty').eq('inbound_shipment_id', ship.id);
  const stock = await warehance.fetchSkuStockMany(items.map((i) => i.sku));
  const productIdToSku = new Map();
  for (const it of items) { const p = stock.get(it.sku); if (p && p.id != null) productIdToSku.set(String(p.id), it.sku); }

  let totalReceived = 0;
  const updates = [];
  for (const ri of remote.items || []) {
    const sku = ri.sku || productIdToSku.get(String(ri.product_id));
    const received = Number(ri.received || 0);
    totalReceived += received;
    if (sku) updates.push({ sku, received });
  }
  for (const u of updates) {
    await sb.from('inbound_shipment_items').update({ qty_received: u.received }).eq('inbound_shipment_id', ship.id).eq('sku', u.sku);
  }

  const closed = remote.closed === true || /received|closed|complete/i.test(String(remote.status || ''));
  const status = closed ? 'received' : 'receiving';
  await sb.from('inbound_shipments').update({
    qty_received_total: totalReceived, status,
    actual_arrival_date: closed ? (ship.actual_arrival_date || new Date().toISOString().slice(0, 10)) : ship.actual_arrival_date,
    last_checked_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }).eq('id', ship.id);

  // Mirror qty_received onto the order lines for the 3-way view.
  if (ship.production_order_id) {
    const { data: orderItems } = await sb.from('production_order_items').select('id, sku').eq('production_order_id', ship.production_order_id);
    const orderSku = new Map((orderItems || []).map((r) => [r.sku, r.id]));
    for (const u of updates) { const id = orderSku.get(u.sku); if (id) await sb.from('production_order_items').update({ qty_received: u.received }).eq('id', id); }
  }

  return { inbound_shipment_id: ship.id, found: true, remote_status: remote.status, status, total_received: totalReceived, matched_lines: updates.length, remote_item_count: (remote.items || []).length };
}

module.exports = {
  readOrderTabs,
  recordManualOrder,
  amendOrder,
  createInboundShipmentFromPackingList,
  recordProductionLots,
  reconcileProductionOrder,
  writeReconciliationSheet,
  uploadInboundToWarehance,
  pollInboundReceiving,
  resolveOrder,
  mergeBySku,
};
