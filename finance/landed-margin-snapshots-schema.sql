-- ============================================================================
-- Landed margin snapshots — append-only history of monthly margin estimates
-- Run in Supabase SQL Editor
-- ============================================================================

CREATE TABLE IF NOT EXISTS landed_margin_snapshots (
  id BIGSERIAL PRIMARY KEY,
  month DATE NOT NULL,                       -- first day of month
  zone TEXT NOT NULL,                        -- 'us' / 'canada' / 'ddp' / 'ddu' / 'all'
  snapshot_date DATE NOT NULL DEFAULT CURRENT_DATE,
  order_count INT NOT NULL,
  gross_revenue NUMERIC,
  net_revenue NUMERIC,
  refunded NUMERIC,
  freight NUMERIC,
  packing NUMERIC,
  customs NUMERIC,
  cogs NUMERIC,
  landed_cost NUMERIC,
  landed_margin_pct NUMERIC,
  customer_shipping_paid NUMERIC,
  ofc_coverage_pct NUMERIC,                  -- % orders with Nitro bill
  cogs_coverage_pct NUMERIC,                 -- % orders with COGS
  customs_coverage_pct NUMERIC,              -- % intl orders with Passport customs
  notes TEXT,                                -- e.g. "partial month — late invoices may arrive"
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (month, zone, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_lms_month ON landed_margin_snapshots(month);
CREATE INDEX IF NOT EXISTS idx_lms_snap ON landed_margin_snapshots(snapshot_date);

-- Latest snapshot per (month, zone) for "current state" queries
CREATE OR REPLACE VIEW landed_margin_current AS
SELECT DISTINCT ON (month, zone) *
FROM landed_margin_snapshots
ORDER BY month, zone, snapshot_date DESC;
