-- ---------------------------------------------------------------------------
-- Webhook infrastructure tables
-- Run once in Supabase SQL Editor
-- ---------------------------------------------------------------------------

-- Webhook event log — every processed webhook (success or failure)
CREATE TABLE IF NOT EXISTS webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL,              -- 'shopify' | 'gorgias'
  topic text NOT NULL,               -- 'orders-create', 'ticket-message-created', etc.
  payload_id text,                   -- Shopify order ID, Gorgias ticket ID, etc.
  status text DEFAULT 'processed',   -- 'processed' | 'failed'
  processing_ms integer,
  error_message text,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_created ON webhook_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_events_status ON webhook_events(status) WHERE status = 'failed';

-- Auto-prune old events (keep 30 days)
-- Run as a Supabase cron or periodically:
-- DELETE FROM webhook_events WHERE created_at < now() - interval '30 days';

-- Dead letter queue — failed webhook payloads for retry
CREATE TABLE IF NOT EXISTS webhook_dead_letter (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL,
  topic text NOT NULL,
  payload jsonb NOT NULL,
  error_message text,
  retry_count integer DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  last_retry_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_webhook_dlq_created ON webhook_dead_letter(created_at DESC);
