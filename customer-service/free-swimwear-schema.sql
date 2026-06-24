-- ============================================================================
-- Free Swimwear Program — applications, decisioning, fulfillment
-- Run in Supabase SQL Editor (one-time setup)
--
-- Brings the "free swimwear for families in need" program into Supabase as the
-- single source of truth (replacing the Google Sheet + Apps Script). One row
-- per application. Fulfillment mirrors the legacy sheet columns so the full
-- multi-year history can be backfilled losslessly.
-- ============================================================================

CREATE TABLE IF NOT EXISTS free_swimwear_requests (
  id                       serial PRIMARY KEY,

  -- Intake
  source                   text NOT NULL DEFAULT 'form',   -- 'form' | 'legacy' | 'manual'
  sheet_row                integer,                        -- 1-indexed source sheet row (provenance)
  submitted_at             timestamptz,                    -- form Timestamp
  email                    text NOT NULL,
  applicant_name           text,
  recipient_age            text,                           -- free text on the form ("10", "10 1/2", etc.)
  is_trans_nonbinary       boolean,                        -- the form yes/no (null when unknown/legacy)
  region                   text,                           -- raw "state/province and country" text
  country_code             text,                           -- ISO alpha-2 when derivable
  situation                text,
  why                      text,
  where_heard              text,
  first_reaction           text,
  product_want             text,
  color_pattern            text,
  suggestions              text,
  size                     text,
  final_response           text,

  -- Decisioning (deterministic eligibility + human decision; NO AI in the gate)
  status                   text NOT NULL DEFAULT 'new',
    -- new | approved | accepted | registered | ordered | expired | expired-final
    -- | rejected | brazil-rejected (legacy, retained for backfill fidelity)
  eligibility_reason       text,   -- 'eligible' | 'excluded region: <X>' | 'not trans/non-binary'
  ai_summary               text,   -- one-line scannable summary (helper only, never a decision)
  ai_summary_at            timestamptz,
  decided_by               text,
  decided_at               timestamptz,

  -- Fulfillment (mirrors the legacy sheet)
  discount_code            text,
  shopify_customer_id      text,
  registration_date        timestamptz,
  expiry_date              timestamptz,
  order_numbers            text[] NOT NULL DEFAULT '{}',
  order_dates              text[] NOT NULL DEFAULT '{}',
  last_acceptance_send_date timestamptz,
  send_attempts            integer NOT NULL DEFAULT 0,
  resend_status            text,

  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

-- Natural key = the source sheet row (append-only, so stable forever). The sync
-- is insert-if-absent on this key: once a row lands in Supabase, Supabase owns
-- its operational state (status/code/dates) and the sheet is only the intake
-- feed for NEW submissions — re-sync never clobbers a portal/lifecycle decision.
-- Plain columns (not an expression) so PostgREST upsert can target it. Manual
-- rows have sheet_row NULL (treated as distinct).
CREATE UNIQUE INDEX IF NOT EXISTS uq_free_swimwear_source_row
  ON free_swimwear_requests (source, sheet_row);

CREATE INDEX IF NOT EXISTS idx_free_swimwear_status ON free_swimwear_requests(status);
CREATE INDEX IF NOT EXISTS idx_free_swimwear_email ON free_swimwear_requests(lower(email));
CREATE INDEX IF NOT EXISTS idx_free_swimwear_discount_code ON free_swimwear_requests(discount_code);
