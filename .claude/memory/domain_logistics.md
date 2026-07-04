---
name: Logistics & Fulfillment
description: 3PL warehouse, multi-carrier tracking, order alerts, delivery estimates, shipping zones
type: project
originSessionId: 76845f16-8454-4953-8882-a8bc486354fb
---
## What's Built

**Multi-Carrier Tracking:** USPS (~80% US), OnTrac (~20% US), Passport (100% international post-Aug 2025). Domestic carriers source events from Shopify's fulfillment.events GraphQL connection (synced nightly). Passport scrapes two tracking pages (local-carrier handoff isn't in Shopify) and normalizes events into the same shape. Single read path through `orders.fulfillments[].events`.

**Warehance 3PL Integration:** Fetches unfulfilled/in-progress orders with hold reasons (address, fraud, payment, warehouse, allocation, store). Can release address holds (auto-correctable) and set warehouse holds. Shipping method updates and order cancellation.

**Unfulfilled Order Detection:** Orders classified into severity buckets — urgent (>7 biz days, unknown reason), attention (pre-order, out of stock, long holds), normal (address hold, recent), auto_resolved (address hold corrected).

**Pre-Order Detection:** Checks order tags (regex), line item custom attributes (_cs_bundle_id for known backorder bundles: 27324, 27097, 37526), and Shopify fulfillment status.

**Daily Order Alerts (email):** Unified report combining unfulfilled orders + shipping delays. Always sends (even quiet days). Color-coded HTML by severity. CLI operators can note, resolve, or file carrier claims.

**Delivery Time Estimation:** Cascading lookup — province/state (if 30+ orders) → country → sub-zone → shipping zone → static policy. Metrics: p50 median, p75 customer-facing, p90 overdue threshold. 90-day rolling window.

**Shipping Zones:** Country → zone mapping (us, canada, ddp, ddu). DDP countries (AU/NZ/UK/EU) = duties pre-paid via Passport. DDU = rest of world, duties at door. Rates synced from Shopify DeliveryProfile API.

**Passport Carrier Handling:** Scrapes two tracking URLs. Extracts local carrier (Royal Mail, Australia Post, DHL, etc.) and local tracking number. Flags customs holds vs cleared state.

## Current Status

- **Production:** Daily unfulfilled order alerts. Shipping delay detection across all carriers (reads `orders.fulfillments[].events`). Address hold auto-resolution. Hourly Passport scrape mirrors into fulfillment row. Delivery time estimation. Shipping info tool (pre-purchase). Passport claims tracking.
- **Partial:** Shipping zone sync from Shopify ready but currently manual table seeding.
- **Production inbound receiving:** supplier packing-list ingest → `inbound_shipments` → lot splitting → 3-way reconcile → founder review tab in the 2026 Production Numbers sheet → Warehance ASN. Warehance ASN upload path built but not yet exercised against the live API. See Key Decisions.

## Key Files

