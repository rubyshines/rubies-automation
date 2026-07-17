-- ============================================================================
-- preorder_notifications — one row per pre-order delay email actually sent.
-- Run in Supabase SQL Editor. Idempotent (IF NOT EXISTS), safe to re-run.
-- ============================================================================
--
-- Written by sendPreOrderUpdateNotices (lib/merchandising/preOrderLifecycle.js)
-- on every live send. A later wave dedupes on (order_number,
-- communicated_target): an order already told "the end of August" is skipped
-- unless the operator passes resend=true. Code is fail-soft if this table is
-- missing — sends still work, dedupe is just disabled with a warning.

CREATE TABLE IF NOT EXISTS preorder_notifications (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_number INTEGER NOT NULL,
  customer_email TEXT NOT NULL,
  -- The exact Pre-order attribute text(s) on the order at send time,
  -- e.g. ["Target availability middle of August, 2026."]
  promised_targets JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- What we told them instead, e.g. "the end of August"
  communicated_target TEXT NOT NULL,
  -- A_pre_only (swap offer) | B_mixed (split-or-swap offer)
  variant TEXT NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS preorder_notifications_order_idx
  ON preorder_notifications (order_number);

CREATE INDEX IF NOT EXISTS preorder_notifications_target_idx
  ON preorder_notifications (communicated_target);

COMMENT ON TABLE preorder_notifications IS
  'Pre-order delay notification log: which open orders were emailed which updated date. Dedupe source for repeat waves (preorder_update_notice tool).';
