-- 2026-09-09 — a customer's email change must follow through to their orders.
--
-- orders.customer_email references customers(email) with no ON UPDATE rule, so
-- the in-place rename that webhooks/lib/customerUpsert.js performs when a
-- Shopify customer changes their email is rejected the moment that customer
-- has a single order in the mirror. Both writers then fail the same way: the
-- customer row keeps the old email, the next order carries the new one, the
-- customer upsert collides with the unique shopify_customer_id, and the order
-- upsert fails the foreign key and is skipped with a console line nobody
-- reads. She Bop changed info@ → purchasing@ in April 2026 and three wholesale
-- orders were missing from the mirror for five months.
--
-- ON UPDATE CASCADE makes the rename carry the orders with it, which is also
-- what Shopify reports: the sync writes order.customer.email, the customer's
-- CURRENT address, not the address at the time of the order. Idempotent.

DO $$
DECLARE
  con RECORD;
BEGIN
  SELECT c.conname, c.confupdtype INTO con
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  WHERE t.relname = 'orders' AND c.contype = 'f'
    AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = t.oid AND attname = 'customer_email')];

  IF con.conname IS NULL THEN
    RAISE NOTICE 'orders.customer_email has no foreign key — nothing to change';
  ELSIF con.confupdtype = 'c' THEN
    RAISE NOTICE '% already cascades on update', con.conname;
  ELSE
    EXECUTE format('ALTER TABLE orders DROP CONSTRAINT %I', con.conname);
    EXECUTE format('ALTER TABLE orders ADD CONSTRAINT %I FOREIGN KEY (customer_email) REFERENCES customers(email) ON UPDATE CASCADE', con.conname);
    RAISE NOTICE '% recreated with ON UPDATE CASCADE', con.conname;
  END IF;
END $$;
