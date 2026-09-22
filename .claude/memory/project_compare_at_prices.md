---
name: Compare-at prices
description: Teach set_product_prices to set and clear compare-at prices, audit every variant whose compare-at differs from its price, then bring them in line on Jamie's say-so
type: project
domain: inventory
done_when: "`set_product_prices` can set or clear a variant's compare-at price through the same preview-and-confirm flow as price (tests green), a report lists every live variant whose compare-at differs from its price grouped by product with the gap and direction, Jamie has been shown that list and named any exceptions, and every non-excepted variant has compare-at equal to its price (or cleared), verified by re-running the report and by the cart drawer showing the right \"You save\" on a discounted adult AJ."
---

# Compare-at prices

For another session. Written 2026-09-22 after the Virtual Closet cart line exposed the bug; Jamie asked for this exact sequence: extend the tool first, then audit, then he decides what gets set.

## Why

Shopify variants carry `compare_at_price`, the struck-through "was" price. The theme's cart drawer (`snippets/cart-drawer.liquid` in rubies-ecom-v4) sums compare-at prices when present and prints the difference from the cart total as "You save". Eight products still carry the compare-at from before their last price rise (AJ adult: price $32, compare-at $28), so every discount on them reads about $4 a pair low, and a discount smaller than the gap hides the line. Confirmed on the live theme 2026-09-22: two adult AJ with a 20% code shows "You save: $4.80" on a $51.20 subtotal.

Nothing in rubies-automations writes compare-at today. `set_product_prices` (`customer-service/lib/tools/setPrices.js`) sets `price` only, through `updateVariantPrices` in `customer-service/lib/shopify.js`, which sends `{ id, price }` to `productVariantsBulkUpdate`. The old spreadsheet sync that once owned product data is gone; the theme repo's `feedback_theme_rules.md` still says otherwise and is stale on that point.

## Step 1: the tool

Extend `set_product_prices` rather than adding a sibling; it already has the item resolution (variant_id / sku / query, sizes and colors filters), the scope description, and the two-phase preview-and-confirm with a `confirmation_token`. Changes:

- Each item accepts, besides `price`, an optional `compare_at_price` (number) and `clear_compare_at` (boolean). At least one of `price`, `compare_at_price`, `clear_compare_at` is required per item. `compare_at_price` and `clear_compare_at` together is an error.
- `updateVariantPrices` passes `compareAtPrice` through when given: a string for a value, `null` to clear. `ProductVariantsBulkInput` accepts `compareAtPrice`. Keep `price` optional in the input so a compare-at-only change does not touch the price.
- Preview lines show what changes per variant group: "price $28 → $32", "compare-at $28 → $32", "compare-at $28 → cleared". Same describeScope wording as today.
- Refuse a compare-at below the resulting price in the preview (Shopify allows it; it is exactly the state that caused this). Allow equal (Shopify shows no strike-through when equal) and above (a real sale).
- The Supabase mirror: check whether `products`/`product_variants` rows carry compare-at (grep `compare_at` in `customer-service/sync/syncProducts.js` and the schema). If they do, write it alongside price the way price is written now; if not, leave it, the daily product sync reconciles from Shopify.
- Tests in `customer-service/test/`: the input validation, the preview wording for each of the three operations, the below-price refusal, and the mutation payload shape (stub `shopifyGraphQL`). Follow whatever the existing setPrices tests do.

## Step 2: the audit

A read-only report, either a `--report` mode on a script under `scripts/` or a small MCP tool (`audit_compare_at_prices`), listing every variant on the live store where `compare_at_price` is set and differs from `price`. Read from Shopify, not the mirror, so it is current. Group by product; per variant show size, colour, price, compare-at, and the direction (below price = stale, above price = an intended sale). Totals per product and overall.

Known as of 2026-09-22 (from the storefront's `products.json`, so unpublished products may add to it): AJ (33 variants), Charlie (33), Ruby (30), Sassy (27), Serena (24), Cheeky (10), Naomi gaff (8), Flo (6), all with compare-at below price. Kids AJ sizes 4 to 10 are $28 with compare-at $28, so they are equal and fine.

## Step 3: Jamie decides

Show him the report. He will name exceptions, if any (a product deliberately on sale keeps a compare-at above its price). For everything else, set compare-at equal to the price, or clear it; ask him which of the two he wants as the default, since "equal" preserves the field for a future sale and "cleared" is tidier. Apply with the tool in step 1, product by product, preview then confirm. Re-run the report to confirm it is empty apart from the exceptions.

## Related, not in scope

- The theme guard so the drawer ignores a compare-at below the price (`snippets/cart-drawer.liquid`, one condition). Worth doing regardless, on the Virtual Closet theme branch or its own; it makes the drawer safe against the next stale value.
- Fixing the stale spreadsheet note in the theme repo's `feedback_theme_rules.md`.
