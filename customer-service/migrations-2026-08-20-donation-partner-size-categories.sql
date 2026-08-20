-- Donation partners: replace the free-text `size_range` with two booleans.
--
-- Why: the onboarding survey asked three overlapping checkboxes ("Youth 4-8" /
-- "Youth 10-16" / "Adult XS-4X") whose categories collide — adult XS is the
-- same waist measurement as kids 12 — so an org that ticked "Adult" alone had
-- told us nothing usable. Queen's Yellow House reported receiving sizes they
-- cannot distribute, which is the failure this closes.
--
-- The new split is on the one physically real boundary:
--   accepts_smaller_sizes — kids 4 through 11
--   accepts_larger_sizes  — kids 12 through 16, and adult XXS through 4X
--
-- `size_range` is DROPPED, not kept: a stale free-text column sitting beside the
-- booleans would read as authoritative and drift. The verbatim onboarding
-- answers remain in the Form Responses sheet, which is where that record lives.
-- Display text is now derived (see lib/sizeAcceptance.js formatSizeAcceptance).

ALTER TABLE donation_partners
  ADD COLUMN IF NOT EXISTS accepts_smaller_sizes boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS accepts_larger_sizes  boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN donation_partners.accepts_smaller_sizes IS
  'Partner can distribute kids sizes 4-11.';
COMMENT ON COLUMN donation_partners.accepts_larger_sizes IS
  'Partner can distribute kids sizes 12-16 and adult sizes XXS-4X.';

-- Backfill from the historical free text. Mirrors parseSizeAcceptance() in
-- lib/sizeAcceptance.js — keep the two in step if either changes.
--
-- "Youth sizes 10-16" maps to LARGER only. This is NOT free: sizes 10 and 11
-- fall on the smaller side of the new boundary and are ~10% of all units ever
-- sold, so those orgs lose volume they had said yes to. Accepted anyway,
-- because the smaller box is now "4-11" — mostly sizes they explicitly
-- declined — and an org that said no to 4-8 would be unlikely to tick it.
-- Confirmed with Jamie 2026-08-20.
UPDATE donation_partners
SET
  accepts_smaller_sizes = (
    size_range ILIKE '%all sizes%'
    OR size_range ILIKE '%youth sizes 4-8%'
  ),
  accepts_larger_sizes = (
    size_range ILIKE '%all sizes%'
    OR size_range ILIKE '%youth sizes 10-16%'
    OR size_range ILIKE '%adult sizes%'
  )
WHERE size_range IS NOT NULL AND btrim(size_range) <> '';

-- Yellow House (Queen's University) told us directly they cannot use smaller
-- sizes; their survey answer predates that conversation.
UPDATE donation_partners
SET accepts_smaller_sizes = false,
    accepts_larger_sizes  = true
WHERE name ILIKE '%Yellow House%';

-- A row that accepts nothing would be silently unroutable. None should exist
-- after the backfill; this surfaces one loudly rather than at draft time.
DO $$
DECLARE
  orphans int;
BEGIN
  SELECT count(*) INTO orphans
  FROM donation_partners
  WHERE active AND NOT accepts_smaller_sizes AND NOT accepts_larger_sizes;
  IF orphans > 0 THEN
    RAISE EXCEPTION 'Backfill left % active partner(s) accepting no sizes', orphans;
  END IF;
END $$;

ALTER TABLE donation_partners DROP COLUMN IF EXISTS size_range;
