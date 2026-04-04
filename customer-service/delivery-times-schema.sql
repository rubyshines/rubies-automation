-- ============================================================================
-- RUBIES Delivery Times — Transit time tracking + aggregation
-- Run in Supabase SQL Editor
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Shipping regions — static mapping from state/province to region
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS shipping_regions (
  country_code TEXT NOT NULL,
  province_code TEXT NOT NULL,         -- '*' for countries without province breakdown
  region TEXT NOT NULL,                -- 'west_coast', 'midwest', 'south', 'northeast', 'mountain', etc.
  region_label TEXT NOT NULL,          -- 'West Coast', 'Midwest', etc.
  PRIMARY KEY (country_code, province_code)
);

-- ---------------------------------------------------------------------------
-- Order delivery times — per-order raw transit data (Nitro orders only)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS order_delivery_times (
  order_number INTEGER PRIMARY KEY,

  -- Destination
  country_code TEXT,
  province_code TEXT,
  region TEXT,                          -- looked up from shipping_regions
  shipping_zone TEXT,                   -- 'us', 'canada', 'ddp', 'ddu'

  -- Provider
  fulfillment_provider TEXT,            -- 'nitro' (only Nitro orders stored)

  -- Core timestamps
  fulfilled_at TIMESTAMPTZ NOT NULL,
  delivered_at TIMESTAMPTZ NOT NULL,    -- from Shopify fulfillment.deliveredAt

  -- Computed transit time
  transit_days INTEGER NOT NULL,        -- calendar days: delivered_at - fulfilled_at
  transit_business_days INTEGER,        -- weekdays only

  -- Passport legs (nullable — only when tracking_snapshots has data)
  passport_received_at TIMESTAMPTZ,     -- when Passport first scans the package
  leg1_days INTEGER,                    -- fulfilled_at -> passport_received_at
  leg2_days INTEGER,                    -- passport_received_at -> delivered_at
  local_carrier TEXT,                   -- Royal Mail, Australia Post, DHL, etc.
  carrier TEXT,                         -- usps, ontrac, passport

  -- Metadata
  computed_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_odt_zone ON order_delivery_times(shipping_zone);
CREATE INDEX IF NOT EXISTS idx_odt_region ON order_delivery_times(region);
CREATE INDEX IF NOT EXISTS idx_odt_country ON order_delivery_times(country_code);
CREATE INDEX IF NOT EXISTS idx_odt_delivered ON order_delivery_times(delivered_at);

-- ---------------------------------------------------------------------------
-- RPC: get_delivery_time_stats — on-the-fly percentile aggregation
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_delivery_time_stats(
  p_country_code TEXT DEFAULT NULL,
  p_region TEXT DEFAULT NULL,
  p_shipping_zone TEXT DEFAULT NULL,
  p_since DATE DEFAULT NULL
)
RETURNS TABLE (
  country_code TEXT,
  region TEXT,
  region_label TEXT,
  shipping_zone TEXT,
  order_count INTEGER,
  median_days NUMERIC,
  p75_days NUMERIC,
  p90_days NUMERIC,
  min_days INTEGER,
  max_days INTEGER,
  avg_days NUMERIC
)
LANGUAGE sql STABLE
AS $$
  SELECT
    odt.country_code,
    odt.region,
    COALESCE(sr.region_label, odt.region) AS region_label,
    odt.shipping_zone,
    COUNT(*)::INTEGER AS order_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY odt.transit_days)::NUMERIC, 1) AS median_days,
    ROUND(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY odt.transit_days)::NUMERIC, 1) AS p75_days,
    ROUND(PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY odt.transit_days)::NUMERIC, 1) AS p90_days,
    MIN(odt.transit_days) AS min_days,
    MAX(odt.transit_days) AS max_days,
    ROUND(AVG(odt.transit_days), 1) AS avg_days
  FROM order_delivery_times odt
  LEFT JOIN shipping_regions sr
    ON sr.country_code = odt.country_code
    AND sr.province_code = COALESCE(odt.province_code, '*')
  WHERE (p_country_code IS NULL OR odt.country_code = p_country_code)
    AND (p_region IS NULL OR odt.region = p_region)
    AND (p_shipping_zone IS NULL OR odt.shipping_zone = p_shipping_zone)
    AND (p_since IS NULL OR odt.delivered_at >= p_since)
  GROUP BY odt.country_code, odt.region, sr.region_label, odt.shipping_zone;
