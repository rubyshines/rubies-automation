---
name: Marketing & Growth
description: SEO tracking, email campaigns, content/blog, pricing strategy, competitor intel, analytics
type: project
originSessionId: 76845f16-8454-4953-8882-a8bc486354fb
---
## What's Built

**SEO Tracking (daily pipeline):** Google Search Console daily totals plus keyword-level and page-level data, with keywords tagged branded/non-branded via config. GA4 daily organic sessions and top landing pages into `ga4_daily`. Note: `ga4_daily` holds Organic Search sessions only (the tracker filters `sessionDefaultChannelGroup = 'Organic Search'`), so it is NOT full-property traffic. Shopify daily organic revenue, conversion rates, orders by channel, and country-level geography. Gap detection auto-backfills missed days. 7-day summary Google Sheet.

**SEO Analysis Engine:** Baseline/period comparisons, keyword/page movers, threshold-based anomaly detection, and a recommendation engine that reads strategy items from Supabase and flags stale ones.

**Weekly SEO Digest (HTML email):** Executive summary with sentiment, weekly + monthly scorecards, movers, anomalies with severity, strategy roadmap progress.

**Email Tracking (Klaviyo, daily):** Account metrics and per-campaign stats, full campaign history in Supabase. Incremental refresh of recently updated campaigns; historical stats are never overwritten by an empty API response. Gap detection + auto-backfill.

**Klaviyo Subscription Management (MCP tools):** `klaviyo_subscription_status` (email + SMS consent, list membership) and `klaviyo_subscription_update` (subscribe/unsubscribe email/SMS). Available in the ticket operator and ad hoc console.

**Competitor Pricing (monthly):** Puppeteer scrapes competitor brands across product categories, converts to USD at live FX, computes diff vs RUBIES. Results to Supabase + email + Google Sheet.

**Daily Sales Report:** ShopifyQL daily/MTD/YTD revenue, conversion rates, channel breakdown, trending. HTML email.

**Discount Management (MCP):** `manage_discount` tool + `managed_discounts` Supabase registry for volume discounts and sale lifecycle (start/extend/end, optional attached free gift), with audit/reconcile and an active-sales banner in the daily order alerts. Replaced the old discount script + Google Sheet. Expired sales self-close via a daily-sync sweep (`sweepExpiredSales`) that runs the full end-sale cleanup.

**Email Marketing Report & Studio (for the email contractor):** Supabase-backed report generator (`reports/email-report.js`) producing a branded HTML report for any period (Overview / Lists / Campaigns / Flows / Strategy: audience growth, revenue, engagement funnel, flows, campaign heatmap, creative gallery, AI takeaways) plus a `how-it-works.html` explainer. Studio MCP tools (`email_report`, `email_campaign_ideas`, `email_subject_lab`, `email_campaign_draft`, `email_calendar_plan`, `refresh_playbook`, `find_review_quotes`) generate ideas/drafts/calendars grounded in real performance, brand voice, and real review quotes. The **Marketing Playbook** (`marketing_playbook`) is a recency-weighted ground-truths + priorities artifact, refreshed on demand. Daily feeds: `klaviyo_flow_metrics`, `klaviyo_audience_daily`, `shopify_sessions_daily`.

**Review Curation (Judge.me):** Reviews tab in the CS dashboard for the publish/hold decision, backed by MCP tools (`review_queue`, `review_assess`, `review_classify`, `review_publish`, `review_hold`). Each queued review carries an Opus publish/hold/decide recommendation against a rubric derived from moderation history, plus a Haiku audience tag (kids / adults / both / unclear). `judgeme_reviews` stores Judge.me display state alongside the operator's decision and the recommendation.

## Current Status

- **Production:** SEO daily pipeline + weekly digest. Klaviyo email tracking. Competitor pricing monthly. Daily sales report. Discount management. Email marketing report + studio tools + Playbook + audience/sessions feeds. Review curation queue + audience tagging.
- **Partial:** Blog prioritization based on keyword impressions (heuristic, not ML). Anomaly thresholds hardcoded in config (not adaptive).

## Key Files

- `seo-tracking/daily-seo-tracking.js` — daily SEO pipeline (GSC, GA4, Shopify).
- `seo-tracking/weekly-seo-digest.js` — weekly HTML digest.
- `klaviyo-tracking/daily-email-tracking.js` — Klaviyo email metrics sync.
- `competitor-pricing/monthly-competitor-pricing.js` — competitor price scraping.
- `customer-service/lib/tools/blogResearch.js` — blog/SEO MCP tools.
- `promotions/discounts.js` — discount engine (volume + sales); `customer-service/lib/tools/discounts.js` is the MCP wrapper.
- `reports/email-report.js` — email marketing report generator.
- `customer-service/lib/tools/emailStudio.js` — marketing studio MCP tools.
- `customer-service/lib/playbook.js` — recency-weighted Marketing Playbook.
- `shared/marketingContext.js` — brand voice + campaign-objectives model fed to the studio tools.
- `customer-service/lib/reviewCuration.js` — review curation rubric, audience classifier, Judge.me write path.

