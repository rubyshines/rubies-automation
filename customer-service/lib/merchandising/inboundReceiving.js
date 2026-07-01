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
async function createInboundShipmentFromPackingList({ packingListPath, orderRef, transferNumber, shipDate, expectedArrival, warehouse, remap }) {
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
    remapped,
    unknown,
    qty_produced_set: producedSet,
    parse_warnings: parsed.warnings,
    reconciliation,
  };
}

// --- 3-way reconciliation ----------------------------------------------------

/**
 * Compare ordered vs produced (shipped) vs received per SKU for an order.
 * produced/received come from the order's inbound shipment(s); ordered from the order.
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

  const ordered = new Map(); for (const r of orderItems || []) ordered.set(r.sku, (ordered.get(r.sku) || 0) + (r.qty_ordered || 0));
  const produced = new Map(); const received = new Map();
  for (const r of inbound) {
    produced.set(r.sku, (produced.get(r.sku) || 0) + (r.qty || 0));
    if (r.qty_received != null) received.set(r.sku, (received.get(r.sku) || 0) + r.qty_received);
  }

  const skus = [...new Set([...ordered.keys(), ...produced.keys()])].sort();
  const lines = skus.map((sku) => {
    const o = ordered.get(sku) || 0;
    const p = produced.get(sku) || 0;
    const rec = received.has(sku) ? received.get(sku) : null;
    let flag = 'ok';
    if (o > 0 && p === 0) flag = 'missing';        // ordered, nothing produced/shipped
    else if (o === 0 && p > 0) flag = 'extra';      // produced but not on the order
    else if (p < o) flag = 'short';                 // under-produced
    else if (p > o) flag = 'over';                  // over-produced (expected, OK)
    return { sku, ordered: o, produced: p, received: rec, delta: p - o, flag };
  });

  const sum = (m) => [...m.values()].reduce((a, b) => a + b, 0);
  const counts = lines.reduce((acc, l) => { acc[l.flag] = (acc[l.flag] || 0) + 1; return acc; }, {});
  return {
    order: { id: order.id, production_code: order.production_code, status: order.status },
    totals: { ordered: sum(ordered), produced: sum(produced), received: sum(received), sku_count: lines.length },
    flag_counts: counts,
    lines,
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
  reconcileProductionOrder,
  uploadInboundToWarehance,
  pollInboundReceiving,
  resolveOrder,
  mergeBySku,
};
