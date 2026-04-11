---
name: Logistics & Fulfillment
description: 3PL warehouse, multi-carrier tracking, order alerts, delivery estimates, shipping zones
type: project
---

## What's Built

**Multi-Carrier Tracking:** USPS (~80% US), OnTrac (~20% US), Passport (100% international post-Aug 2025). Three-stage flow: scrape tracking page → parse (deterministic for Passport, AI fallback for others) → analyze (status classification, problem detection, delay calculation).

**Warehance 3PL Integration:** Fetches unfulfilled/in-progress orders with hold reasons (address, fraud, payment, warehouse, allocation, store). Can release address holds (auto-correctable) and set warehouse holds. Shipping method updates and order cancellation.

**Unfulfilled Order Detection:** Orders classified into severity buckets — urgent (>7 biz days, unknown reason), attention (pre-order, out of stock, long holds), normal (address hold, recent), auto_resolved (address hold corrected).

**Pre-Order Detection:** Checks order tags (regex), line item custom attributes (_cs_bundle_id for known backorder bundles: 27324, 27097, 37526), and Shopify fulfillment status.

**Daily Order Alerts (email):** Unified report combining unfulfilled orders + shipping delays. Always sends (even quiet days). Color-coded HTML by severity. CLI operators can note, resolve, or file carrier claims.

**Delivery Time Estimation:** Cascading lookup — province/state (if 30+ orders) → country → sub-zone → shipping zone → static policy. Metrics: p50 median, p75 customer-facing, p90 overdue threshold. 90-day rolling window.

**Shipping Zones:** Country → zone mapping (us, canada, ddp, ddu). DDP countries (AU/NZ/UK/EU) = duties pre-paid via Passport. DDU = rest of world, duties at door. Rates synced from Shopify DeliveryProfile API.

**Passport Carrier Handling:** Scrapes two tracking URLs. Extracts local carrier (Royal Mail, Australia Post, DHL, etc.) and local tracking number. Flags customs holds vs cleared state.

## Advisor Prompt Candidates

- Currently empty

## Current Status

- **Production:** Daily unfulfilled order alerts. Shipping delay detection. Address hold auto-resolution. Multi-carrier tracking scraping. Delivery time estimation. Shipping info tool (pre-purchase). Passport claims tracking.
- **Partial:** Tracking snapshots structure live but cache logic under development (2h active, 24h delivered). USPS Web Tools API registered but needs USPS_USER_ID env var. Shipping zone sync from Shopify ready but currently manual table seeding. Fulfillment checker stub exists, needs full wiring.
- **Gaps:** No real-time Warehance webhooks (daily alerts miss mid-day issues). No USPS/OnTrac refund claim tracking (only Passport). No customs duty estimation for DDU orders. No auto-filing of Passport loss claims.

## Key Decisions

- **Delivery estimates from order date, not fulfillment date.** Report shipping times from when customer placed the order, not from when warehouse fulfilled it. Customers experience the full wait.
- **Deterministic Passport parser first, AI fallback second.** Passport pages have stable structure — regex extraction is zero cost. Sonnet only if parse fails. Saves ~$0.02/package.
- **90-day rolling delivery stats, not all-time.** Seasonality matters (holiday delays). Recent patterns are more relevant.
- **Province-level US granularity.** Warehouse in Portland OR, so West Coast 2-3 days, Northeast 4-5 days. State-level bucketing needed for accuracy.
- **Pre-order detection via custom attributes, not just fulfillment status.** UNFULFILLED could be hold, stock, or pre-order. Custom attributes disambiguate.
- **Passport since Aug 2025 for all international.** Pre-May 2025 customs complaints are legacy issues, not current.

## What's Next

- Wire up USPS Web Tools API (registered, needs env var)
- Automate Passport loss claim filing at 30+ days
- Real-time Warehance webhook integration
- Shipping zone sync from Shopify (replace manual seeding)
