---
name: Logistics & Fulfillment
description: 3PL warehouse, multi-carrier tracking, order alerts, delivery estimates, shipping zones
type: project
originSessionId: 76845f16-8454-4953-8882-a8bc486354fb
---
## What's Built

**Multi-Carrier Tracking:** USPS and OnTrac domestically, Passport for all international. Domestic carriers source events from Shopify's fulfillment events (synced nightly). Passport is scraped and normalized into the same event shape. Single read path through `orders.fulfillments[].events`.

**Passport Carrier Handling:** Scrapes Passport's tracking pages, extracts the local carrier and local tracking number, and flags customs holds vs cleared state. Hourly sync mirrors into the fulfillment row. Passport claims tracked in `passport_claims`.

**Warehance 3PL Integration:** Fetches unfulfilled/in-progress orders with hold reasons (address, fraud, payment, warehouse, allocation, store). Releases address holds, sets warehouse holds, updates shipping method, cancels orders. Exposes live per-SKU stock breakdown.

**Unfulfilled Order Detection:** Orders classified into severity buckets (urgent, attention, normal, auto_resolved) from a shared set of predicates used by the email, the CLI, and `list_pending_orders`. Pre-order detection from order tags, known backorder bundle attributes, and fulfillment status.

**Daily Order Alerts (email):** Unified report combining unfulfilled orders and shipping delays, always sent. CLI operators can note, resolve, or file carrier claims. Replacement detection auto-resolves stuck shipments that have been manually reshipped.

**Delivery Time Estimation:** Cascading geographic lookup (state/province → country → sub-zone → zone → static policy) using percentile stats over a rolling recent window.

**Shipping Zones:** Country → zone mapping (us, canada, ddp, ddu). DDP countries have duties pre-paid via Passport; DDU pays duties at the door. Rates synced from Shopify's DeliveryProfile API into `shipping_zones`, with changes appended to `shipping_zones_history`.

**Production Inbound Receiving:** Supplier packing-list ingest → `inbound_shipments` → `production_lots` → 3-way reconcile (ordered/produced/shipped/received) → founder review tab in the production sheet → Warehance ASN, with receipt quantities polled back. MCP tools in `inboundReceiving.js`.

**QC Ingest:** Inspector's QC Master .xlsx and AQL PDF parsed into `qc_inspections` / `qc_measurements` / `qc_issues`; `review_production_qc` summarizes on demand, `approve_production_qc` gates the balance payment.

**Supplier Communication:** `export_supplier_lot_list` emits per-lot ordered-vs-produced .xlsx; `draft_supplier_order_email` creates a Gmail draft with the order file attached (draft only, never sends).

## Current Status

- **Production:** Daily unfulfilled order alerts and shipping-delay detection across all carriers. Address hold auto-resolution. Hourly Passport scrape. Delivery time estimation and pre-purchase shipping info tool. Passport claims tracking. Inbound receiving live against the Warehance API (ASNs post, receipts poll back). QC ingest and supplier lot list/email tools.

## Key Files

- `customer-service/lib/tracking/` — Passport scraper, parser, and `eventNormalizer.js` (Passport → Shopify event shape).
- `customer-service/lib/tools/shippingLookup.js`, `customer-service/lib/tools/deliveryEstimate.js` — advisor tracking and delivery-estimate tools.
- `customer-service/sync/syncPassportDelivery.js` — hourly Passport scrape into the fulfillment row.
- `reports/lib/shippingDelays.js`, `reports/lib/unfulfilled.js` — daily alert analyzers.
- `reports/lib/warehanceClient.js` — Warehance (Nitro) API client.
- `webhooks/handlers/shopifyFulfillments.js`, `webhooks/handlers/shopifyOrders.js` — webhook handlers that preserve fulfillment events on merge.
- `customer-service/lib/merchandising/{packingListParser,skuCanonical,inboundReceiving,reconcileSheet,qcSheetParser,qcResults,supplierLotList,supplierEmail}.js` — receiving, QC, and supplier libs; schema in `customer-service/schema/merchandising_v3.sql`.
- `customer-service/lib/tools/inboundReceiving.js`, `customer-service/lib/tools/qcInspection.js` — receiving/supplier and QC MCP tools.

