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

**Landed Margin Pipeline:** Loading a Passport invoice file via `importPassportInvoices.js` auto-runs: (0) a blocking invoice audit (see Key Decisions), (1) idempotent Excel import, (2) Shopify-order resolver (3-stage cascade — see Key Decisions), (3) `customer_shipping_usd` refresh into OFC from `orders.total_shipping`, (4) landed-margin sanity report covering closed/partial/baseline months with country-level buckets, refund-aware net revenue, time-of-order COGS, outliers, and coverage stats. Append-only snapshots persist to `landed_margin_snapshots` (and `landed_margin_current` view) for trend analysis.

**Backfill:** 176 report snapshots + 4,062 transactions (Mar 2022 — Mar 2026).

**Expense Receipt Capture:** photograph a receipt on a phone and one vision call extracts merchant, date, subtotal, per-tax-line breakdown, tip, total, currency, payment method and line items, categorized against the live QBO chart of accounts. Images live in the private `receipts` Storage bucket, served as short-lived signed URLs. Six MCP tools on the finance server; `/receipts` page on the CS ops dashboard (capture, ledger, per-receipt review with in-place correction). Tables `expense_receipts` + `expense_receipt_items`.

**IRAP Status Reporting:** `irap_status_report` MCP tool (thin wrapper; CLI `finance/generate-irap-status-report.js <month>`) builds the NRC-IRAP monthly status report from the month's actual git history across the RUBIES repos (Opus synthesis, PDF output; `.html` out path for Google-Docs-pastable). Every report archives to `finance/irap-reports/<YYYY-MM>.json`; prior months feed the next synthesis for narrative continuity and the claim number auto-derives from the archive. Local-machine only (needs repo checkouts + writes to ~/Downloads). Project constants + CA objectives appendix + starting-point baseline live in `finance/config/irap-project.json`.

## Current Status

- **Production:** Daily finance sync runs as part of daily-sync-all.js pipeline. OAuth tokens persisted in Supabase (singleton pattern). Report snapshots populated every sync. Passport→Shopify resolver hits 99.4% (1511/1520) coverage. Margin snapshots written every Passport import.
- **Partial:** Nitro fulfillment costs need related-party data cleanup. `syncCosts.js` (supplier COGS pull from Google Sheet) hangs intermittently from VPN connections — fall back to direct insert if needed.
- **Manual:** the Passport customs import is the one cost pipeline with no scheduler — Nitro emails a master `.xlsx` and someone runs `importPassportInvoices.js` by hand. Staleness is guarded by a decision-queue item once the newest `invoice_date` passes three weeks (`finance/lib/passportImportFreshness.js`); until that fires, an un-imported window silently reads as $0 customs and flatters international landed margin.

## Key Files

- `finance/server.js` — Finance MCP server entry point.
- `finance/sync/` — QBO sync pipeline (OAuth, transactions, report snapshots).
- `finance/lib/` — Financial analysis functions.
- `finance/generate-margin-report.js` — PDF margin report generation.
- `finance/importPassportInvoices.js` — Passport Excel ingest + post-import pipeline orchestrator (audits first; `--force` / `--skip-audit`).
- `finance/lib/passportInvoiceAudit.js` — the three deterministic invoice checks; settled invoices listed in `finance/config/passport-audit-acknowledged.json`.
- `finance/resolvePassportShopifyOrders.js` — 3-stage Passport → Shopify order# resolver (idempotent).
- `finance/syncCustomerShippingFees.js` — Backfills `customer_shipping_usd` on OFC from `orders.total_shipping`.
- `finance/lib/landedMarginReport.js` — Landed margin report + snapshot writer.
- `finance/generate-irap-status-report.js` — NRC-IRAP monthly status report from repo history.
- `finance/lib/receiptCapture.js` — Receipt capture pipeline (hash, upload, extract, reconcile, CRUD).
- `finance/lib/tools/receipts.js` — The six receipt MCP tools.
- `finance/receipts-schema.sql` — `expense_receipts` + `expense_receipt_items`.

## Key Decisions

