-- ============================================================================
-- RUBIES Finance — Expense Receipt Capture
-- Idempotent. Run in Supabase SQL Editor, or via SUPABASE_DATABASE_URL.
--
-- Images live in the private Supabase Storage bucket `receipts`; the bucket is
-- created at runtime by ensureReceiptBucket() in finance/lib/receiptCapture.js
-- so a fresh environment needs no manual console step.
-- ============================================================================

CREATE TABLE IF NOT EXISTS expense_receipts (
  id                BIGSERIAL PRIMARY KEY,

  -- Idempotency. sha256 of the uploaded bytes: re-uploading the same photo
  -- (retry, double-tap, offline replay) resolves to this row instead of
  -- creating a second receipt and a second extraction charge.
  image_hash        TEXT NOT NULL UNIQUE,
  storage_path      TEXT NOT NULL,
  image_mime        TEXT,
  image_bytes       INTEGER,

  -- Merchant / when
  merchant          TEXT,
  merchant_address  TEXT,
  purchased_at      DATE,
  purchased_time    TEXT,

  -- Money. Currency is captured, never assumed — a USD receipt filed as CAD
  -- is silently wrong in every downstream total.
  currency          TEXT,
  subtotal          NUMERIC(12,2),
  tax_total         NUMERIC(12,2),
  tip               NUMERIC(12,2),
  total             NUMERIC(12,2),
  -- [{ label: 'HST', rate: 0.13, amount: 9.75, registration_number: '...' }]
  -- Broken out per tax line because input tax credits are claimed per tax
  -- type, and a single blended `tax_total` cannot be split back apart.
  tax_lines         JSONB NOT NULL DEFAULT '[]'::jsonb,

  payment_method    TEXT,
  card_last4        TEXT,

  -- Categorization against the live QBO chart of accounts (qbo_accounts).
  -- Soft reference, not an FK: a QBO resync rewrites that table and a receipt
  -- must never be deleted or blocked by chart-of-accounts churn.
  category          TEXT,
  qbo_account_id    TEXT,
  qbo_account_name  TEXT,
  category_rationale TEXT,

  -- Extraction provenance
  extraction_model      TEXT,
  extraction_confidence NUMERIC(3,2),
  extraction_notes      TEXT,
  ai_call_id            BIGINT,
  raw_extraction        JSONB,

  -- Deterministic arithmetic reconciliation of the extracted figures.
  -- { ok: bool, checks: [{ name, ok, expected, actual, delta }] }
  math_check        JSONB,

  -- needs_review | confirmed | rejected
  review_status     TEXT NOT NULL DEFAULT 'needs_review',
  reviewed_at       TIMESTAMPTZ,

  -- Soft duplicate: a different image of the same purchase (same merchant,
  -- date and total). Flagged, never auto-merged — two identical coffees on one
  -- day is a real thing that happens.
  possible_duplicate_of BIGINT REFERENCES expense_receipts(id) ON DELETE SET NULL,

  captured_by       TEXT,
  notes             TEXT,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_expense_receipts_purchased_at ON expense_receipts (purchased_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_expense_receipts_created_at   ON expense_receipts (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_expense_receipts_status       ON expense_receipts (review_status);
CREATE INDEX IF NOT EXISTS idx_expense_receipts_merchant     ON expense_receipts (lower(merchant));
CREATE INDEX IF NOT EXISTS idx_expense_receipts_qbo_account  ON expense_receipts (qbo_account_id);
-- Supports the soft-duplicate probe (merchant + date + total).
CREATE INDEX IF NOT EXISTS idx_expense_receipts_dupe_probe   ON expense_receipts (lower(merchant), purchased_at, total);


CREATE TABLE IF NOT EXISTS expense_receipt_items (
  id               BIGSERIAL PRIMARY KEY,
  receipt_id       BIGINT NOT NULL REFERENCES expense_receipts(id) ON DELETE CASCADE,
  -- Stable per-receipt ordinal. Unique with receipt_id so a re-extraction
  -- upserts line by line instead of delete+insert (which races).
  line_number      INTEGER NOT NULL,
  description      TEXT,
  quantity         NUMERIC(12,3),
  unit_price       NUMERIC(12,2),
  amount           NUMERIC(12,2),
  category         TEXT,
  qbo_account_id   TEXT,
  qbo_account_name TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (receipt_id, line_number)
);

CREATE INDEX IF NOT EXISTS idx_expense_receipt_items_receipt ON expense_receipt_items (receipt_id, line_number);


-- updated_at maintenance
CREATE OR REPLACE FUNCTION touch_expense_receipts_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_expense_receipts_updated_at ON expense_receipts;
CREATE TRIGGER trg_expense_receipts_updated_at
  BEFORE UPDATE ON expense_receipts
  FOR EACH ROW EXECUTE FUNCTION touch_expense_receipts_updated_at();
