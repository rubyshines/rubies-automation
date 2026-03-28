---
name: Shipping tracking subsystem plan
description: Plan for shipping/tracking lookup subsystem — scrape carrier pages, AI summarize, handle unfulfilled orders, sync zones from Shopify. Plan approved 2026-03-27.
type: project
done_when: shipping_lookup MCP tool exists and handles real tracking queries. Check if customer-service/lib/tracking/scraper.js exists.
---

## Approved Plan

Full plan at: `.claude/plans/virtual-herding-thompson.md`

**Carriers:** USPS (~80% US), OnTrac (~20% US), Passport (all international including Canada)
**Zones:** DDP (AU/NZ/UK/EU — duties pre-paid), DDU (rest of world), Canada, US
**Passport timeline:** All international via Passport since Aug 2025. Pre-May 2025 customs complaints are legacy.

## Key Architecture Decisions
- Scrape tracking pages (USPS, OnTrac, Passport) — Passport has no API, just tracking URLs
- Sonnet (not Haiku) for summarization — needs to reason about problems and draft responses
- Cache in Supabase `tracking_snapshots` — re-scrape every 2h active, 24h delivered
- Sync shipping zones + rates from Shopify DeliveryProfile API → `shipping_zones` table
- Unfulfilled order investigation: pre-order detection, inventory sync checks, draft ACTION responses
- All problem cases escalate to human with drafted response

## Implementation Order
1. Schema (tracking_snapshots + shipping_zones tables)
2. Scraper (per-carrier)
3. Analyzer (Sonnet — summarize + draft actions)
4. MCP tool (shipping_lookup)
5. CS Advisor wiring (replace stub)
6. Fulfillment checker (unfulfilled investigation)
7. Zone sync from Shopify
8. Interactive testing
