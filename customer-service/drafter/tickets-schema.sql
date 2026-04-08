-- Ticket-centric refactor: cs_tickets as primary entity, cs_ai_drafts as children
-- Run once in Supabase SQL Editor (after ai-drafts-schema.sql)

-- ============================================================
-- 1. cs_tickets — one row per Gorgias conversation
-- ============================================================
CREATE TABLE IF NOT EXISTS cs_tickets (
  id                      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  gorgias_ticket_id       bigint NOT NULL UNIQUE,
  status                  text NOT NULL DEFAULT 'open',    -- open | snoozed | closed
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
  closed_at               timestamptz,

  -- Gorgias sync
  gorgias_status          text,             -- raw Gorgias status for reconciliation
  gorgias_updated_at      timestamptz       -- last known Gorgias update time
);

CREATE INDEX IF NOT EXISTS idx_tickets_status ON cs_tickets (status);
CREATE INDEX IF NOT EXISTS idx_tickets_status_turn ON cs_tickets (status, turn_number);
CREATE INDEX IF NOT EXISTS idx_tickets_updated ON cs_tickets (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_tickets_customer ON cs_tickets (customer_email);

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
