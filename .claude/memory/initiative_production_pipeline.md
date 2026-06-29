---
name: Production Pipeline
description: End-to-end manufacturing workflow — inventory projections, production orders, pre-orders, QC, Warehance receiving
type: project
domains: [product_design, inventory, logistics]
last_updated: 2026-06-28
---

## Goal
Connect the various scripts and processes into one cohesive production pipeline: inventory projections → production orders → pre-order setup → QC spreadsheets → Warehance receiving.

## Phases
1. Inventory projection engine + supplier registry — **design complete, ready to build** (plan: `.claude/plans/merchandising-projection-engine.md`)
2. Production order generation — design complete (part of Phase 1 plan above)
3. Pre-order setup — **sheet→web push built** (`sync_pre_orders`); remaining: auto-populate `us-YYYY-MM-DD` tabs from a confirmed production order
4. QC spreadsheet generation for third-party inspector
5. Warehance receiving upload + received vs ordered reconciliation
6. Graded spec collection — started (shared with product design initiatives)

## Current Status
Phase 1+2 design locked June 2026. Existing `rubies-utilities` projection script identified as the baseline; new version rebuilds against Supabase, adds OOS-adjusted velocity, supplier registry, and `get_at_risk_skus` query tool. Phase 3 partially delivered 2026-06-24: the sheet→Shopify pre-order push is built (`sync_pre_orders` tool + `scripts/syncPreOrders.js`) and run live across the catalog — it reads the same `us-YYYY-MM-DD` sheet the projection engine uses and reconciles pre-order metafields + inventory policy. Remaining Phase 3 work is auto-populating those tabs from a confirmed production order. Phases 4-6 not yet started.

## Decisions Made
- **Supabase as canonical store for projection output.** Results written to `inventory_projections` table (upsert by SKU per run). Google Sheets output is optional view only.
- **4 Supabase tables:** `suppliers`, `inventory_projections`, `production_orders`, `production_order_items`. Schema in plan file.
- **Supplier registry keyed by SKU prefix.** Kali (JINJIANG JIHE) = catch-all for AJ/BB/UNW/CKY/FLO/RUBY/HLA/SHS/SKY2/SPB/RHW/GAF; Queenas = AVA; JustMax = SWS; Wumes = MPAD. Tees excluded.
- **OOS adjustment uses `available_quantity <= 0` in snapshots** (committed = effectively sold for planning purposes). Pre-order flag fallback for periods before snapshots started (~March 2026).
- **Pre-order spreadsheet (`1m2efAIbrV_...`) and incoming-inventory spreadsheet are the same document.** `us-YYYY-MM-DD` tabs serve both the planning script (incoming units) and `update-incoming-inventory.js` (Shopify pre-order metafields). Phase 3 automates populating these tabs from a production order.
- **Production order CSV format** matches existing 2026 Google Sheet structure (product header + SKU|qty rows + subtotals). Supplier name used as alias (e.g. "Kali" = contact name, company = JINJIANG JIHE IMPORT AND EXPORT).
- **3 MCP tools in Phase 1:** `run_inventory_projection`, `get_at_risk_skus`, `create_production_order`.

## June 2026 Update — Phases 4-6 build (worktree `wt/merchandising-pipeline`, NOT yet deployed)
Full technical handoff (commits, schema, data, scripts, open items) lives in `.claude/plans/https-docs-google-com-spreadsheets-d-1km-delegated-snail.md` (top "⚡ CURRENT STATE / HANDOFF" section). Highlights:
- **Schema v2 applied** (`customer-service/schema/merchandising_v2.sql`): suppliers extended (type, address, bank/beneficiary, `payment_terms` JSONB, `contacts`); new `tech_packs`, `tech_pack_specs` (temporal), `qc_inspections/measurements/issues`, `production_payments`, `inbound_shipments`(+items); `production_orders.production_code`, `production_order_items.qty_produced`.
- **Order loop live** (`draft_production_order` → edit tab → `submit_production_order`): writes/reads the real "2026 Production Numbers" sheet (`1kMZ-…`, SA = Editor), mints `production_code`, records order+items+payments from supplier terms, emits supplier `.xlsx`. Record-only.
- **Vendor registry enriched** (7 vendors + Joyce=qc_inspector, Harry/CLH=freight). Bank details captured by **downloading Gmail PI attachments** via `gmailClient.downloadAttachment` (script `scripts/_ingestGmailInvoice.js` — promote to an `ingest_invoice` MCP tool; basis for `qty_produced`/payment capture). Kali has 2 accounts (production ICBC / samples JPMorgan). Entity mismatches flagged (Queenas→Venca Intimea, Harry→SG International).
- **Grading digitized:** 18 tech packs / 1,677 `tech_pack_specs` (first-stab, typos fixed, tolerances defaulted; refine before first shipment). `check_grading_consistency` flags step anomalies — but velocity/cover logic is invalid on new items.
- **4 years of order history backfilled** (2023-2026, 35 orders) into `production_orders`/items (`status='received'`) — powers cadence/floor analysis + future suggested-vs-actual accuracy tracking. Importer: `scripts/_backfillOrders.js` (handles old col-offset format).

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
