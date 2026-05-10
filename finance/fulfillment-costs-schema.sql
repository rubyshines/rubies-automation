-- ============================================================================
-- Order Fulfillment Costs — consolidated 3PL + DDP cost tracking per order
-- Run in Supabase SQL Editor
-- ============================================================================

CREATE TABLE IF NOT EXISTS order_fulfillment_costs (
  order_number INTEGER PRIMARY KEY,
  shopify_order_id BIGINT,
  created_at TIMESTAMPTZ,

  -- Provider identification
  fulfillment_provider TEXT NOT NULL,         -- 'think-logistics', 'nitro', 'manual', 'mixed'
  fulfillment_location_id BIGINT,             -- Shopify location_id (definitive provider signal)

  -- 3PL costs (what your warehouse charges)
  packing_fee_usd NUMERIC DEFAULT 0,          -- pick/pack fee
  shipping_fee_usd NUMERIC DEFAULT 0,         -- carrier postage billed by 3PL
  freight_charge_cad NUMERIC DEFAULT 0,       -- original CAD freight (Think Logistics invoices)

  -- DDP costs (from passport_invoices, intl only)
  ddp_tax_usd NUMERIC DEFAULT 0,
  ddp_duty_usd NUMERIC DEFAULT 0,
  ddp_clearance_usd NUMERIC DEFAULT 0,
  ddp_total_usd NUMERIC DEFAULT 0,

  -- COGS for the order (sum of line item costs)
  cogs_unit_cost_usd NUMERIC DEFAULT 0,
  cogs_freight_usd NUMERIC DEFAULT 0,
  cogs_duties_usd NUMERIC DEFAULT 0,
  cogs_total_usd NUMERIC DEFAULT 0,

  -- Computed totals
  total_fulfillment_cost_usd NUMERIC DEFAULT 0,  -- packing + shipping + DDP
  total_landed_cost_usd NUMERIC DEFAULT 0,        -- fulfillment + COGS

  -- What customer paid for shipping
  customer_shipping_usd NUMERIC DEFAULT 0,
  shipping_net_usd NUMERIC DEFAULT 0,             -- customer paid minus fulfillment cost

  -- Shipping destination
  shipping_country_code TEXT,
  shipping_zone TEXT,                              -- 'us', 'canada', 'ddp', 'ddu'

  -- Package weight & dimensions (normalized to oz / inches)
  weight_oz NUMERIC,
  length_in NUMERIC,
  width_in NUMERIC,
  height_in NUMERIC,

  -- Carrier tracking numbers (array — multi-package shipments have >1)
  tracking_numbers TEXT[],

  -- Warehance shipment IDs (array — for joining to passport_invoices.order_id "WH-{shipment_id}-{hash}")
  warehance_shipment_ids TEXT[],

  -- Data provenance
  source TEXT NOT NULL,                            -- 'backfill-local-json', 'nitro-api', 'daily-sync'
  synced_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ofc_provider ON order_fulfillment_costs(fulfillment_provider);
CREATE INDEX IF NOT EXISTS idx_ofc_country ON order_fulfillment_costs(shipping_country_code);
CREATE INDEX IF NOT EXISTS idx_ofc_zone ON order_fulfillment_costs(shipping_zone);
CREATE INDEX IF NOT EXISTS idx_ofc_created ON order_fulfillment_costs(created_at);
CREATE INDEX IF NOT EXISTS idx_ofc_tracking_numbers ON order_fulfillment_costs USING GIN (tracking_numbers);
CREATE INDEX IF NOT EXISTS idx_ofc_warehance_shipment_ids ON order_fulfillment_costs USING GIN (warehance_shipment_ids);

