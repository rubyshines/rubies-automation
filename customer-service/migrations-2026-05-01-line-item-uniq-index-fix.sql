-- ============================================================================
-- Migration: 2026-05-01 — Fix partial unique index on order_line_items
-- Run in Supabase SQL Editor before redeploying syncAll.js / shopifyOrders.js.
-- Idempotent (IF EXISTS / IF NOT EXISTS), safe to re-run.
-- ============================================================================
--
-- Background: the 2026-05-01 idempotency migration created a PARTIAL unique
-- index on order_line_items (shopify_line_item_id) WHERE shopify_line_item_id
-- IS NOT NULL. PostgreSQL only honors partial indexes as ON CONFLICT targets
-- when the writer also supplies the matching WHERE predicate — and the
-- Supabase JS client's .upsert() emits a bare ON CONFLICT (column) with no
-- predicate. Result: every line-item upsert from syncAll.js + the orders/*
-- webhook silently fails with `42P10 — there is no unique or exclusion
-- constraint matching the ON CONFLICT specification`. The orphan cleanup
-- still runs, deletes legacy NULL-id rows, and nothing replaces them.
--
-- Net effect since the Apr 30 deploy: ~10% of new orders are missing all
-- their line items in Supabase. Confirmed by reproducing the upsert error
-- directly against the live table. The webhook handler has the same bug.
--
-- Fix: drop the partial index, recreate as a regular (non-partial) unique
-- index. Postgres treats each NULL value as distinct in a regular unique
-- index, so the legacy NULL-id rows still coexist without violating the
-- constraint, and new rows with real IDs upsert correctly.

DROP INDEX IF EXISTS order_line_items_uniq_line_id;

CREATE UNIQUE INDEX IF NOT EXISTS order_line_items_uniq_line_id
  ON order_line_items (shopify_line_item_id);

COMMENT ON INDEX order_line_items_uniq_line_id IS
  'Per-line-item dedup key from Shopify. Regular (non-partial) unique index — required so Supabase JS .upsert(onConflict: shopify_line_item_id) finds a matching constraint. Multiple NULL values are allowed by default (NULLs distinct).';
