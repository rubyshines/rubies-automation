-- 2026-09-02: cc is part of the conversation record.
--
-- b2b_messages stored From and To but never Cc, so a contact cc'ing a
-- colleague was invisible everywhere downstream: the panel could not show who
-- else was on a message, and a reply drafted from the record silently dropped
-- them. Comma-joined addresses, same shape as to_email.
--
-- Run in the Supabase SQL editor BEFORE deploying the code that writes it —
-- inserts naming an unknown column fail, which would break inbound b2b
-- correlation until the column exists.

ALTER TABLE b2b_messages ADD COLUMN IF NOT EXISTS cc_email TEXT;
