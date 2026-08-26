-- Separate what an org IS from which RUBIES programs it is IN (2026-08-26)
--
-- Enrichment first wrote its findings into `program_flags`, which was wrong.
-- That column answers "which of our programs is this org in" — donation
-- partner, affiliate — and two readers depend on that meaning:
--
--   cadence.js  treats ANY truthy flag as "in one of our programs" and halves
--               the community check-in interval (330d → 180d). Writing
--               serves_trans_community onto 158 orgs silently re-paced three
--               active orgs that are in none of our programs.
--
--   outreachAdvisor.js  renders it to the advisor as `Programs: {...}`. An
--               advisor drafting a FIRST TOUCH would read
--               runs_clothing_program:true as "they are already in our
--               donation program" and write to a stranger as a partner.
--
-- Enrichment facts are observations about the org, made from their own
-- website, and carry no claim about a relationship with us. Different kind of
-- fact, different column.
--
-- Run in the Supabase SQL Editor.

ALTER TABLE b2b_companies
  ADD COLUMN IF NOT EXISTS enrich_facts jsonb;

COMMENT ON COLUMN b2b_companies.enrich_facts IS
  'What enrichOrgs.js observed on the org''s own website: runs_clothing_program, serves_trans_community, site_appears_active. Observations about the ORG. Never a statement about their relationship with RUBIES — that is program_flags and relationship_state.';

-- Move the three enrichment keys out of program_flags, preserving any real
-- program flags on the same row. Idempotent: rows already migrated have no
-- enrichment keys left in program_flags and are skipped by the WHERE.
UPDATE b2b_companies
SET
  enrich_facts = COALESCE(enrich_facts, '{}'::jsonb) || (
    jsonb_strip_nulls(jsonb_build_object(
      'runs_clothing_program',  program_flags -> 'runs_clothing_program',
      'serves_trans_community', program_flags -> 'serves_trans_community',
      'site_appears_active',    program_flags -> 'site_appears_active'
    ))
  ),
  program_flags = (program_flags - 'runs_clothing_program' - 'serves_trans_community' - 'site_appears_active')
WHERE program_flags ?| ARRAY['runs_clothing_program', 'serves_trans_community', 'site_appears_active'];

-- A row whose only flags were enrichment's now holds '{}'. Normalize to NULL so
-- `Object.keys(program_flags).length` and the cadence's `.some(Boolean)` both
-- read it as "no programs" rather than as an empty-but-present object.
UPDATE b2b_companies
SET program_flags = NULL
WHERE program_flags = '{}'::jsonb;