$$;

-- ---------------------------------------------------------------------------
-- Shipping delay notes — operator annotations + resolved/ignore status
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS shipping_delay_notes (
  id SERIAL PRIMARY KEY,
  order_number INTEGER NOT NULL,
  note TEXT NOT NULL,
  resolved BOOLEAN DEFAULT FALSE,
  author TEXT DEFAULT 'operator',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sdn_order ON shipping_delay_notes(order_number);
CREATE INDEX IF NOT EXISTS idx_sdn_created ON shipping_delay_notes(created_at DESC);

-- Helper: get latest note per order
CREATE OR REPLACE FUNCTION get_latest_shipping_notes(order_numbers INTEGER[])
RETURNS TABLE (
  order_number INTEGER,
  note TEXT,
  resolved BOOLEAN,
  author TEXT,
  created_at TIMESTAMPTZ
) AS $$
  SELECT DISTINCT ON (n.order_number)
    n.order_number, n.note, n.resolved, n.author, n.created_at
  FROM shipping_delay_notes n
  WHERE n.order_number = ANY(order_numbers)
  ORDER BY n.order_number, n.created_at DESC;
$$ LANGUAGE sql STABLE;

-- ---------------------------------------------------------------------------
-- Passport claims — exception tracking + reimbursement workflow
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS passport_claims (
  id SERIAL PRIMARY KEY,
  order_number INTEGER NOT NULL UNIQUE,
  tracking_number TEXT,
  country_code TEXT,
  destination TEXT,                         -- "Calgary, AB, CA"
  customer_email TEXT,
  shipping_zone TEXT,                       -- ddp, ddu, canada

  -- Claim details
  status TEXT NOT NULL DEFAULT 'open',      -- open | delivered | lost | resolved
  claim_reason TEXT,                        -- likely_lost | exception | returned | customs_hold
  emailed_at TIMESTAMPTZ,                   -- when Passport support was notified
  customer_customs_notified_at TIMESTAMPTZ, -- when customer was emailed about customs hold

  -- Financials (for reimbursement tracking)
  shipping_fee_usd NUMERIC,
  ddp_total_usd NUMERIC,

  -- Resolution
  resolution TEXT,
  resolution_date TIMESTAMPTZ,

  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pc_status ON passport_claims(status);
CREATE INDEX IF NOT EXISTS idx_pc_order ON passport_claims(order_number);

-- ---------------------------------------------------------------------------
-- RPC: get_passport_leg_stats — international intermediary transit times
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_passport_leg_stats(
  p_country_code TEXT DEFAULT NULL,
  p_since DATE DEFAULT NULL
)
RETURNS TABLE (
  country_code TEXT,
  shipping_zone TEXT,
  local_carrier TEXT,
  order_count INTEGER,
  median_leg1 NUMERIC,
  median_leg2 NUMERIC,
  p75_leg1 NUMERIC,
  p75_leg2 NUMERIC
)
LANGUAGE sql STABLE
AS $$
  SELECT
    odt.country_code,
    odt.shipping_zone,
    odt.local_carrier,
    COUNT(*)::INTEGER AS order_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY odt.leg1_days)::NUMERIC, 1) AS median_leg1,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY odt.leg2_days)::NUMERIC, 1) AS median_leg2,
    ROUND(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY odt.leg1_days)::NUMERIC, 1) AS p75_leg1,
    ROUND(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY odt.leg2_days)::NUMERIC, 1) AS p75_leg2
  FROM order_delivery_times odt
  WHERE odt.passport_received_at IS NOT NULL
    AND odt.leg1_days IS NOT NULL
    AND (p_country_code IS NULL OR odt.country_code = p_country_code)
    AND (p_since IS NULL OR odt.delivered_at >= p_since)
  GROUP BY odt.country_code, odt.shipping_zone, odt.local_carrier;
$$;

-- ============================================================================
-- MIGRATION: Add order-to-door tracking + enhanced delivery estimate RPC
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Add ordered_at + processing_days to order_delivery_times
-- ---------------------------------------------------------------------------
ALTER TABLE order_delivery_times
  ADD COLUMN IF NOT EXISTS ordered_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS processing_days INTEGER;

