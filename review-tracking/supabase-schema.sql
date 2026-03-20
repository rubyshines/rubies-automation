-- RUBIES Review Tracking (Judge.me) — Supabase schema
-- Run once in Supabase SQL Editor.

-- Individual reviews
CREATE TABLE IF NOT EXISTS judgeme_reviews (
  review_id integer PRIMARY KEY,
  rating integer NOT NULL,
  title text NOT NULL DEFAULT '',
  body text NOT NULL DEFAULT '',
  reviewer_name text NOT NULL DEFAULT '',
  reviewer_email text NOT NULL DEFAULT '',
  product_external_id text,
  product_title text NOT NULL DEFAULT '',
  product_handle text NOT NULL DEFAULT '',
  verified text NOT NULL DEFAULT '',
  source text NOT NULL DEFAULT '',
  curated text NOT NULL DEFAULT '',
  has_pictures boolean NOT NULL DEFAULT false,
  has_videos boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone,
  updated_at timestamp with time zone
);

CREATE INDEX IF NOT EXISTS idx_judgeme_reviews_created ON judgeme_reviews(created_at);
CREATE INDEX IF NOT EXISTS idx_judgeme_reviews_product ON judgeme_reviews(product_handle);
CREATE INDEX IF NOT EXISTS idx_judgeme_reviews_rating ON judgeme_reviews(rating);
ALTER TABLE judgeme_reviews ENABLE ROW LEVEL SECURITY;

-- Daily aggregate snapshot
CREATE TABLE IF NOT EXISTS judgeme_daily_metrics (
  date date PRIMARY KEY,
  total_reviews integer NOT NULL DEFAULT 0,
  avg_rating decimal NOT NULL DEFAULT 0,
  stars_1 integer NOT NULL DEFAULT 0,
  stars_2 integer NOT NULL DEFAULT 0,
  stars_3 integer NOT NULL DEFAULT 0,
  stars_4 integer NOT NULL DEFAULT 0,
  stars_5 integer NOT NULL DEFAULT 0,
  new_reviews_today integer NOT NULL DEFAULT 0
);

ALTER TABLE judgeme_daily_metrics ENABLE ROW LEVEL SECURITY;