## Key Decisions

- **Supabase is the source of truth; Sheets are best-effort.** Pipelines don't fail if a Sheets write fails.
- **Blog writing guidelines:** Community-first plus SEO traffic. Brand voice for tone, real reviews for social proof. Published posts are registered in Supabase to avoid duplicate topics.
- **GA4 structurally undercounts Shopify orders; compare like-for-like.** Non-web sources (Shop App, POS, draft orders, partner APIs) can't fire web pixels, and ITP/ad blockers eat a further baseline; the gap is tracking attrition, not a pixel bug. When comparing GA4 to Shopify, exclude non-web `sourceName` orders.
- **GA4 `itemId` is the Merchant Center offer ID** (`shopify_<COUNTRY>_<PRODUCT_ID>_<VARIANT_ID>`), so item-level GA4 data joins to the Shopify catalog by parsing the ID, no fuzzy name matching.
- **Competitor pricing compares base-currency prices, not customer-facing geo prices.** Both sides pull each store's base currency (bypassing Shopify Markets geo-pricing) and convert to USD; change detection runs on local-currency prices so FX wobble doesn't fire phantom changes. This measures intrinsic merchant pricing.
- **Discounts never stack, by design.** Managed discounts are product- or collection-level, so Shopify applies only the single best discount per item, while combinesWith stays all-true so the Smile loyalty reward and the free-gift twin coexist. Machine-generated Smile/Klaviyo/comp codes are deliberately outside the registry; audit reconciles automatic discounts only.
- **`manage_discount audit` can transiently flag a just-created discount as missing** because Shopify's automatic-discount list is eventually consistent. Re-run a few seconds later; not a bug.
- **Email revenue attribution is last-touch (Klaviyo's model), no double-counting.** Campaigns + flows + other sum to store revenue exactly. But attributed is not incremental: last-touch credits email for any recent open/click, so the email share is an upper bound. True lift needs a holdout test.
- **The email report is a pure consumer of Supabase feeds** populated by `daily-sync-all`; the only live call is the optional creative gallery. Store revenue comes from the Shopify `orders` table and total sessions from ShopifyQL, because `ga4_daily` is organic-only and unsuitable as the traffic denominator.
- **Campaign-objectives model.** Judge each send by its real objective (revenue / R&D / community / list-growth / education), not revenue alone; R&D sends are tied to the product dev cycle. Lives in `shared/marketingContext.js` and feeds the report takeaways and all studio tools.
- **Review curation recommends; it never publishes.** Judge.me records no reason for an unpublished review, and the manual workflow causes accidental skips, so deliberate declines and misses are indistinguishable in the data. The rubric was derived only from trustworthy signal (explicit hides plus low-star passed-over reviews). Any future "auto-publish the safe ones" proposal needs new evidence, not a threshold.
- **Judge.me has no tag or custom-field API, so review audience lives in our Supabase.** The only review write is publish/hide; text is immutable. Consequence: a kids/adults toggle on the storefront needs a custom reviews component in the theme repo reading from us, not Judge.me's widget.
- **Review audience is classified from text first, then the size bought, because text-only under-counts adults** (parents name their kids; adults writing about themselves don't say so). The size join only ever fills an `unclear`, never overwrites the text, and only trusts products whose sizing distinguishes age tiers. Size-derived tags are marked so the pass is reversible. Do not quote a text-only audience ratio.
- **Audience filtering is inclusive: `unclear` shows under both kids and adults.** A review with no audience signal is relevant to either shopper, so hiding it from both is the worse failure. Invariant: no stored audience value may hide a review from both shopper-facing filters.
- **Playbook = deterministic stats + one Opus synthesis, recency-weighted, refreshed on demand.** Separates expensive pattern-learning from cheap per-call use; report takeaways and studio tools both read it. Priorities are split by domain (Audience / Campaigns / Flows).

## What's Next

- Holdout test for true incremental email lift (attributed is not caused; the headline open question)
- Single-file shareable email report (inline the explainer so it's one self-contained HTML)
- Behavioral analysis, conversion funnel tracking, and channel/SEO-to-sales attribution are tracked under the [Traffic & Conversion Intelligence](initiative_traffic_conversion_intelligence.md) initiative (GA4 BigQuery export)