- `customer-service/lib/tracking/` — Passport scraper + parser. Domestic carriers source events from Shopify directly via `fetchOrdersForSync` — no scraper needed.
- `customer-service/lib/tracking/eventNormalizer.js` — Converts Passport scrape events to the Shopify event shape so all carriers share one read path.
- `customer-service/lib/tools/shippingLookup.js` — Shipping tracking MCP tool. Carrier-agnostic; reads `orders.fulfillments[].events`.
- `customer-service/lib/tools/deliveryEstimate.js` — Delivery time estimation tool.
- `customer-service/sync/syncPassportDelivery.js` — Hourly Passport scrape; mirrors normalized events into the fulfillment row.
- `reports/lib/shippingDelays.js` — Daily shipping-delay analyzer; reads fulfillment events for every carrier.
- `webhooks/handlers/shopifyFulfillments.js`, `webhooks/handlers/shopifyOrders.js` — Webhook handlers preserve fulfillment events on merge (REST payloads don't carry events).
- `customer-service/lib/merchandising/{packingListParser,skuCanonical,inboundReceiving,reconcileSheet}.js` — production inbound receiving: parse supplier packing list, catalog-validated SKU correction, inbound shipment + lots + reconcile, founder review sheet. Schema: `customer-service/schema/merchandising_v3.sql` (`production_lots`).
- `customer-service/lib/merchandising/{qcSheetParser,qcResults}.js` + `customer-service/lib/tools/qcInspection.js` — QC ingest: inspector's QC Master .xlsx + AQL PDF -> qc_inspections/measurements/issues; review + approve tools.
- `customer-service/lib/merchandising/{supplierLotList,supplierEmail}.js` — supplier-facing per-lot ordered-vs-produced .xlsx + Gmail order-email drafts (attachment always included).
- `customer-service/lib/tools/inboundReceiving.js` — 10 receiving/supplier MCP tools (`receive_shipment`, `reconcile_production_order`, `write_reconciliation`, `record_manual_order`, `amend_production_order`, `record_production_lots`, `upload_inbound_to_warehance`, `poll_inbound_receiving`).

## Key Decisions

- **Delivery estimates from order date, not fulfillment date.** Customers experience the full wait.
- **Deterministic Passport parser first, AI fallback second.** Stable structure = regex, Sonnet only if parse fails.
- **90-day rolling delivery stats, not all-time.** Recent patterns more relevant than seasonal history.
- **Passport since Aug 2025 for all international.** Pre-May 2025 customs complaints are legacy.
- **Shipping zone changes are captured to `shipping_zones_history` on diff detect.** `shipping_zones` is current-state only (upsert-overwrite); the daily sync compares incoming Shopify rates against stored values and appends a history row when zone/rate/threshold/currency changes. Zero-change days write nothing.
- **Apr 18 2026 shipping change captured in history** (474 rows seeded, 237 baselines + 237 change rows): US $9 → $10.50 USD; Canada switched USD → CAD (was ~$10 USD, now $15 CAD); DDP went $12.72 USD median → $15 USD flat with free-shipping option added; DDU went $12.67 USD median → $12 USD flat. Prior rates were calculated/dynamic (carrier-derived, ~$1 variance) — backfilled values are medians from Jan-Apr 2026 order data.
- **`orders.fulfillments[].events` is the canonical store for tracking events across every carrier.** syncAll pulls them from Shopify's fulfillment.events GraphQL connection (covers USPS, OnTrac, any Shopify-supported carrier). syncPassportDelivery normalizes Passport scrapes to the same shape and writes them into the same field. Passport-only extras (`lastLocation`, `localCarrier`, `customsCleared`, `localTrackingNumber`, `estimatedDeliveryAt`) sit alongside on the fulfillment row. `tracking_snapshots` is now write-only audit; readers (`shippingLookup`, `shippingDelays`) no longer touch it. Webhook handlers (orders/update, fulfillments/update) merge defensively so REST payloads don't wipe the GraphQL-synced events.
- **Advisor `shipping_lookup` is the right tool for any FULFILLED order with a delivery question.** `check_unfulfilled_order` is for UNFULFILLED only — calling it on a FULFILLED order produces "partially fulfilled / stuck" hallucinations. Both are registered in the advisor's TOOLS array; the prompt routes by `fulfillment_status`. The `returned` shipping-response template asks the customer to confirm their on-file address before reshipping.
- **`passport_claims.status` is reconciled against `fulfillments[].deliveredAt` at report time.** [syncPassportDelivery.js](../../customer-service/sync/syncPassportDelivery.js)'s auto-resolve only fires when a fresh scrape returns `delivered`, so claims filed after delivery (or before deliveredAt was set via another path) would otherwise stay `open` forever and the "Waiting on Response from Passport" bucket grows monotonically. [checkShippingDelays](../../reports/lib/shippingDelays.js) now partitions open claims by `fulfillments[].deliveredAt` (strict tracking-number match, guards split shipments) before building the awaiting list, and flips matched claims to `delivered` with a `(reconciled)` resolution note.
- **Nitro and Warehance are the same 3PL** — Nitro is the company/brand, Warehance the WMS; the API client, docs, and Passport handoff all use the names interchangeably (see [warehanceClient.js](../../reports/lib/warehanceClient.js), titled "Warehance (Nitro)"). Warehance/Nitro holds physical stock and is the **inventory-quantity source of truth**, syncing levels to Shopify via its own connector (near real-time; not driven by our code — we never push inventory to Shopify). Key consequence for any inventory reasoning: Shopify `available` = on-hand minus committed, so a **fully-committed in-stock SKU reads 0 available without being out of stock**. The genuine shortfall signal is Warehance **`backordered > 0`** (demand beyond physical on-hand). Treat Shopify `available ≤ 0` only as a cheap "maybe OOS" pre-filter and confirm true unfulfillability against Warehance backordered. `fetchSkuStock` / `fetchSkuStockMany` in warehanceClient expose the live per-SKU on-hand/allocated/available/backordered breakdown.
- **Feb 2026: Nitro changed Passport handoff identifier.** Passport invoice `order_id` field switched from Shopify order number (`#28547`) to Warehance internal order ID (`WH-{warehance_order_id}-{hash}`). Format mix in transition: Feb 58% Shopify / 42% WH-, by April 99% WH-. The `WH-{12digits}` middle segment is the Warehance Order ID, resolvable via Warehance API `/orders/{id}` → `order_number` (Shopify form). Resolver lives in `finance/resolvePassportShopifyOrders.js`. The Warehance bill CSV's `Shipment ID` column is a *different* identifier (starts `231185...` vs Passport's `231186...`) and does NOT bridge the two — must use the API.

