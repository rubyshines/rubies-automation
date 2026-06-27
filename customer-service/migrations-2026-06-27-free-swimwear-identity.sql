-- ============================================================================
-- Free Swimwear: switch the natural key from the volatile sheet position to the
-- stable (email, submission time). The "Form Responses 1" sheet gets re-sorted,
-- so sheet_row is not a reliable identity (it would re-insert every applicant as
-- a duplicate on the next sync, and mis-target sheet write-backs).
-- Verified 0 collisions on (lower(email), submitted_at) across all rows.
-- Run once in the Supabase SQL Editor.
-- ============================================================================

DROP INDEX IF EXISTS uq_free_swimwear_source_row;

CREATE UNIQUE INDEX IF NOT EXISTS uq_free_swimwear_identity
  ON free_swimwear_requests (lower(email), COALESCE(submitted_at, 'epoch'::timestamptz));
