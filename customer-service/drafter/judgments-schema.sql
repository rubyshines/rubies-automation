-- Closeness-to-final judge results (#3): one verdict per sent advisor draft.
-- Continuous version of the May 2026 baseline study's AI comparison.
-- Run once in Supabase SQL Editor (executed 2026-06-10).

CREATE TABLE IF NOT EXISTS cs_draft_judgments (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  draft_id            bigint REFERENCES cs_ai_drafts(id) UNIQUE,
  gorgias_ticket_id   bigint,
  category            text NOT NULL,   -- identical | cosmetic | substantive | factual_correction | action_divergence
  draft_may_be_right  boolean DEFAULT false,
  severity            text,            -- low | medium | high
  rationale           text,
  message_type        text,
  judge_model         text,            -- model id, or 'deterministic' for identical short-circuit
  source              text DEFAULT 'baseline',  -- baseline | daily
  created_at          timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_judgments_category ON cs_draft_judgments (category);
CREATE INDEX IF NOT EXISTS idx_judgments_created ON cs_draft_judgments (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_judgments_msgtype ON cs_draft_judgments (message_type);
