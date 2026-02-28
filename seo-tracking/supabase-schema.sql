I think-- RUBIES SEO Backfill — Supabase schema
-- Run this once in Supabase SQL Editor if you don't set SUPABASE_DATABASE_URL (script can create tables via pg when that is set).

-- gsc_daily_summary
CREATE TABLE IF NOT EXISTS gsc_daily_summary (
  date date PRIMARY KEY,
  clicks integer NOT NULL DEFAULT 0,
  impressions integer NOT NULL DEFAULT 0,
  ctr decimal NOT NULL DEFAULT 0,
  position decimal NOT NULL DEFAULT 0
);

-- gsc_keywords
CREATE TABLE IF NOT EXISTS gsc_keywords (
  date date NOT NULL,
  keyword text NOT NULL,
  keyword_type text NOT NULL,
  clicks integer NOT NULL DEFAULT 0,
  impressions integer NOT NULL DEFAULT 0,
  ctr decimal NOT NULL DEFAULT 0,
  position decimal NOT NULL DEFAULT 0,
  PRIMARY KEY (date, keyword)
);

CREATE INDEX IF NOT EXISTS idx_gsc_keywords_date ON gsc_keywords(date);
CREATE INDEX IF NOT EXISTS idx_gsc_keywords_keyword ON gsc_keywords(keyword);
CREATE INDEX IF NOT EXISTS idx_gsc_keywords_keyword_type ON gsc_keywords(keyword_type);
CREATE INDEX IF NOT EXISTS idx_gsc_keywords_date_keyword ON gsc_keywords(date, keyword);

-- gsc_keyword_pages
CREATE TABLE IF NOT EXISTS gsc_keyword_pages (
  date date NOT NULL,
  keyword text NOT NULL,
  page_url text NOT NULL,
  keyword_type text NOT NULL,
  clicks integer NOT NULL DEFAULT 0,
  impressions integer NOT NULL DEFAULT 0,
  ctr decimal NOT NULL DEFAULT 0,
  position decimal NOT NULL DEFAULT 0,
  PRIMARY KEY (date, keyword, page_url)
);

CREATE INDEX IF NOT EXISTS idx_gsc_kp_date ON gsc_keyword_pages(date);
CREATE INDEX IF NOT EXISTS idx_gsc_kp_keyword ON gsc_keyword_pages(keyword);
CREATE INDEX IF NOT EXISTS idx_gsc_kp_page_url ON gsc_keyword_pages(page_url);
CREATE INDEX IF NOT EXISTS idx_gsc_kp_date_keyword ON gsc_keyword_pages(date, keyword);
CREATE INDEX IF NOT EXISTS idx_gsc_kp_keyword_page ON gsc_keyword_pages(keyword, page_url);

-- gsc_pages
CREATE TABLE IF NOT EXISTS gsc_pages (
  date date NOT NULL,
  page_url text NOT NULL,
  clicks integer NOT NULL DEFAULT 0,
  impressions integer NOT NULL DEFAULT 0,
  ctr decimal NOT NULL DEFAULT 0,
  position decimal NOT NULL DEFAULT 0,
  PRIMARY KEY (date, page_url)
);

CREATE INDEX IF NOT EXISTS idx_gsc_pages_date ON gsc_pages(date);
CREATE INDEX IF NOT EXISTS idx_gsc_pages_page_url ON gsc_pages(page_url);
CREATE INDEX IF NOT EXISTS idx_gsc_pages_date_page ON gsc_pages(date, page_url);

-- shopify_daily_channels
CREATE TABLE IF NOT EXISTS shopify_daily_channels (
  date date NOT NULL,
  channel text NOT NULL,
  sessions integer NOT NULL DEFAULT 0,
  orders integer NOT NULL DEFAULT 0,
  revenue decimal NOT NULL DEFAULT 0,
  conversion_rate decimal NOT NULL DEFAULT 0,
  avg_order_value decimal NOT NULL DEFAULT 0,
  new_customers integer NOT NULL DEFAULT 0,
  returning_customers integer NOT NULL DEFAULT 0,
  PRIMARY KEY (date, channel)
);

CREATE INDEX IF NOT EXISTS idx_shopify_channels_date ON shopify_daily_channels(date);
CREATE INDEX IF NOT EXISTS idx_shopify_channels_channel ON shopify_daily_channels(channel);
CREATE INDEX IF NOT EXISTS idx_shopify_channels_date_channel ON shopify_daily_channels(date, channel);

-- shopify_geography
CREATE TABLE IF NOT EXISTS shopify_geography (
  date date NOT NULL,
  country text NOT NULL,
  sessions integer NOT NULL DEFAULT 0,
  orders integer NOT NULL DEFAULT 0,
  revenue decimal NOT NULL DEFAULT 0,
  conversion_rate decimal NOT NULL DEFAULT 0,
  PRIMARY KEY (date, country)
);

CREATE INDEX IF NOT EXISTS idx_shopify_geo_date ON shopify_geography(date);
CREATE INDEX IF NOT EXISTS idx_shopify_geo_country ON shopify_geography(country);

-- ga4_daily
CREATE TABLE IF NOT EXISTS ga4_daily (
  date date PRIMARY KEY,
  sessions integer NOT NULL DEFAULT 0,
  users integer NOT NULL DEFAULT 0,
  new_users integer NOT NULL DEFAULT 0,
  returning_users integer NOT NULL DEFAULT 0,
  engaged_sessions integer NOT NULL DEFAULT 0,
  engagement_rate decimal NOT NULL DEFAULT 0,
  pages_per_session decimal NOT NULL DEFAULT 0,
  avg_session_duration decimal NOT NULL DEFAULT 0,
  bounce_rate decimal NOT NULL DEFAULT 0
);

-- ga4_landing_pages
CREATE TABLE IF NOT EXISTS ga4_landing_pages (
  date date NOT NULL,
  landing_page text NOT NULL,
  sessions integer,
  engaged_sessions integer,
  engagement_rate decimal,
  avg_session_duration decimal,
  PRIMARY KEY (date, landing_page)
);

CREATE INDEX IF NOT EXISTS idx_ga4_lp_date ON ga4_landing_pages(date);
CREATE INDEX IF NOT EXISTS idx_ga4_lp_landing_page ON ga4_landing_pages(landing_page);
CREATE INDEX IF NOT EXISTS idx_ga4_lp_date_page ON ga4_landing_pages(date, landing_page);
