-- CS Product Config: exchange-specific product metadata
-- Shopify owns product data (title, price, variants). This table adds
-- CS-exchange routing fields that Shopify doesn't know about.
--
-- Run this in Supabase SQL Editor, then seed with:
--   node customer-service/import/seedCsConfig.js

CREATE TABLE IF NOT EXISTS product_cs_config (
  id              serial PRIMARY KEY,
  product_handle  text NOT NULL UNIQUE,
  nickname        text NOT NULL,
  category        text NOT NULL,
  keywords        text[] NOT NULL DEFAULT '{}',
  delta_wording   text,
  sizes_override  text[],
  style_switch    jsonb,
  status          text NOT NULL DEFAULT 'draft',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_product_cs_config_status ON product_cs_config(status);

-- RPC: get all active product configs for the decision tree
CREATE OR REPLACE FUNCTION get_cs_product_config()
RETURNS TABLE(
  product_handle text,
  nickname text,
  category text,
  keywords text[],
  delta_wording text,
  sizes_override text[],
  style_switch jsonb,
  status text
) AS $$
  SELECT product_handle, nickname, category, keywords,
         delta_wording, sizes_override, style_switch, status
  FROM product_cs_config
  WHERE status = 'active'
  ORDER BY nickname;
$$ LANGUAGE sql STABLE;
