-- 2026-07-29 — capture the operator's edit to a B2B draft, not just a boolean.
--
-- b2b_drafts.operator_edited told us THAT Jamie changed something; it never
-- told us WHAT. The body was partly recoverable (b2b_messages.body_text) but
-- with no draft_id linking the rows, and the subject had no per-message record
-- at all — only b2b_threads.subject, so a subject edited on a reply was lost.
--
-- These two columns make the before/after pair sit on one row, the same shape
-- as cs_ai_drafts.draft_response vs sent_response: `subject`/`body` stay the
-- advisor's originals, `sent_subject`/`sent_body` are what actually went out.
-- Edit patterns are the most reliable signal for where advisor judgment is
-- weak, and they only exist if we store both halves.

ALTER TABLE b2b_drafts ADD COLUMN IF NOT EXISTS sent_subject TEXT;
ALTER TABLE b2b_drafts ADD COLUMN IF NOT EXISTS sent_body    TEXT;

-- Backfill what is recoverable for already-sent drafts: the body from the
-- outbound message on the same company at the same send time. Subject is only
-- recoverable for drafts that opened a NEW thread (a reply inherits, and no
-- per-message subject was ever stored), so it stays null where unknowable
-- rather than guessing a value that would pollute the edit signal.
UPDATE b2b_drafts d
SET sent_body = m.body_text
FROM b2b_messages m
WHERE d.status = 'sent'
  AND d.sent_body IS NULL
  AND m.company_id = d.company_id
  AND m.direction = 'outbound'
  AND m.sent_at = d.sent_at;

COMMENT ON COLUMN b2b_drafts.sent_subject IS 'Subject actually sent; compare to subject (AI original) for the edit signal';
COMMENT ON COLUMN b2b_drafts.sent_body    IS 'Body actually sent; compare to body (AI original) for the edit signal';
