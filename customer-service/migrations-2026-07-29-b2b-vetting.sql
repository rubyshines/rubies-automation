-- 2026-07-29 — admit prospects to the outreach queue only after a human says so.
--
-- The queue has always had a Tier 4 ("prospect first-touch") in queue.js
-- TIER_BY_TYPE, but nothing in cadence.evaluateDue ever returned intro_pitch /
-- intro_outreach, so the tier was unreachable and the whole discovery backlog
-- was invisible. Tier 4 now fires — which means ~200 imported rows become
-- eligible at once, and they are NOT equally ready: 23 donation-form orgs told
-- us their size ranges and named a contact, while ~120 CenterLink rows are a
-- name slug and an email until the research pass enriches them.
--
-- vetted_at is the admission gate. Tier 4 requires it, so supply is let in
-- deliberately, cohort by cohort, instead of flooding the panel with rows
-- nobody can write a credible first email to.
--
-- triage_reason records WHY on a drop or snooze — without it, a row marked
-- 'lost' six months ago is indistinguishable from a bad import, and the next
-- session re-litigates a decision that was already made.

ALTER TABLE b2b_companies ADD COLUMN IF NOT EXISTS vetted_at     TIMESTAMPTZ;
ALTER TABLE b2b_companies ADD COLUMN IF NOT EXISTS triage_reason TEXT;

-- first_order_checkin has been unreachable since it was written: it gated on a
-- ctx.firstOrderDeliveredAt that buildContexts never set. There is no delivery
-- timestamp in the orders mirror (delivery lives in tracking), so fulfillment
-- is the honest proxy. syncB2bCompanyState already matches orders to companies
-- daily — it fills this, and the queue reads it off the row instead of
-- re-deriving order history on every build.
ALTER TABLE b2b_companies ADD COLUMN IF NOT EXISTS first_order_fulfilled_at TIMESTAMPTZ;

-- Tier 4 scans for vetted prospects on every queue build; keep it cheap.
CREATE INDEX IF NOT EXISTS idx_b2b_companies_vetted
  ON b2b_companies (relationship_state, vetted_at)
  WHERE vetted_at IS NOT NULL;

COMMENT ON COLUMN b2b_companies.vetted_at IS
  'Operator admitted this prospect to outreach. Tier-4 first-touch requires it; null = not yet reviewed.';
COMMENT ON COLUMN b2b_companies.triage_reason IS
  'Why the operator dropped or snoozed this company, so the decision is not re-litigated later.';
COMMENT ON COLUMN b2b_companies.first_order_fulfilled_at IS
  'When their first paid order shipped. Drives first_order_checkin; written by syncB2bCompanyState.';
