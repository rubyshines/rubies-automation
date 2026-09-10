-- 2026-09-10 — commitments table + meeting notes columns + duplicate-event link.
--
-- Apply BEFORE deploying the code. Idempotent.
--
-- 1. b2b_commitments: see b2b-commitments-schema.sql (repeated here so one file
--    applies the whole change).
-- 2. b2b_meetings gains the Wispr notes: summary, share link, meeting id, the
--    transcript (stored on the row, never fed to an AI context), and when the
--    notes were fetched.
-- 3. b2b_meetings.linked_event_ids: when our Book & Send event and the
--    partner's own invite for the SAME call arrive as two Google events, the
--    second event id is recorded on the first row instead of making a second
--    row (Le JAG, 2026-09-10 — two rows for one 9:30 call).

CREATE TABLE IF NOT EXISTS b2b_commitments (
  id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id           TEXT REFERENCES b2b_companies(id),
  thread_id            BIGINT REFERENCES b2b_threads(id),
  meeting_id           BIGINT REFERENCES b2b_meetings(id),
  source_message_id    BIGINT,
  owner                TEXT NOT NULL,
  text                 TEXT NOT NULL,
  original_text        TEXT,
  due_on               DATE,
  status               TEXT NOT NULL DEFAULT 'open',
  done_at              TIMESTAMPTZ,
  done_by              TEXT,
  done_message_id      BIGINT,
  completes_on_send    BOOLEAN NOT NULL DEFAULT FALSE,
  blocked_by           BIGINT REFERENCES b2b_commitments(id),
  pinned_at            TIMESTAMPTZ,
  source               TEXT NOT NULL,
  created_by           TEXT NOT NULL DEFAULT 'operator',
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  updated_at           TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_b2b_commitments_company_status ON b2b_commitments (company_id, status);
CREATE INDEX IF NOT EXISTS idx_b2b_commitments_owner_open ON b2b_commitments (owner, due_on) WHERE status = 'open';

ALTER TABLE b2b_meetings ADD COLUMN IF NOT EXISTS summary            TEXT;
ALTER TABLE b2b_meetings ADD COLUMN IF NOT EXISTS transcript         TEXT;
ALTER TABLE b2b_meetings ADD COLUMN IF NOT EXISTS wispr_meeting_id   TEXT;
ALTER TABLE b2b_meetings ADD COLUMN IF NOT EXISTS wispr_share_link   TEXT;
ALTER TABLE b2b_meetings ADD COLUMN IF NOT EXISTS notes_fetched_at   TIMESTAMPTZ;
ALTER TABLE b2b_meetings ADD COLUMN IF NOT EXISTS linked_event_ids   TEXT[];

-- 4. oauth_tokens: where the server keeps a refreshed OAuth token it holds on
--    its own behalf (Wispr Flow first). A refresh may rotate the refresh token,
--    and a Railway env var cannot be rewritten by the app, so the live copy
--    lives here; WISPR_TOKEN_JSON is only the bootstrap.
CREATE TABLE IF NOT EXISTS oauth_tokens (
  key        TEXT PRIMARY KEY,
  token      JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
