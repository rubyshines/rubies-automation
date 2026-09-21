-- ---------------------------------------------------------------------------
-- b2b_deliverables — one piece of work above many promises (2026-09-21).
--
-- A deliverable is internal work several commitments across several companies
-- hang off: build the affiliate onboarding, make the partner collateral kit,
-- the October shipment run. It is not a promise to anyone, so it is never a
-- row on the To do list and never touches On Me; it is the fold those rows sit
-- under. `blocks` says what membership means: TRUE — members cannot be done
-- until this ships (they fold under "Waiting on: …" and sort last); FALSE — a
-- batch, members actionable now and grouped because they are done together.
--
-- Shipping a deliverable completes no member: the app existing is not the
-- same as having written to the partner. See b2b-outreach/lib/deliverables.js.
--
-- Run in the Supabase SQL editor. Idempotent.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS b2b_deliverables (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name         TEXT NOT NULL,                       -- the fold's header line
  detail       TEXT,                                -- what "shipped" means, one line
  blocks       BOOLEAN NOT NULL DEFAULT TRUE,       -- members wait on this (TRUE) or are a batch (FALSE)
  status       TEXT NOT NULL DEFAULT 'open',        -- 'open' | 'shipped'
  target_on    DATE,
  shipped_at   TIMESTAMPTZ,
  notes        TEXT,
  created_by   TEXT NOT NULL DEFAULT 'operator',    -- 'operator' | 'engine'
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

-- A commitment belongs to at most one deliverable. Deleting the deliverable
-- detaches its members; it never removes them.
ALTER TABLE b2b_commitments
  ADD COLUMN IF NOT EXISTS deliverable_id BIGINT REFERENCES b2b_deliverables(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_b2b_commitments_deliverable_open
  ON b2b_commitments (deliverable_id) WHERE status = 'open';
