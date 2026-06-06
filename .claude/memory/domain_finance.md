---
name: Finance
description: QBO integration, financial reporting, corporate structure, cost tracking
type: project
originSessionId: 76845f16-8454-4953-8882-a8bc486354fb
---
## What's Built

**QuickBooks Online MCP Server (10 tools):** Financial summary, margin analysis, cash flow analysis, financial health dashboard (letter grades on 5 KPIs), expense breakdown, trend analysis, budget vs actual, tax estimate, account detail, runway projection. All tools default to cached Supabase snapshots; can live-fetch via `--live` parameter.

**QBO Sync Pipeline:** OAuth 2.0 with auto-refresh (5-min buffer before expiry). Incremental transaction sync via LastUpdatedTime high-water mark. Daily sync: chart of accounts (full refresh) + transactions (incremental) + report snapshots (P&L, Balance Sheet, Cash Flow — current + prior month + YTD + quarterly).

**Reporting:** PDF margin reports with raw + adjusted views (multi-year comparison, one-time exclusions, industry benchmarks). Weekly cash-position digest email summarizing cash position and runway.

**Cost Tracking:** Nitro/Warehance fulfillment cost sync. Passport customs invoice imports. Both joined per-order via tracking + Warehance shipment IDs.

**Landed Margin Pipeline:** Loading a Passport invoice file via `importPassportInvoices.js` auto-runs: (1) idempotent Excel import, (2) Shopify-order resolver (3-stage cascade — see Key Decisions), (3) `customer_shipping_usd` refresh into OFC from `orders.total_shipping`, (4) landed-margin sanity report covering closed/partial/baseline months with country-level buckets, refund-aware net revenue, time-of-order COGS, outliers, and coverage stats. Append-only snapshots persist to `landed_margin_snapshots` (and `landed_margin_current` view) for trend analysis.

**Backfill:** 176 report snapshots + 4,062 transactions (Mar 2022 — Mar 2026).

## Current Status

- **Production:** Daily finance sync runs as part of daily-sync-all.js pipeline. OAuth tokens persisted in Supabase (singleton pattern). Report snapshots populated every sync. Passport→Shopify resolver hits 99.4% (1511/1520) coverage. Margin snapshots written every Passport import.
- **Partial:** Nitro fulfillment costs need related-party data cleanup. `syncCosts.js` (supplier COGS pull from Google Sheet) hangs intermittently from VPN connections — fall back to direct insert if needed.

## Key Files

- `finance/server.js` — Finance MCP server entry point.
- `finance/sync/` — QBO sync pipeline (OAuth, transactions, report snapshots).
- `finance/lib/` — Financial analysis functions.
- `finance/generate-margin-report.js` — PDF margin report generation.
- `finance/importPassportInvoices.js` — Passport Excel ingest + post-import pipeline orchestrator.
- `finance/resolvePassportShopifyOrders.js` — 3-stage Passport → Shopify order# resolver (idempotent).
- `finance/syncCustomerShippingFees.js` — Backfills `customer_shipping_usd` on OFC from `orders.total_shipping`.
- `finance/lib/landedMarginReport.js` — Landed margin report + snapshot writer.

## Key Decisions

- **C-Corp (CCPC):** Estate freeze completed Feb 2025. Family trust. Logan Katz as accountants.
- **Report-first architecture:** Primary analysis uses QBO's pre-calculated reports (P&L, CF, BS) rather than custom aggregation from raw transactions.
- **QBO pending transactions caveat:** QBO API only returns posted transactions. Always caveat that pending Wise items may be missing.
- **Fulfillment costs are monthly batches, not a daily sync.** `order_fulfillment_costs` is updated when the 3PL invoice arrives — typically once a month. A "stale" high-water mark on this table just means the next bill hasn't arrived yet, not that anything is broken. **If a margin analysis is blocked by stale fulfillment costs, prompt Jamie to update them before falling back to historical zone averages** (e.g. "latest fulfillment cost row is from <date> — has the next 3PL invoice come in?").
- **Passport rows resolve to Shopify order# via 3-stage cascade**: tracking match (84%) → `#NNNN` parse (12%) → Warehance `/orders/{warehance_order_id}` API (4%). Cached in `passport_invoices.shopify_order_number`; idempotent resolver only re-runs unresolved rows. The Warehance API path was added because Nitro began passing `WH-{warehance_order_id}-{hash}` instead of Shopify order# in Feb 2026 (see logistics domain).
- **`passport_invoices` unique key uses `NULLS NOT DISTINCT`** on `(invoice_number, order_id, tracking_id)` so placeholder trackings (Passport uses `393581000000000000`-style fillers when no real tracking exists) and missing order_ids dedupe correctly across re-imports.
- **Append-only margin snapshots.** `landed_margin_snapshots` keyed on `(month, zone, snapshot_date)`. The `landed_margin_current` view returns latest per (month, zone) for dashboards; raw table preserves how partial-month estimates evolved as Passport invoices arrived. Lets us answer "is this month really closed?" by checking whether successive snapshots are still moving.
- **Country-level buckets.** Top intl countries (≥5 shipments in any reported month) get their own bucket; small ones roll into `ddp_other` / `ddu_other`. Threshold computed per-run so new growth markets surface as soon as they hit volume.
- **Time-of-order COGS lookup.** Each line item uses the `product_costs` row with the latest `effective_date <= order.created_at`. Future cost changes don't retroactively shift historical margins. Falls back to earliest known cost if order pre-dates first cost entry. Missing SKU prefixes flagged in report output.
- **Returns are donated, not restocked** → COGS counts the full ordered quantity, not net of `refunded_quantity`. Cancelled-pre-shipment orders (no OFC row) still get $0 COGS via the OFC-presence filter inside the COGS calculator.
- **Revenue is net of refunds.** Report uses `orders.current_total_price` (or `total_price - total_refunded` fallback). Surfaces refund rate per period. Refund rate is currently 2-5%; impact on margin is small but visible.

## What's Next

- Build anomaly alerting (margin compression, unusual expenses)
- Budgeting tools
