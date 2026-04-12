-- B2B Companies & Contacts — Two-level hierarchy
-- Run in Supabase SQL Editor

-- ---------------------------------------------------------------------------
-- B2B Companies — the durable entity (org persists even when contacts change)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS b2b_companies (
  id TEXT PRIMARY KEY,                -- slug: 'sock-drawer-heroes', 'lgbt-center-raleigh'
  name TEXT NOT NULL,
  relationship_type TEXT NOT NULL,    -- 'wholesale' | 'lgbtq_org'
  website TEXT,
  city TEXT,
  region TEXT,                        -- state/province
  country TEXT,
  address TEXT,
  phone TEXT,
  description TEXT,                   -- org description (from form responses, etc.)
  status TEXT DEFAULT 'lead',         -- 'lead', 'qualified_lead', 'customer', 'active_partner', 'inactive', 'not_interested'
  stage TEXT,                         -- sales pipeline stage or partner stage
  temperature TEXT,                   -- 'warm', 'neutral', 'cold'
  ai_summary TEXT,                    -- AI-generated relationship summary
  next_action TEXT,
  next_action_due DATE,
  next_action_owner TEXT,
  order_count INTEGER DEFAULT 0,
  total_sales NUMERIC(10,2) DEFAULT 0,
  last_order_date DATE,
  source TEXT,                        -- where we found them: 'google_sheet', 'klaviyo_centerlink', 'donation_form', 'wholesale_discover', 'email'
  source_id TEXT,                     -- original ID in source system
  metadata JSONB,                     -- source-specific data (campaign, size ranges, programs, etc.)
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_b2b_companies_type ON b2b_companies (relationship_type);
CREATE INDEX IF NOT EXISTS idx_b2b_companies_status ON b2b_companies (status);
CREATE INDEX IF NOT EXISTS idx_b2b_companies_action ON b2b_companies (next_action_due) WHERE next_action_due IS NOT NULL;

-- ---------------------------------------------------------------------------
-- B2B Contacts — individual people at companies (many-to-one)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS b2b_contacts (
  id TEXT PRIMARY KEY,                -- normalized email address
  email TEXT NOT NULL UNIQUE,
  company_id TEXT REFERENCES b2b_companies(id),
  first_name TEXT,
  last_name TEXT,
  full_name TEXT,                     -- convenience: first + last or parsed from sheet
  role TEXT,                          -- 'owner', 'buyer', 'program_coordinator', etc.
  title TEXT,
  is_primary BOOLEAN DEFAULT FALSE,  -- primary contact for the company
  is_active BOOLEAN DEFAULT TRUE,    -- false when someone leaves the org
  source TEXT,                        -- 'google_sheet', 'klaviyo', 'donation_form', 'email_detected'
  first_seen_at TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ,
  message_count INTEGER DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_b2b_contacts_company ON b2b_contacts (company_id);
CREATE INDEX IF NOT EXISTS idx_b2b_contacts_active ON b2b_contacts (is_active) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_b2b_contacts_email ON b2b_contacts (email);