CREATE INDEX IF NOT EXISTS idx_odt_ordered ON order_delivery_times(ordered_at);

-- Backfill from orders.created_at
UPDATE order_delivery_times odt
SET
  ordered_at = o.created_at,
  processing_days = EXTRACT(DAY FROM (odt.fulfilled_at - o.created_at))::INTEGER
FROM orders o
WHERE o.order_number = odt.order_number
  AND odt.ordered_at IS NULL;

-- ---------------------------------------------------------------------------
-- RPC: get_delivery_estimate_stats — enhanced stats with processing + transit
-- + total order-to-door + passport legs in one call.
-- Accepts single country, country array (sub-zone), or zone.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_delivery_estimate_stats(
  p_country_code TEXT DEFAULT NULL,
  p_country_codes TEXT[] DEFAULT NULL,
  p_shipping_zone TEXT DEFAULT NULL,
  p_since DATE DEFAULT NULL
)
RETURNS TABLE (
  order_count INTEGER,
  -- Processing time (order placed -> fulfillment)
  processing_median NUMERIC,
  processing_p75 NUMERIC,
  processing_p90 NUMERIC,
  -- Transit time (fulfillment -> delivery)
  transit_median NUMERIC,
  transit_p75 NUMERIC,
  transit_p90 NUMERIC,
  -- Total order-to-door
  total_median NUMERIC,
  total_p75 NUMERIC,
  total_p90 NUMERIC,
  -- Passport legs
  leg1_median NUMERIC,
  leg1_p75 NUMERIC,
  leg2_median NUMERIC,
  leg2_p75 NUMERIC,
  passport_count INTEGER
)
LANGUAGE sql STABLE
AS $$
  SELECT
    COUNT(*)::INTEGER AS order_count,
    -- Processing (only rows with ordered_at)
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY odt.processing_days)
      FILTER (WHERE odt.processing_days IS NOT NULL)::NUMERIC, 1) AS processing_median,
    ROUND(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY odt.processing_days)
      FILTER (WHERE odt.processing_days IS NOT NULL)::NUMERIC, 1) AS processing_p75,
    ROUND(PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY odt.processing_days)
      FILTER (WHERE odt.processing_days IS NOT NULL)::NUMERIC, 1) AS processing_p90,
    -- Transit
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY odt.transit_days)::NUMERIC, 1) AS transit_median,
    ROUND(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY odt.transit_days)::NUMERIC, 1) AS transit_p75,
    ROUND(PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY odt.transit_days)::NUMERIC, 1) AS transit_p90,
    -- Total order-to-door (processing + transit, only where ordered_at exists)
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY odt.processing_days + odt.transit_days)
      FILTER (WHERE odt.processing_days IS NOT NULL)::NUMERIC, 1) AS total_median,
    ROUND(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY odt.processing_days + odt.transit_days)
      FILTER (WHERE odt.processing_days IS NOT NULL)::NUMERIC, 1) AS total_p75,
    ROUND(PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY odt.processing_days + odt.transit_days)
      FILTER (WHERE odt.processing_days IS NOT NULL)::NUMERIC, 1) AS total_p90,
    -- Passport legs
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY odt.leg1_days)
      FILTER (WHERE odt.leg1_days IS NOT NULL)::NUMERIC, 1) AS leg1_median,
    ROUND(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY odt.leg1_days)
      FILTER (WHERE odt.leg1_days IS NOT NULL)::NUMERIC, 1) AS leg1_p75,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY odt.leg2_days)
      FILTER (WHERE odt.leg2_days IS NOT NULL)::NUMERIC, 1) AS leg2_median,
    ROUND(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY odt.leg2_days)
      FILTER (WHERE odt.leg2_days IS NOT NULL)::NUMERIC, 1) AS leg2_p75,
    COUNT(*) FILTER (WHERE odt.leg1_days IS NOT NULL)::INTEGER AS passport_count
  FROM order_delivery_times odt
  WHERE (p_country_code IS NULL OR odt.country_code = p_country_code)
    AND (p_country_codes IS NULL OR odt.country_code = ANY(p_country_codes))
    AND (p_shipping_zone IS NULL OR odt.shipping_zone = p_shipping_zone)
    AND (p_since IS NULL OR odt.delivered_at >= p_since);
$$;
