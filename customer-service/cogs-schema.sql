-- COGS & Margin Tracking Schema
-- Run this in the Supabase SQL Editor

-- Product costs (COGS) with temporal tracking
CREATE TABLE IF NOT EXISTS product_costs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sku_prefix text NOT NULL,
  product_name text NOT NULL,
  unit_cost decimal(10,2) NOT NULL DEFAULT 0,
  freight decimal(10,2) NOT NULL DEFAULT 0,
  duties_rate decimal(5,4) NOT NULL DEFAULT 0,
  duties_amount decimal(10,2) NOT NULL DEFAULT 0,
  total_landed_cost decimal(10,2) NOT NULL DEFAULT 0,
  effective_date date NOT NULL DEFAULT CURRENT_DATE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sku_prefix, effective_date)
);

CREATE INDEX IF NOT EXISTS idx_product_costs_sku ON product_costs (sku_prefix);
CREATE INDEX IF NOT EXISTS idx_product_costs_date ON product_costs (effective_date DESC);

-- Retail price change log
CREATE TABLE IF NOT EXISTS price_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  variant_id text NOT NULL,
  sku text,
  product_title text,
  variant_title text,
  price decimal(10,2) NOT NULL,
  previous_price decimal(10,2),
  changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_price_history_variant ON price_history (variant_id);
CREATE INDEX IF NOT EXISTS idx_price_history_sku ON price_history (sku);
CREATE INDEX IF NOT EXISTS idx_price_history_date ON price_history (changed_at DESC);

-- RPC: get latest cost per SKU prefix
CREATE OR REPLACE FUNCTION get_current_costs()
RETURNS TABLE (
  sku_prefix text,
  product_name text,
  unit_cost decimal,
  freight decimal,
  duties_rate decimal,
  duties_amount decimal,
  total_landed_cost decimal,
  effective_date date
) AS $$
  SELECT DISTINCT ON (sku_prefix)
    sku_prefix,
    product_name,
    unit_cost,
    freight,
    duties_rate,
    duties_amount,
    total_landed_cost,
    effective_date
  FROM product_costs
  ORDER BY sku_prefix, effective_date DESC;
$$ LANGUAGE sql STABLE;
