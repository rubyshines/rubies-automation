---
name: Production Pipeline
description: End-to-end manufacturing workflow — inventory projections, production orders, pre-orders, QC, Warehance receiving
type: project
domains: [product_design, inventory, logistics]
last_updated: 2026-06-08
---

## Goal
Connect the various scripts and processes into one cohesive production pipeline: inventory projections → production orders → pre-order setup → QC spreadsheets → Warehance receiving.

## Phases
1. Inventory projection engine + supplier registry — **design complete, ready to build** (plan: `.claude/plans/merchandising-projection-engine.md`)
2. Production order generation — design complete (part of Phase 1 plan above)
3. Pre-order setup — automate populating `us-YYYY-MM-DD` tabs in pre-order spreadsheet from a confirmed production order
4. QC spreadsheet generation for third-party inspector
5. Warehance receiving upload + received vs ordered reconciliation
6. Graded spec collection — started (shared with product design initiatives)

## Current Status
Phase 1+2 design locked June 2026. Existing `rubies-utilities` projection script identified as the baseline; new version rebuilds against Supabase, adds OOS-adjusted velocity, supplier registry, and `get_at_risk_skus` query tool. Phases 3-6 not yet started.

## Decisions Made
- **Supabase as canonical store for projection output.** Results written to `inventory_projections` table (upsert by SKU per run). Google Sheets output is optional view only.
- **4 Supabase tables:** `suppliers`, `inventory_projections`, `production_orders`, `production_order_items`. Schema in plan file.
- **Supplier registry keyed by SKU prefix.** Kali (JINJIANG JIHE) = catch-all for AJ/BB/UNW/CKY/FLO/RUBY/HLA/SHS/SKY2/SPB/RHW/GAF; Queenas = AVA; JustMax = SWS; Wumes = MPAD. Tees excluded.
- **OOS adjustment uses `available_quantity <= 0` in snapshots** (committed = effectively sold for planning purposes). Pre-order flag fallback for periods before snapshots started (~March 2026).
- **Pre-order spreadsheet (`1m2efAIbrV_...`) and incoming-inventory spreadsheet are the same document.** `us-YYYY-MM-DD` tabs serve both the planning script (incoming units) and `update-incoming-inventory.js` (Shopify pre-order metafields). Phase 3 automates populating these tabs from a production order.
- **Production order CSV format** matches existing 2026 Google Sheet structure (product header + SKU|qty rows + subtotals). Supplier name used as alias (e.g. "Kali" = contact name, company = JINJIANG JIHE IMPORT AND EXPORT).
- **3 MCP tools in Phase 1:** `run_inventory_projection`, `get_at_risk_skus`, `create_production_order`.
