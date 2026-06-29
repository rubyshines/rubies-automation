-- ============================================================================
-- Free Swimwear: repeat / duplicate applicant handling (intake-time).
--
-- Adds the columns the intake repeat-check writes. Two new closed statuses ride
-- on the existing free-text `status` column (no CHECK constraint to alter):
--   repeat    — too-soon repeat (within a year of the recipient's last
--               application); closed, and the family is emailed a reapply-after
--               notice (NOT silent).
--   duplicate — same-day resubmit / correction; the redundant row is closed
--               silently (collapse to one active entry per recipient).
-- The existing silent `rejected` path (Brazil / not-trans) is unchanged.
--
-- Run once in the Supabase SQL Editor.
-- ============================================================================

ALTER TABLE free_swimwear_requests
  ADD COLUMN IF NOT EXISTS possible_second_child boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS prior_application_at  timestamptz,
  ADD COLUMN IF NOT EXISTS prior_status          text,
  ADD COLUMN IF NOT EXISTS reapply_after         timestamptz,
  ADD COLUMN IF NOT EXISTS repeat_notice_sent_at timestamptz;
