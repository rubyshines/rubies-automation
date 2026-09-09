-- 2026-09-09: a stored timezone per company, with where it came from.
-- Run in the Supabase SQL Editor BEFORE deploying the code that writes it.
--
-- timezone         IANA name, e.g. America/Chicago
-- timezone_source  'operator' — set by hand in the panel or the b2b_update_company tool;
--                  never overwritten by inference.
--                  'inferred' — derived from city/region/country; kept in step with
--                  them by updateCompanyLocation and backfillCompanyTimezones.
ALTER TABLE b2b_companies ADD COLUMN IF NOT EXISTS timezone TEXT;
ALTER TABLE b2b_companies ADD COLUMN IF NOT EXISTS timezone_source TEXT;
