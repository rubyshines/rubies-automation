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
  createInboundShipmentFromPackingList, createInboundShipmentFromItems,
  updateInboundShipmentMeta, recordProductionLots, reconcileProductionOrder,
  writeReconciliationSheet, uploadInboundToWarehance, pollInboundReceiving,
} = require('../merchandising/inboundReceiving');
const { describeEstimate } = require('../merchandising/transitEstimate');

function anomalyBlock(a) {
  if (!a) return '';
  const parts = [];
  if (a.missing.length) parts.push(`${a.missing.length} missing`);
  if (a.short.length) parts.push(`${a.short.length} short (beyond tolerance)`);
  if (a.extra.length) parts.push(`${a.extra.length} extra`);
  if (a.big_over.length) parts.push(`${a.big_over.length} large over-run`);
  if (a.pending_catalog.length) parts.push(`${[...new Set(a.pending_catalog)].length} pending catalog`);
  return parts.length ? `⚠️ Anomalies: ${parts.join(' · ')}` : '✅ No anomalies beyond tolerance.';
}

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

async function handleReceive({ packing_list_path, items, order_ref, transfer_number, carrier, tracking_number, ship_date, expected_arrival, transit_days, warehouse, remap, flag, write_sheet }) {
  if (!packing_list_path && !(Array.isArray(items) && items.length)) {
    return err('provide `packing_list_path` (the supplier .xlsx) or `items` ([{sku, qty}]) for a small consignment.');
  }
  const common = {
    orderRef: order_ref, transferNumber: transfer_number, carrier, trackingNumber: tracking_number,
    shipDate: ship_date, expectedArrival: expected_arrival, transitDays: transit_days, warehouse, flag,
  };
  let r;
  try {
    r = packing_list_path
      ? await createInboundShipmentFromPackingList({ ...common, packingListPath: packing_list_path, remap })
      : await createInboundShipmentFromItems({ ...common, items });
  } catch (e) {
    // A missing arrival date is a question for the operator, not a failure — nothing was
    // written, so ask and call again rather than recording a blank Warehance dates as
    // 0001-01-01 and the warehouse cannot plan receiving around it.
    return err(e.message);
  }
  const p = r.packing;
  const out = [
    `## Inbound shipment recorded — ${r.transfer_number}`,
    `**Inbound ID:** ${r.inbound_shipment_id}${r.order ? ` · **Order:** ${r.order.production_code} (#${r.order.id})` : ' · (not linked to an order)'}`,
    p
      ? `**Packing:** ${p.units.toLocaleString()} units · ${p.sku_count} SKUs · ${p.cartons} cartons · ${p.cbm} CBM · ${p.gross_weight_kg} kg gross`
      : `**Shipment:** ${r.total_units.toLocaleString()} units · ${r.canonical_sku_count} SKUs (entered directly, no packing list)`,
    `Canonical SKUs: ${r.canonical_sku_count} (${r.remapped.length} size-alias remaps applied)`,
  ];
  if (carrier || tracking_number) out.push(`🚚 **${carrier || 'Carrier'}**${tracking_number ? ` · tracking \`${tracking_number}\`` : ''}`);
  const etaNote = describeEstimate(r.eta);
  if (etaNote) out.push(`📅 Expected arrival ${etaNote}`);
  else if (r.eta) out.push(`📅 Expected arrival **${r.eta.expectedArrival}**`);
  if (r.prefix_remapped && r.prefix_remapped.length) out.push(`🔁 **${r.prefix_remapped.length} prefix correction(s)** applied: ${r.prefix_remapped.map((x) => `${x.from}→${x.to}`).join(', ')}`);
  if (r.lots && r.lots.flagged) out.push(`🎨 **${r.lots.flagged} flagged lot(s)** recorded (${flag && flag.marker ? flag.marker : 'flagged'}${flag && flag.quality ? ` · ${flag.quality}` : ''}) + ${r.lots.standard} standard.`);
  if (r.unknown.length) out.push(`⚠️ **${r.unknown.length} unknown SKU(s)** (no catalog match — review): ${r.unknown.map((u) => `${u.sku}=${u.qty}`).join(', ')}`);
  if (r.parse_warnings && r.parse_warnings.length) out.push('⚠️ ' + r.parse_warnings.join('\n⚠️ '));
  if (r.reconciliation) out.push('\n' + reconcileBlock(r.reconciliation));

  // Write the founder-facing reconcile tab to the 2026 Production Numbers sheet (default
  // on when linked to an order). Fail-soft: the shipment is already recorded.
  if (r.order && write_sheet !== false) {
    try {
      const w = await writeReconciliationSheet({ orderRef: r.order.id });
      out.push(`\n📄 Reconcile tab **"${w.tab_name}"** written to the 2026 Production Numbers sheet. ${anomalyBlock(w.anomalies)}\n[Open the sheet](${w.url})`);
    } catch (e) {
      out.push(`\n⚠️ Could not write the reconcile tab: ${e.message}`);
    }
  }
  out.push('\nNext: `upload_inbound_to_warehance` to push the ASN to Nitro, then `poll_inbound_receiving` to track check-in.');
  return ok(out.join('\n'));
}

async function handleWriteReconciliation({ order_ref }) {
  if (!order_ref) return err('`order_ref` is required.');
  const w = await writeReconciliationSheet({ orderRef: order_ref });
  return ok([
    `## Reconcile tab written — ${w.order.production_code}`,
    `Tab **"${w.tab_name}"** in the 2026 Production Numbers sheet · ordered ${w.totals.ordered.toLocaleString()} / produced ${w.totals.produced.toLocaleString()} / received ${w.totals.received.toLocaleString()}`,
    anomalyBlock(w.anomalies),
    `[Open the sheet](${w.url})`,
  ].join('\n'));
}