- **Production inbound receiving = packing-list → inbound_shipment → lots → 3-way reconcile → review sheet (`merchandising_v3`).** Supplier `.xlsx` packing lists parse to per-SKU qty; SKU corrections are catalog-validated — size aliases (Kali codes plus sizes `1X`→catalog `XL`), and supplier prefix/typo fixes via a section-scoped `remap` — so we never invent a SKU (uncatalogued SKUs are flagged, not guessed). `inbound_shipments`/`_items` hold what physically ships (many per order → supports ocean+air splits). `production_lots` split a produced line by quality×disposition (`ship`, optionally flagged e.g. a pink-sticker test batch, vs `hold_storage`) — a production issue like the June 2026 thin-black-swimwear-fabric mistake records flagged/held lots. `reconcile_production_order` computes ordered→produced→shipped→received per SKU with anomaly + fabric flags, written to a disposable "Reconcile — <code>" tab (live formulas; Supabase stays canonical). Warehance ASN via `POST /inbound-shipments` keys on `product_id` (resolve SKU→id). **Lesson (SB/SPB):** a brand-new product with no catalog SKUs got barcoded under an existing product's prefix (sports bra shipped as Ava's `SB`); always create the Shopify product + SKUs before first production.

- **QC results are recorded data, not a reporting surface.** `ingest_qc_results` parses the inspector's completed QC Master (geometry detected per tab; catalog-validated SKU resolution with tab-scoped prefix remaps — both Ava and Evey tabs are labeled AVA-*, resolving to SB-*/SPB-*) into per-sample `qc_measurements`; `ingest_qc_report` Opus-extracts the AQL PDF into `qc_issues`. Sheet Orig targets are cross-validated against `tech_pack_specs` — measurements arbitrate when they disagree (caught stale QC Master targets posing as garment failures). A founder review tab with AI triage was built and then deliberately removed (too much surface); QC lives in Supabase for historical comparison, `review_production_qc` summarizes on demand, `approve_production_qc` gates the balance payment per category.
- **Supplier quantity conversations happen per lot; receiving reconciles per shipment.** `export_supplier_lot_list` emits the ordered-vs-produced `.xlsx` grouped like the production order (product-color, size order, live subtotals), one section per lot: shipped discrepancies (red = short ≥10 units and ≥10%; orange = ≥2× over), marked test batches, and held-at-factory SKUs with a fill-in produced column that becomes the next shipment's expected packing list. `draft_supplier_order_email` creates the Gmail draft with the order `.xlsx` always attached (draft-only, never sends). The reconcile tab's Lot column shows each row's lot split.

## What's Next

- Real-time Warehance webhook integration
- Automate Passport loss claim filing at 30+ days
- Per-shipment reconcile tab (parked); seed-next-order-from-held helper
