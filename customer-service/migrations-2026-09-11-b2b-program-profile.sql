-- What an LGBTQ+ org's own gender-affirming programme actually looks like:
-- a standing closet, gear by request, periodic events, or nothing they hold
-- themselves. Harvested from what the org told us in its own words (the
-- donation onboarding survey, a call recording, their replies), never from
-- the website scrape, which is marketing copy.
--
-- Deliberately NOT program_flags: that column says which RUBIES programme a
-- company is in (donation_closet, purchases, affiliate) and promotes a
-- relationship_state. This is an observation about THEM, like enrich_facts,
-- and must never move a relationship.

ALTER TABLE b2b_companies ADD COLUMN IF NOT EXISTS program_profile JSONB;
ALTER TABLE b2b_companies ADD COLUMN IF NOT EXISTS program_profile_at TIMESTAMPTZ;

COMMENT ON COLUMN b2b_companies.program_profile IS
  'How the org distributes gender-affirming items, in their own account of it: {type, line, sources:[{kind,at,label}], evidence_through}. type is one of standing_closet | by_request | events | no_program | unknown. `line` is the one scannable sentence the panel shows above "Where this stands" and the advisor is given. `evidence_through` is the ISO timestamp of the newest piece of evidence read, so evidence landing after it marks the profile stale rather than silently out of date.';

COMMENT ON COLUMN b2b_companies.program_profile_at IS
  'When the profile was last written. Distinct from program_profile.evidence_through, which is about the evidence rather than the write.';

-- Only orgs have programmes; a retailer has a shop.
CREATE INDEX IF NOT EXISTS idx_b2b_companies_program_type
  ON b2b_companies ((program_profile ->> 'type'))
  WHERE program_profile IS NOT NULL;
