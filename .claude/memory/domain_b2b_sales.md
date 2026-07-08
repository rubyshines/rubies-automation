---
name: B2B Sales
description: Retailer discovery, web scraping, lead scoring, wholesale orders, B2B outreach, pricing
type: project
originSessionId: 76845f16-8454-4953-8882-a8bc486354fb
---
## What's Built

**Prospect Discovery Pipeline:** Google Maps searches across tier-1/tier-2 cities with targeted search terms (LGBTQ friendly boutique, swimwear shop, etc.). Deduplicates by Google Place ID and website domain.

**Scraping Pipeline:** Puppeteer scrapes homepage + key pages (about, shop, contact) for each prospect with a website. Browser instance recycled every 10 pages for memory management. Rate limiting: 1s between domains, 2s same-domain subpages.

**Contact Finder:** Regex + DOM parsing extracts email, phone, contact form URL. Classifies email type (business/personal) for scoring.

**AI Analysis:** Claude analyzes scraped HTML. Returns structured JSON: subcategory (bra-fitting, online-trans-retail, etc.), trans/gender-affirming mentions, product type, ownership (independent vs chain), presence, brand list, outreach angle.

**Lead Scoring:** Points-based 1-10 scale. Positive: trans mention (+3), LGBTQ/inclusivity (+2), carries gender products (+2), underwear/swimwear (+1), independent (+1), physical store (+1). Negative: chain (-2), no website (-2). Threshold: score >= 5 = qualified.

**Google Sheets Sync:** Exports qualified prospects for sales outreach.

**Wholesale Orders (MCP tool):** Two-phase confirmation like exchanges. Pricing: US/AU 50% off, others 30% off, free shipping, AU auto-splits at $1k AUD. Currency override: hello@sockdrawerheroes.com always USD.

**Store Locator (MCP tools):** `store_locator_*` tools (list/create/update/delete/publish) manage the rubyshines.com/pages/store-locator map. Data lives in `b2b_companies` (9 new `locator_*` columns + `on_store_locator` flag). Publish writes `rubies-ecom-v4/assets/store-locators.json` via worktree + auto-merge, same pattern as donation partners. Haiku auto-extracts store descriptions from the website. 7 retail partners live as of 2026-06-08.

**Outreach Engine (2026-06-11):** the unified B2B outreach system (design SSOT: `.claude/plans/b2b-outreach-system.md`). One spine, three channels (retailers / LGBTQ+ orgs / affiliates): 6-tier signal-based queue, cadence engine (per-message-type due conditions), two Opus advisors (`b2b_sales_advisor`, `b2b_community_advisor`) drafting into `b2b_drafts` with enforced output schema (facts_to_verify + open_commitments fields instead of "don't hallucinate" rules), Gmail reply correlation (inbound → company thread, bounce/departure detection pauses cadence), and a two-phase send tool **hard-gated by the `b2b_send_enabled` system flag (default OFF — go-live is a Jamie-only act)**. Surfaces: operator-console tools (`b2b_queue`, `b2b_draft`, `send_b2b_email`) + dashboard Outreach panel. Tables: `b2b_threads`/`b2b_messages`/`b2b_drafts` + outreach columns on `b2b_companies`. Outbound `b2b_messages` rows are written ONLY by the send tool, never Gmail-synced (draft-checkpoint dedupe rule).

## Current Status

- **Production:** Discovery backlog fully researched (all 3,537 Feb rows triaged + analyzed 2026-06-11 → 41 qualified retailers, 144 community-partner orgs). Wholesale orders working via MCP tools. Outreach engine deployed with sending OFF — drafts only, warm-first migration order (partners → re-routed orgs → cold retailers).
- **Not yet exercised:** Jamie hasn't run the b2b discovery/outreach tooling end-to-end yet — no real-world signal on quality (incl. whether Haiku is adequate for the prospect routing/dismiss decision; revisit the model tier after first real runs).
- **Partial:** Sheet sync exists but unclear if continuous or one-time. Contact-loss auto-re-intro draft flow not yet wired (detection + cadence pause + general_email fallback are live).

## Key Files

- `b2b-outreach/` — outreach engine: cadence, queue, advisors, send tool, sweep.
- `b2b-discovery/discover.js` — Prospect discovery pipeline entry point (+ `prefilter.js`, `researchSurvivors.js`).
- `customer-service/lib/tools/b2bOutreach.js` — console/MCP outreach tools.
- `customer-service/lib/tools/wholesaleOrder.js` — Wholesale order MCP tool.
- `customer-service/lib/tools/storeLocator.js` — Store locator MCP tools.

## Key Decisions

- **Never manually parse CSV data** — always pass raw CSV to `parse_wholesale_input` tool.
- **Order creation tool selection:** `create_wholesale_order` requires an existing Shopify customer ID — use it for established wholesale accounts. For one-off bulk or community orders where the customer may not be in the system yet, use `create_order` with `discount_percent: 50` — it finds or creates the customer automatically from email + name + address.
- **Two-tier discovery:** Google Maps for breadth, then deep research for depth.
- **Domain dedup:** Merge sources if domain already exists, don't duplicate.
- **Shipping speed driven by Shopify shipping method title.** All order-creation tools (`create_order`, `create_exchange_order`, `create_invoice_order`, `create_wholesale_order`) take `shipping_speed: 'standard' | 'expedited'`. The Shopify shipping line title is set via `getShippingMethodTitle(country, speed)` (in `orderUtils.js`) at price `$0.00` — Warehance auto-maps the title to the correct carrier (US Standard / US Expedited / Passport DDP / Passport DDU / Fedex). No FedEx tags. Wholesale defaults: standard for US, expedited for non-US (preserves the prior "non-US wholesale = FedEx" rule). Post-creation `update_shipping_speed` is fully programmatic: US standard ↔ US Expedited; non-US standard maps zone → Passport DDP (Canada / DDP) or Passport DDU (DDU / unknown); non-US expedited → Fedex. Incoterms is implicit in the Passport method name and handled automatically by Warehance for Fedex orders.

- **`pre_increase_pricing` flag on `create_wholesale_order`:** When set, per-line prices use `price_history.previous_price` from the Apr 16 2026 rollout row × country discount, instead of current retail. SKUs without an Apr 16 row fall back to current retail silently. No draft-level `appliedDiscount` when flag is on — discount is baked into per-line prices. When all partners have transitioned to current pricing, remove the flag (park a cleanup entry at that time).

## What's Next

- Outreach tracking (contacted status, response tracking)
- Sales results feedback loop to improve scoring
- Tier 3 custom searches
