-- B2B org enrichment (2026-08-24)
--
-- The CenterLink cohort arrived from Klaviyo with IP-geolocated "locations" —
-- the region column holds the datacenter that served the profile, not the org
-- (metrotampabay.org filed as Des Moines, Iowa; norcaloutreach.org as Ashburn,
-- Virginia, which is AWS us-east-1). Geography is therefore unusable as an
-- admission filter, which is what blocks working the queue by region.
--
-- enrichOrgs.js scrapes each org's own website for its stated address and
-- contact details, geocodes the address, and writes the result back. These
-- columns make that pass idempotent and let a failed row be found again.
--
-- Run in the Supabase SQL Editor.

ALTER TABLE b2b_companies
  ADD COLUMN IF NOT EXISTS enriched_at timestamptz,
  ADD COLUMN IF NOT EXISTS enrich_status text,
  ADD COLUMN IF NOT EXISTS enrich_notes text;

COMMENT ON COLUMN b2b_companies.enriched_at IS
  'When enrichOrgs.js last completed a pass for this row. NULL = never enriched. Set on every terminal outcome including failures, so a re-run skips it; clear it to force a retry.';
COMMENT ON COLUMN b2b_companies.enrich_status IS
  'Outcome of the last enrichment pass. located = geocoded from an address the org publishes. located_approx = geocoded from a stated service area, so region is trustworthy and the point is a centroid — never treat it as a postal address. no_address = the site genuinely states neither. scrape_thin = too little content came back to conclude anything, retry. Also: scrape_failed | no_website | analysis_failed.';
COMMENT ON COLUMN b2b_companies.enrich_notes IS
  'Human-readable detail for the last pass — the scrape error, or what the analyzer found instead of an address.';

-- Rows that failed are the ones worth finding again; the happy path is read by id.
CREATE INDEX IF NOT EXISTS idx_b2b_companies_enrich_status
  ON b2b_companies (enrich_status)
  WHERE enrich_status IS NOT NULL AND enrich_status <> 'located';
