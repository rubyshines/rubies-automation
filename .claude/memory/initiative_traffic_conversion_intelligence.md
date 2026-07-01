---
name: Traffic & Conversion Intelligence
description: Use GA4 raw-event data (BigQuery) to understand visitor behavior — funnels, drop-offs, path patterns — and connect behavior to revenue through attribution
type: initiative
domains: [marketing, tech]
last_updated: 2026-06-30
---

## Goal
Turn GA4 traffic data into decisions. Understand how visitors actually move through the site (funnels, drop-offs, path patterns), infer which behaviors correlate with conversion, and connect traffic to revenue through attribution. Built on the GA4 raw-event export to BigQuery, which unlocks session-level analysis the GA4 Data API cannot do (segments, custom funnels, journeys, unsampled/unthresholded data).

## Phases
1. **Enable GA4 BigQuery export** — DONE 2026-06-30. Daily event-level export to dataset `analytics_363593585` in the `rubies-operations` GCP project, forward-only from this date.
2. **BigQuery client + first funnel query** — wire a shared BQ client (singleton pattern); first analysis is the compare-page → PDP → purchase funnel (the question that motivated the export).
3. **Conversion funnel tracking** — site-wide and per-page funnels with drop-off; productionize the recurring ones into the reporting layer.
4. **Behavioral pattern inference** — which paths, entry points, and on-site behaviors correlate with conversion.
5. **Attribution** — tie SEO keywords, email, and channel to actual Shopify sales (two-step: aggregate in BQ, join to Shopify data in our layer).

## Current Status
Phase 1 complete (export enabled 2026-06-30); first daily table lands ~24h later. Phases 2+ pending first export. Absorbs the attribution / funnel-tracking / revenue-by-channel directional items previously in the Marketing domain's What's Next.

## Decisions Made
- **BigQuery is the home for raw GA4 events, not Supabase** (event-level volume + it is already a warehouse). Query BQ directly; sync only small aggregated results into Supabase when a metric feeds a recurring report or dashboard.
- **Daily (complete) export, not Streaming** — completeness over latency; Daily is free tier and our event volume is a tiny fraction of the limit.
- **The GA4 Data API stays for aggregate reporting** (daily traffic, top pages, channels via `shared/ga4Client.js`); it is only bypassed for session-scoped questions it structurally cannot answer.
