---
name: Finance
description: QBO integration, financial reporting, corporate structure, cost tracking
type: project
originSessionId: 76845f16-8454-4953-8882-a8bc486354fb
---
## What's Built

**QuickBooks Online MCP Server:** financial summary, margin analysis, cash flow analysis, financial health dashboard (letter-graded KPIs), expense breakdown, trend analysis, budget vs actual, tax estimate, account detail, runway projection. Tools default to cached Supabase snapshots and can live-fetch via `--live`.

**QBO Sync Pipeline:** OAuth 2.0 with auto-refresh. Daily sync of the chart of accounts (full refresh), transactions (incremental via a high-water mark), and report snapshots (P&L, Balance Sheet, Cash Flow for current, prior month, YTD, quarterly).

**Reporting:** PDF margin reports with raw + adjusted views (multi-year comparison, one-time exclusions, industry benchmarks). Weekly cash-position digest email.

**Cost Tracking:** Nitro/Warehance fulfillment cost sync and Passport customs invoice imports, both joined per-order via tracking + Warehance shipment IDs.

**Landed Margin Pipeline:** `importPassportInvoices.js` runs a blocking invoice audit, an idempotent Excel import, the Passport-to-Shopify order resolver, a customer-shipping refresh into `order_fulfillment_costs`, and a landed-margin report (country-level buckets, refund-aware net revenue, time-of-order COGS, outliers, coverage). Append-only snapshots persist to `landed_margin_snapshots` with a `landed_margin_current` view.

**Expense Receipt Capture:** photograph a receipt on a phone; one vision call extracts merchant, date, taxes, tip, total, currency, payment method and line items, categorized against the live QBO chart of accounts. Images live in a private Storage bucket served as signed URLs; a long receipt is captured as multiple overlapping photos read as one receipt. Receipt MCP tools on the finance server plus a `/receipts` page on the CS ops dashboard (capture, ledger, per-receipt review and correction). Tables `expense_receipts`, `expense_receipt_items`, `expense_receipt_pages`.

**IRAP Status Reporting:** `irap_status_report` MCP tool (CLI `finance/generate-irap-status-report.js <month>`) builds the NRC-IRAP monthly status report from the month's git history across the RUBIES repos (Opus synthesis, PDF or HTML output). Reports archive to `finance/irap-reports/` and feed the next month's narrative; project constants live in `finance/config/irap-project.json`. Local-machine only.

## Current Status

- **Production:** daily finance sync runs inside the daily-sync-all pipeline; OAuth tokens persisted in Supabase; report snapshots populated every sync; margin snapshots written every Passport import.
- **Partial:** Nitro fulfillment costs need related-party data cleanup. `syncCosts.js` (supplier COGS pull from Google Sheet) hangs intermittently over VPN; fall back to direct insert if needed.
- **Manual:** the Passport customs import has no scheduler; Nitro emails a master `.xlsx` and someone runs `importPassportInvoices.js` by hand. Staleness raises a decision-queue item (`finance/lib/passportImportFreshness.js`); until that fires an un-imported window reads as $0 customs and flatters international landed margin.

## Key Files

- `finance/server.js` — Finance MCP server entry point.
- `finance/sync/` — QBO sync pipeline.
- `finance/generate-margin-report.js` — PDF margin report.
- `finance/importPassportInvoices.js` — Passport ingest + post-import orchestrator (audit first; `--force` / `--skip-audit`).
- `finance/resolvePassportShopifyOrders.js` — Passport to Shopify order resolver.
- `finance/lib/landedMarginReport.js` — landed margin report + snapshot writer.
- `finance/lib/receiptCapture.js` — receipt capture pipeline.
- `finance/generate-irap-status-report.js` — NRC-IRAP monthly status report.

## Key Decisions

