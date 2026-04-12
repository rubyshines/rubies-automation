-- RUBIES Retailer Lead Gen — Supabase schema
-- Run once in Supabase SQL Editor

-- retailer_prospects: one row per discovered prospect
CREATE TABLE IF NOT EXISTS retailer_prospects (
  id text PRIMARY KEY,
  status text,
  score integer,
  company_name text,
  website text,
  website_domain text,
  address text,
  city text,
  state text,
  google_place_id text,
  discovery_tier text,
  source text,
  sources text[],
  scrape_status text,
  scrape_error text,
  contact_name text,
  contact_role text,
  contact_method text,
  email text,
  email_type text,
  additional_emails text[],
  phone text,
  contact_page_url text,
  contact_form_url text,
  subcategory text,
  mentions_trans boolean,
  mentions_lgbtq boolean,
  mentions_inclusivity boolean,
  carries_gender_products boolean,
  carries_underwear_swimwear boolean,
  independently_owned boolean,
  has_physical_store boolean,
  has_online_store boolean,
  brands_list text[],
  services_list text[],
  raw_profile text,
  outreach_angle text,
  is_relevant boolean,
  irrelevant_reason text,
  score_breakdown jsonb,
  community_mention_count integer DEFAULT 0,
  community_mentions jsonb,
  analysis_status text,
  found_date timestamptz DEFAULT now(),
  researched_date timestamptz
);

-- Dedup indexes
CREATE UNIQUE INDEX IF NOT EXISTS idx_retailer_prospects_domain
  ON retailer_prospects (website_domain)
  WHERE website_domain IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_retailer_prospects_place_id
  ON retailer_prospects (google_place_id)
  WHERE google_place_id IS NOT NULL;

-- Query indexes
CREATE INDEX IF NOT EXISTS idx_retailer_prospects_status ON retailer_prospects (status);
CREATE INDEX IF NOT EXISTS idx_retailer_prospects_score ON retailer_prospects (score);
CREATE INDEX IF NOT EXISTS idx_retailer_prospects_source ON retailer_prospects (source);
CREATE INDEX IF NOT EXISTS idx_retailer_prospects_city ON retailer_prospects (city);
CREATE INDEX IF NOT EXISTS idx_retailer_prospects_state ON retailer_prospects (state);


-- discovery_progress: tracks which city+term combos / directories / reddit queries are done
CREATE TABLE IF NOT EXISTS discovery_progress (
  id text PRIMARY KEY,
  source text,
  tier text,
  city text,
  search_term text,
  completed boolean DEFAULT false,
  result_count integer DEFAULT 0,
  completed_at timestamptz
);
