-- 2026-08-28 — mailbox verification is a fact about an ADDRESS, not a contact row.
--
-- The 2026-08-19 partner round bounced at 12% (2 of 17) against the ~2% that
-- damages sender reputation on rubyshines.com — the domain Klaviyo shares. Both
-- dead addresses were individual mailboxes on healthy domains (bagly.org
-- published working MX throughout), which is the churn-driven failure mode a
-- syntax/MX check cannot see and an SMTP-probe verification service can.
--
-- One table keyed on the normalized address, because the same address can
-- appear as a b2b_contacts row, a b2b_companies.general_email, and a historical
-- alternate offered by bounce recovery. Storing the verdict per holding row
-- would create denormalized copies to chase — the exact trap the bounce work
-- hit with b2b_companies.last_outbound_at.
--
-- Reading rules (enforced in code, stated here because they are the design):
--   * Only status = 'undeliverable' ever blocks a send. A missing row, a failed
--     lookup, or this table not existing yet all mean "unverified — proceed".
--     A guard that can never pass is indistinguishable from an empty queue
--     (2026-08-27), and the whole book starts unverified.
--   * NULL-in-absence vs 'unknown'-in-presence are different answers: no row
--     means never checked; 'unknown' means the vendor probed and could not tell.

CREATE TABLE IF NOT EXISTS b2b_email_verifications (
  email TEXT PRIMARY KEY,              -- normalized: trimmed, lowercased
  status TEXT NOT NULL,                -- 'deliverable' | 'undeliverable' | 'risky' | 'unknown'
  reason TEXT,                         -- vendor sub-code, e.g. 'rejected_email', plus did-you-mean hints
  sendex NUMERIC,                      -- Kickbox 0..1 address quality score
  verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source TEXT                          -- 'intake' | 'operator_update' | 'enrich' | 'backfill'
);

-- The sweep re-verifies stale rows; the guards read single addresses by PK.
CREATE INDEX IF NOT EXISTS b2b_email_verifications_verified_at
  ON b2b_email_verifications (verified_at);
