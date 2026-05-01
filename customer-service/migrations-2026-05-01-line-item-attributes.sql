-- ============================================================================
-- Migration: 2026-05-01 — Line item custom attributes
-- Run in Supabase SQL Editor before deploying the matching code changes.
-- Idempotent (IF NOT EXISTS), safe to re-run.
-- ============================================================================
--
-- Background: Shopify line items carry per-item customAttributes (e.g. the
-- Pre-Order Now app stamps each pre-ordered line item with a `Pre-order`
-- attribute whose value is the customer-visible target string). The CS
-- dashboard's order card surfaces this inline so operators can see, per
-- item, when an outstanding pre-order is expected to ship without leaving
-- the ticket. Existing pre-order detection in fulfillmentChecker.js reads
-- this from live Shopify; persisting it here lets the dashboard render
-- without a per-page Shopify call.
--
-- Affected paths after migration:
--   - customer-service/lib/shopify.js fetchOrdersForSync (GraphQL select)
--   - customer-service/sync/syncAll.js (write to new column)
--   - webhooks/lib/normalize.js (REST `properties` → JSONB)
--   - customer-service/dashboard/server.js (already reads after this migration)
--
-- Backfill: not required. Order line items get the column populated at the
-- next sync cycle for any order that's re-synced. Recent orders sync nightly.

ALTER TABLE order_line_items
  ADD COLUMN IF NOT EXISTS custom_attributes JSONB;

COMMENT ON COLUMN order_line_items.custom_attributes IS
  'Per-line-item customAttributes from Shopify (e.g. Pre-order target string). JSONB array of {key, value} pairs.';
