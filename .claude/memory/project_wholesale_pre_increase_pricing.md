---
name: Wholesale pre-increase pricing flag
description: Add `pre_increase_pricing` flag to create_wholesale_order so transitional retailers can be invoiced at pre-Apr-16 retail × wholesale discount.
type: project
domain: b2b_sales
done_when: |
  - `create_wholesale_order` accepts `pre_increase_pricing: true`
  - When set, each line item's unit price is `previous_price × (1 - discount/100)` for SKUs with an Apr 16 2026 row in `price_history`; SKUs without one fall back to current retail × discount silently
  - Draft summary output shows old retail and the wholesale unit price per line so operator can sanity-check
  - Validated end-to-end on one real wholesale draft (e.g. AJ-only) — Shopify draft shows correct unit prices, no draft-level `appliedDiscount`
originSessionId: TBD
---

## Goal

Let Jamie create wholesale draft orders priced as if the Apr 16 2026 retail bump (16 products, 542 variants, adult sizes +$3-6) hadn't happened. Specific motivating case: AJ retail went $28 → $32; pre-increase US wholesale was $28 × 0.5 = $14, current US wholesale is $32 × 0.5 = $16. Existing wholesale partners who had been quoted the old prices need invoices at $14 for a transitional period.

## Build steps

1. **Backend (`customer-service/lib/tools/wholesaleOrder.js`):**
   - Add `pre_increase_pricing: { type: 'boolean', default: false }` to the `create_wholesale_order` input schema.
   - In the handler, when `pre_increase_pricing === true`:
     - Before resolving line items into the Shopify draft input, query Supabase: `price_history` rows where `variant_id IN (...resolved variant ids)` AND `changed_at >= '2026-04-16T00:00:00Z'` AND `changed_at < '2026-04-17T00:00:00Z'` AND `previous_price IS NOT NULL`. Build a `Map<variantId, previousPrice>`.
     - For each resolved line item: if the variant is in the map, set its `originalUnitPrice` (in the DraftOrderInput line) to `previousPrice × (1 - discountPercent/100)`. If not, leave `originalUnitPrice` unset (Shopify uses current retail) and apply no per-line discount.
     - **Skip the draft-level `appliedDiscount`** when the flag is on — discount is baked into per-line `originalUnitPrice` for snapshot SKUs, and non-snapshot SKUs are charged at current retail (intentional: they didn't change, so old=current).
     - The country-tier discount (50% US/AU, 30% others) and any `discount_percent` override still apply — they just feed into the per-line math instead of `appliedDiscount`.
2. **AU de minimis path:** the existing probe-then-split logic at `wholesaleOrder.js:386` reads back actual AUD prices from the Shopify draft. With per-line `originalUnitPrice` set, Shopify's currency conversion still runs against those overridden USD prices, so the probe should keep working. Verify on a non-trivial AU order.
3. **Draft summary output:** when the flag is on, prepend a header line `**Pricing:** pre-Apr-16 2026 retail (pre_increase_pricing=true)` and per-line show `~$<currentRetail>~ → $<oldRetail> × (1 - <discount>%) = $<unitPrice>` so operator can confirm before sending invoice. For lines not in the snapshot, show a `(no change)` marker so the operator notices.
4. **Tests:** add a test in `customer-service/test/` that stubs `price_history` with a couple of known SKUs (one with Apr 16 change, one without), calls the resolver, and asserts the line item input has correct `originalUnitPrice`. Per technical_rules: "Tests accompany deterministic code changes" — the price-mapping helper is deterministic and required.

## Decisions made (design conversation 2026-05-01 → 2026-05-03)

- **Source of pre-Apr-16 prices:** `price_history.previous_price` for rows on 2026-04-16. Verified 542 rows exist matching the initiative file's Apr 16 rollout count. **No hardcoded snapshot file.**
- **SKUs not in the Apr 16 rollout:** silently use current retail × wholesale discount. Rationale: youth sizes and unaffected products didn't change, so old = current; no need for a warning. Operator sees `(no change)` in the per-line output.
- **Single flag vs per-line override:** flag-based (boolean). Per-line price override would be more flexible but invites operator error and isn't motivated by current need. If a future case needs surgical override, add `price_overrides: { [sku]: number }` then.
- **Currency:** prices in `price_history` are USD. Shopify auto-converts overridden USD line prices into customer's currency, same as it does for variant retail. AU customer with USD overrides → Shopify presents AUD equivalents in the draft. The existing AU split logic reads `discountedUnitPriceSet.presentmentMoney` so it picks up converted prices automatically.
- **No `appliedDiscount` when flag is on:** keeping both would double-discount. Discount lives in per-line price math instead.
- **Flag name:** `pre_increase_pricing`. Considered `use_april_2026_pricing` (more explicit but uglier). Picked the cleaner one — the date is in the project file and code comment.
- **Sunset:** not part of `done_when`. When wholesale partners have transitioned to current pricing, removing the flag becomes a fresh parked entry.

## Alternatives considered and rejected

- **Hardcoded `wholesalePriceSnapshot.js` SKU→price map:** rejected — `price_history` already has full coverage, hardcoded snapshot would drift and require manual maintenance.
- **Manual `discount_percent` override per order:** works for single-product orders but breaks on mixed-product orders where the per-product price jump differs (AJ +$4, others +$3). Operator would have to compute a custom percentage each time and accept that mixed orders can't land all lines on old prices.
- **Decoupled wholesale price list table (MAP-style):** right long-term answer but much bigger build; overkill for a transitional flag.

## Edge cases

- **A draft mixes snapshot and non-snapshot lines:** snapshot lines get `originalUnitPrice` set, non-snapshot lines don't. Both end up correctly priced. Per-line summary makes the difference visible.
- **`discount_percent` override + `pre_increase_pricing`:** both honored — the override replaces the country-tier 50/30, and that overridden percentage is applied to `previous_price` per line.
- **Variant has multiple Apr 16 rows (price changed twice that day):** unlikely but possible. Take the earliest Apr 16 row's `previous_price` (= the truly pre-rollout price). Order by `changed_at ASC LIMIT 1` per variant.
- **Variant deleted from catalog since Apr 16:** `resolveLineItems` would fail upstream, so the pricing logic never sees it. Not our problem.
- **Free shipping:** unchanged — wholesale is always free shipping regardless of flag.
