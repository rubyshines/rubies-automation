-- ============================================================================
-- Passport Shipping Invoices — DDP cost tracking
-- Run in Supabase SQL Editor
-- ============================================================================

CREATE TABLE IF NOT EXISTS passport_invoices (
  id BIGSERIAL PRIMARY KEY,
  invoice_number TEXT NOT NULL,
  invoice_date DATE,
  ship_date DATE NOT NULL,
  order_id TEXT,
  dest_city TEXT,
  dest_state TEXT,
  dest_zip TEXT,
  dest_country TEXT NOT NULL,
  tracking_id TEXT,
  actual_weight_oz NUMERIC,
  dimensional_weight_oz NUMERIC,
  billable_weight_oz NUMERIC,
  length_in NUMERIC,
  width_in NUMERIC,
  height_in NUMERIC,
  tax NUMERIC DEFAULT 0,
  duty NUMERIC DEFAULT 0,
  insurance NUMERIC DEFAULT 0,
  clearance_fee NUMERIC DEFAULT 0,
  total_customs_duties NUMERIC DEFAULT 0,
  -- Resolved Shopify order number (populated by resolvePassportShopifyOrders.js)
  shopify_order_number INTEGER,
  resolution_method TEXT,  -- 'tracking', 'shopify_order_id', 'warehance_api', null = unresolved
  synced_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT passport_invoices_natural_key UNIQUE NULLS NOT DISTINCT (invoice_number, order_id, tracking_id)
);

CREATE INDEX IF NOT EXISTS idx_passport_ship_date ON passport_invoices(ship_date);
CREATE INDEX IF NOT EXISTS idx_passport_country ON passport_invoices(dest_country);
CREATE INDEX IF NOT EXISTS idx_passport_invoice ON passport_invoices(invoice_number);
CREATE INDEX IF NOT EXISTS idx_passport_shopify_order ON passport_invoices(shopify_order_number);

-- Summary view: DDP costs by country by month
CREATE OR REPLACE VIEW passport_monthly_costs AS
SELECT
  dest_country,
  DATE_TRUNC('month', ship_date)::DATE AS month,
  COUNT(*) AS shipments,
  SUM(tax) AS total_tax,
  SUM(duty) AS total_duty,
  SUM(clearance_fee) AS total_clearance,
  SUM(tax + duty + clearance_fee + insurance) AS total_ddp_cost,
  AVG(tax + duty + clearance_fee + insurance) AS avg_ddp_per_shipment,
  AVG(billable_weight_oz) AS avg_weight_oz
FROM passport_invoices
GROUP BY dest_country, DATE_TRUNC('month', ship_date)
ORDER BY month DESC, shipments DESC;

-- Summary view: DDP costs by country (all time)
CREATE OR REPLACE VIEW passport_country_costs AS
SELECT
  dest_country,
  COUNT(*) AS shipments,
  SUM(tax + duty + clearance_fee + insurance) AS total_ddp_cost,
  AVG(tax + duty + clearance_fee + insurance) AS avg_ddp_per_shipment,
  MIN(ship_date) AS first_shipment,
  MAX(ship_date) AS last_shipment
FROM passport_invoices
GROUP BY dest_country
ORDER BY shipments DESC;
