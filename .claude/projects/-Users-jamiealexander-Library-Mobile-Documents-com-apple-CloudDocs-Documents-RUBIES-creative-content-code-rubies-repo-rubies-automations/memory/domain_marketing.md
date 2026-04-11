---
name: Marketing & Growth
description: SEO tracking, email campaigns, content/blog, pricing strategy, competitor intel, analytics
type: project
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

**Email Tracking (Klaviyo, daily):** Account metrics (sends, opens, clicks, bounces, unsubscribes, spam complaints). Campaign stats (recipients, conversions, value, AOV) for last 365 days. Gap detection + auto-backfill.

**Competitor Pricing (monthly):** Puppeteer scrapes 6-8 competitor brands across 3-4 product categories. Live exchange rate conversion to USD. Price diff vs RUBIES calculated. Results to Supabase + email + Google Sheet.

**Daily Sales Report:** ShopifyQL for daily/MTD/YTD revenue, conversion rates, channel breakdown. 7-day + 365-day trending. HTML email.

## Advisor Prompt Candidates

- Currently empty

## Current Status

- **Production:** SEO daily pipeline + weekly digest. Klaviyo email tracking. Competitor pricing monthly. Sales reports daily.
- **Partial:** Blog prioritization based on keyword impressions (heuristic, not ML). Anomaly thresholds hardcoded in config (not adaptive). Strategy roadmap items manually updated in Supabase.
- **Gaps:** No conversion funnel tracking. No attribution between SEO and sales (GSC/Shopify separate). Email tracking missing flow-level granularity.

## Key Decisions

- **Baseline date concept:** Fixed reference date (2026-02-18) in config for normalized sentiment scoring across periods.
- **Anomaly-first recommendations:** Only generated if anomalies detected AND strategy items exist. Reduces noise.
- **Best-effort Sheet updates:** Pipeline doesn't fail if Sheets write fails; Supabase is source of truth.
- **Blog writing guidelines:** Community-first + SEO traffic. Use data to pick topics, brand voice for tone, real reviews for social proof. Register published posts in Supabase to avoid duplication.
- **Pricing strategy 2026:** Full analysis + PDF at finance/RUBIES-Pricing-Strategy-2026.pdf. Price increases, bundles, DDP, wholesale, projected $1.1-1.3M CAD.

## What's Next

- SEO/content strategy execution
- Pricing and bundles revamp
- Attribution: connect SEO keywords to actual sales
