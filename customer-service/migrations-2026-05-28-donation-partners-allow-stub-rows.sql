-- ============================================================================
-- Allow stub "out" rows in donation_partners so the operator can mark a
-- survey submission as decided=out without geocoding / ingesting it.
--
-- A stub row carries: name + active=false + (optional) description holding
-- the rejection reason. All other fields stay null.
-- ============================================================================

ALTER TABLE donation_partners ALTER COLUMN country_code DROP NOT NULL;
