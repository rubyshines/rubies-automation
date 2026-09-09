-- 2026-09-09 — calendar-driven meetings + no-show outcome + calendar MIME method.
--
-- b2b_meetings rows now come from Google Calendar for EVERY call, ours or the
-- partner's (see b2b-outreach/lib/meetingSync.js), and the operator records
-- whether a call actually happened. email_messages gains the calendar MIME
-- method so an RSVP in any language is recognised as machine mail.
--
-- Idempotent. Apply BEFORE deploying the code: the Gmail push path upserts
-- calendar_method, so a deploy ahead of this file would fail the CS-critical
-- intake on every message.

ALTER TABLE b2b_meetings ADD COLUMN IF NOT EXISTS organizer_email     TEXT;
ALTER TABLE b2b_meetings ADD COLUMN IF NOT EXISTS source              TEXT NOT NULL DEFAULT 'operator'; -- 'operator' | 'calendar_sync'
ALTER TABLE b2b_meetings ADD COLUMN IF NOT EXISTS attendee_responses  JSONB;   -- [{email, response}] from the calendar event
ALTER TABLE b2b_meetings ADD COLUMN IF NOT EXISTS synced_at           TIMESTAMPTZ;
ALTER TABLE b2b_meetings ADD COLUMN IF NOT EXISTS outcome             TEXT;    -- 'held' | 'no_show' (null = not recorded)
ALTER TABLE b2b_meetings ADD COLUMN IF NOT EXISTS outcome_at          TIMESTAMPTZ;
ALTER TABLE b2b_meetings ADD COLUMN IF NOT EXISTS outcome_note        TEXT;

CREATE INDEX IF NOT EXISTS idx_b2b_meetings_company_outcome
  ON b2b_meetings (company_id, outcome) WHERE outcome IS NOT NULL;

-- 'REQUEST' | 'REPLY' | 'CANCEL' | ... from a text/calendar MIME part; null when none.
ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS calendar_method TEXT;
