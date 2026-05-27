-- ai_calls — unified per-call AI usage / cost / latency log.
-- One row per provider API call (Anthropic Messages or Voyage Embeddings),
-- tagged with the component that made it. Cost is computed at write time via
-- shared/aiPricing.js so historical rows preserve the rate as charged.
--
-- Written by shared/aiClient.js (callClaude + embedTexts). The wrapper
-- fail-soft no-ops the insert if this table is absent, so creating it later is
-- safe — no production AI path depends on the write succeeding.
--
-- Run in the Supabase SQL Editor.

CREATE TABLE IF NOT EXISTS ai_calls (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  component TEXT NOT NULL,
  model_id TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'anthropic',  -- 'anthropic' | 'voyage'

  -- Token usage
  input_tokens INT,
  output_tokens INT,
  cache_read_tokens INT DEFAULT 0,
  cache_creation_tokens INT DEFAULT 0,

  -- Latency
  duration_ms INT,

  -- Cost (computed at write time, USD)
  cost_usd NUMERIC(10, 6),

  -- Tool use (Anthropic only)
  tool_calls TEXT[],
  tool_count INT DEFAULT 0,

  -- Linkage
  ticket_id BIGINT,
  draft_id BIGINT,
  parent_call_id BIGINT,  -- for tool-loop chains: which initial call spawned this one

  -- Component-specific extras (stop reason, customer email, etc.)
  metadata JSONB,

  -- Error path
  error TEXT,

  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_calls_component ON ai_calls (component);
CREATE INDEX IF NOT EXISTS idx_ai_calls_created ON ai_calls (created_at);
CREATE INDEX IF NOT EXISTS idx_ai_calls_ticket ON ai_calls (ticket_id);
CREATE INDEX IF NOT EXISTS idx_ai_calls_draft ON ai_calls (draft_id);
CREATE INDEX IF NOT EXISTS idx_ai_calls_model ON ai_calls (model_id);
