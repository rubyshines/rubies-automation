-- ============================================================================
-- b2b_companies: add store locator columns
--
-- Extends existing b2b_companies rows with the fields needed to power the
-- rubyshines.com/pages/store-locator map. The on_store_locator flag is the
-- SSOT for what appears on the map; publish writes store-locators.json from
-- rows WHERE on_store_locator = true.
--
-- Run in Supabase SQL Editor (one-time).
-- ============================================================================

ALTER TABLE b2b_companies
  ADD COLUMN IF NOT EXISTS on_store_locator         boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS locator_display_name     text,
  ADD COLUMN IF NOT EXISTS locator_description      text,
  ADD COLUMN IF NOT EXISTS locator_hours            text,
  ADD COLUMN IF NOT EXISTS locator_products         text[],
  ADD COLUMN IF NOT EXISTS locator_display_address  text,
  ADD COLUMN IF NOT EXISTS locator_logo_url         text,
  ADD COLUMN IF NOT EXISTS latitude                 numeric,
  ADD COLUMN IF NOT EXISTS longitude                numeric;

CREATE INDEX IF NOT EXISTS idx_b2b_companies_on_locator
  ON b2b_companies(on_store_locator) WHERE on_store_locator = true;
