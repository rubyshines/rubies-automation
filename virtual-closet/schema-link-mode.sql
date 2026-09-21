-- Virtual Closet, the minimal cut (2026-09-21): a per-centre mode.
-- Run once in the Supabase SQL editor before the first link-mode enrolment.
--
-- link   : the pilot programme. One page (shop button, sponsor tiles, running
--          total), a balance that accrues from orders, a digest email on days
--          with activity. No accounts, no requests, no boxes.
-- closet : the full app as built 2026-09-18. Kept, unused by new centres.

alter table vc_centres add column if not exists mode text not null default 'closet'
  check (mode in ('link', 'closet'));

-- Activity has been emailed to the centre up to this instant (link mode).
-- Advances only after a successful send, so a failed send retries next run
-- and a re-run never sends the same rows twice.
alter table vc_centres add column if not exists digest_through timestamptz;

-- A redemption is the centre spending its balance on a partner order: a
-- negative row, source_type 'wholesale_order', source_id the order number,
-- so the unique source index makes a repeated tool call a no-op.
alter table vc_ledger drop constraint if exists vc_ledger_kind_check;
alter table vc_ledger add constraint vc_ledger_kind_check check (kind in (
  'order_credit', 'sponsor', 'centre_add', 'carry_in', 'adjustment',
  'match', 'door_shipping', 'carry_out', 'redemption'));
