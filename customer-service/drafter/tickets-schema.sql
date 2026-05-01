-- Ticket-centric refactor: cs_tickets as primary entity, cs_ai_drafts as children
-- Run once in Supabase SQL Editor (after ai-drafts-schema.sql)

-- ============================================================
-- 1. cs_tickets — one row per Gorgias conversation
-- ============================================================
CREATE TABLE IF NOT EXISTS cs_tickets (
  id                      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  gorgias_ticket_id       bigint NOT NULL UNIQUE,
  status                  text NOT NULL DEFAULT 'open',    -- open | snoozed | closed | parked
  turn_number             integer NOT NULL DEFAULT 1,

  -- Customer (denormalized for queue display)
  customer_email          text,
  customer_name           text,
  customer_pronouns       text,
  customer_country        text,
  order_number            text,

  -- Conversation (moved from per-draft snapshots)
  conversation_history    jsonb,            -- [{id, sender, body, body_html, created_at, channel}]
  order_context           jsonb,
  customer_context        jsonb,

  -- Active draft pointer (the pending draft, if any)
  active_draft_id         bigint,

  -- Latest draft metadata (for queue display without joining)
  message_type            text,             -- exchange | refund | sizing_inquiry | ...
  confidence              text,             -- high | medium | low
  advisor_status          text,             -- ready | needs_info | gathering | route_to_human

  -- Timestamps
  created_at              timestamptz DEFAULT now(),
  updated_at              timestamptz DEFAULT now(),
  snoozed_at              timestamptz,
  parked_at               timestamptz,
  closed_at               timestamptz,

  -- Source tracking
  source                  text DEFAULT 'gorgias',  -- gorgias | gmail

  -- Gorgias sync
  gorgias_status          text,             -- raw Gorgias status for reconciliation
  gorgias_updated_at      timestamptz       -- last known Gorgias update time
);

CREATE INDEX IF NOT EXISTS idx_tickets_status ON cs_tickets (status);
CREATE INDEX IF NOT EXISTS idx_tickets_status_turn ON cs_tickets (status, turn_number);
CREATE INDEX IF NOT EXISTS idx_tickets_updated ON cs_tickets (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_tickets_customer ON cs_tickets (customer_email);

-- history_summary: 2-4 sentence prose summary of what happened on this ticket,
-- used to inject prior ticket context into the advisor for second-round follow-ups.
ALTER TABLE cs_tickets ADD COLUMN IF NOT EXISTS history_summary text;
CREATE INDEX IF NOT EXISTS idx_tickets_prior_lookup
  ON cs_tickets (customer_email, status, message_type, closed_at DESC);

-- customer_sentiment: overall tone of the customer across their messages.
-- Orthogonal to message_type (which is the inquiry category).
-- Allowed values: 'positive' | 'neutral' | 'negative' | null
ALTER TABLE cs_tickets ADD COLUMN IF NOT EXISTS customer_sentiment text;

-- follow_up_stage: tracks auto follow-up progress (event-driven off Gorgias snooze expiry).
-- 0 = no follow-up sent, 1 = care@ follow-up sent, 2 = jamie@ personal email sent + closed.
-- Reset to 0 when customer replies during snooze.
ALTER TABLE cs_tickets ADD COLUMN IF NOT EXISTS follow_up_stage integer DEFAULT 0;

-- test_snooze: temporary flag for follow-up testing. When true, snooze durations use ~5 min
-- instead of 3 days. Set per-ticket by the "Send & Snooze (Test)" button. Remove column after testing.
ALTER TABLE cs_tickets ADD COLUMN IF NOT EXISTS test_snooze boolean DEFAULT false;

-- viewed_at: tracks when the operator last viewed this ticket's detail in the dashboard.
-- last_customer_message_at: timestamp of the most recent customer message in conversation_history.
-- A ticket is "unread" when viewed_at IS NULL or viewed_at < last_customer_message_at.
-- We use last_customer_message_at instead of updated_at because updated_at gets bumped by
-- agent actions, syncs, and status changes — not just new customer messages.
ALTER TABLE cs_tickets ADD COLUMN IF NOT EXISTS viewed_at timestamptz;
ALTER TABLE cs_tickets ADD COLUMN IF NOT EXISTS last_customer_message_at timestamptz;

-- auto_close_path: marks tickets closed by an automated fast path (no human review).
-- Mirrors the column on cs_ai_drafts so the dashboard queue can show a pill without
-- joining. Values: 'thank_you' for the thank-you closer fast path. Null for tickets
-- closed normally.
ALTER TABLE cs_tickets ADD COLUMN IF NOT EXISTS auto_close_path text;
CREATE INDEX IF NOT EXISTS idx_tickets_auto_close_path ON cs_tickets (auto_close_path)
  WHERE auto_close_path IS NOT NULL;

-- initiated_by: who started the conversation. Default 'customer' for the inbound
-- pipeline (customer messages → webhook → cs_tickets row). Set to 'operator' for
-- proactive outbound tickets created via customerOutreach.sendIncidentOutreach()
-- and similar operator-initiated paths. Used for analytics and dashboard badges;
-- not consulted by intake or follow-up logic.
ALTER TABLE cs_tickets ADD COLUMN IF NOT EXISTS initiated_by text DEFAULT 'customer';
CREATE INDEX IF NOT EXISTS idx_tickets_initiated_by ON cs_tickets (initiated_by);

-- gorgias_ticket_id nullable: ad-hoc operator outreach drafts (composed by the
-- standalone operator console via create_outreach_ticket) stage as cs_tickets +
-- cs_ai_drafts rows BEFORE any Gorgias ticket exists. The Gorgias ticket is
-- created lazily on send by the dashboard, which back-fills gorgias_ticket_id
-- on both rows. NULLs are still distinct under the UNIQUE constraint, so we
-- only need to drop NOT NULL on both tables.
ALTER TABLE cs_tickets ALTER COLUMN gorgias_ticket_id DROP NOT NULL;
ALTER TABLE cs_ai_drafts ALTER COLUMN gorgias_ticket_id DROP NOT NULL;

-- ============================================================
-- 2. Add ticket_id FK on cs_ai_drafts
-- ============================================================
ALTER TABLE cs_ai_drafts ADD COLUMN IF NOT EXISTS ticket_id bigint REFERENCES cs_tickets(id);
CREATE INDEX IF NOT EXISTS idx_drafts_ticket_id ON cs_ai_drafts (ticket_id);

-- ============================================================
-- 3. Deferred FK for active_draft_id (circular reference)
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_active_draft'
  ) THEN
    ALTER TABLE cs_tickets ADD CONSTRAINT fk_active_draft
      FOREIGN KEY (active_draft_id) REFERENCES cs_ai_drafts(id);
  END IF;
END $$;
