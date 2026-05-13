-- RUBIES Product Catalog — Supabase Schema
-- Run once in the Supabase SQL Editor.
-- Products + variants synced from Shopify, with metafields as typed columns.

-- ─── Products ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS products (
  shopify_product_id  text PRIMARY KEY,          -- Shopify GID
  title               text NOT NULL,
  handle              text NOT NULL,
  status              text NOT NULL DEFAULT 'ACTIVE',
  product_type        text,
  vendor              text,
  description_html    text,
  tags                text[] DEFAULT '{}',

  -- Metafields (custom namespace)
  collections         text[] DEFAULT '{}',
  categories          text[] DEFAULT '{}',
  age_groups          text[] DEFAULT '{}',
  kid_sizes           text[] DEFAULT '{}',
  adult_sizes         text[] DEFAULT '{}',
  kid_colors          text[] DEFAULT '{}',
  adult_colors        text[] DEFAULT '{}',

  -- Bundle fields
  bundle_product_1    text,
  bundle_product_2    text,
  labels              text[] DEFAULT '{}',
  discount_percent    numeric,

  -- Comparison / product metadata
  fit_description         text,
  best_for                text,
  comparison_notes        text,
  materials_composition   text,

  -- SEO meta (from Shopify Online Store SEO panel)
  seo_title           text,                          -- null = default-from-title
  seo_description     text,                          -- null = default-from-description excerpt

  synced_at           timestamptz NOT NULL DEFAULT now()
);

-- ─── Product Variants ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS product_variants (
  shopify_variant_id  text PRIMARY KEY,          -- Shopify GID
  shopify_product_id  text NOT NULL REFERENCES products(shopify_product_id) ON DELETE CASCADE,
  shopify_inventory_item_id text,                -- Shopify InventoryItem GID (for webhook inventory updates)
  title               text NOT NULL,
  sku                 text,
  price               numeric NOT NULL DEFAULT 0,
  inventory_quantity  integer NOT NULL DEFAULT 0,
  selected_options    jsonb DEFAULT '[]',

  -- Pre-order metafields (custom.pre_order_incoming_us / pre_order_date_us on Shopify)
  pre_order_incoming  integer,
  pre_order_date      date,

  synced_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_product_variants_product
  ON product_variants(shopify_product_id);

CREATE INDEX IF NOT EXISTS idx_product_variants_sku
  ON product_variants(sku);

CREATE INDEX IF NOT EXISTS idx_product_variants_inventory_item
  ON product_variants(shopify_inventory_item_id);

-- ─── RPC: get_product_catalog ────────────────────────────────────────────────
-- Returns all products with aggregate variant stats.
-- Optional filters: p_collection, p_category, p_age_group

CREATE OR REPLACE FUNCTION get_product_catalog(
  p_collection text DEFAULT NULL,
  p_category   text DEFAULT NULL,
  p_age_group  text DEFAULT NULL
)
RETURNS TABLE (
  shopify_product_id  text,
  title               text,
  handle              text,
  status              text,
  product_type        text,
  tags                text[],
  collections         text[],
  categories          text[],
  age_groups          text[],
  kid_sizes           text[],
  adult_sizes         text[],
  kid_colors          text[],
  adult_colors        text[],
  fit_description     text,
  best_for            text,
  comparison_notes    text,
  materials_composition text,
  seo_title           text,
  seo_description     text,
  variant_count       bigint,
  total_inventory     bigint,
  min_price           numeric,
  max_price           numeric,
  synced_at           timestamptz
) LANGUAGE sql STABLE AS $$
  SELECT
    p.shopify_product_id,
    p.title,
    p.handle,
    p.status,
    p.product_type,
    p.tags,
    p.collections,
    p.categories,
    p.age_groups,
    p.kid_sizes,
    p.adult_sizes,
    p.kid_colors,
    p.adult_colors,
    p.fit_description,
    p.best_for,
    p.comparison_notes,
    p.materials_composition,
    p.seo_title,
    p.seo_description,
    COUNT(v.shopify_variant_id)     AS variant_count,
    COALESCE(SUM(v.inventory_quantity), 0) AS total_inventory,
    MIN(v.price)                    AS min_price,
    MAX(v.price)                    AS max_price,
    p.synced_at
  FROM products p
  LEFT JOIN product_variants v ON v.shopify_product_id = p.shopify_product_id
  WHERE
    (p_collection IS NULL OR p_collection = ANY(p.collections))
    AND (p_category IS NULL OR p_category = ANY(p.categories))
    AND (p_age_group IS NULL OR p_age_group = ANY(p.age_groups))
  GROUP BY p.shopify_product_id
  ORDER BY p.title;
$$;