## Key Decisions

- **Delivery estimates run from order date, not fulfillment date, over a rolling recent window.** Customers experience the full wait, and recent patterns matter more than all-time seasonal history.
- **Deterministic Passport parser first, AI fallback second.** The page structure is stable, so regex; Sonnet only if the parse fails.
- **Passport since Aug 2025 for all international.** Earlier customs complaints are legacy.
- **`orders.fulfillments[].events` is the canonical store for tracking events across every carrier.** Shopify supplies domestic events; Passport scrapes are normalized into the same field, with Passport-only extras alongside on the fulfillment row. `tracking_snapshots` is write-only audit. Webhook handlers merge defensively so REST payloads don't wipe synced events.
- **A warehouse hold outranks the pre-order silo and a resolved note in the daily order report.** Holds are current Warehance state; the pre-order flag and notes are context. Silo/actionable/resolved membership comes from one set of predicates shared by the email, the CLI, and `list_pending_orders` so readers cannot drift apart.
- **`shipping_zones` is current-state only; changes are captured to `shipping_zones_history` on diff detect.** Zero-change days write nothing.
- **Advisor routes delivery questions by fulfillment status:** `shipping_lookup` for FULFILLED orders, `check_unfulfilled_order` for UNFULFILLED only, because the latter hallucinates "stuck" states on fulfilled orders.
- **A stuck shipment whose customer has a newer $0 same-SKU order is treated as a manual reship and auto-resolved.** Shopify records no link from a duplicated order to its source, and the fingerprint (newer, non-cancelled, $0, covering every line) is unambiguous; an exchange never matches because it swaps variants. A PAID lookalike is only annotated, never auto-resolved, because it may be a repeat purchase and a wrong resolve hides a lost package.
- **Nitro and Warehance are the same 3PL** (Nitro the company, Warehance the WMS) and are the inventory-quantity source of truth, syncing levels to Shopify via their own connector; we never push inventory to Shopify. Shopify `available` is on-hand minus committed, so a fully-committed SKU reads 0 without being out of stock; the genuine shortfall signal is Warehance `backordered > 0`. Treat Shopify `available ≤ 0` only as a cheap pre-filter.
- **Passport charges are billed through the Nitro/Warehance invoice; there is no separate Passport payment.** For cost analysis never add `passport_invoices` totals on top of Nitro bill totals, which would double-count customs; `passport_invoices` is the per-shipment breakdown of a cost already inside the Nitro bills.
- **Passport invoices identify orders by Warehance internal order ID, not Shopify order number.** Resolve to the Shopify number via the Warehance orders API (resolver in the finance code); the Warehance bill CSV's Shipment ID is a different identifier and does not bridge the two.
- **Production inbound receiving = packing list → inbound_shipment → lots → 3-way reconcile → review sheet.** SKU corrections are catalog-validated (size aliases, section-scoped supplier prefix remaps) so a SKU is never invented; uncatalogued SKUs are flagged. `inbound_shipments` hold what physically ships (many per order, supporting ocean+air splits); `production_lots` split a produced line by quality × disposition (ship vs hold). The reconcile tab is disposable; Supabase stays canonical. Always create the Shopify product and SKUs before a product's first production run so the supplier barcodes against real SKUs.
- **One Warehance ASN per physical consignment, and the split must be right before upload.** ASN line items cannot be changed after creation and there is no delete, so correcting one means posting a replacement. No shipment is recorded without an expected arrival date (Warehance renders a blank as a real-looking date); when not given it is estimated from the carrier mode, and when the mode is unrecognisable the tool asks rather than guesses.
- **QC results are recorded data, not a reporting surface.** Measurements arbitrate over sheet targets when they disagree with `tech_pack_specs`. A founder review tab with AI triage was built and deliberately removed as too much surface; QC lives in Supabase for historical comparison with on-demand summary and per-category approval gating the balance payment.
- **Supplier quantity conversations happen per lot; receiving reconciles per shipment.** The supplier lot list is grouped like the production order with discrepancies and held-at-factory SKUs, and its fill-in produced column becomes the next shipment's expected packing list.

## What's Next

- Real-time Warehance webhook integration
- Automate Passport loss claim filing at 30+ days
- Seed-next-order-from-held helper
