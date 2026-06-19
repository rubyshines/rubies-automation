-- shopify_sessions_daily — daily total online-store sessions via ShopifyQL
-- (analytics/sync-sessions.js). Powers the signup conversion rate.
CREATE TABLE IF NOT EXISTS shopify_sessions_daily (
  date               date PRIMARY KEY,
  sessions           integer NOT NULL DEFAULT 0,
  completed_checkout integer NOT NULL DEFAULT 0,
  updated_at         timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE shopify_sessions_daily ENABLE ROW LEVEL SECURITY;
