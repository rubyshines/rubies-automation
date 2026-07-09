-- Operator-knowledge facts injected into the CS advisor's system prompt.
-- Fed by the daily closeness judge (factual_correction verdicts propose
-- candidate facts) + seed script; Jamie approves/rejects in the dashboard.
-- Run once in Supabase SQL Editor.

CREATE TABLE IF NOT EXISTS advisor_facts (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fact              text NOT NULL,             -- one self-contained sentence a draft can rely on
  category          text NOT NULL DEFAULT 'general',  -- product | shipping | returns_donations | programs | process | general
  status            text NOT NULL DEFAULT 'pending',  -- pending | active | rejected | expired
  expires_at        timestamptz,               -- perishable facts (restock ETAs, sale windows) auto-drop
  source            text NOT NULL DEFAULT 'judge',    -- judge | seed | manual
  source_draft_id   bigint,                    -- cs_ai_drafts.id whose correction produced this
  source_rationale  text,                      -- judge rationale, for review context
  created_at        timestamptz DEFAULT now(),
  decided_at        timestamptz                -- when Jamie approved/rejected
);

CREATE INDEX IF NOT EXISTS idx_advisor_facts_status ON advisor_facts (status);
