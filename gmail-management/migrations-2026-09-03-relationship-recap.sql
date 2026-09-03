-- Relationship recap: the three-line version of relationship_summary that the
-- Outreach panel renders (started / agreed / now). relationship_summary stays
-- the paragraph the advisor and the console tool read. Written by
-- b2b-outreach/lib/relationshipSummary.js on every summary pass once the column
-- exists (it checks), and backfilled by a forced sweep after this migration.
ALTER TABLE b2b_companies ADD COLUMN IF NOT EXISTS relationship_recap JSONB; -- {started, agreed, now}
