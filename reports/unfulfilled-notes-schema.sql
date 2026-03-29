-- ============================================================================
-- Unfulfilled Order Notes — operator annotations + resolved status
-- Run in Supabase SQL Editor
-- ============================================================================

CREATE TABLE IF NOT EXISTS unfulfilled_order_notes (
  id serial PRIMARY KEY,
  order_number integer NOT NULL,
  note text NOT NULL,
  resolved boolean DEFAULT false,
  author text DEFAULT 'operator',
  created_at timestamptz DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_uon_order ON unfulfilled_order_notes(order_number);
CREATE INDEX IF NOT EXISTS idx_uon_created ON unfulfilled_order_notes(created_at DESC);

-- Helper: get latest note per order (used by the report)
CREATE OR REPLACE FUNCTION get_latest_order_notes(order_numbers integer[])
RETURNS TABLE (
  order_number integer,
  note text,
  resolved boolean,
  author text,
  created_at timestamptz
) AS $$
  SELECT DISTINCT ON (n.order_number)
    n.order_number, n.note, n.resolved, n.author, n.created_at
  FROM unfulfilled_order_notes n
  WHERE n.order_number = ANY(order_numbers)
  ORDER BY n.order_number, n.created_at DESC;
$$ LANGUAGE sql STABLE;
