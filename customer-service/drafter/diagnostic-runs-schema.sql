-- Diagnostic table for shadow model evaluation. Persistent infrastructure
-- for comparing candidate models against production drafts and (eventually)
-- against the human-approved final sent message.

CREATE TABLE IF NOT EXISTS cs_diagnostic_runs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('advisor', 'operator')),
  customer_email TEXT,

  -- Opus (production) results
  opus_draft TEXT,
  opus_structured JSONB,
  opus_timing JSONB,
  opus_tools_called TEXT[],

  -- Sonnet (shadow) results
  sonnet_draft TEXT,
  sonnet_structured JSONB,
  sonnet_timing JSONB,
  sonnet_tools_called TEXT[],

  -- AI judge comparison (1–5 score, 3 = baseline / tied with Opus)
  judge_result JSONB,

  -- Auto-detected divergences between Opus and Sonnet
  divergences TEXT[],

  -- Linkage to source ticket/draft so we can pull the human-approved final
  -- sent message and score each candidate against ground truth.
  ticket_id BIGINT,    -- gorgias_ticket_id
  draft_id BIGINT,     -- cs_ai_drafts.id (null for intake-time runs)

  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE cs_diagnostic_runs ADD COLUMN IF NOT EXISTS ticket_id BIGINT;
ALTER TABLE cs_diagnostic_runs ADD COLUMN IF NOT EXISTS draft_id BIGINT;

-- Index for analysis queries
CREATE INDEX IF NOT EXISTS idx_diagnostic_runs_source ON cs_diagnostic_runs (source);
CREATE INDEX IF NOT EXISTS idx_diagnostic_runs_created ON cs_diagnostic_runs (created_at);
CREATE INDEX IF NOT EXISTS idx_diagnostic_runs_ticket ON cs_diagnostic_runs (ticket_id);
CREATE INDEX IF NOT EXISTS idx_diagnostic_runs_draft ON cs_diagnostic_runs (draft_id);
