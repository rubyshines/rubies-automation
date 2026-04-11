---
name: Inventory & Catalog
description: Product sync from Shopify, inventory snapshots, fuzzy search, variant management
type: project
---

## What's Built

**Product Sync Pipeline:** Fetches from Shopify GraphQL — title, handle, status, metafields (sizes, colors, fit_description, materials, bundle associations, labels, discount_percent). ~500 variants across 25 products synced to Supabase `products` + `product_variants` tables. Shopify GIDs as PKs.

**In-Memory Product Cache:** Loads full catalog from Supabase at startup. Reshapes into Shopify-compatible format for fuzzy search. Reload on demand via `reload_products` tool.

**Fuzzy Search:** Three-part scoring — tokenization (splits query into size tokens vs descriptive tokens), fuzzy matching (product title, variant titles, SKU, tags), size filtering (with numeric-to-letter fallback). Example: "Ruby bikini bottom size L in red" → product + size + color matched.

**Inventory Snapshots (daily):** Point-in-time inventory state captured daily. Groups by product_handle, flattens to variant-level rows. Full historical retention enables trend analysis.

**Inventory Velocity Tool:** Compares inventory across N days for a product/SKU. Returns quantity sold and growth rate.

**Price History:** Automatic detection and logging of price changes to `price_history` table.

## Advisor Prompt Candidates

- Currently empty

## Current Status

- **Production:** Full catalog synced daily. Inventory snapshots captured daily (2+ years retention). Fuzzy search working. Price history tracking active.
- **Partial:** Metafields synced but materials_composition and comparison_notes not surfaced in recommendations.
- **Gaps:** No real-time intra-day inventory (daily snapshots only; Shopify webhooks update variants but no streaming view). Some legacy SKU inconsistencies.

## Key Decisions

- **Metafields as typed columns, not JSONB:** Each metafield gets its own typed column (arrays for multi-valued, text for single). Enables direct SQL filtering and type safety. Trade-off: migration step in sync to map Shopify structure → table schema.
- **Supabase is cache, Shopify is source of truth:** Products always fetched fresh from Shopify; Supabase enables fast reads without API rate limits. 1-hour staleness threshold triggers fallback to live Shopify.
- **Products migration from JSON to Supabase:** Recently completed. Some tooling may still reference old product-cache.json — clean up if found.

## What's Next

- Clean up any remaining JSON cache references
- Surface metafield data in product recommendations
- Investigate real-time inventory streaming (beyond daily snapshots)
