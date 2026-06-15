---
name: Marketing & Growth
description: SEO tracking, email campaigns, content/blog, pricing strategy, competitor intel, analytics
type: project
originSessionId: 76845f16-8454-4953-8882-a8bc486354fb
---
## What's Built

**SEO Tracking (daily pipeline):**
- Google Search Console: daily clicks, impressions, CTR, position + keyword-level + page-level data. Keywords tagged as branded/non-branded via config.
- GA4: daily organic sessions + top 7 landing pages.
- Shopify: daily organic revenue, conversion rates, orders by channel + country-level geography.
- Gap detection: auto-backfills missed days on next run.
- 7-day summary Google Sheet with GSC, Shopify Search, top 10 keywords, priority pages.

**SEO Analysis Engine:** Baseline/period comparisons, keyword/page movers (gainers/losers), anomaly detection (20% click swing, 20% CTR change, 3-position shift, 15% revenue change). Recommendation engine fetches strategy items from Supabase, flags stale items >21 days.

**Weekly SEO Digest (HTML email):** Executive summary with sentiment (strong/positive/steady/declining). Weekly + monthly scorecards. Keyword/page movers. Anomalies with severity tags. Strategy roadmap progress.

**Email Tracking (Klaviyo, daily):** Account metrics (sends, opens, clicks, bounces, unsubscribes, spam complaints). Campaign stats backfilled to 2021-06-11 (673 campaigns, 644 with stats). Daily sync uses `updatedSince=90 days` for incremental refresh and a two-pass write (metadata always upserted, stats only updated when report returns values) so historical stats never get wiped. Gap detection + auto-backfill.

**Klaviyo Subscription Management (MCP tools):** `klaviyo_subscription_status` looks up a customer's email + SMS consent state and list membership. `klaviyo_subscription_update` subscribes or unsubscribes from email/SMS marketing (auto-picks Newsletter list for subscribe; uses unsubscription job for unsubscribe). Available in both the ticket operator and ad hoc console.

**Competitor Pricing (monthly):** Puppeteer scrapes 6-8 competitor brands across 3-4 product categories. Live exchange rate conversion to USD. Price diff vs RUBIES calculated. Results to Supabase + email + Google Sheet.

**Daily Sales Report:** ShopifyQL for daily/MTD/YTD revenue, conversion rates, channel breakdown. 7-day + 365-day trending. HTML email.

**Discount Management (MCP):** `manage_discount` tool + `managed_discounts` Supabase registry — volume discounts + sales lifecycle (start/extend/end, optional attached free gift), with audit/reconcile and an active-sales banner in the daily order alerts. Replaced the rubies-utilities discount script + Google Sheet.

## Current Status

- **Production:** SEO daily pipeline + weekly digest. Klaviyo email tracking. Competitor pricing monthly. Sales reports daily.
- **Partial:** Blog prioritization based on keyword impressions (heuristic, not ML). Anomaly thresholds hardcoded in config (not adaptive).

## Key Files

- `seo-tracking/daily-seo-tracking.js` — Daily SEO pipeline (GSC, GA4, Shopify).
- `seo-tracking/weekly-seo-digest.js` — Weekly HTML email digest.
- `klaviyo-tracking/daily-email-tracking.js` — Klaviyo email metrics sync.
- `competitor-pricing/monthly-competitor-pricing.js` — Competitor price scraping.
- `customer-service/lib/tools/blogResearch.js` — Blog/SEO MCP tools.
- `promotions/discounts.js` — Discount engine (volume + sales, combination invariants).
- `customer-service/lib/tools/discounts.js` — `manage_discount` MCP tool.

## Key Decisions

- **Best-effort Sheet updates:** Pipeline doesn't fail if Sheets write fails; Supabase is source of truth.
- **Blog writing guidelines:** Community-first + SEO traffic. Brand voice for tone, real reviews for social proof. Register published posts in Supabase to avoid duplication.
- **Klaviyo daily sync uses incremental refresh, not fixed limit.** Originally `limit: 50` capped daily fetches and lost old campaigns as new ones bumped them out. Now: any campaign updated in last 90 days is refreshed; older campaign stats are stable and stay in Supabase. Pattern: metadata-always-upserted + stats-only-updated-when-returned, so missing API responses never wipe rows.
- **GA4 vs Shopify capture rate is ~70% of web orders by design.** Structural undercount: ~13% non-web sources (Shop App / POS / draft orders / partner APIs) can't fire web pixels at all, ~5–10% baseline from iOS Safari ITP and ad blockers. Shop Pay accelerated checkout DOES fire `purchase` with a well-formed payload — the residual gap is downstream cookie/tracking attrition, not a pixel issue. When comparing GA4 to Shopify, exclude non-web `sourceName` orders from the comparator.
- **GA4 `itemId` format:** `shopify_<COUNTRY>_<PRODUCT_ID>_<VARIANT_ID>` (Merchant Center offer ID). Parse with `/^shopify_([A-Z]{2})_(\d+)_(\d+)$/` to join GA4 item-level data to the Shopify catalog. No fuzzy-name matching needed.
- **Competitor pricing comparison uses base-currency, not customer-facing prices.** RUBIES side pulls live adult-tier max-variant from rubyshines.com (USD base). Competitor side pulls each store's base currency via minimal-headers Shopify JSON + `/meta.json` (deliberately bypassing Shopify Markets geo-pricing pads). Both convert to USD via market FX. Change detection compares local-currency prices, not USD, so FX wobble doesn't fire phantom changes. This compares intrinsic merchant pricing, not what an individual customer in any one geo would pay.

- **Discounts never stack — by design.** All managed discounts are product-level (volume) or collection-level (sale), so Shopify applies only the single highest discount per item (volume vs sale resolve to the better one, never the sum). Every managed discount sets combinesWith all-true so the Smile loyalty reward and the free-gift twin coexist alongside. Smile/Klaviyo/comp codes (16k+) are machine-generated and deliberately out of the registry; `manage_discount audit` reconciles automatic discounts only.
- **`manage_discount audit` has a transient false-positive right after create.** Shopify's `automaticDiscountNodes` list query is eventually consistent, so a just-created discount can briefly flag as "MISSING NODES" (the node exists and works — fetch-by-id confirms it — it just hasn't hit the list index yet). Re-running audit a few seconds later clears it. Not a bug; don't chase it.

## What's Next

- Attribution: connect SEO keywords to actual sales
- Conversion funnel tracking
