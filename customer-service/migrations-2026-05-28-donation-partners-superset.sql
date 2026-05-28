-- ============================================================================
-- donation_partners: extend to be a superset serving both CS routing and the
-- public donation page on rubyshines.com (published as a static JSON asset).
--
-- Adds:
--   mailing_address  multi-line "RUBIES Returns / c/o ..." block (theme display)
--   logo_url         public CDN URL for the partner's logo
--   website_url      partner's external website
--   size_range       freeform sizes accepted (e.g. "Adult XS - 4X")
--
-- Also adds a UNIQUE constraint on name so upserts by name are race-safe.
--
-- Run in Supabase SQL Editor (one-time).
-- ============================================================================

ALTER TABLE donation_partners
  ADD COLUMN IF NOT EXISTS mailing_address text,
  ADD COLUMN IF NOT EXISTS logo_url        text,
  ADD COLUMN IF NOT EXISTS website_url     text,
  ADD COLUMN IF NOT EXISTS size_range      text;

-- Unique constraint on name so MCP tool / import can upsert by it safely.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'donation_partners_name_key'
  ) THEN
    ALTER TABLE donation_partners
      ADD CONSTRAINT donation_partners_name_key UNIQUE (name);
  END IF;
END $$;
