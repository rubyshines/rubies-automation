-- ============================================================================
-- RUBIES Shipping — Tracking + Zone Tables
-- Run in Supabase SQL Editor to create all tables.
-- ============================================================================

-- Shipping zones synced from Shopify DeliveryProfile API
CREATE TABLE IF NOT EXISTS shipping_zones (
  country_code TEXT PRIMARY KEY,
  country_name TEXT NOT NULL,
  zone TEXT NOT NULL,                    -- 'us', 'canada', 'ddp', 'ddu'
  duties_prepaid BOOLEAN DEFAULT FALSE,  -- true for DDP countries
  free_shipping_threshold NUMERIC,       -- e.g. 99.00 for US, 96.00 for CA
  standard_rate NUMERIC,                 -- e.g. 9.00 for US, 12.00 for intl
  expedited_rate NUMERIC,                -- e.g. 22.00 for US expedited
  currency TEXT DEFAULT 'USD',
  synced_at TIMESTAMPTZ DEFAULT NOW()
);

-- Tracking snapshots — cached scrape results
CREATE TABLE IF NOT EXISTS tracking_snapshots (
  tracking_number TEXT PRIMARY KEY,
  order_number INTEGER,
  carrier TEXT NOT NULL,                 -- 'usps', 'ontrac', 'passport'
  tracking_url TEXT,
  destination_country TEXT,
  shipping_zone TEXT,                    -- 'us', 'canada', 'ddp', 'ddu'
  raw_events JSONB,                      -- array of { timestamp, status, location, description }
  summary TEXT,                          -- AI-generated plain language summary
  action_draft TEXT,                     -- AI-drafted response for problem cases
  current_status TEXT,                   -- 'pre_transit', 'in_transit', 'out_for_delivery', 'delivered', 'exception', 'returned', 'unknown'
  estimated_delivery DATE,
  last_location TEXT,
  local_carrier TEXT,                    -- for Passport: the last-mile carrier (Royal Mail, Australia Post, etc.)
  local_tracking_number TEXT,            -- for Passport: the local carrier tracking number
  customs_cleared BOOLEAN,              -- for international: has it cleared customs?
  raw_text TEXT,                          -- raw scraped page text (for re-parsing without re-scraping)
  scraped_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tracking_order ON tracking_snapshots(order_number);
CREATE INDEX IF NOT EXISTS idx_tracking_status ON tracking_snapshots(current_status);
CREATE INDEX IF NOT EXISTS idx_tracking_scraped ON tracking_snapshots(scraped_at);

-- Migration: add raw_text column
ALTER TABLE tracking_snapshots ADD COLUMN IF NOT EXISTS raw_text TEXT;

-- Passport sync run log — one row per hourly run, read by daily order alerts
CREATE TABLE IF NOT EXISTS passport_sync_runs (
  id SERIAL PRIMARY KEY,
  ran_at TIMESTAMPTZ DEFAULT NOW(),
  backfill_scraped INTEGER DEFAULT 0,
  backfill_delivered INTEGER DEFAULT 0,
  updates_scraped INTEGER DEFAULT 0,
  updates_delivered INTEGER DEFAULT 0,
  expired INTEGER DEFAULT 0,
  captcha INTEGER DEFAULT 0,
  errors INTEGER DEFAULT 0,
  backfill_remaining INTEGER DEFAULT 0,
  updates_remaining INTEGER DEFAULT 0,
  too_old_skipped INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_passport_sync_ran_at ON passport_sync_runs(ran_at);
