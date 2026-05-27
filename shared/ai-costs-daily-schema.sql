-- ai_costs_daily — per-day, per-component, per-model rollup of ai_calls.
-- Populated by lib/rollupAiCosts.js, invoked from daily-sync-all.js. The
-- rollup is idempotent: it deletes the target day's rows then re-inserts, so
-- re-running a day produces the same result.
--
-- Run in the Supabase SQL Editor (after ai-calls-schema.sql).

CREATE TABLE IF NOT EXISTS ai_costs_daily (
  date DATE NOT NULL,
  component TEXT NOT NULL,
  model_id TEXT NOT NULL,
  call_count INT NOT NULL,
  total_input_tokens BIGINT NOT NULL,
  total_output_tokens BIGINT NOT NULL,
  total_cache_read_tokens BIGINT NOT NULL,
  total_cache_create_tokens BIGINT NOT NULL,
  total_cost_usd NUMERIC(10, 4) NOT NULL,
  avg_duration_ms INT NOT NULL,
  p95_duration_ms INT,
  error_count INT DEFAULT 0,
  PRIMARY KEY (date, component, model_id)
);

CREATE INDEX IF NOT EXISTS idx_ai_costs_daily_date ON ai_costs_daily (date);
CREATE INDEX IF NOT EXISTS idx_ai_costs_daily_component ON ai_costs_daily (component);
