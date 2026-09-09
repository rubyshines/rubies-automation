---
name: Production Pipeline
description: End-to-end manufacturing workflow — inventory projections, production orders, pre-orders, QC, Warehance receiving
type: project
domains: [product_design, inventory, logistics]
last_updated: 2026-09-09
---

## Goal
Connect the various scripts and processes into one cohesive production pipeline: inventory projections → production orders → pre-order setup → QC spreadsheets → Warehance receiving.

## Phases
1. Inventory projection engine + supplier registry — **design complete, ready to build** (algorithm locked below; the separate plan file was retired)
2. Production order generation — design complete (part of Phase 1 plan above)
3. Pre-order setup — **sheet→web push built** (`sync_pre_orders`); remaining: auto-populate `us-YYYY-MM-DD` tabs from a confirmed production order
4. QC spreadsheet generation for third-party inspector — **ingest side built + run live on KALI-2601 (PR #48); remaining: generate_qc_sheet for the next order**
5. Warehance receiving upload + received vs ordered reconciliation — **run live end-to-end (Aug 2026)**: packing-list → inbound shipment → lots (ship/held) → 3-way reconcile → founder review sheet → ASN posted to Warehance → receipts polled back per SKU
6. Graded spec collection — started (shared with product design initiatives)

## Current Status
Phases 1+2 design locked June 2026 (algorithm below); the existing `rubies-utilities` projection script is the baseline and the rebuild targets Supabase with OOS-adjusted velocity, a supplier registry, and `get_at_risk_skus`. Phase 3: the sheet→Shopify pre-order push is built and run live (`sync_pre_orders`); auto-populating the incoming-inventory tabs from a confirmed production order remains. Phases 4 and 5 are built and have run live end to end on a real supplier shipment: packing-list ingest → inbound shipment → lots (ship/held) → 3-way reconcile → founder review sheet → Warehance ASN → receipts polled back per SKU, and QC ingest (inspector's measurements + AQL report) with per-category approval gating the balance payment. Detail lives in `domain_logistics.md`.

- **August 2026:** two ASNs live at the 3PL; one ran the full cycle including receipts. The receipt poll had never matched an ASN line to a SKU until it was fixed, so earlier reconciles had an empty received column.
- **July 2026:** receiving and QC built on the first real shipment. Learnings folded into logistics Key Decisions: create the Shopify product before a product's first run (a new style shipped barcoded under another product's prefix); catalog-validated SKU correction; held-quality lots recorded per batch.
- **June 2026:** schema v2 (suppliers extended, `tech_packs`/`tech_pack_specs`, QC tables, `production_payments`, `inbound_shipments`), the order loop (`draft_production_order` → edit tab → `submit_production_order`, record-only), vendor registry with bank details captured from Gmail PI attachments, grading digitized into tech-pack specs (first pass, refine before first shipment), and four years of order history backfilled into `production_orders` for cadence and size-spread analysis.

Open: `ingest_invoice` MCP tool (promote the one-off Gmail PI ingest script); the Phase 1 projection rebuild; Phase 3 tab auto-population.

## Decisions Made
- **Supabase as canonical store for projection output.** Results written to `inventory_projections` table (upsert by SKU per run). Google Sheets output is optional view only.
- **4 Supabase tables:** `suppliers`, `inventory_projections`, `production_orders`, `production_order_items`. Schema in plan file.
- **Supplier registry keyed by SKU prefix — the `suppliers` table is the source of truth for prefix→vendor mappings; don't trust memory snapshots of the lists (they drift).** Corrected 2026-07-17: Stella (RHW) is made by Pigeons and Thread (studio), NOT Kali — first P&T production order placed as PIGEONS-2607. P&T is billed after delivery (payment_terms: 100% balance due on delivery).
- **OOS adjustment uses `available_quantity <= 0` in snapshots** (committed = effectively sold for planning purposes). Pre-order flag fallback for periods before snapshots started (~March 2026).
- **Pre-order spreadsheet (`1m2efAIbrV_...`) and incoming-inventory spreadsheet are the same document.** `us-YYYY-MM-DD` tabs serve both the planning script (incoming units) and `update-incoming-inventory.js` (Shopify pre-order metafields). Phase 3 automates populating these tabs from a production order.
- **Production order CSV format** matches existing 2026 Google Sheet structure (product header + SKU|qty rows + subtotals). Supplier name used as alias (e.g. "Kali" = contact name, company = JINJIANG JIHE IMPORT AND EXPORT).
- **3 MCP tools in Phase 1:** `run_inventory_projection`, `get_at_risk_skus`, `create_production_order`.

## Key Decisions — the ordering ALGORITHM (locked, June 2026)
Founder priority: **simple, readable rules** — must be able to see *why* any suggested number exists; no per-item/per-supplier risk weights. Caution = **supply resilience (never get caught empty on something that takes ~a year to re-source)**, NOT overstock avoidance.
1. **Velocity** = units/wk over last year, in-stock weeks only (OOS-adjusted), **+30%**.
2. **Target cover = 18 months** (≈6-7mo make+ship + supplier-replacement buffer + sell-through). Keep it; it's deliberate.
3. **Coverage on hand** = on-hand + incoming.
4. **Order = gap** to (target × velocity); already covered → order nothing.
5. **New items: formula does NOT apply** (no velocity → garbage, e.g. Sassy SND "6.5yr"). Flag as new; founder gives a **launch quantity + an analog product**; apply the analog's **size spread** (computed from the backfilled order history). Distinguish **new colourway** (analog = sibling color of same product, auto) vs **new product** (pick analog + needs full dev workflow).
6. **Reorder trigger (the "minimum" rule):** only order a color now if its cover would fall **below the make+ship lead time (~6-7mo)** before the next planned order; else SKIP (catch it next cycle). This is minimum-*need*, not a color-level MOQ; never actually stock out; small color needs still ride free in a big order (Kali flexes on which colors go in the PO).
- **Decision unit = style+color, not SKU** — once a color is committed, fill the whole size curve; only the color-level call matters.
- **Per-SKU production floor = 20 units (Kali's manufacturing minimum — Kali will not cut a run smaller than 20).** Every size line in a committed color is ordered at **≥20**: thin sizes whose computed need is below 20 **round up to 20** (caution = supply resilience, not overstock — carrying a few extra beats missing a size on a ~year-lead item). Exception: a size with no real trailing-year demand is **dropped from the curve**, not floored to 20. Color-level flex (small total need riding free in a big PO) coexists with this — it's individual SKU runs below 20 that Kali won't do.
- **Trust earned by measurement:** the order loop's review gate stays; add outlier flags (vs 4-yr history), new-item flags, order-level sanity ("2× largest ever"). Log suggested-vs-actual each cycle → graduate to auto-accepting high-confidence lines, always review exceptions. Never blind auto-order (irreversible big spend).
- **Draft tool rebuild (planned):** the edit surface should be the **projections spreadsheet** (full columns: on-hand, incoming, weeks cover, sales/wk, priority + editable Order Qty + live "weeks-cover-after-order" + Rule-6 ORDER/SKIP flag), formula-based totals (never hardcoded); GO reads Order Qty → order + supplier `.xlsx`.
