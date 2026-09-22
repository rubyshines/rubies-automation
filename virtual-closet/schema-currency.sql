-- Virtual Closet, per-centre currency (Jamie, 2026-09-22). Run once in the
-- Supabase SQL editor BEFORE the code that writes these columns deploys.
-- Build spec: .claude/memory/project_closet_currency.md
--
-- Each centre's money lives in its own currency, set from its country at
-- enrolment, so a centre's balance never moves with the exchange rate. Every
-- ledger row carries the amount in the centre's currency plus what was
-- actually paid, in the currency it was paid in, and the rate when one was
-- used. Same-currency orders carry no rate.

alter table vc_centres add column if not exists currency text not null default 'USD'
  check (currency ~ '^[A-Z]{3}$');

alter table vc_ledger add column if not exists currency text not null default 'USD'
  check (currency ~ '^[A-Z]{3}$');
-- The original amount as paid (an order credit's base is the product subtotal
-- the shopper paid; a sponsor row's is the line's price; a redemption's is
-- itself), and the currency it was paid in.
alter table vc_ledger add column if not exists paid_amount_cents integer;
alter table vc_ledger add column if not exists paid_currency text
  check (paid_currency is null or paid_currency ~ '^[A-Z]{3}$');
-- Centre currency per one unit of the shop currency (USD) on the day, only
-- when the row was converted. Null means no conversion happened.
alter table vc_ledger add column if not exists fx_rate numeric;

-- Backfill: every row so far was recorded in USD, including the retired
-- Toronto test centre's simulated rows, so every existing centre stays USD.
update vc_ledger
   set paid_currency = 'USD',
       paid_amount_cents = coalesce((detail->>'subtotal_cents')::integer, amount_cents)
 where paid_currency is null;

comment on column vc_centres.currency is 'ISO 4217. Set from address.country at enrolment; never edited.';
comment on column vc_ledger.currency is 'The centre''s currency at the time of the row; amount_cents is in it.';
comment on column vc_ledger.paid_amount_cents is 'What was paid, in paid_currency: an order credit''s product subtotal, a sponsor line''s price, a redemption''s own amount.';
comment on column vc_ledger.fx_rate is 'Centre currency per 1 USD from the fx-reference product on the day; null when no conversion.';
