-- Merchandising: Projection Engine + Production Orders
-- Run in Supabase SQL Editor. Seed suppliers table after creation.

-- Supplier registry
CREATE TABLE IF NOT EXISTS suppliers (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  company_name TEXT,
  contact_name TEXT,
  email TEXT,
  sku_prefixes TEXT[] NOT NULL DEFAULT '{}',
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Latest projection results (upsert on each run, one row per SKU)
CREATE TABLE IF NOT EXISTS inventory_projections (
  id SERIAL PRIMARY KEY,
  run_date DATE NOT NULL,
  sku TEXT NOT NULL,
  product_handle TEXT,
  product_name TEXT,
  color TEXT,
  size TEXT,
  age_range TEXT,
  current_inventory INTEGER,
  total_incoming INTEGER DEFAULT 0,
  total_inventory INTEGER,
  units_sold_year INTEGER,
  sales_per_week NUMERIC(8,2),
  weeks_until_no_stock NUMERIC(8,1),
  priority TEXT,
  qty_to_order INTEGER,
  weeks_unavailable INTEGER DEFAULT 0,
  oos_periods TEXT,
  first_sale_date DATE,
  growth_factor NUMERIC(4,2) DEFAULT 1.3,
  target_weeks INTEGER DEFAULT 78,
  supplier_id INTEGER REFERENCES suppliers(id),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(sku)
);

-- Production orders (lifecycle tracking)
CREATE TABLE IF NOT EXISTS production_orders (
  id SERIAL PRIMARY KEY,
  supplier_id INTEGER REFERENCES suppliers(id) NOT NULL,
  status TEXT NOT NULL DEFAULT 'placed'
    CHECK (status IN ('placed','in_production','qc_inspection','shipped','received','reconciled')),
  placed_date DATE NOT NULL DEFAULT CURRENT_DATE,
  expected_ship_date DATE,
  expected_delivery_date DATE,
  actual_ship_date DATE,
  actual_delivery_date DATE,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Per-SKU items within a production order
CREATE TABLE IF NOT EXISTS production_order_items (
  id SERIAL PRIMARY KEY,
  production_order_id INTEGER REFERENCES production_orders(id) ON DELETE CASCADE NOT NULL,
  sku TEXT NOT NULL,
  qty_ordered INTEGER NOT NULL,
  qty_received INTEGER,
  notes TEXT,
  UNIQUE(production_order_id, sku)
);

-- Seed: supplier registry
-- Run after CREATE TABLE above.
INSERT INTO suppliers (name, company_name, contact_name, email, sku_prefixes) VALUES
  ('Kali',               'JINJIANG JIHE IMPORT AND EXPORT', 'Kali Lin',    'kali.lin@qq.com',            ARRAY['AJ','BB','UNW','CKY','FLO','RUBY','HLA','SHS','SKY2','SPB','GAF','PAD3','EAR','FLAG','PIN','MIA','TNK']),
  ('Queenas',            'Queenas',                         'Fandy',       'biz2@queenas.com',            ARRAY['SB']),
  ('JustMax',            'JustMax',                         'Maggie Chen', 'maggiechen@justmax.cn',       ARRAY['SWS']),
  ('Wumes',              'Wumes',                           'Maggie',      'sales03@wumes.com',           ARRAY['MPAD']),
  ('Pigeons and Thread', 'Pigeons and Thread',              'Cat',         'pigeonsandthread@gmail.com',  ARRAY['RHW'])
ON CONFLICT DO NOTHING;
