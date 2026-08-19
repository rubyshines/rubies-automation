-- Judge.me publish state + audience tagging (2026-08).
--
-- Two gaps this closes.
--
-- 1. We synced reviews for years without ever storing whether Judge.me is
--    actually SHOWING them. `curated` was stored but `published`/`hidden` were
--    dropped on the floor, so nothing on our side could tell that 48 reviews
--    (2026-06-05 onward) had never been through a publish pass. `curated` is
--    the control (ok = published, spam = hidden) and `published` is the effect;
--    we store both because the API returns both and a future divergence between
--    them is exactly the kind of thing we'd want to see rather than infer.
--
-- 2. A review's audience (a parent writing about their daughter vs an adult
--    writing about herself) is not derivable from the product — most SKUs sell
--    in both youth and adult sizes. Judge.me has no tag or custom-field API, so
--    the classification has to live here.
--
-- `ai_recommendation` and `decision` are deliberately separate columns rather
-- than one field the operator overwrites: the gap between what the rubric
-- suggested and what Jamie actually did is the only signal we'll have for
-- whether the rubric is any good.
--
-- Run in the Supabase SQL Editor. Safe to re-run.

ALTER TABLE judgeme_reviews
  -- Judge.me display state, straight off the API response.
  ADD COLUMN IF NOT EXISTS published boolean,
  ADD COLUMN IF NOT EXISTS hidden boolean,
  ADD COLUMN IF NOT EXISTS featured boolean,

  -- Audience classification (Haiku, from review text only).
  ADD COLUMN IF NOT EXISTS audience text,
  ADD COLUMN IF NOT EXISTS audience_reason text,
  ADD COLUMN IF NOT EXISTS audience_model text,
  ADD COLUMN IF NOT EXISTS audience_at timestamptz,

  -- What the curation rubric suggested: publish | hold | decide.
  -- 'decide' is a real outcome, not a failure — some categories (a review that
  -- fit fine but did not conceal well enough) are the founder's call by policy.
  ADD COLUMN IF NOT EXISTS ai_recommendation text,
  ADD COLUMN IF NOT EXISTS ai_rationale text,

  -- What the operator actually did.
  ADD COLUMN IF NOT EXISTS decision text,
  ADD COLUMN IF NOT EXISTS decision_reason text,
  ADD COLUMN IF NOT EXISTS decision_by text,
  ADD COLUMN IF NOT EXISTS decision_at timestamptz;

-- The queue reads "unpublished, oldest first" on every load.
CREATE INDEX IF NOT EXISTS idx_judgeme_reviews_published
  ON judgeme_reviews(published, created_at);

-- Audience filtering for review quotes and the tab's own filter.
CREATE INDEX IF NOT EXISTS idx_judgeme_reviews_audience
  ON judgeme_reviews(audience);

COMMENT ON COLUMN judgeme_reviews.published IS
  'Judge.me display state: true = live on the storefront. Mirrors curated (ok/spam) but stored independently so a divergence is visible rather than assumed.';

COMMENT ON COLUMN judgeme_reviews.audience IS
  'Who the review is about: kids | adults | both | unclear. Classified from review text alone (Haiku) — the product does not tell us, since most SKUs sell in youth and adult sizes.';

COMMENT ON COLUMN judgeme_reviews.ai_recommendation IS
  'What the curation rubric suggested (publish | hold | decide). Kept alongside decision so operator disagreement is measurable.';

COMMENT ON COLUMN judgeme_reviews.decision IS
  'What the operator did: published | held. NULL means the review has never been through a pass.';
