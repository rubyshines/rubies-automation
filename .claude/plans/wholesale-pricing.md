# Wholesale terms + price list (2026-09-09)

**Status:** executing (branch `wt/wholesale-pricing` in both repos)
**Domains:** b2b_sales, tech
**Done when:** a "Wholesale terms + price list" template appears for retailers in the Outreach composer; sending it delivers the inline terms at the retailer's rate and a link to the page for their country; `rubyshines.com/pages/wholesale-pricing` shows the featured styles with no nav entry and a `noindex` tag, and `?country=xx` switches rate and terms.

## What Jamie asked

Another composer template, this one for sending a retailer the wholesale terms and pricing. Terms in both the website link and the email body. A page on rubyshines.com, not in the main nav, showing 50% off. Restricted "to the list".

## Decisions

- **The public "Stock RUBIES in Your Store" page stays as the pitch.** It is already live and in the main nav under Community. Pricing goes on a second page, `/pages/wholesale-pricing`, in no menu, with a `noindex,nofollow` robots meta.
- **No login gate.** The 50% figure is in every pitch email and the sheet is retail halved, which anyone can compute from the shop. Unlisted + noindex is proportionate and costs the retailer zero clicks. If a real lock is ever wanted, it is a per-company token link checked by ops.rubyshines.com, not a Shopify account.
- **One source for two surfaces.** `b2b-outreach/lib/wholesalePriceList.js` builds the rows from the product catalog (Supabase mirror of Shopify) and owns the terms wording. The email template prints the terms; the storefront page fetches `assets/wholesale-pricing.json`, which this repo publishes through the existing theme-asset worktree + auto-merge PR flow (`themeAssetPublish.js`). A PDF attachment was built on day one and removed on day two (Jamie: the link serves); the country-aware page covers every case it did.
- **Prices are live, not published (2026-09-10, "why are the prices hardcoded into the theme").** The theme section emits the catalog from Liquid (`collections.all.products`: handles, titles, images, variant prices in the visitor's market currency, size options) and applies the view's rate on the page. The published JSON carries only what Shopify does not know: featured handles per section in popularity order, views (rate + terms), the local-currency map. A retail price change never touches the theme; the nightly publish refreshes order/terms and is a no-op otherwise. The currency switch is a market switch through Shopify's localization form, so every figure is the store's own conversion with no FX math anywhere.
- **Country-aware page (2026-09-10).** `?country=xx` picks a view: `us` (50%, domestic terms, the default with no parameter), `au` (50%, international terms), everything else (30%, international terms). Views and each band's wholesale figure per rate are precomputed in the JSON; the page only looks up. Prices stay USD; the international view adds "Pay in USD (recommended) or in your local currency at the exchange rate on the day".
- **Sectioning is by title, not tag.** Naomi and Sassy are tagged `swimwear` but are underwear, and Jamie's own July 2026 list files them under Underwear. The title is what the retailer reads.
- **Bands are variants grouped by price**, labelled "Youth 4-11" / "Adult 12-16, XS-4X" / "XS-4X" / "(incl. Tall)", matching the July 2026 list Jamie sent Illusions Lingerie.
- **The email is rate-aware.** Discount = stored `b2b_companies.wholesale_discount_percent` if set, else the country default (US/AU 50, elsewhere 30, the agreement's lookup). The link carries the company's country so the page shows the matching view. A negotiated rate the page has no view for is stated in one sentence next to the link.
- **Excluded from the sheet:** bundles, merch (`pride-merch`, `rubies-merch`), chest pads (`chest-shaping`), gift cards, anything with no sized variant. Adding an exclusion is a constant edit, not a rule change.

## Terms (revised by Jamie 2026-09-10: "way too verbose")

1. X% off retail, priced in USD
2. $300 USD minimum order, no unit minimums
3. Free shipping, no duties

## The sheet (Jamie 2026-09-10)

A curated subset in popularity order, `FEATURED` in `wholesalePriceList.js`: Underwear (AJ, Charlie, Naomi, Sassy), Swimwear (Cheeky, Ruby, Mia, Serena), Bras last (Ava, Brooke, Evey). One entry per product with its youth/adult bands beneath, not one row per band. The page is a line sheet: product photo (Shopify featured image, fetched at publish), linked name, bands with wholesale bold and retail muted; terms at the foot. Site tokens only: Assistant, the Motter Corpus title face in #2000a0 for section names, zero radius, hairline rules.

## Build

**rubies-automations**
- `b2b-outreach/lib/wholesalePriceList.js` — featured list, sections, bands, terms, country views, theme payload.
- `b2b-outreach/lib/messageTemplates.js` — `wholesale_terms` template, `retailerOnly`, country-aware link.
- `customer-service/lib/wholesalePriceListPublish.js` (fetches Shopify featured images at publish) + `customer-service/lib/tools/wholesalePriceList.js` (`wholesale_price_list`, `wholesale_price_list_publish`), registered in `operatorTools.js` and `server.js`; `scripts/publishWholesalePriceList.js` CLI (print by default, `--publish` to land it).
- Tests: `customer-service/test/wholesalePriceList.test.js`.

**rubies-ecom-v4**
- `sections/wholesale-pricing.liquid` — fetches the JSON asset, renders terms + tables.
- `templates/page.wholesale-pricing.json` — page headers + the section.
- `assets/wholesale-pricing.json` — first publish.
- `snippets/meta-tags.liquid` — robots noindex for the `wholesale-pricing` template suffix.
- Shopify page "Wholesale Pricing" created via Admin API with `templateSuffix: wholesale-pricing`, not added to any menu.

## Out of scope / noticed

- `templates/collection.wholesale-collection.json` in the theme is orphaned (its collection no longer exists in Shopify).
- The theme repo's CLAUDE.md says "Patented no-tuck shaping technology"; the automations guardrail says RUBIES holds no patent.
- Re-publishing after a price change is a manual tool call for now; wiring it into `set_product_prices` is a follow-up.
