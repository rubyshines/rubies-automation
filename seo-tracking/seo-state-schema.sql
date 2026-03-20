-- RUBIES SEO Strategy State — Supabase schema
-- Run once in Supabase SQL Editor.
-- Migrates dynamic state from config.json to Supabase.

-- Unified table for SEO roadmap tasks AND blog post targets.
CREATE TABLE IF NOT EXISTS seo_strategy_items (
  id text PRIMARY KEY,                          -- e.g. "phase1_task1", "no_tuck_vs_tucking"
  type text NOT NULL CHECK (type IN ('task', 'blog_post')),
  name text NOT NULL,
  status text NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started', 'in_progress', 'completed')),
  notes text,
  completed_date date,
  -- Blog-post-specific fields (null for tasks)
  target_keywords text[],
  published_url text,
  published_date date,
  -- Ordering
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_seo_strategy_type ON seo_strategy_items(type);
CREATE INDEX IF NOT EXISTS idx_seo_strategy_status ON seo_strategy_items(status);
ALTER TABLE seo_strategy_items ENABLE ROW LEVEL SECURITY;

-- Priority product/page URLs and redirect source URLs.
CREATE TABLE IF NOT EXISTS seo_tracked_urls (
  url text NOT NULL,
  category text NOT NULL CHECK (category IN ('priority_product', 'priority_page', 'redirect_source')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (url, category)
);

CREATE INDEX IF NOT EXISTS idx_seo_tracked_urls_category ON seo_tracked_urls(category);
ALTER TABLE seo_tracked_urls ENABLE ROW LEVEL SECURITY;
