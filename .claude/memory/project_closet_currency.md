---
name: Virtual Closet, per-centre currency
description: Each centre's ledger, goal, page, digest, thank-you, sign and dashboard figures live in the centre's own currency, set by its country at enrolment; orders paid in another currency are converted once at the fx-reference rate and never revisited.
type: project
domain: community
done_when: A centre enrolled with country GB gets currency GBP and a £1,000 goal; a simulated order paid in GBP for that centre credits a quarter of the GBP subtotal exactly with no rate involved; a simulated order paid in USD for it credits a GBP amount at the fx-reference rate and the row stores the original USD amount; a £25 sponsor tile on the hidden product is priced at exactly £25 for the UK market and records £25; the closet page, digest, sponsor thank-you, sign and dashboard show that centre's figures in pounds; existing US centres and rows are unchanged; the full suite is green and the change is on main.
---

# Virtual Closet, per-centre currency

Build spec, written 2026-09-22 from Jamie's brief. Initiative: `initiative_virtual_closet.md`. Store-side plan: `.claude/plans/virtual-closet-theme.md`.

## Why

The ledger (`vc_ledger`) records every credit in USD, Shopify's shop currency. A UK centre's money would then move with the exchange rate every time it was shown, and its sponsors would pay odd converted amounts (£9, £21, £42, £84 today). On 2026-09-22 Jamie decided each centre gets its own currency and the ledger records in it, so a centre's money never moves. All current centres are US, so nothing changes for the pilot; this lands before the first non-US centre enrols (UK is next on the partnerships list).

## Decisions (closed 2026-09-22, do not reopen)

1. **Country sets the centre's currency at enrolment.** US → USD, CA → CAD, GB → GBP, Eurozone countries → EUR, AU → AUD. No override, no centre-facing setting, not in `CENTRE_EDITABLE`. Any other country falls back to USD (the store settles in USD, so that is the honest default); `UK` is accepted as an alias of `GB`.
2. **Everything about a centre is in its currency:** goal (default 1,000 in that currency, floor 300), page total, digest, sponsor thank-you, balance, redemptions, adjustments, the sign's amounts, the dashboard and the MCP tools' output.
3. **Same-currency orders record as paid.** When the order's presentment currency is the centre's currency, the presentment subtotal (product lines only, sponsor lines excluded) is recorded as it stands. No rate. Sponsor lines the same: the line's presentment price times quantity.
4. **Cross-currency orders convert once, at the day's rate, and are never revisited.** The rate comes from the store's fx-reference product (handle `fx-reference`, base price USD 9,900) priced through Shopify Markets: contextual pricing for the centre's country gives the local price, and rate = local / base. The theme's announcement bar reads the same product (`sections/announcement-bar.liquid` in rubies-ecom-v4). Conversion is from Shopify's shop money (USD, what RUBIES actually settles), so a GBP centre's order paid in CAD goes CAD → USD (Shopify) → GBP (fx-reference), never CAD → GBP directly.
5. **Sponsor tiles get fixed round prices per market** through Shopify Markets price lists (CA$10/25/50/100, £10/25/50/100, €10/25/50/100, A$10/25/50/100; the $1 unit is 1.00 in each), so a sponsor pays a round number in the centre's currency. `setupShopify.js --tiles` previews and `--tiles --create` sets them.
6. **Every ledger row keeps the amount in the centre's currency plus the original amount and currency as paid, and the rate when one was used.** Columns, not JSON, so it can be audited with SQL.

## Assumptions made while building (stated, not decided by Jamie)

- **US centres are unchanged by construction.** For a centre whose currency is the shop currency (USD) the ledger keeps using shop money exactly as before, including for orders a shopper paid in CAD or EUR (Shopify's own settlement). The fx-reference is consulted only for non-USD centres on orders not paid in their currency.
- **Style prices on the closet page are shown only for USD centres.** `MENU` retail prices are the store's USD prices; a GBP centre's page would otherwise show dollars beside pounds. The card still taps through Shop, where the store shows the market's real price. Revisit if a centre asks.
- **The welcome's partner-pricing sentence ("$600 or more") stays in dollars.** That is a RUBIES partner term, not a centre figure; UK partner terms are not decided.
- **The operator "This week" KPI in Needs attention sums ledger amounts across centres** and will mix currencies once a non-USD centre has activity. Operator-only, pilot-scale; not fixed here.
- **A failed fx lookup fails the credit, not the order.** `recordOrder` throws before writing; the webhook handler already catches and warns, and the daily reconcile retries (idempotent). Late is better than wrong.
- **Existing rows and centres backfill to USD**, including the retired Toronto test centre (#10), because its rows were recorded in USD.

## Where the code changes

- `virtual-closet/schema-currency.sql` (new; Jamie applies by hand, **before** the merge deploys): `vc_centres.currency` (text, default USD, ISO check), `vc_ledger.currency`, `vc_ledger.paid_amount_cents`, `vc_ledger.paid_currency`, `vc_ledger.fx_rate`; backfill existing rows.
- `virtual-closet/lib/money.js`: `currencyForCountry()`, `dollars(cents, currency)` with a second optional argument (USD `$1,000`, CAD `CA$1,000`, GBP `£1,000`, EUR `€1,000`, AUD `A$1,000`), `CURRENCIES`.
- `virtual-closet/lib/fx.js` (new): `rate(centre)`, the fx-reference read via contextual pricing, cached per process for an hour, refuses when the returned currency is not the centre's.
- `virtual-closet/lib/centres.js`: `enrol` sets `currency` from `country`.
- `virtual-closet/lib/sponsorship.js`: `readLineItem` also returns `shopCurrency` and `presentment {cents, currency}` from `price_set` (webhook) or `presentment_unit_price` (mirror).
- `virtual-closet/lib/ledger.js`: `settle()` picks presentment / shop / converted per decisions 3 and 4; `credit()` writes the currency columns; `recordOrder` reads `subtotal_price_set`; `reconcile` passes the mirror's shop and presentment money through; `redeem` formats in the centre's currency.
- `virtual-closet/views/closet.js`, `virtual-closet/lib/emails.js`, `virtual-closet/lib/sign.js`, `virtual-closet/server.js` (thanks page): every figure through `dollars(cents, centre.currency)`; tiles labelled in the centre's currency.
- `customer-service/lib/tools/virtualCloset.js`: `vc_enrol_centre` preview shows the currency; `vc_centre`, `vc_centres`, `vc_set_goal`, `vc_redeem` format in it; ledger lines show the original paid amount when it differs.
- `customer-service/dashboard/public/closets.js`: currency-aware formatter for link-mode rows and the centre card.
- `virtual-closet/scripts/setupShopify.js`: `--tiles` previews per-market prices; `--tiles --create` adds fixed prices to each market price list (`priceListFixedPricesAdd`).
- Tests: `customer-service/test/virtualClosetLink.test.js` (in-memory Supabase pattern) covers enrolment, same-currency, cross-currency, sponsor lines, formatting and the emails; `virtualClosetBrand.test.js` stays green.

## Edge cases handled

- A REST payload without `subtotal_price_set` (older tests, simulated orders) is treated as shop money in USD with no presentment info: USD centres behave exactly as before; a non-USD centre converts.
- Mirror rows whose `presentment_currency` is null are treated as having no presentment info.
- A sponsor line for a GBP centre bought by a US shopper is paid in USD and converts; bought by a UK shopper it is £25 exactly once the fixed prices are set.
- Zero-subtotal orders credit nothing, as before.
