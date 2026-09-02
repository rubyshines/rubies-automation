-- Per-partner wholesale terms (negotiated deals) on b2b_companies.
-- NULL = no negotiated override; create_wholesale_order falls back to the
-- country/zone defaults (50% US/AU else 30%; incoterms by shipping zone;
-- customer's local currency). Precedence: explicit tool param > these > default.
-- Run in the Supabase SQL Editor.

ALTER TABLE b2b_companies
  ADD COLUMN IF NOT EXISTS wholesale_discount_percent numeric
    CHECK (wholesale_discount_percent > 0 AND wholesale_discount_percent <= 100),
  ADD COLUMN IF NOT EXISTS wholesale_incoterms text
    CHECK (wholesale_incoterms IN ('ddp', 'ddu')),
  ADD COLUMN IF NOT EXISTS wholesale_currency text
    CHECK (wholesale_currency ~ '^[A-Z]{3}$');

COMMENT ON COLUMN b2b_companies.wholesale_discount_percent IS
  'Negotiated wholesale discount override (e.g. 50). NULL = country default (50 US/AU, 30 elsewhere).';
COMMENT ON COLUMN b2b_companies.wholesale_incoterms IS
  'Negotiated incoterms override: ddu = partner pays duties/VAT at import, ddp = RUBIES pays. NULL = shipping-zone default. Drives the Shopify shipping line title that Warehance maps to carrier + incoterms.';
COMMENT ON COLUMN b2b_companies.wholesale_currency IS
  'Forced invoice currency (ISO 4217, e.g. USD). NULL = customer''s local presentment currency.';

-- Initial partner terms:
-- Transting (DK): 50% + DDU — they handle Danish customs/VAT.
UPDATE b2b_companies
  SET wholesale_discount_percent = 50, wholesale_incoterms = 'ddu'
  WHERE id = 'transitting' AND relationship_type = 'wholesale';

-- Sock Drawer Heroes (AU): always invoiced in USD (replaces the hardcoded
-- CURRENCY_OVERRIDES map in wholesaleOrder.js).
UPDATE b2b_companies
  SET wholesale_currency = 'USD'
  WHERE id = 'sock-drawer-heroes' AND relationship_type = 'wholesale';
