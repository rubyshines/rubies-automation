-- Temporary diagnostic table for shadow Sonnet evaluation.
-- Drop after analysis is complete (~5 days).
-- Created: 2026-04-18

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

  -- AI judge comparison
  judge_result JSONB,

  -- Auto-detected divergences between Opus and Sonnet
  divergences TEXT[],

  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for analysis queries
CREATE INDEX IF NOT EXISTS idx_diagnostic_runs_source ON cs_diagnostic_runs (source);
CREATE INDEX IF NOT EXISTS idx_diagnostic_runs_created ON cs_diagnostic_runs (created_at);
