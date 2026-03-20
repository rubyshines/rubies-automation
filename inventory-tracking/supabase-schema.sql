-- Inventory Snapshots: daily variant-level inventory tracking
-- Run once in Supabase SQL Editor

CREATE TABLE IF NOT EXISTS inventory_snapshots (
  date date NOT NULL,
  variant_id text NOT NULL,
  sku text NOT NULL DEFAULT '',
  product_handle text NOT NULL DEFAULT '',
  inventory_quantity integer NOT NULL DEFAULT 0,
  price decimal NOT NULL DEFAULT 0,
  PRIMARY KEY (date, variant_id)
);

CREATE INDEX IF NOT EXISTS idx_inventory_snapshots_date ON inventory_snapshots (date);
CREATE INDEX IF NOT EXISTS idx_inventory_snapshots_variant_id ON inventory_snapshots (variant_id);
CREATE INDEX IF NOT EXISTS idx_inventory_snapshots_product_handle ON inventory_snapshots (product_handle);
CREATE INDEX IF NOT EXISTS idx_inventory_snapshots_sku ON inventory_snapshots (sku);

ALTER TABLE inventory_snapshots ENABLE ROW LEVEL SECURITY;
