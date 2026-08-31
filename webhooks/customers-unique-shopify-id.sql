-- Customers mirror: one row per Shopify customer.
--
-- The customers table is keyed by email (PK), and the webhook handlers used to
-- upsert onConflict: 'email' — so a Shopify email change forked the customer
-- into two rows sharing one shopify_customer_id, with the old-email row
-- orphaned forever. The handlers now resolve by shopify_customer_id first
-- (webhooks/lib/customerUpsert.js); this migration cleans up existing forks and
-- adds the unique index that makes the id-first upsert concurrency-safe.
--
-- Run in the Supabase SQL Editor.

-- 1) One-off cleanup: for each shopify_customer_id held by more than one row,
--    keep the most recently synced row (ties broken by email, arbitrarily but
--    deterministically) and delete the rest. All deleted columns are
--    re-derivable from the Shopify sync.
DELETE FROM customers c
USING customers k
WHERE c.shopify_customer_id IS NOT NULL
  AND c.shopify_customer_id = k.shopify_customer_id
  AND c.email <> k.email
  AND (COALESCE(c.synced_at, 'epoch'::timestamptz), c.email)
    < (COALESCE(k.synced_at, 'epoch'::timestamptz), k.email);

-- 2) Guarantee it can't recur: a Shopify customer id maps to at most one row.
CREATE UNIQUE INDEX IF NOT EXISTS customers_shopify_customer_id_key
  ON customers (shopify_customer_id)
  WHERE shopify_customer_id IS NOT NULL;
