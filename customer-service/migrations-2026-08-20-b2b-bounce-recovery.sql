-- 2026-08-20 — a bounced outreach email is work, not silence.
--
-- The 2026-08-19 partner check-in round sent 17 emails and two hard-bounced:
-- BAGLY (lflynn@bagly.org, 5.2.1 inactive) and Valid USA
-- (ax.switzer@validbybrodie.com, 5.1.1 no such user). Neither reached the
-- outreach engine. The detector existed and was correct; its only call site sat
-- under `if (m.is_sent || m.is_auto_reply) continue`, and the Gmail intake marks
-- mailer-daemon DSNs as auto-replies — so a bounce was exactly the message shape
-- that could never reach the bounce detector. It had never run.
--
-- Three columns, each closing a different way the miss turns into wrong state.
--
-- 1. b2b_messages.undelivered_at — the send row currently ASSERTS we contacted
--    BAGLY on 19 Aug, and three things read it as truth: lastOutboundAt (so the
--    cadence counts contact made), relationshipSummary (so the recap narrates a
--    check-in that never landed), and Tier 1's lastInbound > lastOutbound
--    comparison. Without this the record stays wrong even after a successful
--    resend: it would show two check-ins where one arrived. Nullable on purpose
--    — every existing row means "no bounce known", so there is nothing to
--    backfill and no moment where the column is half-true.
--
-- 2. b2b_contacts.bounced_at — "this mailbox is dead" and "we do not know who to
--    talk to" are different facts. Today a detected bounce sets
--    contact_unknown, which makes companyEligible() return false and drops the
--    company out of the queue entirely, and nothing in the panel renders that
--    flag — so detection working would have SILENTLY MUTED a partner, which is
--    worse than the current miss. Instead the dead address is retired
--    (is_active=false) and resolveRecipient falls through to the next contact on
--    its own; contact_unknown is reserved for when nothing reachable remains.
--    Recording bounced_at separately from is_active keeps "known dead" a query
--    rather than a text search through notes, which is what the follow-on bulk
--    address-verification pass will need.
--
-- 3. b2b_drafts.bounced_from_draft_id — the approved text survives the send in
--    sent_subject/sent_body, so recovery is a revival, not a regeneration (no
--    second Opus call, and Jamie gets HIS edit rather than the AI's original —
--    on draft #92 he rewrote it substantially). The bounced draft is NOT flipped
--    back to pending: sent_at, operator_edited and sent_body are the
--    operator-edit training signal, the b2b_messages row points at that send,
--    and a resend through sendDraftById would overwrite sent_body and destroy
--    the record that a first attempt was ever made. So the original stays 'sent'
--    as history and the revival is a new row pointing back at it.

ALTER TABLE b2b_messages ADD COLUMN IF NOT EXISTS undelivered_at TIMESTAMPTZ;
ALTER TABLE b2b_messages ADD COLUMN IF NOT EXISTS undelivered_reason TEXT;

ALTER TABLE b2b_contacts ADD COLUMN IF NOT EXISTS bounced_at TIMESTAMPTZ;

ALTER TABLE b2b_drafts ADD COLUMN IF NOT EXISTS bounced_from_draft_id BIGINT REFERENCES b2b_drafts(id);

-- One pending revival per bounced draft. The replay path is re-runnable by
-- design (it re-reads stored email_messages and is the catch-up for anything
-- the push path skipped), so without this a second run would hand Jamie two
-- identical drafts for the same dead address. Partial, because the uniqueness
-- claim is only about drafts still awaiting review — once one is sent or
-- dismissed, a later bounce on the same original may legitimately revive again.
CREATE UNIQUE INDEX IF NOT EXISTS b2b_drafts_one_pending_revival
  ON b2b_drafts (bounced_from_draft_id)
  WHERE bounced_from_draft_id IS NOT NULL AND status = 'pending';

-- Finding the send a bounce refers to: newest outbound to this address.
CREATE INDEX IF NOT EXISTS b2b_messages_to_email_sent_at
  ON b2b_messages (to_email, sent_at DESC)
  WHERE direction = 'outbound';
