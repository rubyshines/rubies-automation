/**
 * MCP tools for the back side of the merchandising pipeline — receiving.
 *
 *   record_manual_order        — record a production order from sheet tab(s), no projection
 *   amend_production_order      — add / top up lines on an existing order (a change)
 *   receive_shipment            — parse a supplier packing list -> inbound shipment + 3-way reconcile
 *   reconcile_production_order  — ordered vs produced vs received per SKU
 *   upload_inbound_to_warehance — POST the ASN to Warehance (Nitro)
 *   poll_inbound_receiving      — pull receiving progress into qty_received
 */

const {
  readOrderTabs, recordManualOrder, amendOrder,
  createInboundShipmentFromPackingList, reconcileProductionOrder,
  uploadInboundToWarehance, pollInboundReceiving,
} = require('../merchandising/inboundReceiving');

const ok = (text) => ({ content: [{ type: 'text', text }] });
const err = (text) => ({ content: [{ type: 'text', text: `Error: ${text}` }] });

function flagSummary(rc) {
  const f = rc.flag_counts || {};
  const parts = [];
  if (f.over) parts.push(`${f.over} over`);
  if (f.short) parts.push(`${f.short} short`);
  if (f.missing) parts.push(`${f.missing} missing`);
  if (f.extra) parts.push(`${f.extra} extra`);
  if (f.ok) parts.push(`${f.ok} exact`);
  return parts.join(' · ');
}

function reconcileBlock(rc) {
  const t = rc.totals;
  const lines = [
    `**Reconcile ${rc.order.production_code}** — ordered ${t.ordered.toLocaleString()} · produced/shipped ${t.produced.toLocaleString()} · received ${t.received.toLocaleString()} (${t.sku_count} SKUs)`,
    `Flags: ${flagSummary(rc)}`,
  ];
  const show = (flag, label) => {
    const ls = rc.lines.filter((l) => l.flag === flag);
    if (!ls.length) return;
    const head = ls.slice(0, 25).map((l) => `${l.sku} (ord ${l.ordered} / prod ${l.produced}${l.delta ? `, Δ${l.delta > 0 ? '+' : ''}${l.delta}` : ''})`).join(', ');
    lines.push(`- **${label}** (${ls.length}): ${head}${ls.length > 25 ? ' …' : ''}`);
  };
  show('short', 'Short-shipped');
  show('missing', 'Not in shipment');
  show('extra', 'Shipped, not ordered');
  return lines.join('\n');
}

async function handleRecordManual({ supplier, tabs, items, production_code, placed_date, status, notes }) {
  if (!supplier) return err('`supplier` is required.');
  let lines = items;
  const warns = [];
  if (!lines && Array.isArray(tabs) && tabs.length) {
    const read = await readOrderTabs(tabs);
    lines = read.items;
    warns.push(...read.warnings);
  }
  if (!lines || !lines.length) return err('provide `tabs` (sheet tab names) or `items` ([{sku, qty}]).');
  const r = await recordManualOrder({ supplier, items: lines, productionCode: production_code, placedDate: placed_date, status, notes });
  return ok([
    `## Manual order recorded — ${r.supplier}`,
    `**Code:** ${r.production_code} · **Order ID:** ${r.order_id} · **${r.sku_count}** SKUs · **${r.total_units.toLocaleString()}** units (no projection)`,
    [...warns, ...r.warnings].length ? '\n⚠️ ' + [...warns, ...r.warnings].join('\n⚠️ ') : '',
  ].filter(Boolean).join('\n'));
}

async function handleAmend({ order_ref, tabs, items }) {
  if (!order_ref) return err('`order_ref` (production_code or order id) is required.');
  let lines = items;
  if (!lines && Array.isArray(tabs) && tabs.length) lines = (await readOrderTabs(tabs)).items;
  if (!lines || !lines.length) return err('provide `tabs` or `items` to add.');
  const r = await amendOrder({ orderRef: order_ref, items: lines });
  const changeLines = [
    ...r.inserts.map((i) => `+ ${i.sku} = ${i.qty} (new)`),
    ...r.changes.map((c) => `~ ${c.sku} ${c.from} → ${c.to}`),
  ];
  return ok([
    `## Amended order ${r.production_code} (#${r.order_id})`,
    `${r.added} line(s) added · ${r.increased} increased`,
    changeLines.length ? '```\n' + changeLines.join('\n') + '\n```' : '',
  ].filter(Boolean).join('\n'));
}

