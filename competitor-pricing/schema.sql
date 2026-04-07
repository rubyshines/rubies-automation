-- Competitor price monitoring — historical price tracking
-- Run once in Supabase SQL Editor

CREATE TABLE IF NOT EXISTS competitor_prices (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  scrape_date date NOT NULL,
  competitor_brand text NOT NULL,
  competitor_domain text NOT NULL,
  product_category text NOT NULL,       -- underwear, swim_bottom, swimsuit, bra
  product_name text NOT NULL,
  product_url text NOT NULL,
  price_local numeric(10,2),            -- price in the store's native currency
  currency_code text NOT NULL DEFAULT 'USD',
  price_usd numeric(10,2),             -- converted to USD for comparison
  compare_at_price_usd numeric(10,2),  -- sale original price if applicable
  in_stock boolean DEFAULT true,
  rubies_product_name text NOT NULL,    -- which RUBIES product this compares to
  rubies_price_usd numeric(10,2) NOT NULL,
  price_diff_usd numeric(10,2),         -- competitor - RUBIES (positive = competitor more expensive)
  price_diff_pct numeric(5,1),          -- percentage difference
  scrape_method text,                   -- simple, puppeteer, collection_fallback
  scrape_error text,                    -- null on success
  created_at timestamptz DEFAULT now(),

  UNIQUE(scrape_date, competitor_brand, product_category)
);

CREATE INDEX IF NOT EXISTS idx_competitor_prices_date ON competitor_prices (scrape_date);
CREATE INDEX IF NOT EXISTS idx_competitor_prices_brand ON competitor_prices (competitor_brand);
CREATE INDEX IF NOT EXISTS idx_competitor_prices_category ON competitor_prices (product_category);

-- Helper: get latest prices for all competitors in a category
CREATE OR REPLACE FUNCTION get_latest_competitor_prices(p_category text DEFAULT NULL)
RETURNS TABLE (
  scrape_date date,
  competitor_brand text,
  product_category text,
  product_name text,
  product_url text,
  price_usd numeric,
  compare_at_price_usd numeric,
  in_stock boolean,
  rubies_product_name text,
  rubies_price_usd numeric,
  price_diff_usd numeric,
  price_diff_pct numeric
) LANGUAGE sql STABLE AS $$
  SELECT DISTINCT ON (cp.competitor_brand, cp.product_category)
    cp.scrape_date,
    cp.competitor_brand,
    cp.product_category,
    cp.product_name,
    cp.product_url,
    cp.price_usd,
    cp.compare_at_price_usd,
    cp.in_stock,
    cp.rubies_product_name,
    cp.rubies_price_usd,
    cp.price_diff_usd,
    cp.price_diff_pct
  FROM competitor_prices cp
  WHERE cp.scrape_error IS NULL
    AND (p_category IS NULL OR cp.product_category = p_category)
  ORDER BY cp.competitor_brand, cp.product_category, cp.scrape_date DESC;
$$;
