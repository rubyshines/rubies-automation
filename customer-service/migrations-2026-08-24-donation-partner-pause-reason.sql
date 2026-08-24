-- Donation partners: record WHY an org stopped receiving donations.
--
-- `active` could always stop the boxes but never say why, so a paused org and a
-- dropped one were the same row, and the reason lived only in a Gmail thread.
-- Mirrors the b2b outreach pause (b2b-outreach/lib/triage.js) — indefinite, and
-- the reason is mandatory rather than encouraged.
--
-- These are DIFFERENT axes. This one stops DONATIONS; outreach_paused_at on
-- b2b_companies stops EMAIL. Both orgs below stopped taking returns while
-- explicitly asking to keep buying, so neither has outreach paused.

ALTER TABLE donation_partners
  ADD COLUMN IF NOT EXISTS paused_at     timestamptz,
  ADD COLUMN IF NOT EXISTS paused_reason text;

COMMENT ON COLUMN donation_partners.paused_at IS
  'When the org stopped receiving donations. NULL while active.';
COMMENT ON COLUMN donation_partners.paused_reason IS
  'Why the org stopped receiving donations. Set with paused_at; both cleared on resume.';

-- Backfill the two orgs paused on 2026-08-20, both of whom asked to stop and
-- both of whom asked to keep buying.
UPDATE donation_partners
SET paused_at = timestamptz '2026-08-20 20:46:00+00',
    paused_reason = 'Asked to stop 2026-08-20 (Charly Robles, Director of Community Programs): wants to offer more consistent products through their G.E.A.R. programme rather than a stream of mixed returns. Not a complaint — still buying at the 50% tier, and a call is open about carrying RUBIES in G.E.A.R. Previous contact DJ has left the org.'
WHERE name ILIKE '%Massachusetts Transgender Political Coalition%';

UPDATE donation_partners
SET paused_at = timestamptz '2026-08-20 20:48:00+00',
    paused_reason = 'Asked to stop 2026-08-20 (Kat Pamplin, Assistant Director): oversupplied — enough RUBIES stock for their youth "for years to come", and asked that returns go where they reach people faster. Happy to buy direct with or without the discount. Worth re-approaching if their uptake grows.'
WHERE name ILIKE '%Rainbow Youth Center%';

-- Any other inactive row predates this field. Surface them rather than leaving
-- a silent mix of "paused with a reason" and "inactive, nobody remembers why".
DO $$
DECLARE
  unexplained int;
BEGIN
  SELECT count(*) INTO unexplained
  FROM donation_partners WHERE NOT active AND paused_reason IS NULL;
  IF unexplained > 0 THEN
    RAISE NOTICE '% inactive partner(s) have no paused_reason (pre-existing mark_out stubs carry theirs in description)', unexplained;
  END IF;
END $$;
