-- Steer & Send shadow verdicts — one row per steered regen while the
-- `steersend_shadow` flag is on. Nothing sends; the daily digest joins
-- gate-passed rows to cs_draft_judgments (would-have-erred = go/no-go).
-- Run once in Supabase SQL Editor. Idempotent.

CREATE TABLE IF NOT EXISTS steer_send_shadow (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  draft_id BIGINT,            -- cs_ai_drafts.id
  gorgias_ticket_id BIGINT,
  steer TEXT NOT NULL,
  message_type TEXT,
  would_send BOOLEAN NOT NULL DEFAULT false,
  reason TEXT,
  pure_eligible BOOLEAN,      -- passed deterministic checks (verifier ran)
  action_changed BOOLEAN,     -- steer changed the proposed action_type
  verifier JSONB,             -- full Opus verifier output { would_send, concerns }
  draft_snapshot TEXT,        -- the steered draft at gate time (row survives later regens)
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_steersend_draft ON steer_send_shadow (draft_id);
CREATE INDEX IF NOT EXISTS idx_steersend_created ON steer_send_shadow (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_steersend_would_send ON steer_send_shadow (would_send) WHERE would_send;

-- Turn the shadow on in the same paste (opt-in DB flag, all runtimes).
INSERT INTO system_flags (key, enabled, note, updated_at)
VALUES ('steersend_shadow', true, 'Steer & Send shadow gate — records would_send verdicts on steered regens, nothing sends. Enabled with table creation.', now())
ON CONFLICT (key) DO UPDATE SET enabled = true, note = EXCLUDED.note, updated_at = now();