async function handleReceive({ packing_list_path, order_ref, transfer_number, ship_date, expected_arrival, warehouse }) {
  if (!packing_list_path) return err('`packing_list_path` (path to the supplier .xlsx) is required.');
  const r = await createInboundShipmentFromPackingList({
    packingListPath: packing_list_path, orderRef: order_ref, transferNumber: transfer_number,
    shipDate: ship_date, expectedArrival: expected_arrival, warehouse,
  });
  const p = r.packing;
  const out = [
    `## Inbound shipment recorded — ${r.transfer_number}`,
    `**Inbound ID:** ${r.inbound_shipment_id}${r.order ? ` · **Order:** ${r.order.production_code} (#${r.order.id})` : ' · (not linked to an order)'}`,
    `**Packing:** ${p.units.toLocaleString()} units · ${p.sku_count} SKUs · ${p.cartons} cartons · ${p.cbm} CBM · ${p.gross_weight_kg} kg gross`,
    `Canonical SKUs: ${r.canonical_sku_count} (${r.remapped.length} size-alias remaps applied)`,
  ];
  if (r.unknown.length) out.push(`⚠️ **${r.unknown.length} unknown SKU(s)** (no catalog match — review): ${r.unknown.map((u) => `${u.sku}=${u.qty}`).join(', ')}`);
  if (r.parse_warnings.length) out.push('⚠️ ' + r.parse_warnings.join('\n⚠️ '));
  if (r.reconciliation) out.push('\n' + reconcileBlock(r.reconciliation));
  out.push('\nNext: `upload_inbound_to_warehance` to push the ASN to Nitro, then `poll_inbound_receiving` to track check-in.');
  return ok(out.join('\n'));
}

async function handleReconcile({ order_ref }) {
  if (!order_ref) return err('`order_ref` is required.');
  const rc = await reconcileProductionOrder(order_ref);
  return ok('## ' + reconcileBlock(rc));
}

async function handleUpload({ inbound_shipment_id, client_id }) {
  if (!inbound_shipment_id) return err('`inbound_shipment_id` is required.');
  const r = await uploadInboundToWarehance(inbound_shipment_id, { clientId: client_id });
  return ok([
    `## Uploaded inbound ${inbound_shipment_id} to Warehance`,
    `**Warehance inbound ID:** ${r.warehance_inbound_id} · ${r.uploaded} line(s) sent`,
    r.unresolved.length ? `⚠️ ${r.unresolved.length} SKU(s) not found in Warehance (skipped): ${r.unresolved.join(', ')}` : '',
  ].filter(Boolean).join('\n'));
}

async function handlePoll({ inbound_shipment_id }) {
  if (!inbound_shipment_id) return err('`inbound_shipment_id` is required.');
  const r = await pollInboundReceiving(inbound_shipment_id);
  if (!r.found) return ok(`Inbound ${inbound_shipment_id}: not found in Warehance yet (no ASN with that reference).`);
  return ok([
    `## Receiving — inbound ${inbound_shipment_id}`,
    `Warehance status: **${r.remote_status}** → local **${r.status}** · received **${r.total_received.toLocaleString()}** units across ${r.matched_lines}/${r.remote_item_count} matched lines`,
  ].join('\n'));
}

module.exports = [
  {
    name: 'record_manual_order',
    description: 'Record a production order WITHOUT running an inventory projection — for one-off reorders typed straight into the 2026 Production Numbers sheet, or to backfill an older order a delivery belongs to. Pass `tabs` (one or more sheet tab names, read with the same parser as submit_production_order) or explicit `items` ([{sku, qty}]). Mints a production_code unless one is given. Use this instead of the draft/submit loop when there is no projection behind the order.',
    inputSchema: {
      type: 'object',
      properties: {
        supplier: { type: 'string', description: 'Supplier name (e.g. Kali)' },
        tabs: { type: 'array', items: { type: 'string' }, description: 'Sheet tab name(s) in the 2026 Production Numbers sheet to read as the order (merged across tabs).' },
        items: { type: 'array', items: { type: 'object', properties: { sku: { type: 'string' }, qty: { type: 'number' } } }, description: 'Explicit order lines, as an alternative to tabs.' },
        production_code: { type: 'string', description: 'Optional explicit code (e.g. KALI-2601); otherwise auto-minted.' },
        placed_date: { type: 'string', description: 'YYYY-MM-DD the order was placed.' },
        status: { type: 'string', description: "Order status (placed/in_production/shipped/received). Default 'placed'." },
        notes: { type: 'string' },
      },
      required: ['supplier'],
    },
    handler: handleRecordManual,
  },
  {
    name: 'amend_production_order',
    description: 'Add or top up line items on an existing production order (a change to a placed order — e.g. a follow-up Mia addition). Existing SKUs have their qty_ordered increased; new SKUs are inserted. Pass `order_ref` (production_code or order id) and `tabs` or `items`.',
    inputSchema: {
      type: 'object',
      properties: {
        order_ref: { type: 'string', description: 'production_code (e.g. KALI-2601) or numeric order id' },
        tabs: { type: 'array', items: { type: 'string' }, description: 'Sheet tab name(s) holding the change.' },
        items: { type: 'array', items: { type: 'object', properties: { sku: { type: 'string' }, qty: { type: 'number' } } } },
      },
      required: ['order_ref'],
    },
    handler: handleAmend,
  },
  {
    name: 'receive_shipment',
    description: "Parse a supplier packing/shipping list (.xlsx) into an inbound shipment: maps supplier SKU codes to catalog SKUs (e.g. Kali's '1X' -> 'XL', validated against the catalog), writes inbound_shipments + items, sets qty_produced on matched order lines, and returns the 3-way ordered/produced/received reconciliation. Flags unknown SKUs (no catalog match) for review. Link it to the order it fulfills via `order_ref`.",
    inputSchema: {
      type: 'object',
      properties: {
        packing_list_path: { type: 'string', description: 'Path to the supplier packing-list .xlsx (e.g. in ~/Downloads).' },
        order_ref: { type: 'string', description: 'production_code or order id this delivery fulfills. Reconciliation needs this.' },
        transfer_number: { type: 'string', description: 'Unique shipment reference. Defaults to the order production_code. Used as the Warehance reference.' },
        ship_date: { type: 'string', description: 'YYYY-MM-DD' },
        expected_arrival: { type: 'string', description: 'YYYY-MM-DD' },
        warehouse: { type: 'string', description: "Destination warehouse name. Default 'Nitro Logistics AMU'." },
      },
      required: ['packing_list_path'],
    },
    handler: handleReceive,
  },
  {
    name: 'reconcile_production_order',
    description: 'Show the 3-way reconciliation for a production order: ordered vs produced/shipped (from its inbound shipments) vs received (from Warehance), per SKU, with short / over / missing / extra flags. Over-production is expected and OK. Pass `order_ref` (production_code or order id).',
    inputSchema: { type: 'object', properties: { order_ref: { type: 'string', description: 'production_code or order id' } }, required: ['order_ref'] },
    handler: handleReconcile,
  },
  {
    name: 'upload_inbound_to_warehance',
    description: 'POST an inbound shipment to Warehance (Nitro) as an ASN. Resolves each catalog SKU to its Warehance product id, sends the shipment with the production code as the reference number, and stores the returned Warehance inbound id. Pass `inbound_shipment_id` (from receive_shipment).',
    inputSchema: {
      type: 'object',
      properties: {
        inbound_shipment_id: { type: 'number', description: 'The local inbound_shipments id.' },
        client_id: { type: 'number', description: 'Warehance client id (required only for organization-level API keys).' },
      },
      required: ['inbound_shipment_id'],
    },
    handler: handleUpload,
  },
  {
    name: 'poll_inbound_receiving',
    description: 'Pull receiving progress for an inbound shipment from Warehance into qty_received (matched back to our SKUs by product id), update the shipment status, and mirror received quantities onto the order lines. Pass `inbound_shipment_id`.',
    inputSchema: { type: 'object', properties: { inbound_shipment_id: { type: 'number' } }, required: ['inbound_shipment_id'] },
    handler: handlePoll,
  },
];
