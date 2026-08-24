-- ============================================================================
-- Donation Partners, Routing, Exchange Decision Rules, Size Charts
-- Run in Supabase SQL Editor (one-time setup)
-- ============================================================================

-- 1. Donation Partners — orgs that accept pre-loved RUBIES clothing
CREATE TABLE IF NOT EXISTS donation_partners (
  id            serial PRIMARY KEY,
  name          text NOT NULL,
  country_code  text NOT NULL,  -- ISO alpha-2 (US, CA, CH, AU, etc.)
  region        text,           -- state/province/canton
  city          text,
  address       text,           -- legacy single-line address (publish + routing prefer mailing_address)
  mailing_address text,         -- multi-line "RUBIES Returns / c/o ORG / ..." block shown on the donation page
  description   text,           -- org's full self-written description (website)
  description_short text,       -- 1-2 sentence version used in CS advisor emails
  -- Which size categories the org can actually distribute. Split on the one
  -- boundary that is physically real (kids 12 == adult XS by waist), so routing
  -- never sends an org a box it cannot use. See lib/sizeAcceptance.js.
  accepts_smaller_sizes boolean NOT NULL DEFAULT true,  -- kids 4-11
  accepts_larger_sizes  boolean NOT NULL DEFAULT true,  -- kids 12-16 + adult XXS-4X
  logo_url      text,           -- always on cdn.shopify.com (re-hosted on save)
  website_url   text,
  latitude      double precision,
  longitude     double precision,
  active        boolean NOT NULL DEFAULT true,
  -- Why routing stopped. Set together; both cleared on resume. See
  -- lib/donationPartnerPause.js. Separate axis from the b2b outreach pause —
  -- this stops donations, that one stops email.
  paused_at     timestamptz,
  paused_reason text,
  donations_routed integer NOT NULL DEFAULT 0,  -- lifetime counter (impact reporting; routing uses donation_routings)
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_donation_partners_country ON donation_partners(country_code);
CREATE INDEX IF NOT EXISTS idx_donation_partners_active ON donation_partners(active);

-- Migration for existing databases (2026-07-28): CS emails use a short
-- description; the website keeps the full one.
ALTER TABLE donation_partners ADD COLUMN IF NOT EXISTS description_short text;

-- 2. Donation Routings — log of which partner was recommended to which customer
CREATE TABLE IF NOT EXISTS donation_routings (
  id            serial PRIMARY KEY,
  customer_email text,
  order_number  text,
  partner_id    integer REFERENCES donation_partners(id),
  items_count   integer NOT NULL DEFAULT 1,
  routing_type  text NOT NULL CHECK (routing_type IN ('partner', 'local_single', 'local_no_partner')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_donation_routings_email ON donation_routings(customer_email);
CREATE INDEX IF NOT EXISTS idx_donation_routings_partner ON donation_routings(partner_id);

-- 3. Exchange Decision Rules — extracted from conversation mining, reviewed by Jamie
CREATE TABLE IF NOT EXISTS exchange_decision_rules (
  id                  serial PRIMARY KEY,
  rule_key            text UNIQUE NOT NULL,  -- slug: 'close-fit-one-size-up', 'multi-item-same-category'
  category            text NOT NULL,          -- sizing_exchange, product_switch, multi_item, refund_conversion, defect, product_not_working
  condition_description text NOT NULL,        -- when this rule applies
  action_description  text NOT NULL,          -- what to do
  priority            integer NOT NULL DEFAULT 50,  -- higher = checked first (0-100)
  examples            jsonb DEFAULT '[]',     -- [{conversation_id, summary}]
  anti_patterns       jsonb DEFAULT '[]',     -- things NOT to do
  active              boolean NOT NULL DEFAULT false,  -- only active after Jamie approves
  source              text DEFAULT 'extracted',  -- 'extracted' | 'manual'
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_exchange_rules_category ON exchange_decision_rules(category);
CREATE INDEX IF NOT EXISTS idx_exchange_rules_active ON exchange_decision_rules(active);

-- 4. Size Charts — measurement → size lookup (deterministic)
-- For when a customer gives their waist/chest/height measurement
CREATE TABLE IF NOT EXISTS size_charts (
  id              serial PRIMARY KEY,
  chart_category  text NOT NULL,  -- 'kids_underwear_bottoms', 'kids_swimwear_bottoms', 'kids_tops', 'kids_onepiece', 'adult_swimwear_bottoms', 'adult_underwear_bottoms', 'adult_onepiece', 'adult_tops', 'chest_pads'
  size_label      text NOT NULL,  -- '4', '6', 'XXS', 'M', etc.
  measurement_type text NOT NULL, -- 'waist', 'chest', 'height'
  min_inches      decimal,        -- lower bound (inclusive)
  max_inches      decimal,        -- upper bound (inclusive)
  min_cm          decimal,        -- cm equivalent
  max_cm          decimal,
  notes           text,           -- e.g., 'Regular' or 'Tall' for one-pieces
  UNIQUE (chart_category, size_label, measurement_type, notes)
);

CREATE INDEX IF NOT EXISTS idx_size_charts_category ON size_charts(chart_category);
CREATE INDEX IF NOT EXISTS idx_size_charts_lookup ON size_charts(chart_category, measurement_type);

-- 5. Size Grading Rules — relative sizing (fabric delta per size step)
-- For when a customer says "too tight" and we recommend one size up/down
CREATE TABLE IF NOT EXISTS size_grading_rules (
  id              serial PRIMARY KEY,
  chart_category  text NOT NULL,  -- matches size_charts.chart_category
  size_from       text NOT NULL,  -- starting size
  size_to         text NOT NULL,  -- next size (up)
  delta_inches    decimal NOT NULL,  -- fabric difference in inches (+2" for even, +1" for odd/half)
  delta_cm        decimal NOT NULL,  -- fabric difference in cm
  direction       text NOT NULL DEFAULT 'up' CHECK (direction IN ('up', 'down')),
  UNIQUE (chart_category, size_from, size_to, direction)
);

CREATE INDEX IF NOT EXISTS idx_size_grading_category ON size_grading_rules(chart_category);

-- 6. Tone Samples — Jamie's actual phrasing extracted from conversations
-- Used as few-shot examples so the AI agent sounds like Jamie, not generic CS
CREATE TABLE IF NOT EXISTS cs_tone_samples (
  id              serial PRIMARY KEY,
  situation       text NOT NULL,          -- when to use this: 'opening_exchange', 'explaining_donation', 'nudge_toward_exchange', 'product_not_working_probe', 'parent_sensitivity', 'defect_photo_request', 'closing_positive'
  agent_message   text NOT NULL,          -- Jamie's exact words (the gold standard)
  context         text,                   -- brief context: what the customer said before this
  conversation_id text,                   -- source conversation for traceability
  tags            text[] DEFAULT '{}',    -- e.g., ['sizing', 'empathetic', 'parent']
  active          boolean NOT NULL DEFAULT true,
  source          text DEFAULT 'extracted',  -- 'extracted' | 'manual'
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tone_samples_situation ON cs_tone_samples(situation);
CREATE INDEX IF NOT EXISTS idx_tone_samples_active ON cs_tone_samples(active);

-- RPC: Get tone samples by situation (returns up to N active samples for a given situation)
CREATE OR REPLACE FUNCTION get_tone_samples(
  p_situation text DEFAULT NULL,
  p_limit integer DEFAULT 3
)
RETURNS TABLE (
  id integer,
  situation text,
  agent_message text,
  context text,
  tags text[]
) AS $$
BEGIN
  RETURN QUERY
  SELECT ts.id, ts.situation, ts.agent_message, ts.context, ts.tags
  FROM cs_tone_samples ts
  WHERE ts.active = true
    AND (p_situation IS NULL OR ts.situation = p_situation)
  ORDER BY random()  -- rotate samples so agent doesn't repeat the same phrasing
  LIMIT p_limit;
END;
$$ LANGUAGE plpgsql;

-- RPC: Find matching size from measurement
CREATE OR REPLACE FUNCTION find_size_by_measurement(
  p_chart_category text,
  p_measurement_type text,
  p_value decimal,
  p_unit text DEFAULT 'inches',  -- 'inches' or 'cm'
  p_notes text DEFAULT NULL
)
RETURNS TABLE (
  size_label text,
  min_val decimal,
  max_val decimal,
  unit text,
  notes text
) AS $$
BEGIN
  IF p_unit = 'cm' THEN
    RETURN QUERY
    SELECT sc.size_label, sc.min_cm AS min_val, sc.max_cm AS max_val, 'cm'::text AS unit, sc.notes
    FROM size_charts sc
    WHERE sc.chart_category = p_chart_category
      AND sc.measurement_type = p_measurement_type
      AND sc.min_cm <= p_value AND sc.max_cm >= p_value
      AND (p_notes IS NULL OR sc.notes = p_notes)
    ORDER BY sc.size_label;
  ELSE
    RETURN QUERY
    SELECT sc.size_label, sc.min_inches AS min_val, sc.max_inches AS max_val, 'inches'::text AS unit, sc.notes
    FROM size_charts sc
    WHERE sc.chart_category = p_chart_category
      AND sc.measurement_type = p_measurement_type
      AND sc.min_inches <= p_value AND sc.max_inches >= p_value
      AND (p_notes IS NULL OR sc.notes = p_notes)
    ORDER BY sc.size_label;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- RPC: Get size grading (what's one size up/down from a given size)
CREATE OR REPLACE FUNCTION get_size_grading(
  p_chart_category text,
  p_current_size text,
  p_direction text DEFAULT 'up'  -- 'up' or 'down'
)
RETURNS TABLE (
  size_from text,
  size_to text,
  delta_inches decimal,
  delta_cm decimal
) AS $$
BEGIN
  IF p_direction = 'up' THEN
    RETURN QUERY
    SELECT sgr.size_from, sgr.size_to, sgr.delta_inches, sgr.delta_cm
    FROM size_grading_rules sgr
    WHERE sgr.chart_category = p_chart_category
      AND sgr.size_from = p_current_size
      AND sgr.direction = 'up'
    LIMIT 1;
  ELSE
    RETURN QUERY
    SELECT sgr.size_from, sgr.size_to, sgr.delta_inches, sgr.delta_cm
    FROM size_grading_rules sgr
    WHERE sgr.chart_category = p_chart_category
      AND sgr.size_to = p_current_size
      AND sgr.direction = 'up'  -- reverse lookup: find the row where size_to = current
    LIMIT 1;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- RPC: Get donation partners by country (sorted by fewest donations routed)
CREATE OR REPLACE FUNCTION get_donation_partners_by_country(
  p_country_code text,
  p_limit integer DEFAULT 3
)
RETURNS TABLE (
  id integer,
  name text,
  region text,
  city text,
  address text,
  description text,
  donations_routed integer
) AS $$
BEGIN
  RETURN QUERY
  SELECT dp.id, dp.name, dp.region, dp.city, dp.address, dp.description, dp.donations_routed
  FROM donation_partners dp
  WHERE dp.country_code = p_country_code
    AND dp.active = true
  ORDER BY dp.donations_routed ASC, dp.name ASC
  LIMIT p_limit;
END;
$$ LANGUAGE plpgsql;

-- RPC: Get active exchange decision rules by category
CREATE OR REPLACE FUNCTION get_exchange_rules(
  p_category text DEFAULT NULL
)
RETURNS TABLE (
  rule_key text,
  category text,
  condition_description text,
  action_description text,
  priority integer,
  examples jsonb,
  anti_patterns jsonb
) AS $$
BEGIN
  RETURN QUERY
  SELECT edr.rule_key, edr.category, edr.condition_description, edr.action_description,
         edr.priority, edr.examples, edr.anti_patterns
  FROM exchange_decision_rules edr
  WHERE edr.active = true
    AND (p_category IS NULL OR edr.category = p_category)
  ORDER BY edr.priority DESC;
END;
$$ LANGUAGE plpgsql;
