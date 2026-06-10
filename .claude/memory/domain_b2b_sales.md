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

## Current Status

- **Production:** Tier 1 & 2 discovery complete. AI analysis and scoring automated. Wholesale orders working via MCP tools.
- **Partial:** Sheet sync exists but unclear if continuous or one-time.

## Key Files

- `b2b-discovery/discover.js` — Prospect discovery pipeline entry point.
- `b2b-discovery/lib/` — Scraping, contact finding, AI analysis, lead scoring.
- `customer-service/lib/tools/wholesaleOrder.js` — Wholesale order MCP tool.
- `customer-service/lib/tools/storeLocator.js` — Store locator MCP tools.
- `customer-service/lib/storeLocatorPublish.js` — Publish helper (worktree + auto-merge).

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
