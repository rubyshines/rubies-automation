-- ---------------------------------------------------------------------------
-- b2b_commitments — one row per promise: what, to whom, who owes it, by when,
-- and whether it is done.
--
-- The first structured definition of a commitment in the system (2026-09-10).
-- Before this the record held prose only: a relationship summary with ONE
-- next-step sentence per company, and the advisor's free-text promise list on a
-- draft, rewritten every pass and visible only by opening the company. A call
-- produces several concrete commitments on both sides, and that is the object
-- that was missing.
--
-- On Me is derived from this table (see b2b-outreach/lib/commitments.js
-- syncOnMeFlag): a company is on Jamie when it has at least one open row with
-- owner='me'. b2b_companies.on_me_at / on_me_source / on_me_note are kept as a
-- denormalised copy maintained by that one write path — the same status as
-- last_outbound_at — so every existing reader (cadence suppression, the
-- pending-draft merge, the panel badge) keeps working unchanged.
--
-- Run in the Supabase SQL editor. Idempotent.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS b2b_commitments (
  id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id           TEXT REFERENCES b2b_companies(id),     -- nullable: a general item
  thread_id            BIGINT REFERENCES b2b_threads(id),
  meeting_id           BIGINT REFERENCES b2b_meetings(id),
  source_message_id    BIGINT,                                -- b2b_messages.id it was read from

  owner                TEXT NOT NULL,                         -- 'me' | 'them'
  text                 TEXT NOT NULL,
  original_text        TEXT,                                  -- as captured, before any operator edit
  due_on               DATE,

  status               TEXT NOT NULL DEFAULT 'open',          -- 'open' | 'done'
  done_at              TIMESTAMPTZ,
  done_by              TEXT,                                  -- 'operator' | 'engine' | 'send'
  done_message_id      BIGINT,                                -- b2b_messages.id that settled it
  completes_on_send    BOOLEAN NOT NULL DEFAULT FALSE,        -- a claim-created reply item: any send on its thread completes it
  blocked_by           BIGINT REFERENCES b2b_commitments(id),
  pinned_at            TIMESTAMPTZ,                           -- "today"

  source               TEXT NOT NULL,                         -- 'meeting' | 'email' | 'claim' | 'cadence' | 'manual' | 'backfill'
  created_by           TEXT NOT NULL DEFAULT 'operator',      -- 'operator' | 'engine'
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  updated_at           TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_b2b_commitments_company_status
  ON b2b_commitments (company_id, status);

CREATE INDEX IF NOT EXISTS idx_b2b_commitments_owner_open
  ON b2b_commitments (owner, due_on) WHERE status = 'open';
