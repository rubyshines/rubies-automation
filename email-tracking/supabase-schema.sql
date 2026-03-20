-- RUBIES Email Marketing (Klaviyo) — Supabase schema
-- Run once in Supabase SQL Editor.

-- Account-level daily email metrics
CREATE TABLE IF NOT EXISTS klaviyo_daily_metrics (
  date date PRIMARY KEY,
  emails_sent integer NOT NULL DEFAULT 0,
  opens integer NOT NULL DEFAULT 0,
  clicks integer NOT NULL DEFAULT 0,
  bounces integer NOT NULL DEFAULT 0,
  unsubscribes integer NOT NULL DEFAULT 0,
  spam_complaints integer NOT NULL DEFAULT 0,
  open_rate decimal NOT NULL DEFAULT 0,
  click_rate decimal NOT NULL DEFAULT 0,
  bounce_rate decimal NOT NULL DEFAULT 0,
  unsubscribe_rate decimal NOT NULL DEFAULT 0
);

ALTER TABLE klaviyo_daily_metrics ENABLE ROW LEVEL SECURITY;

-- Per-campaign cumulative stats
CREATE TABLE IF NOT EXISTS klaviyo_campaigns (
  campaign_id text PRIMARY KEY,
  campaign_name text NOT NULL DEFAULT '',
  subject text NOT NULL DEFAULT '',
  send_date date,
  recipients integer NOT NULL DEFAULT 0,
  opens integer NOT NULL DEFAULT 0,
  clicks integer NOT NULL DEFAULT 0,
  open_rate decimal NOT NULL DEFAULT 0,
  click_rate decimal NOT NULL DEFAULT 0,
  bounce_rate decimal NOT NULL DEFAULT 0,
  unsubscribe_rate decimal NOT NULL DEFAULT 0,
  conversions integer NOT NULL DEFAULT 0,
  conversion_value decimal NOT NULL DEFAULT 0,
  conversion_rate decimal NOT NULL DEFAULT 0,
  average_order_value decimal NOT NULL DEFAULT 0,
  content_text text NOT NULL DEFAULT '',
  updated_at timestamp with time zone DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_klaviyo_campaigns_send_date ON klaviyo_campaigns(send_date);
ALTER TABLE klaviyo_campaigns ENABLE ROW LEVEL SECURITY;

-- Flow metadata snapshot
CREATE TABLE IF NOT EXISTS klaviyo_flows (
  flow_id text PRIMARY KEY,
  flow_name text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT '',
  trigger_type text NOT NULL DEFAULT '',
  updated_at timestamp with time zone DEFAULT now()
);

ALTER TABLE klaviyo_flows ENABLE ROW LEVEL SECURITY;
