-- ============================================================================
-- Advocacy P.S. dedup — one-time "spread the word" ask per customer.
--
-- The CS advisor appends a short advocacy P.S. to a positive-resolution reply
-- (closing_ask = peer_parent | peer_self). It must never ask the same customer
-- twice. This table is the cross-ticket record, keyed by (normalized) email so
-- the primary key itself enforces once-ever.
--
-- Written at SEND time by the dashboard send hook (apiSendDraft) via an
-- idempotent upsert (ON CONFLICT DO NOTHING). Read at draft time by aiAdvisor
-- to inject the "already asked" fact into the prompt. Both sides fail soft: the
-- advisor treats a missing row/table as not-yet-asked.
--
-- MUST exist before the advisor prompt change ships — otherwise the P.S. would
-- send with no dedup.
-- ============================================================================

CREATE TABLE IF NOT EXISTS advocacy_asks_sent (
  customer_email     text PRIMARY KEY,           -- normalized (lowercased, gmail-aliased)
  closing_ask        text NOT NULL,              -- peer_parent | peer_self (what we asked)
  gorgias_ticket_id  bigint,                     -- the ticket the ask went out on
  draft_id           bigint,                     -- cs_ai_drafts row that carried it
  sent_at            timestamptz DEFAULT now()
);
