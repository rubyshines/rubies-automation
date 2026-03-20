---
name: Products Migration — JSON Cache to Supabase
description: Plan to move product catalog from local JSON file cache to Supabase tables, including metafields for sizing logic
type: project
---

## Why
- Everything else is in Supabase (orders, customers, conversations, inventory, reviews)
- Product data in a JSON file is inconsistent with the rest of the system
- Other Supabase tables reference products by text strings (variant_id, product_title, sku) but can't join
- Metafields (product_category, product_collection, product_age, sizing info) need to be queryable for the AI sizing logic
- Only 24 active products — no performance concern

## Plan
1. **Schema**: Create `products` and `product_variants` tables in Supabase
   - products: id (Shopify GID), title, handle, tags, product_type, description, metafields (category, collection, age, kid_sizes, adult_sizes, etc.)
   - product_variants: id (Shopify GID), product_id FK, title, sku, price, inventory_quantity, size, color, selected_options
2. **Sync**: Add product sync to `daily-sync-all.js` (or just the existing `reload_products` flow)
   - Fetches from Shopify GraphQL (already includes metafields after our edit)
   - Upserts to Supabase
3. **MCP Cache**: `productCache.js` loads from Supabase instead of JSON file
   - Still keeps in-memory cache for fast search
   - Falls back to Supabase on startup instead of JSON file
4. **Search tool**: `search_products` returns product-level metadata (category, collection, sizes) not just variant info
5. **New tool**: `get_product_catalog` — lists all products with classifications for the AI to understand the full catalog
6. **Cleanup**: Remove `product-cache.json` file dependency

## Status: NOT STARTED — needs Jamie's go-ahead to implement
