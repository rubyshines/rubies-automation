-- Merchandising Pipeline — Phases 4-6 schema (manufacturer registry, tech-pack grading,
-- QC, payments, inbound shipments/receiving, production code, cycle-time tracking).
--
-- Additive + idempotent: safe to run on top of merchandising.sql (Phases 1-3).
-- RUN IN THE SUPABASE SQL EDITOR. Seed data (suppliers enrichment, graded specs) is
-- loaded separately via MCP tools after the founder reviews the overnight review docs.

-- ===========================================================================
-- 1. Manufacturer / vendor registry — extend suppliers
-- ===========================================================================
-- manufacturer = overseas/volume factory; studio = Canadian R&D + first-run (Pigeons & Thread);
-- freight_forwarder = e.g. Harry/CLH Express; qc_inspector = independent pre-ship QC (Joyce/galenfixqc).
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'manufacturer'
  CHECK (type IN ('manufacturer','studio','freight_forwarder','qc_inspector'));
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS address_line1 TEXT;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS address_line2 TEXT;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS city TEXT;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS region TEXT;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS postal_code TEXT;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS country TEXT;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS whatsapp TEXT;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS website TEXT;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS lead_time_days INTEGER;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS incoterms TEXT;
-- Per-supplier installment schedule, e.g.
--   [{"type":"deposit","pct":30,"due":"placement"},{"type":"balance","pct":70,"due":"delivery"}]
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS payment_terms JSONB;
-- Multiple contacts: [{"name":..,"email":..,"phone":..,"role":..}]
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS contacts JSONB;
-- Beneficiary / bank details for T/T payment
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS bank_name TEXT;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS bank_address TEXT;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS swift TEXT;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS account_number TEXT;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS beneficiary_name TEXT;

-- ===========================================================================
-- 2. Production orders — production code, cycle-time dates
-- ===========================================================================
-- Human-readable batch handle: {SUPPLIER}-{YYMM} (e.g. KALI-2606); -NN suffix only on
-- a same-month collision. Printed on cartons + used as the Warehance inbound reference.
ALTER TABLE production_orders ADD COLUMN IF NOT EXISTS production_code TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS production_orders_production_code_key
  ON production_orders (production_code) WHERE production_code IS NOT NULL;
ALTER TABLE production_orders ADD COLUMN IF NOT EXISTS production_requested_date DATE;
ALTER TABLE production_orders ADD COLUMN IF NOT EXISTS estimated_ready_date DATE;
ALTER TABLE production_orders ADD COLUMN IF NOT EXISTS actual_ready_date DATE;

-- Three-way reconciliation: qty_ordered -> qty_produced (invoice/packing) -> qty_received
ALTER TABLE production_order_items ADD COLUMN IF NOT EXISTS qty_produced INTEGER;

-- ===========================================================================
-- 3. Tech packs + graded specs (temporal grading; canonical = the tech packs)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS tech_packs (
  id SERIAL PRIMARY KEY,
  product_handle TEXT NOT NULL UNIQUE,
  product_name TEXT,
  category TEXT,
  colors TEXT[] NOT NULL DEFAULT '{}',
  samples_per_color INTEGER DEFAULT 3,
  tech_pack_url TEXT,
  tech_pack_version TEXT,
  measurement_unit TEXT DEFAULT 'cm',
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- One row per product/size/POM/version. New grading versions are APPENDED, not overwritten,
-- so a QC for an order checks against the spec current at the order's date.
CREATE TABLE IF NOT EXISTS tech_pack_specs (
  id SERIAL PRIMARY KEY,
  product_handle TEXT NOT NULL,
  size TEXT NOT NULL,
  size_alias TEXT,
  pom_code TEXT NOT NULL,
  pom_name TEXT,
  target_cm NUMERIC(8,2),
  tolerance_cm NUMERIC(6,3),
  sort_order INTEGER,
  effective_date DATE NOT NULL DEFAULT CURRENT_DATE,
  superseded_date DATE,
  is_current BOOLEAN NOT NULL DEFAULT TRUE,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (product_handle, size, pom_code, effective_date)
);
CREATE INDEX IF NOT EXISTS tech_pack_specs_lookup
  ON tech_pack_specs (product_handle, is_current);

-- ===========================================================================
-- 4. QC inspections, measurements, issues
-- ===========================================================================
CREATE TABLE IF NOT EXISTS qc_inspections (
  id SERIAL PRIMARY KEY,
  production_order_id INTEGER REFERENCES production_orders(id) ON DELETE CASCADE NOT NULL,
  category TEXT,
  sheet_url TEXT,
  sheet_file_id TEXT,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','sent','in_progress','completed','approved','rejected')),
  inspector TEXT,
  sent_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  approved_at TIMESTAMPTZ,
  approved_by TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS qc_measurements (
  id SERIAL PRIMARY KEY,
  qc_inspection_id INTEGER REFERENCES qc_inspections(id) ON DELETE CASCADE NOT NULL,
  sku TEXT NOT NULL,
  size TEXT,
  color TEXT,
  pom_code TEXT NOT NULL,
  sample_number INTEGER NOT NULL DEFAULT 1,
  measured_cm NUMERIC(8,2),
  target_cm NUMERIC(8,2),
  tolerance_cm NUMERIC(6,3),
  diff_cm NUMERIC(8,2),
  in_tolerance BOOLEAN,
  UNIQUE (qc_inspection_id, sku, color, pom_code, sample_number)
);

CREATE TABLE IF NOT EXISTS qc_issues (
  id SERIAL PRIMARY KEY,
  qc_inspection_id INTEGER REFERENCES qc_inspections(id) ON DELETE CASCADE NOT NULL,
  sku TEXT,
  pom_code TEXT,
  severity TEXT,
  description TEXT NOT NULL,
  resolution TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ===========================================================================
-- 5. Production payments (per-supplier installments; balance gated on QC approval)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS production_payments (
  id SERIAL PRIMARY KEY,
  production_order_id INTEGER REFERENCES production_orders(id) ON DELETE CASCADE NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('deposit','balance','final','other')),
  pct NUMERIC(5,2),
  amount NUMERIC(12,2),
  currency TEXT DEFAULT 'USD',
  due_event TEXT CHECK (due_event IN ('placement','delivery','ship','other')),
  status TEXT NOT NULL DEFAULT 'due' CHECK (status IN ('due','paid','cancelled')),
  paid_date DATE,
  invoice_url TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ===========================================================================
-- 6. Inbound shipments (= shipment AND Warehance inbound/ASN; many per order)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS inbound_shipments (
  id SERIAL PRIMARY KEY,
  production_order_id INTEGER REFERENCES production_orders(id) ON DELETE CASCADE,
  transfer_number TEXT NOT NULL UNIQUE,
  warehouse TEXT NOT NULL DEFAULT 'Nitro Logistics AMU',
  carrier TEXT,
  tracking_number TEXT,
  warehance_inbound_id TEXT,
  warehance_response JSONB,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','uploaded','in_transit','receiving','received','in_inventory')),
  qty_received_total INTEGER DEFAULT 0,
  ship_date DATE,
  estimated_arrival_date DATE,
  actual_arrival_date DATE,
  in_inventory_date DATE,
  last_checked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  uploaded_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS inbound_shipment_items (
  id SERIAL PRIMARY KEY,
  inbound_shipment_id INTEGER REFERENCES inbound_shipments(id) ON DELETE CASCADE NOT NULL,
  sku TEXT NOT NULL,
  qty INTEGER NOT NULL,
  qty_received INTEGER,
  UNIQUE (inbound_shipment_id, sku)
);
