---
name: Finance
description: QBO integration, financial reporting, corporate structure, cost tracking
type: project
---

## What's Built

**QuickBooks Online MCP Server (10 tools):** Financial summary, margin analysis, cash flow analysis, financial health dashboard (letter grades on 5 KPIs), expense breakdown, trend analysis, budget vs actual, tax estimate, account detail, runway projection. All tools default to cached Supabase snapshots; can live-fetch via `--live` parameter.

**QBO Sync Pipeline:** OAuth 2.0 with auto-refresh (5-min buffer before expiry). Incremental transaction sync via LastUpdatedTime high-water mark. Daily sync: chart of accounts (full refresh) + transactions (incremental) + report snapshots (P&L, Balance Sheet, Cash Flow — current + prior month + YTD + quarterly).

**Reporting:** PDF margin reports with raw + adjusted views (multi-year comparison, one-time exclusions, industry benchmarks). Weekly SendGrid digest summarizing cash position and runway.

**Cost Tracking:** Nitro fulfillment cost sync (separate script). Passport invoice imports. Both partially integrated.

**Backfill:** 176 report snapshots + 4,062 transactions (Mar 2022 — Mar 2026).

## Advisor Prompt Candidates

- Currently empty

## Current Status

- **Production:** Daily finance sync runs as part of daily-sync-all.js pipeline. OAuth tokens persisted in Supabase (singleton pattern). Report snapshots populated every sync.
- **Partial:** Nitro fulfillment costs need related-party data cleanup. Passport invoice imports exist but sparse integration. One-time project exclusions hardcoded in margin report.
- **Gaps:** No budgeting tools. Limited vendor/customer aging analysis. No automated anomaly alerts (flags exist but no email triggers).

## Key Decisions

- **C-Corp (CCPC):** Estate freeze completed Feb 2025. Family trust. Shareholder accounts. Capital extraction mechanics. Logan Katz as accountants.
- **Singleton token pattern:** One active set of QBO tokens per company (stored with id='singleton').
- **Report-first architecture:** Primary analysis uses QBO's pre-calculated reports (P&L, CF, BS) rather than custom aggregation from raw transactions.
- **High-water mark incremental sync:** Transactions synced by MetaData.LastUpdatedTime, handles corrections/voided transactions gracefully.
- **QBO pending transactions caveat:** QBO API only returns posted transactions. Always caveat that pending Wise items may be missing.
- **IRAP 2026 proposal:** NRC-IRAP funding for AI ops automation. May-Dec 2026, ~$135K total (~$70K IRAP). 4 automation goals: CS, sales, finance, SME documentation. Prep docs at ~/Downloads/IRAP-Meeting-Prep.html. Lisa Borneaz (ITA).

## What's Next

- Clean up Nitro fulfillment cost data
- Build anomaly alerting (margin compression, unusual expenses)
- IRAP proposal execution (May 2026 start)
