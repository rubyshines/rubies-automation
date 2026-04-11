---
name: Wholesale
description: Retailer discovery, web scraping, lead scoring, wholesale orders, pricing
type: project
---

## What's Built

**Prospect Discovery Pipeline:** Google Maps searches across tier-1/tier-2 cities with targeted search terms (LGBTQ friendly boutique, swimwear shop, etc.). Deduplicates by Google Place ID and website domain.

**Scraping Pipeline:** Puppeteer scrapes homepage + key pages (about, shop, contact) for each prospect with a website. Browser instance recycled every 10 pages for memory management. Rate limiting: 1s between domains, 2s same-domain subpages.

**Contact Finder:** Regex + DOM parsing extracts email, phone, contact form URL. Classifies email type (business/personal) for scoring.

**AI Analysis:** Claude analyzes scraped HTML. Returns structured JSON: subcategory (bra-fitting, online-trans-retail, etc.), trans/gender-affirming mentions, product type, ownership (independent vs chain), presence, brand list, outreach angle.

**Lead Scoring:** Points-based 1-10 scale. Positive: trans mention (+3), LGBTQ/inclusivity (+2), carries gender products (+2), underwear/swimwear (+1), independent (+1), physical store (+1). Negative: chain (-2), no website (-2). Threshold: score >= 5 = qualified.

**Google Sheets Sync:** Exports qualified prospects for sales outreach.

**Wholesale Orders (MCP tool):** Two-phase confirmation like exchanges. Pricing: US/AU 50% off, others 30% off, free shipping, AU auto-splits at $1k AUD. Currency override: hello@sockdrawerheroes.com always USD.

## Advisor Prompt Candidates

- Currently empty

## Current Status

- **Production:** Tier 1 & 2 discovery complete. AI analysis and scoring automated. Wholesale orders working via MCP tools.
- **Partial:** Sheet sync exists but unclear if continuous or one-time. Tier 3 (custom searches) mentioned but not implemented.
- **Gaps:** No outreach tracking (which prospects contacted, response status). No feedback loop (sales results not fed back to scoring).

## Key Decisions

- **Never manually parse CSV data** — always pass raw CSV to `parse_wholesale_input` tool. Caught off-by-one error on Illusions Lingerie order when manually parsed.
- **Two-tier discovery:** Google Maps for breadth, then deep research for depth. Avoids scraping thousands of irrelevant sites.
- **Pre-filter patterns:** Hotels, bookstores, vintage/thrift, community orgs auto-dismissed before scraping.
- **Domain dedup:** If another prospect already has this domain, merge sources instead of duplicating.
- **Content truncated to 15,000 chars** for AI analysis.

## What's Next

- Build outreach tracking (contacted status, response tracking)
- Sales results feedback loop to improve scoring
- Expand to Tier 3 custom searches
