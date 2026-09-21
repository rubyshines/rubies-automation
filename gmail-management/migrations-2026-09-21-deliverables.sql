-- 2026-09-21 — deliverables: one piece of work above many promises.
--
-- Apply BEFORE deploying the code. Idempotent. The code fails soft until this
-- is applied (the To do list simply shows no folds), so applying it after is
-- safe too; applying it first is the house rule.
--
-- See b2b-deliverables-schema.sql for the why. Repeated here so one file
-- applies the whole change.

CREATE TABLE IF NOT EXISTS b2b_deliverables (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name         TEXT NOT NULL,
  detail       TEXT,
  blocks       BOOLEAN NOT NULL DEFAULT TRUE,
  status       TEXT NOT NULL DEFAULT 'open',
  target_on    DATE,
  shipped_at   TIMESTAMPTZ,
  notes        TEXT,
  created_by   TEXT NOT NULL DEFAULT 'operator',
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE b2b_commitments
  ADD COLUMN IF NOT EXISTS deliverable_id BIGINT REFERENCES b2b_deliverables(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_b2b_commitments_deliverable_open
  ON b2b_commitments (deliverable_id) WHERE status = 'open';
