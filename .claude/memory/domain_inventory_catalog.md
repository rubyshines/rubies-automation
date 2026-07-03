---
name: Inventory & Catalog
description: Product sync from Shopify, inventory snapshots, fuzzy search, variant management
type: project
originSessionId: 76845f16-8454-4953-8882-a8bc486354fb
---
## What's Built

**Product Sync Pipeline:** Fetches from Shopify GraphQL — title, handle, status, product metafields (sizes, colors, fit_description, materials, bundle associations, labels, discount_percent), and variant-level pre-order metafields (`pre_order_incoming`, `pre_order_date` — from Shopify's `custom.pre_order_incoming_us` / `pre_order_date_us`; the `_us` suffix is historical, single-warehouse era). ~500 variants across 25 products synced to Supabase `products` + `product_variants` tables. Shopify GIDs as PKs.

**Pre-Order Web Sync:** `sync_pre_orders` MCP tool + `scripts/syncPreOrders.js` CLI read the incoming-inventory sheet (us-YYYY-MM-DD tabs, reusing `fetchIncomingOrders`) and push pre-order state to the website per variant: `inventory_policy=continue` plus variant metafields `pre_order_incoming_us` (total upcoming qty) and `pre_order_date_us` (earliest upcoming date). Reconciles against the sheet — clears (policy=deny + deletes the `_us` metafields) any variant whose arrivals have all passed. Scopable to a SKU prefix (e.g. "MPAD"); mirrors writes to `product_variants`. Batched per product via `productVariantsBulkUpdate`. CLI defaults to dry-run, `--send` to apply.

**In-Memory Product Cache:** Loads full catalog from Supabase at startup. Reshapes into Shopify-compatible format for fuzzy search. Reload on demand via `reload_products` tool.

**Fuzzy Search:** Three-part scoring — tokenization (splits query into size tokens vs descriptive tokens), fuzzy matching (product title, variant titles, SKU, tags), size filtering (with numeric-to-letter fallback). Example: "Ruby bikini bottom size L in red" → product + size + color matched.

**Inventory Snapshots (daily):** Point-in-time inventory state captured daily. Groups by product_handle, flattens to variant-level rows. Full historical retention enables trend analysis.

**Inventory Velocity Tool:** Compares inventory across N days for a product/SKU. Returns quantity sold and growth rate.

**Price History:** Automatic detection and logging of price changes to `price_history` table.

**Collections Sync (daily):** All Shopify collections (manual + smart) synced to Supabase `collections` table — handle, title, descriptionHtml, SEO meta, ruleSet (for smart collections), product_handles, productsCount. Runs in the daily product-sync chain.

**SEO Meta Tooling:** `seo_meta_draft` MCP tool reads the synced collection/product row + top GSC keywords for the page URL + the collection's product list, then drafts a title/description following RUBIES house style. `seo_meta_update` writes back to Shopify (collectionUpdate / productUpdate), supports handle renames (Shopify auto-creates a 301 redirect), and mirrors the change to Supabase. Validation: ≤80 char title, ≤165 char desc, no em dashes, lowercase-hyphen handle.

**Product Creation:** `create_product` MCP tool (+ JSON-input CLI) builds a launch-complete DRAFT in one idempotent call (keyed by handle, so it finishes a half-built DRAFT by matching variants on color/size rather than duplicating): title/handle with "THE" stripped, tiered variants + SKUs, the full `custom.*` metafield set (live keys), design-independent `shopify.*` taxonomy copied from an analog product, SEO, description (optionally AI-generated in house style from an analog), collection membership, and the `product_cs_config` row. Two-phase (`commit=false` previews + completeness check, `commit=true` applies + syncs). Never publishes and never sets design-specific taxonomy (bra-style/strap/coverage) or images — those stay in the admin. Supersedes the create-in-Shopify path of `cs-manage-product`.

## Current Status

- **Production:** Full catalog synced daily. Inventory snapshots captured daily since ~March 2026 (2+ year retention policy; ~3 months of data as of June 2026). Fuzzy search working. Price history tracking active.
- **Partial:** Metafields synced but materials_composition and comparison_notes not surfaced in recommendations.

## Key Files

- `customer-service/lib/productCache.js` — In-memory product cache loaded from Supabase.
- `customer-service/lib/tools/productSearch.js` — Fuzzy product search MCP tool.
- `customer-service/lib/tools/inventory.js` — Inventory snapshot and velocity tools.
- `customer-service/lib/tools/seoMeta.js` — `seo_meta_draft` + `seo_meta_update` MCP tools.
- `customer-service/sync/syncCollections.js` — Daily Shopify → Supabase collections sync.
- `inventory-tracking/daily-inventory-tracking.js` — Daily inventory snapshot pipeline.
- `customer-service/lib/merchandising/preOrderSync.js` — Sheet → Shopify pre-order write/reconcile (tool `sync_pre_orders`, CLI `scripts/syncPreOrders.js`).
- `customer-service/lib/tools/createProduct.js` — `create_product` MCP tool + CLI for launch-complete product builds.

## Key Decisions

- **Supabase is cache, Shopify is source of truth:** Supabase enables fast reads without API rate limits. (This is the *catalog* source of truth — titles, variants, metafields.)
- **Supabase catalog cache includes DRAFT products (excludes ARCHIVED).** The sync + product webhook write ACTIVE and DRAFT so a new product being built is visible to internal tools before launch; customer-facing surfaces (`productCache`, inventory projections, daily snapshots) filter `status='ACTIVE'` themselves, so drafts never reach customers or the advisor. Live taxonomy metafield keys are `product_collection` / `product_category` / `product_age` (the older `collections`/`categories`/`age_groups` keys are abandoned) → columns of the same legacy name.
- **Inventory *quantities* trace to Nitro/Warehance, not Shopify.** The 3PL (Nitro = Warehance) is the physical-stock source of truth and syncs levels to Shopify; the daily snapshot then reads Shopify. So `inventory_quantity` (synced Shopify `available`) is a twice-removed, once-daily lagging read, and `available` is committed-aware (a fully-committed in-stock SKU shows 0). To judge whether something is genuinely unfulfillable, check Warehance `backordered > 0`, not the snapshot. See logistics domain for the available-vs-backordered semantics.
- **Metafields as typed columns, not JSONB:** Each metafield gets its own typed column for direct SQL filtering.
- **Use `productCache.renderVariantForCustomer(sku)` for any customer-facing product reference.** Three traps the codebase has hit before, encoded in the helper's docstring + tests so future code doesn't re-derive them: (1) Shopify `selectedOptions` are sometimes named "Option 1" / "Option 2" generically, not "Color" / "Size" — don't rely on option names; the variant `title` field is consistently formatted "Color / Size" or just "Size". (2) Product titles are verbose all-caps ("THE SASSY NO-TUCK SHAPING UNDERWEAR"); the product `handle`'s first non-"the" segment gives the short customer-friendly name (acronyms ≤2 chars stay uppercase, e.g. "AJ"). (3) SKU prefixes are unique across products today (verified Apr 2026 — every prefix maps to one handle, no exact-SKU collisions). Use `getVariantBySku()` for lookup, structured fields for rendering.

- **SEO meta drafts anchor on the page's display title, not the product list.** When `seo_meta_draft` generates a title/description, the collection/product display title defines the category — products are supporting evidence for in-category specifics, never used to broaden scope. A "Tops" collection that contains a bikini top stays a Tops page (not Tops + Swimwear), even when individual products span multiple categories. House style for the SEO meta itself (descriptor patterns, sizing range, audience phrasing, no em dashes) lives in the prompt inside `seoMeta.js`, not duplicated here.

## Key Decisions (continued)

- **Live pre-order source of truth is the variant-level `_us` metafields + `inventory_policy`, NOT the legacy product-level fields.** The storefront reads `custom.pre_order_incoming_us` / `pre_order_date_us` per country via `api.rubyshines.com`; `inventory_policy=continue` is the master switch that keeps an out-of-stock variant buyable and flips the PDP button to "Pre-Order". The 2025-era product-level `custom.pre_order_skus` / `pre_order_date` metafields are abandoned (stale 2025 data still on Shopify) — read/write the variant `_us` pair, never the product-level ones. Pre-order is US-only today, so `sync_pre_orders` writes the `_us` keys directly (hardcoded); add a country param when a second market needs it.

- **Inventory projections output to `inventory_projections` Supabase table.** Queried via `run_inventory_projection` / `get_at_risk_skus` MCP tools (building June 2026 — see `initiative_production_pipeline.md`). OOS-adjusted velocity uses `available_quantity <= 0` in snapshots as the stockout signal. Supplier registry in `suppliers` table; SKU prefix → supplier mapping drives production order generation.

## What's Next

- Real-time inventory streaming (beyond daily snapshots)
- Inventory projection + production order MCP tools (see initiative_production_pipeline.md Phase 1)
