-- AI Draft System: poller → dashboard → Gorgias reply
-- Run once in Supabase SQL Editor

-- ============================================================
-- 1. Poller state (high-water mark for polling)
-- ============================================================
CREATE TABLE IF NOT EXISTS cs_poller_state (
  id            text PRIMARY KEY DEFAULT 'gorgias_drafter',
  last_poll_at  timestamptz DEFAULT now() - interval '1 hour',
  updated_at    timestamptz DEFAULT now()
);

-- Seed initial row
INSERT INTO cs_poller_state (id) VALUES ('gorgias_drafter')
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- 2. AI drafts (one per customer message)
-- ============================================================
CREATE TABLE IF NOT EXISTS cs_ai_drafts (
  id                      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  gorgias_ticket_id       bigint NOT NULL,
  gorgias_message_id      bigint NOT NULL,

  -- Customer context snapshot
  customer_email          text,
  customer_name           text,
  customer_pronouns       text,
  customer_country        text,
  order_number            text,

  -- AI output
  draft_response          text NOT NULL,
  structured_output       jsonb NOT NULL,
  intake_state            jsonb,
  audit_trail             text[],
  confidence              text NOT NULL DEFAULT 'low',   -- high | medium | low
  advisor_status          text,                          -- ready | needs_info | gathering | route_to_human
  message_type            text,                          -- exchange | refund | defect | sizing_inquiry | ...

  -- Context snapshots (for dashboard display)
  conversation_history    jsonb,                         -- [{sender, body, created_at}]
  order_context           jsonb,                         -- order details used by advisor
  customer_context        jsonb,                         -- customer profile used by advisor

  -- Review workflow
  status                  text NOT NULL DEFAULT 'pending',  -- pending | sent | superseded | released
  sent_response           text,                          -- what was actually sent (may differ from draft)
  edit_distance           float,                         -- 0.0 = identical, 1.0 = completely rewritten
  feedback_notes          text,                          -- optional training notes from Jamie
  reviewed_at             timestamptz,
  sent_at                 timestamptz,
  gorgias_reply_message_id bigint,

  -- Action execution
  action_type             text,                          -- exchange | refund | null (no action yet)
  action_result           jsonb,                         -- {draft_order_id, draft_order_url, refund_id, ...}
  action_executed_at      timestamptz,

  -- Follow-up tracking (3-day no-reply)
  follow_up_draft_id      bigint REFERENCES cs_ai_drafts(id),

  -- Multi-turn tracking
  turn_number             integer DEFAULT 1,
  previous_draft_id       bigint REFERENCES cs_ai_drafts(id),

  created_at              timestamptz DEFAULT now(),

  UNIQUE(gorgias_ticket_id, gorgias_message_id)
);

CREATE INDEX IF NOT EXISTS idx_drafts_status ON cs_ai_drafts (status);
CREATE INDEX IF NOT EXISTS idx_drafts_ticket ON cs_ai_drafts (gorgias_ticket_id);
CREATE INDEX IF NOT EXISTS idx_drafts_created ON cs_ai_drafts (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_drafts_confidence ON cs_ai_drafts (confidence);

-- ============================================================
-- 3. Feedback log (one row per send/release action)
-- ============================================================
CREATE TABLE IF NOT EXISTS cs_ai_feedback_log (
  id                      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  draft_id                bigint REFERENCES cs_ai_drafts(id),
  gorgias_ticket_id       bigint,
  action                  text NOT NULL,                 -- sent | edited | released | bypassed
  original_response       text,
  final_response          text,
  edit_distance           float,                         -- 0.0 = identical, 1.0 = rewritten
  feedback_notes          text,
  advisor_status          text,
  confidence              text,
  message_type            text,
  turn_number             integer,
  created_at              timestamptz DEFAULT now()
);

-- status: 'new' (unreviewed) | 'addressed' (fix implemented)
ALTER TABLE cs_ai_feedback_log ADD COLUMN IF NOT EXISTS status text DEFAULT 'new';

CREATE INDEX IF NOT EXISTS idx_feedback_action ON cs_ai_feedback_log (action);
CREATE INDEX IF NOT EXISTS idx_feedback_created ON cs_ai_feedback_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_message_type ON cs_ai_feedback_log (message_type);

-- ============================================================
-- 4. Simulator sessions (interactive training)
-- ============================================================
CREATE TABLE IF NOT EXISTS cs_simulator_sessions (
  id                      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_conversation_id  text,
  customer_email          text NOT NULL,
  order_number            text,
  order_context           jsonb,
  customer_context        jsonb,
  turns                   jsonb NOT NULL DEFAULT '[]',
  status                  text DEFAULT 'in_progress',
  created_at              timestamptz DEFAULT now(),
  completed_at            timestamptz
);

CREATE INDEX IF NOT EXISTS idx_sim_sessions_created ON cs_simulator_sessions (created_at DESC);
