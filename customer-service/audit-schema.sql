-- Audit log for tracking MCP server actions
-- Run once in Supabase SQL Editor

CREATE TABLE IF NOT EXISTS audit_log (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  action_type   text NOT NULL,           -- e.g. draft_order_created, exchange_created, draft_order_deleted
  actor         text DEFAULT 'claude_code',
  entity_type   text,                    -- e.g. draft_order, conversation, blog_post
  entity_id     text,                    -- Shopify GID or Supabase ID
  details       jsonb DEFAULT '{}',      -- Flexible metadata (customer email, amounts, items, etc.)
  created_at    timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log (action_type);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log (entity_type, entity_id);
