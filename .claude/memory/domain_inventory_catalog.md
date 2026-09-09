---
name: Inventory & Catalog
description: Product sync from Shopify, inventory snapshots, fuzzy search, variant management
type: project
originSessionId: 76845f16-8454-4953-8882-a8bc486354fb
---
## What's Built

**Product Sync Pipeline:** Fetches products from Shopify GraphQL (title, handle, status, product metafields, variant-level pre-order metafields) into Supabase `products` + `product_variants`. Shopify GIDs as PKs.

**Pre-Order Web Sync:** `sync_pre_orders` MCP tool + `scripts/syncPreOrders.js` CLI read the incoming-inventory sheet and reconcile pre-order state on live variants: refresh incoming qty / earliest date on variants already on pre-order, clear variants whose arrivals have all passed. Turning pre-order ON or force-OFF is an explicit operator step (`enable` / `disable` prefixes). Scopable to a SKU prefix; mirrors writes to `product_variants`; CLI defaults to dry-run.

**In-Memory Product Cache:** Loads the catalog from Supabase at startup, reshaped into Shopify-compatible form for fuzzy search. Reload on demand via `reload_products`.

**Fuzzy Search:** Tokenizes the query into size vs descriptive tokens, fuzzy-matches product/variant titles, SKU, and tags, then filters by size (numeric-to-letter fallback).

**Inventory Snapshots (daily):** Point-in-time inventory captured daily at variant level, retained historically for trend analysis.

**Inventory Velocity Tool:** Compares inventory across N days for a product/SKU; returns quantity sold and growth rate.

**Inventory Projections:** `run_inventory_projection` / `get_at_risk_skus` MCP tools write to the `inventory_projections` table. Supplier registry in `suppliers`; SKU prefix → supplier mapping drives production order generation (see `initiative_production_pipeline.md`).

**Price History:** Automatic detection and logging of price changes to `price_history`.

**Collections Sync (daily):** All Shopify collections (manual + smart) synced to Supabase `collections` in the daily product-sync chain.

**SEO Meta Tooling:** `seo_meta_draft` reads the synced collection/product row plus top GSC keywords and drafts title/description in house style; `seo_meta_update` writes back to Shopify (supports handle renames with auto-301) and mirrors to Supabase.

**Product Creation:** `create_product` MCP tool (+ JSON-input CLI) builds a launch-complete DRAFT product in one idempotent call keyed by handle: variants + SKUs, the full `custom.*` metafield set, design-independent taxonomy copied from an analog product, SEO, description, collection membership, and the `product_cs_config` row. Two-phase (preview + completeness check, then commit + sync). Never publishes and never sets design-specific taxonomy or images; those stay in the admin.

## Current Status

- **Production:** Catalog synced daily. Inventory snapshots captured daily. Fuzzy search, price history, collections sync, pre-order web sync, SEO meta tooling, and product creation all running.
- **Partial:** `materials_composition` is synced but not surfaced to the advisor (fit_description and comparison_notes are).

## Key Files

- `customer-service/lib/productCache.js` — in-memory product cache from Supabase.
- `customer-service/lib/tools/productSearch.js` — fuzzy product search MCP tool.
- `customer-service/lib/tools/inventory.js` — inventory snapshot and velocity tools.
- `customer-service/lib/tools/seoMeta.js` — `seo_meta_draft` + `seo_meta_update`.
- `customer-service/sync/syncCollections.js` — daily Shopify → Supabase collections sync.
- `inventory-tracking/daily-inventory-tracking.js` — daily inventory snapshot pipeline.
- `customer-service/lib/merchandising/preOrderSync.js` — sheet → Shopify pre-order sync (tool `sync_pre_orders`, CLI `scripts/syncPreOrders.js`).
- `customer-service/lib/tools/createProduct.js` — `create_product` MCP tool + CLI.

## Key Decisions

- **Supabase is cache, Shopify is source of truth for the catalog** (titles, variants, metafields). Supabase enables fast reads without API rate limits.
- **The catalog cache includes DRAFT products (excludes ARCHIVED)** so a product being built is visible to internal tools before launch; customer-facing surfaces (`productCache`, projections, snapshots) filter `status='ACTIVE'` themselves so drafts never reach customers or the advisor. Live taxonomy metafields are `product_collection` / `product_category` / `product_age`; the older keys are abandoned.
- **Inventory quantities trace to Nitro/Warehance, not Shopify.** The 3PL holds physical stock and syncs levels to Shopify; the daily snapshot reads Shopify, so `inventory_quantity` is a lagging, committed-aware read (a fully-committed in-stock SKU shows 0). To judge genuine unfulfillability, check Warehance `backordered > 0`. See the logistics domain.
- **SKU size codes are `XL/2XL/3XL/4XL`, never `1X/2X/3X/4X`.** Legacy convention consistent across every product; `1X/2X/3X` is display-only. Shopify variants must be created with XL-form SKUs because every merchandising tool validates against the catalog, so a wrong-form catalog silently propagates. Supplier codes map to XL-form via `skuCanonical`.
- **`product_cs_config.status` mirrors the Shopify product status automatically, no manual flip at launch.** The advisor only sees `active` config rows and `create_product` seeds `draft`, so the reconcile runs from the daily sync, the products webhook, and `reload_products`; launching activates the advisor config and archiving deactivates it.
- **Metafields as typed columns, not JSONB,** so each can be filtered directly in SQL.
- **Use `productCache.renderVariantForCustomer(sku)` for any customer-facing product reference.** Shopify option names and product titles are inconsistent (generic option names, verbose all-caps titles); the helper encodes the known traps in its docstring and tests so callers don't re-derive them. Use `getVariantBySku()` for lookup.
- **SEO meta drafts anchor on the page's display title, not the product list.** Products are supporting evidence for in-category specifics, never used to broaden a page's scope. House style for the meta lives in the prompt in `seoMeta.js`.
- **Live pre-order source of truth is the variant-level `_us` metafields plus `inventory_policy`, not the legacy product-level fields.** `inventory_policy=continue` is the master switch that keeps an out-of-stock variant buyable and flips the PDP to "Pre-Order"; the product-level pre-order metafields are abandoned. Pre-order is US-only today, so the `_us` keys are written directly; add a country param when a second market needs it.
- **Pre-order enablement is decoupled from the incoming-inventory sheet.** Recording a production order's incoming inventory never puts products on pre-order by itself; turning it on (or pausing it despite upcoming arrivals) is an explicit operator action.

## What's Next

- Real-time inventory streaming (beyond daily snapshots)
