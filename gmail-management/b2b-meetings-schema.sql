-- ---------------------------------------------------------------------------
-- b2b_meetings — calls booked with a company, one row per meeting.
--
-- A table rather than columns on b2b_threads because a relationship has several
-- calls over its life, and the summary wants to say "call held 12 August" long
-- after the thread it was arranged in has closed.
--
-- Run in the Supabase SQL editor. Idempotent.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS b2b_meetings (
  id                     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id             TEXT REFERENCES b2b_companies(id) NOT NULL,
  thread_id              BIGINT REFERENCES b2b_threads(id),

  google_event_id        TEXT NOT NULL,
  google_calendar_id     TEXT NOT NULL,
  meet_url               TEXT,
  html_link              TEXT,

  title                  TEXT NOT NULL,
  starts_at              TIMESTAMPTZ NOT NULL,
  ends_at                TIMESTAMPTZ NOT NULL,
  duration_minutes       INT NOT NULL,

  attendee_emails        TEXT[],
  their_timezone         TEXT,          -- IANA zone used for the "their time" label
  their_timezone_source  TEXT,          -- 'stated' | 'inferred from …' | 'operator'

  status                 TEXT NOT NULL DEFAULT 'booked',  -- 'booked' | 'cancelled'
  booked_by              TEXT,                            -- 'operator' | advisor name
  notes                  TEXT,

  created_at             TIMESTAMPTZ DEFAULT NOW(),
  updated_at             TIMESTAMPTZ DEFAULT NOW()
);

-- Scoped to the company, NOT a bare UNIQUE(google_event_id).
--
-- Same reasoning as the b2b_threads fix (2026-08-13): a uniqueness constraint is
-- a claim about the world, and UNIQUE on an external system's id asserts that the
-- external entity belongs to exactly one of ours. A single call can legitimately
-- be with two organizations, and a bare unique index would force the second row
-- into either a failed insert or a silent overwrite of the first.
CREATE UNIQUE INDEX IF NOT EXISTS idx_b2b_meetings_company_event
  ON b2b_meetings (company_id, google_event_id);

-- The cadence asks "does this company have a call coming up?" on every queue
-- build, so that lookup gets its own index.
CREATE INDEX IF NOT EXISTS idx_b2b_meetings_company_starts
  ON b2b_meetings (company_id, starts_at) WHERE status = 'booked';

CREATE INDEX IF NOT EXISTS idx_b2b_meetings_thread
  ON b2b_meetings (thread_id) WHERE thread_id IS NOT NULL;