- **C-Corp (CCPC):** Estate freeze completed Feb 2025. Family trust. Logan Katz as accountants.
- **Captured receipts categorize straight to the live QBO chart of accounts, and the model is given no figures to compute (2026-08-19).** The model picks from `qbo_accounts` (active expenses) rather than a private taxonomy, so a captured receipt is bookkeeping-ready and a future push-to-QBO is a mapping we already hold. Three things are deliberately code, not prompt, because they are arithmetic or a lookup: the sha256 of the image bytes is the idempotency key and is checked **before** the upload and the model call, so a retry or a double-tapped shutter costs nothing rather than merely avoiding a duplicate row (the claim-before-the-spend rule); the arithmetic is reconciled after extraction and buys **triage, not approval** — nothing auto-confirms, but a receipt whose sums hold is the one you need not open, and a check whose inputs are missing is SKIPPED rather than failed, or a receipt with no printed subtotal wears a permanent red flag nobody reads; and soft duplicates (same merchant, date and total from a different photo) are flagged, never merged. What the reconciliation cannot see is a line item that was never read at all, so **line-item recall is the metric any model comparison must use** — total accuracy looks clean while lines go missing.
- **Report-first architecture:** Primary analysis uses QBO's pre-calculated reports (P&L, CF, BS) rather than custom aggregation from raw transactions.
- **QBO pending transactions caveat:** QBO API only returns posted transactions. Always caveat that pending Wise items may be missing.
- **Fulfillment costs are monthly batches, not a daily sync.** `order_fulfillment_costs` is updated when the 3PL invoice arrives — typically once a month. A "stale" high-water mark on this table just means the next bill hasn't arrived yet, not that anything is broken. **If a margin analysis is blocked by stale fulfillment costs, prompt Jamie to update them before falling back to historical zone averages** (e.g. "latest fulfillment cost row is from <date> — has the next 3PL invoice come in?").
- **Passport rows resolve to Shopify order# via 3-stage cascade**: tracking match (84%) → `#NNNN` parse (12%) → Warehance `/orders/{warehance_order_id}` API (4%). Cached in `passport_invoices.shopify_order_number`; idempotent resolver only re-runs unresolved rows. The Warehance API path was added because Nitro began passing `WH-{warehance_order_id}-{hash}` instead of Shopify order# in Feb 2026 (see logistics domain).
- **The Passport import audits before it writes, and blocks on a finding.** A billing error absorbed into `passport_invoices` is effectively invisible afterwards, because landed-margin aggregates bury it in variance — three June 2026 invoices carried inflated customs totals for a month before anyone noticed, and Nitro credited $1,008.50. So the checks run at the only point they are cheap: import time, before the upsert. `--force` imports anyway, `--skip-audit` skips the checks. Only deterministic checks earn a place — a statistical per-shipment-cost check was built and removed for producing 11 false positives while catching none of the 4 real errors, because destination mix moves cost far more than a billing error does, and a report the operator learns to ignore is worse than no report. What this cannot check is whether tax and duty are themselves right: both derive from a declared customs value the master file does not carry.
- **`passport_invoices` unique key uses `NULLS NOT DISTINCT`** on `(invoice_number, order_id, tracking_id)` so placeholder trackings (Passport uses `393581000000000000`-style fillers when no real tracking exists) and missing order_ids dedupe correctly across re-imports.
- **Append-only margin snapshots.** `landed_margin_snapshots` keyed on `(month, zone, snapshot_date)`. The `landed_margin_current` view returns latest per (month, zone) for dashboards; raw table preserves how partial-month estimates evolved as Passport invoices arrived. Lets us answer "is this month really closed?" by checking whether successive snapshots are still moving.
- **Country-level buckets.** Top intl countries (≥5 shipments in any reported month) get their own bucket; small ones roll into `ddp_other` / `ddu_other`. Threshold computed per-run so new growth markets surface as soon as they hit volume.
- **Time-of-order COGS lookup.** Each line item uses the `product_costs` row with the latest `effective_date <= order.created_at`. Future cost changes don't retroactively shift historical margins. Falls back to earliest known cost if order pre-dates first cost entry. Missing SKU prefixes flagged in report output.
- **Returns are donated, not restocked** → COGS counts the full ordered quantity, not net of `refunded_quantity`. Cancelled-pre-shipment orders (no OFC row) still get $0 COGS via the OFC-presence filter inside the COGS calculator.
- **Revenue is net of refunds.** Report uses `orders.current_total_price` (or `total_price - total_refunded` fallback). Surfaces refund rate per period. Refund rate is currently 2-5%; impact on margin is small but visible.

## What's Next

- Build anomaly alerting (margin compression, unusual expenses)
- Budgeting tools
