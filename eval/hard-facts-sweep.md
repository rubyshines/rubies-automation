# Hard-Facts Sweep — DB source-of-truth vs advisor tools vs KB

Principle (Jamie): facts stored in our DB tables are authoritative and should override stale/ambiguous KB or memory. The advisor should look them up via tools and favor them.

The advisor has **11 tools** and **never reads the knowledge base** (no cs_knowledge_base tool in its loop) — its facts come from those tools + verbatim system-prompt text.

| Fact category | Authoritative DB source | Advisor tool today | KB/prompt textual coverage & conflict | Recommendation |
|---|---|---|---|---|
| Product sizes (incl Tall) | product_variants.selected_options, products.{kid,adult}_sizes | get_adjacent_sizes ✓ | size guide text | covered (extended grounding rule added) |
| Product colors | products.{kid,adult}_colors, product_variants | compare_products ✓ | — | covered (grounding rule added) |
| Inventory / stock | product_variants.inventory_quantity | compare_products / check_unfulfilled_order ✓ | — | covered |
| Pre-order / restock date | product_variants.pre_order_incoming, pre_order_date | check_unfulfilled_order / compare_products ✓ | — | rule 7 nudge added; verify the tools actually return restock date |
| **Delivery / transit time** | order_delivery_times (6,862 rows) + deliveryEstimate.js | **was DEAD ref → now wired ✓** | prompt assumed it existed | FIXED this session |
| **Ship-to countries / rates / free-ship threshold / DDP** | shipping_zones (237 rows, populated: US $99/$10.5, CA $96/$15, intl free/$15) | **NONE** | KB "Shipping Policy" ($99 everywhere, Portland) — stale | **ADD shipping_info advisor tool** (handler exists: lib/tools/shippingInfo.js) |
| Order tracking state | Shopify fulfillment events | shipping_lookup ✓ | — | covered |
| Materials / composition | products.materials_composition | not surfaced | — | low priority |
| Donation partner + geography | donation partner table | get_donation_partner ✓ | — | covered (geography-honesty rule added) |

## KB conflicts (advisor doesn't read KB, but cs_get_knowledge MCP tool does on OTHER surfaces — needs cleanup)
1. **"RUBIES Shipping Information"** — describes AUSTRALIA domestic shipping + buyer-pays-duties. Wholly wrong (US-shipping, DDP). Stale/other-brand scrape. **Quarantine.**
2. **"Shipping Policy"** — says ships from Portland, Oregon; fixed delivery windows; $99 everywhere. Stale (now US/LA via Passport). **Update.**
3. KB articles generally are raw web-page scrapes with cart/UI junk → low retrieval quality.

## Top recommendations
1. Add a `shipping_info` advisor tool over shipping_zones (countries / rates / threshold / DDP).  ← next
2. ~~Wire delivery_estimate into the advisor TOOLS array~~ — DONE this session.
3. Quarantine/fix the stale KB shipping articles (separate surface).
