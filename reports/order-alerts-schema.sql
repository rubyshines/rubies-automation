-- ============================================================================
-- Order Alert Notes — unified operator annotations + resolved status
-- Replaces: unfulfilled_order_notes + shipping_delay_notes
-- Run in Supabase SQL Editor
-- ============================================================================

CREATE TABLE IF NOT EXISTS order_alert_notes (
  id SERIAL PRIMARY KEY,
  order_number INTEGER NOT NULL,
  note TEXT NOT NULL,
  resolved BOOLEAN DEFAULT FALSE,
  author TEXT DEFAULT 'operator',
  alert_type TEXT DEFAULT 'unfulfilled',  -- 'unfulfilled' or 'shipping'
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_oan_order ON order_alert_notes(order_number);
CREATE INDEX IF NOT EXISTS idx_oan_created ON order_alert_notes(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_oan_type ON order_alert_notes(alert_type);

-- ---------------------------------------------------------------------------
-- Migrate existing data from old tables
-- ---------------------------------------------------------------------------

INSERT INTO order_alert_notes (order_number, note, resolved, author, created_at, alert_type)
SELECT order_number, note, resolved, author, created_at, 'unfulfilled'
FROM unfulfilled_order_notes
ON CONFLICT DO NOTHING;

INSERT INTO order_alert_notes (order_number, note, resolved, author, created_at, alert_type)
SELECT order_number, note, resolved, author, created_at, 'shipping'
FROM shipping_delay_notes
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- RPC: get latest note per order (replaces both old RPCs)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION get_latest_alert_notes(order_numbers INTEGER[])
RETURNS TABLE (
  order_number INTEGER,
  note TEXT,
  resolved BOOLEAN,
  author TEXT,
  alert_type TEXT,
  created_at TIMESTAMPTZ
) AS $$
  SELECT DISTINCT ON (n.order_number)
    n.order_number, n.note, n.resolved, n.author, n.alert_type, n.created_at
  FROM order_alert_notes n
  WHERE n.order_number = ANY(order_numbers)
  ORDER BY n.order_number, n.created_at DESC;
$$ LANGUAGE sql STABLE;

-- ---------------------------------------------------------------------------
-- Backward-compatible aliases (safe to drop once all code is migrated)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION get_latest_order_notes(order_numbers INTEGER[])
RETURNS TABLE (
  order_number INTEGER,
  note TEXT,
  resolved BOOLEAN,
  author TEXT,
  created_at TIMESTAMPTZ
) AS $$
  SELECT n.order_number, n.note, n.resolved, n.author, n.created_at
  FROM get_latest_alert_notes(order_numbers) n;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION get_latest_shipping_notes(order_numbers INTEGER[])
RETURNS TABLE (
  order_number INTEGER,
  note TEXT,
  resolved BOOLEAN,
  author TEXT,
  created_at TIMESTAMPTZ
) AS $$
  SELECT n.order_number, n.note, n.resolved, n.author, n.created_at
  FROM get_latest_alert_notes(order_numbers) n;
$$ LANGUAGE sql STABLE;
