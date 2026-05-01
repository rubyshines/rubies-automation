-- ============================================================================
-- Migration: 2026-05-01 — Sync idempotency
-- Run in Supabase SQL Editor before deploying the matching code changes.
-- All statements are idempotent (IF NOT EXISTS), safe to re-run.
-- ============================================================================
--
-- Background: two production code paths used a delete + insert pattern that
-- raced under concurrent execution, occasionally leaving duplicate rows.
-- These migrations add per-row stable identifiers + unique indexes so the
-- writers can switch to upsert semantics that are safe under concurrency.
--
-- Affected paths after migration:
--   - customer-service/sync/syncAll.js
--   - webhooks/handlers/shopifyOrders.js
--   - customer-service/sync/syncShippingZones.js
--
-- Once this is run, deploy the code changes that populate the new column +
-- use upsert. Existing rows missing shopify_line_item_id will be filled in
-- the natural sync cycle (no manual backfill required — orphan-cleanup pass
-- in the writers handles legacy null rows).

-- ----------------------------------------------------------------------------
-- order_line_items: per-line-item Shopify ID + partial unique index
-- ----------------------------------------------------------------------------

ALTER TABLE order_line_items
  ADD COLUMN IF NOT EXISTS shopify_line_item_id TEXT;

-- Partial unique index — only enforces uniqueness once the column is populated.
-- Existing rows with NULL are unaffected; new writes get protection immediately.
CREATE UNIQUE INDEX IF NOT EXISTS order_line_items_uniq_line_id
  ON order_line_items (shopify_line_item_id)
  WHERE shopify_line_item_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- shipping_zones_history: dedupe by (country, change_type, observed_at)
-- ----------------------------------------------------------------------------
-- The history table is append-only; bare insert can produce duplicates when
-- two sync runs interleave. The matching code change truncates observed_at
-- to the minute before insert, so two concurrent runs of the same change
-- produce identical (country_code, change_type, observed_at) tuples and
-- collide on this unique constraint — upsert with ignoreDuplicates makes the
-- second insert a no-op. Distinct changes in different minutes still record.

CREATE UNIQUE INDEX IF NOT EXISTS shipping_zones_history_uniq_change
  ON shipping_zones_history (country_code, change_type, observed_at);
