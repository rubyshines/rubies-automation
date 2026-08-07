-- Away mode: a first-contact out-of-office acknowledgment sent while Jamie is
-- unreachable, plus the generic self-expiring-flag support it rests on.
-- Runnable as-is in the Supabase SQL Editor; idempotent.

-- 1. Self-expiring flags.
--
-- The whole point of away mode is that nobody has to remember to switch it off.
-- `expires_at` makes that a property of the flag system rather than of this one
-- feature: shared/systemFlags.js reads a flag as DISABLED once expires_at has
-- passed, so a window that ends is a window that closes itself. NULL means the
-- flag never expires, which is how every pre-existing flag keeps behaving.
ALTER TABLE system_flags ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

-- 2. The away-mode flag itself. Default OFF with no expiry — the CLI
-- (scripts/awayMode.js) sets both when a trip starts.
--
-- `note` carries the customer-facing return phrase (e.g. "Sunday, August 9"),
-- so the next trip is a CLI invocation and not a code change.
INSERT INTO system_flags (key, enabled, note)
VALUES ('cs_away_mode', false, NULL)
ON CONFLICT (key) DO NOTHING;

-- 3. Per-ticket idempotency for the acknowledgment.
--
-- cs_ai_drafts already carries UNIQUE(gorgias_ticket_id, gorgias_message_id),
-- which the advisor draft for this same message occupies — so the ack cannot
-- claim its slot there the way the thank-you auto-close does. The natural key
-- for "this customer has been told once" is the ticket, and a conditional
-- UPDATE ... WHERE away_ack_sent_at IS NULL is the atomic claim that makes
-- concurrent intake runs (webhook vs reconcile vs resync) send exactly one.
ALTER TABLE cs_tickets ADD COLUMN IF NOT EXISTS away_ack_sent_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_tickets_away_ack ON cs_tickets (away_ack_sent_at)
  WHERE away_ack_sent_at IS NOT NULL;