- **C-Corp (CCPC) with an estate freeze (Feb 2025) and a family trust** holding a corporate beneficiary, so cash moving corp to trust to beneficiary corp does not need a dividend declared when it moves; the year-end entry settles it. Two firms with distinct roles: **Logan Katz** for tax, estate and trust structuring (they did the freeze and the trust); **AZ Accounting** for the bookkeeping.
- **Capital leaves RUBIES through the balance sheet, so the P&L cannot show it (2026-08):** extraction runs on three routes and only wages touch profit; repayment of a related-party loan (JATA, later the trust payable) and dividends move cash with no P&L impact. Any "where did the money go" question starts from balance-sheet accounts and cash, never the income statement. The JATA loan funded years of extraction and was fully repaid; the trust payable replaced it. Once a pre-existing loan balance is drained, extraction must come from current earnings, so the sustainable figure is normalized earnings minus the working capital growth consumes.
- **The books are written up annually, so in-year QBO data is stale by design (2026-08):** AZ Accounting categorizes once a year; between write-ups only automated Wagepoint payroll entries post, which makes a stale dataset look alive. Do not diagnose this as a broken sync: check the newest non-payroll transaction date before trusting any current-year figure. Everything downstream inherits the staleness (cash digest, financial health, runway, cash flow).
- **QBO "COGS" is supplier payments, not cost of goods sold, and Inventory Asset is a manual year-end plug (2026-08):** a large year-end purchase lands wholly in that year's expense with its revenue in the next, so P&L gross margin is not valid year-over-year. Compute true COGS from units sold times cost (the landed-margin pipeline). Shopify figures are USD and QBO is CAD.
- **Captured receipts categorize straight to the live QBO chart of accounts, and the model is given no figures to compute (2026-08):** picking from `qbo_accounts` makes a receipt bookkeeping-ready and a future push-to-QBO a mapping we already hold. Arithmetic and lookups are code, not prompt: an image-hash idempotency check runs before the upload and the model call (claim before the spend); post-extraction reconciliation buys triage, not approval (nothing auto-confirms; a check with missing inputs is skipped, not failed); soft duplicates are flagged, never merged. Reconciliation cannot see a line item that was never read, so line-item recall is the metric for any model comparison.
- **A derived value must stay distinguishable from a read one, and the identity of a multi-photo capture is the set (2026-08):** currency records its source (printed, tax-label-inferred, country-inferred, or operator) because a guess that looks like a reading corrupts totals with nothing to flag it; conflicting signals file the likelier reading and raise a conflict. Multi-photo identity hashes the sorted page hashes so shot order does not matter and single-page receipts stay idempotent; overlap between shots is the model's to reconcile, and the arithmetic check proves it did.
- **Report-first architecture:** primary analysis uses QBO's pre-calculated reports (P&L, CF, BS) rather than custom aggregation from raw transactions.
- **QBO pending transactions caveat:** the API returns posted transactions only; always caveat that pending Wise items may be missing.
- **Fulfillment costs are monthly batches, not a daily sync:** `order_fulfillment_costs` updates when the 3PL invoice arrives. A stale high-water mark just means the next bill has not arrived. If a margin analysis is blocked by stale fulfillment costs, prompt Jamie to update them before falling back to historical zone averages.
- **The Passport import audits before it writes, and blocks on a finding:** a billing error absorbed into `passport_invoices` is invisible afterwards because aggregates bury it in variance, so checks run at import time, before the upsert. Only deterministic checks earn a place; a statistical per-shipment-cost check was removed for false positives, since destination mix moves cost more than a billing error and a report the operator learns to ignore is worse than none. Tax and duty correctness cannot be checked because the master file lacks the declared customs value.
- **Append-only margin snapshots:** `landed_margin_snapshots` preserves how partial-month estimates evolved as invoices arrived, with `landed_margin_current` giving latest per (month, zone) for dashboards. Lets us answer "is this month really closed?" by whether successive snapshots still move.
- **Time-of-order COGS lookup:** each line item uses the cost effective at order time, so future cost changes do not retroactively shift historical margins.
- **Returns are donated, not restocked,** so COGS counts the full ordered quantity, not net of refunds. Cancelled-pre-shipment orders get $0 COGS.
- **Revenue is net of refunds,** and the report surfaces refund rate per period.

## What's Next

- Build anomaly alerting (margin compression, unusual expenses)
- Budgeting tools