async function handleReconcile({ order_ref }) {
  if (!order_ref) return err('`order_ref` is required.');
  const rc = await reconcileProductionOrder(order_ref);
  return ok('## ' + reconcileBlock(rc));
}

async function handleUpload({ inbound_shipment_id, client_id, force }) {
  if (!inbound_shipment_id) return err('`inbound_shipment_id` is required.');
  let r;
  try {
    r = await uploadInboundToWarehance(inbound_shipment_id, { clientId: client_id, force });
  } catch (e) { return err(e.message); }
  return ok([
    `## Uploaded inbound ${inbound_shipment_id} to Warehance`,
    `**Warehance inbound ID:** ${r.warehance_inbound_id} · ref \`${r.transfer_number}\` · ${r.uploaded} line(s) sent${r.tracking_number ? ` · tracking \`${r.tracking_number}\`` : ''}`,
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
    description: "Record an inbound shipment — one physical consignment on its way to the 3PL. Two input modes: `packing_list_path` parses a supplier packing/shipping list (.xlsx) and maps supplier SKU codes to catalog SKUs (e.g. Kali's '1X' -> 'XL'); `items` takes [{sku, qty}] directly, for a small courier parcel that arrives with an email and a tracking number rather than a formatted list. Either way it writes inbound_shipments + items, sets qty_produced on matched order lines, and returns the 3-way ordered/produced/received reconciliation. Unknown SKUs are flagged, never invented. AN ORDER CAN HAVE SEVERAL SHIPMENTS (ocean + air, a held batch following later) — call this once per consignment and the transfer number auto-increments, so each gets its own Warehance ASN the warehouse can receive against separately. EVERY SHIPMENT GETS AN EXPECTED ARRIVAL DATE: pass `expected_arrival` if you know it, otherwise it is estimated from the carrier (ocean ~30d, air ~10d, courier/UPS ~5d). If the carrier's mode is not recognisable the tool records nothing and asks you how long the shipment is in transit — put that question to the operator and call again with `transit_days` or `expected_arrival`, rather than retrying blind.",
    inputSchema: {
      type: 'object',
      properties: {
        packing_list_path: { type: 'string', description: 'Path to the supplier packing-list .xlsx (e.g. in ~/Downloads).' },
        items: { type: 'array', description: 'Explicit shipment lines, as an alternative to a packing list. Use for small consignments where no .xlsx exists.', items: { type: 'object', properties: { sku: { type: 'string' }, qty: { type: 'number' } }, required: ['sku', 'qty'] } },
        order_ref: { type: 'string', description: 'production_code or order id this delivery fulfills. Reconciliation needs this.' },
        transfer_number: { type: 'string', description: "Unique shipment reference, used as the Warehance reference. Defaults to the next free number for the order: the bare production_code for the first shipment, then '<code>-2', '<code>-3' for later ones." },
        carrier: { type: 'string', description: "How this consignment travels, e.g. 'UPS', 'Ocean/CLH'." },
        tracking_number: { type: 'string', description: 'Carrier tracking number. Sent to Warehance with the ASN.' },
        ship_date: { type: 'string', description: 'YYYY-MM-DD the goods left the supplier. Used as the base for the arrival estimate.' },
        expected_arrival: { type: 'string', description: 'YYYY-MM-DD the warehouse should expect it. If omitted, estimated from the carrier (ocean ~30d, air ~10d, courier ~5d) off the ship date, or today when there is no ship date.' },
        transit_days: { type: 'number', description: 'How many days this shipment is in transit. Supply this when asked, for a carrier whose mode is not obvious.' },
        warehouse: { type: 'string', description: "Destination warehouse name. Default 'Nitro Logistics AMU'." },
        remap: {
          type: 'array',
          description: "SKU corrections for a supplier error. PREFIX rule (from = bare prefix) rewrites the prefix keeping color/size, optionally scoped to a packing-list section — e.g. the Evey sports bra shipped under the Ava bra's prefix: [{\"from\":\"SB\",\"to\":\"SPB\",\"section\":\"sports bra\"}]. EXACT rule (from = full SKU) fixes one size typo — e.g. {\"from\":\"MIA-BLK-11\",\"to\":\"MIA-BLK-10\"}. Section-scoping prevents touching genuine SB (Ava) lines.",
          items: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' }, section: { type: 'string', description: 'Case-insensitive substring the packing-list section header must contain for the rule to apply.' } }, required: ['from', 'to'] },
        },
        write_sheet: { type: 'boolean', description: 'Write the founder-facing reconcile tab to the 2026 Production Numbers sheet (default true when linked to an order).' },
        flag: {
          type: 'object',
          description: "Mark a subset of shipped SKUs as a flagged quality lot (a production issue). E.g. the thin-black-fabric test batch: {\"skus\":[\"RUBY-BLK-16\",\"CKY-BLK-M\"],\"quality\":\"thin_black_fabric\",\"marker\":\"pink_sticker\"}. Listed SKUs become flagged lots; the rest are standard.",
          properties: {
            skus: { type: 'array', items: { type: 'string' } },
            quality: { type: 'string', description: "Short quality label, e.g. 'thin_black_fabric'." },
            marker: { type: 'string', description: "Physical marker on the garment, e.g. 'pink_sticker'." },
            notes: { type: 'string' },
          },
          required: ['skus'],
        },
      },
    },
    handler: handleReceive,
  },
  {
    name: 'update_inbound_shipment',
    description: "Update an inbound shipment's travel details — carrier, tracking number, ship date, expected arrival, actual arrival — and push tracking + dates to the live Warehance ASN if it has already been uploaded. Use when a shipment's tracking comes through after it was recorded, or when the freight forwarder reports a new arrival date. NOTE: Warehance can only update the shipment HEADER; the SKU lines on an ASN cannot be changed and an ASN cannot be deleted. To correct what is ON a shipment, record a new one and have the warehouse disregard the old.",
    inputSchema: {
      type: 'object',
      properties: {
        inbound_shipment_id: { type: 'number', description: 'The local inbound_shipments id.' },
        carrier: { type: 'string', description: "e.g. 'UPS', 'Ocean/CLH'" },
        tracking_number: { type: 'string' },
        tracking_url: { type: 'string', description: 'Optional tracking URL, passed to Warehance only.' },
        ship_date: { type: 'string', description: 'YYYY-MM-DD' },
        expected_arrival: { type: 'string', description: 'YYYY-MM-DD' },
        actual_arrival: { type: 'string', description: 'YYYY-MM-DD the goods actually landed.' },
        status: { type: 'string', description: 'draft / uploaded / in_transit / receiving / received / in_inventory' },
      },
      required: ['inbound_shipment_id'],
    },
    handler: async (args) => {
      if (!args.inbound_shipment_id) return err('`inbound_shipment_id` is required.');
      try {
        const r = await updateInboundShipmentMeta({
          inboundShipmentId: args.inbound_shipment_id,
          carrier: args.carrier, trackingNumber: args.tracking_number, trackingUrl: args.tracking_url,
          shipDate: args.ship_date, expectedArrival: args.expected_arrival,
          actualArrival: args.actual_arrival, status: args.status,
        });
        const u = r.updated;
        const lines = [
          `## Updated inbound ${r.inbound_shipment_id} — ${r.transfer_number}`,
          `Carrier: **${u.carrier || '—'}** · Tracking: **${u.tracking_number || '—'}** · Status: **${u.status}**`,
          `Ship ${u.ship_date || '—'} · Expected ${u.estimated_arrival_date || '—'} · Arrived ${u.actual_arrival_date || '—'}`,
        ];
        if (!r.warehance_inbound_id) lines.push('_Not yet in Warehance — run `upload_inbound_to_warehance` to create the ASN._');
        else if (r.remote.attempted && r.remote.ok) lines.push(`✅ Warehance ASN ${r.warehance_inbound_id} updated (${r.remote.fields.join(', ')}).`);
        else if (r.remote.attempted) lines.push(`⚠️ Local record updated, but the Warehance push failed: ${r.remote.error}`);
        return ok(lines.join('\n'));
      } catch (e) { return err(e.message); }
    },
  },
  {
    name: 'record_production_lots',
    description: "Record produced-but-not-shipped units for a production order as HELD in storage — the other side of a split caused by a production issue (e.g. the thin-fabric swimwear Kali held back). Pass `order_ref` and `lots`: [{sku, qty, quality?, marker?, notes?}]. Held units count as produced but not shipped, and roll up under FABRIC/QUALITY on the reconcile tab. Idempotent per (order, sku). Shipped flagged units are recorded by receive_shipment's `flag`; this is for the held remainder.",
    inputSchema: {
      type: 'object',
      properties: {
        order_ref: { type: 'string', description: 'production_code or order id' },
        lots: {
          type: 'array',
          items: { type: 'object', properties: { sku: { type: 'string' }, qty: { type: 'number' }, quality: { type: 'string' }, marker: { type: 'string' }, notes: { type: 'string' } }, required: ['sku', 'qty'] },
        },
      },
      required: ['order_ref', 'lots'],
    },
    handler: async ({ order_ref, lots }) => {
      if (!order_ref || !Array.isArray(lots) || !lots.length) return err('`order_ref` and non-empty `lots` are required.');
      const r = await recordProductionLots({ orderRef: order_ref, lots: lots.map((l) => ({ ...l, disposition: 'hold_storage' })) });
      return ok(`Recorded **${r.recorded}** held lot(s) for ${r.production_code} (#${r.order_id}). Re-run \`write_reconciliation\` to refresh the sheet.`);
    },
  },
  {
    name: 'write_reconciliation',
    description: "Write (or refresh) the founder-facing reconciliation tab for a production order to the 2026 Production Numbers Google Sheet — a separate 'Reconcile — <code>' tab grouped by product/color, with Ordered / Produced (shipping list) / Received (Warehance) / Δ per SKU, live =SUM totals, colour-coded flags, and an ⚠ ANOMALIES block. Supabase stays the source of truth; this is a disposable review view. Re-run after Warehance receiving to fill the Received column. Pass `order_ref` (production_code or order id).",
    inputSchema: { type: 'object', properties: { order_ref: { type: 'string', description: 'production_code or order id' } }, required: ['order_ref'] },
    handler: handleWriteReconciliation,
  },
  {
    name: 'reconcile_production_order',
    description: 'Show the 3-way reconciliation for a production order: ordered vs produced/shipped (from its inbound shipments) vs received (from Warehance), per SKU, with short / over / missing / extra flags. Over-production is expected and OK. Pass `order_ref` (production_code or order id).',
    inputSchema: { type: 'object', properties: { order_ref: { type: 'string', description: 'production_code or order id' } }, required: ['order_ref'] },
    handler: handleReconcile,
  },
  {
    name: 'upload_inbound_to_warehance',
    description: 'POST an inbound shipment to Warehance (Nitro) as an ASN. Resolves each catalog SKU to its Warehance product id, sends the shipment with the transfer number as the reference and its tracking number, and stores the returned Warehance inbound id. Pass `inbound_shipment_id` (from receive_shipment). Refuses to re-post a shipment that already has an ASN, because Warehance cannot delete one and the duplicate would be receivable — use `update_inbound_shipment` for dates and tracking instead.',
    inputSchema: {
      type: 'object',
      properties: {
        inbound_shipment_id: { type: 'number', description: 'The local inbound_shipments id.' },
        client_id: { type: 'number', description: 'Warehance client id (required only for organization-level API keys).' },
        force: { type: 'boolean', description: 'Post a second ASN even though this shipment already has one. Rarely correct — the old ASN cannot be deleted.' },
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
  {
    name: 'draft_supplier_order_email',
    description: 'Create a Gmail DRAFT (never sends) to the supplier for a production order, with the supplier-ready order .xlsx ALWAYS attached — built fresh from the canonical Supabase order lines. Use `updated: true` when the order revises one already sent; `note` adds order-specific context to the body.',
    inputSchema: {
      type: 'object',
      properties: {
        order_ref: { type: 'string', description: 'production_code (e.g. KALI-2606) or order id' },
        note: { type: 'string', description: 'Optional context paragraph, e.g. why quantities changed' },
        updated: { type: 'boolean', description: 'True when this replaces a previously sent order' },
        to: { type: 'string', description: 'Override recipient; defaults to the supplier email on file' },
      },
      required: ['order_ref'],
    },
    handler: async (args) => {
      try {
        const { draftSupplierOrderEmail } = require('../merchandising/supplierEmail');
        const r = await draftSupplierOrderEmail({ orderRef: args.order_ref, note: args.note, updated: args.updated, to: args.to });
        const parts = [];
        if (r.catalog_created && r.catalog_created.length) parts.push(`\n✅ Added ${r.catalog_created.length} missing variant(s) to Shopify (sibling price): ${r.catalog_created.join(', ')}`);
        if (r.catalog_unresolvable && r.catalog_unresolvable.length) parts.push(`\n🚨 ${r.catalog_unresolvable.length} SKU(s) have NO PRODUCT in Shopify (cannot auto-create): ${r.catalog_unresolvable.join(', ')} — create the product first.`);
        const warn = parts.join('');
        return ok(`**Gmail draft created** — "${r.subject}" to ${r.to}\n${r.sku_count} SKUs · ${r.total_units.toLocaleString()} units · attachment: ${r.filename}${warn}\nReview and send from Gmail drafts.`);
      } catch (e) { return err(e.message); }
    },
  },
  {
    name: 'export_supplier_lot_list',
    description: 'Export the supplier-facing ordered-vs-produced .xlsx for a production order, one section per lot: shipped-goods discrepancies (significant under-production highlighted red, over-production orange — significant means ≥10 units and ≥10% of ordered), marked test batches for reference, and held-at-factory SKUs with a fill-in produced column for the supplier to confirm. Writes to ~/Downloads unless out_path is given.',
    inputSchema: {
      type: 'object',
      properties: {
        order_ref: { type: 'string', description: 'production_code (e.g. KALI-2601) or order id' },
        out_path: { type: 'string' },
      },
      required: ['order_ref'],
    },
    handler: async (args) => {
      try {
        const { writeSupplierLotList } = require('../merchandising/supplierLotList');
        const r = await writeSupplierLotList({ orderRef: args.order_ref, outPath: args.out_path });
        const s = r.stats;
        return ok([
          `**Supplier lot list written** — ${r.order.production_code}`,
          `${s.shipped_discrepancies} shipped discrepancies (${s.highlighted_under} significant under 🟥 · ${s.highlighted_over} significant over 🟧) · ${s.marked_skus} test-batch SKUs · ${s.held_skus} held SKUs to confirm`,
          r.path,
        ].join('\n'));
      } catch (e) { return err(e.message); }
    },
  },
];
