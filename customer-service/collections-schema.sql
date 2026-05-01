-- RUBIES Collections — Supabase Schema
-- Run once in the Supabase SQL Editor.
-- Collections synced from Shopify (manual + smart) with SEO meta and rule sets.

CREATE TABLE IF NOT EXISTS collections (
  shopify_collection_id text PRIMARY KEY,            -- Shopify GID
  handle              text NOT NULL UNIQUE,
  title               text NOT NULL,
  description_html    text,

  -- SEO meta (from Shopify Online Store SEO panel)
  seo_title           text,                          -- null = default-from-title
  seo_description     text,                          -- null = default-from-description excerpt

  -- Rule set (smart collections only)
  is_smart            boolean NOT NULL DEFAULT false,
  rule_set            jsonb,                         -- full ruleSet object, null for manual collections

  -- Membership snapshot
  product_handles     text[] DEFAULT '{}',
  products_count      integer NOT NULL DEFAULT 0,

  synced_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_collections_handle ON collections(handle);
CREATE INDEX IF NOT EXISTS idx_collections_is_smart ON collections(is_smart);

-- Migration helper for existing products table (run once if products already exists):
-- ALTER TABLE products ADD COLUMN IF NOT EXISTS seo_title text;
-- ALTER TABLE products ADD COLUMN IF NOT EXISTS seo_description text;
-- After running, re-run the get_product_catalog function definition from products-schema.sql
-- so the RPC return signature includes the new columns.
