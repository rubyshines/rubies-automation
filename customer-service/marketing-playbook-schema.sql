-- marketing_playbook — recency-weighted "ground truths" artifact
-- (customer-service/lib/playbook.js, refreshed on demand).
CREATE TABLE IF NOT EXISTS marketing_playbook (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  generated_at timestamptz NOT NULL DEFAULT now(),
  through_date date,
  campaigns_analyzed integer NOT NULL DEFAULT 0,
  stats        jsonb NOT NULL DEFAULT '{}'::jsonb,
  narrative    text NOT NULL DEFAULT '',
  model        text
);
CREATE INDEX IF NOT EXISTS idx_playbook_generated ON marketing_playbook (generated_at DESC);
ALTER TABLE marketing_playbook ENABLE ROW LEVEL SECURITY;
