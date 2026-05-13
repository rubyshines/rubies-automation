-- ============================================================================
-- Migration: 2026-05-13 — Variant pre-order metafields
-- Run in Supabase SQL Editor before deploying the matching code changes.
-- Idempotent (IF NOT EXISTS), safe to re-run.
-- ============================================================================
--
-- Background: variant-level `custom.pre_order_incoming_us` and
-- `custom.pre_order_date_us` metafields hold the incoming-quantity and
-- target-restock-date for SKUs currently on pre-order. The `_us` suffix is
-- historical (single-warehouse era post-Think→Nitro transition); columns
-- are stored without the suffix since there's no other locale.
--
-- Used by Shop App leak outreach to populate restock ETAs in customer
-- emails, and by operator + advisor agents answering pre-order questions.
--
-- Backfill: re-run product sync (`npm run cs-sync-products` or
-- `node customer-service/sync/syncProducts.js`).

ALTER TABLE product_variants
  ADD COLUMN IF NOT EXISTS pre_order_incoming integer,
  ADD COLUMN IF NOT EXISTS pre_order_date     date;
