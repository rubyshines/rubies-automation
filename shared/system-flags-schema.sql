-- Runtime feature flags, read by all services via shared/systemFlags.js.
-- Single source of truth across the webhook server, cron services, and dashboard —
-- replaces per-service env-var toggles that required manual propagation
-- (scripts/copy-railway-vars.js) and silently diverged across runtimes.
-- Runnable as-is in the Supabase SQL Editor; idempotent.

CREATE TABLE IF NOT EXISTS system_flags (
  key        TEXT PRIMARY KEY,
  enabled    BOOLEAN NOT NULL DEFAULT false,
  note       TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- CS shadow / diagnostics eval toggle. Default OFF: it doubles every advisor and
-- operator call (Sonnet draft + Opus judge) and only has value during an active
-- model evaluation. Running it unintentionally cost ~$9-10/day. To re-enable a
-- model eval, set enabled = true here (propagates to all runtimes within ~60s);
-- no env vars, no per-service propagation.
INSERT INTO system_flags (key, enabled, note)
VALUES ('cs_diagnostics', false, 'Shadow model eval for CS advisor + operator. Default off — ~$9-10/day when on.')
ON CONFLICT (key) DO NOTHING;
