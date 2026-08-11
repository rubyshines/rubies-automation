-- Judge tool-gap signal (2026-08-11).
--
-- The closeness judge no longer proposes an advisor_fact when a system of
-- record could have answered the correction (product comparisons, size-chart
-- arithmetic, donation routing, shipping/stock lookups). That stops
-- advisor_facts refilling with look-up-able prose, but the signal itself is
-- the most direct evidence we have of WHICH tool is missing data — so capture
-- it here instead of discarding it.
--
-- One sentence naming the tool or table that should have returned the fact,
-- or NULL. Nullable and un-indexed on purpose: it is read by the daily digest
-- rollup over a 30-day window, never filtered on in a hot path.
--
-- Run in the Supabase SQL Editor. Safe to re-run.

ALTER TABLE cs_draft_judgments
  ADD COLUMN IF NOT EXISTS tool_gap text;

COMMENT ON COLUMN cs_draft_judgments.tool_gap IS
  'Judge note: the tool/table that should have returned this correction, so it becomes a data ticket rather than an operator fact. NULL when the gap was genuinely operator-only knowledge.';
