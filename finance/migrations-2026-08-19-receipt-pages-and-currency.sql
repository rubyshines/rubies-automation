-- ============================================================================
-- Expense receipts: multi-page capture + currency provenance
-- Idempotent. Run in Supabase SQL Editor, or via SUPABASE_DATABASE_URL.
-- ============================================================================

-- ── Multi-page ──────────────────────────────────────────────────────────────
-- A long receipt is photographed in several overlapping shots. The pages are
-- their own rows; `expense_receipts.storage_path` keeps pointing at page 1 so
-- every existing thumbnail and signed-URL read keeps working untouched.
CREATE TABLE IF NOT EXISTS expense_receipt_pages (
  id           BIGSERIAL PRIMARY KEY,
  receipt_id   BIGINT NOT NULL REFERENCES expense_receipts(id) ON DELETE CASCADE,
  -- Capture order, which is the order the pages are shown to the model. NOT
  -- necessarily the receipt's own reading order — the model re-orders by
  -- content, because people photograph the bottom half first often enough.
  page_number  INTEGER NOT NULL,
  image_hash   TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  image_mime   TEXT,
  image_bytes  INTEGER,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (receipt_id, page_number)
);

CREATE INDEX IF NOT EXISTS idx_receipt_pages_receipt ON expense_receipt_pages (receipt_id, page_number);
-- Storage blobs are content-addressed, so the same image can legitimately be
-- referenced by two receipts. Deleting one must not orphan the other's photo —
-- this index backs the "is anyone else still using this blob?" check.
CREATE INDEX IF NOT EXISTS idx_receipt_pages_hash    ON expense_receipt_pages (image_hash);

-- Backfill every existing receipt as its own page 1.
INSERT INTO expense_receipt_pages (receipt_id, page_number, image_hash, storage_path, image_mime, image_bytes)
SELECT r.id, 1, r.image_hash, r.storage_path, r.image_mime, r.image_bytes
FROM expense_receipts r
WHERE r.storage_path IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM expense_receipt_pages p WHERE p.receipt_id = r.id);

ALTER TABLE expense_receipts ADD COLUMN IF NOT EXISTS page_count INTEGER NOT NULL DEFAULT 1;

-- ── Currency provenance ─────────────────────────────────────────────────────
-- A currency read off the paper and one inferred from the merchant's address
-- are not the same claim, and the difference has to survive into the row.
-- A wrong currency is silently wrong in every total that touches it, so the
-- inferred case must be visibly inferred rather than indistinguishable.
--   printed    — an ISO code or unambiguous symbol on the receipt
--   tax_label  — HST/QST/PST, which only exist in Canada
--   address    — derived from the merchant's country. A GUESS.
--   operator   — a human set it by hand, which outranks all of the above
ALTER TABLE expense_receipts ADD COLUMN IF NOT EXISTS currency_source  TEXT;
ALTER TABLE expense_receipts ADD COLUMN IF NOT EXISTS merchant_country TEXT;

CREATE INDEX IF NOT EXISTS idx_expense_receipts_country ON expense_receipts (merchant_country);

-- Existing rows: anything with a currency got it from a printed code or a
-- Canadian tax label under the old ladder, and there is no way to tell which
-- after the fact. Left NULL rather than guessed — an unknown provenance must
-- not masquerade as a confirmed one.
