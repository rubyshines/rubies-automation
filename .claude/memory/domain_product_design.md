---
name: Product Design & R&D
description: Graded specs, measurements, sizing research, product development, fit analysis
type: project
originSessionId: 76845f16-8454-4953-8882-a8bc486354fb
---
## What's Built

**Two Sizing Systems:**
- Numeric (Youth): 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16. Even-only products (underwear, swim tops) vs full range (swim bottoms, one-piece includes odd sizes).
- Letter (Adult): XXS, XXS+, XS, XS+, S, M, L, 1X, 2X, 3X, 4X. Plus variants only on swim bottoms and one-piece.
- Cross-system aliases: XL→1X, XXL→2X, etc. Numeric-to-letter fallback: 10=XXS, 11=XXS+, 12=XS, 13=XS+, 14=S, 16=M.
- Tall variants: SKU suffixes ST/MT/LT/XLT → "S Tall", "M Tall" etc.

**Grading Specifications (Fabric Deltas):**
- Full-size step: 2 inches (5cm) waist/chest circumference.
- Half-size step: 1 inch (2.5cm) — odd numeric sizes and plus variants.
- Cumulative deltas calculated by stepping through intermediate sizes.
- Product-specific delta wording (e.g., "bra band will be X inches longer" vs "fabric around the waist").

**Measurement & Fit Logic:**
- Primary: waist circumference (below navel). Secondary: height (one-piece only).
- Size charts in Supabase (94 entries) with min/max inches per size per chart category.
- One-piece fit analysis: exact fit, wiggle room (±1 size), separates recommendation (2+ sizes apart).
- 65 grading rules seeded from 8 rubyshines.com size guide pages.

**Product Classification:** 25 active products across 7 categories (underwear_bottom, underwear_top, swim_bottom, swim_top, onepiece, chest_pads, accessory). Each has specific size system and variant rules.

## Current Status

- **Production:** Sizing constants and normalization library fully stable. Product classification and grading deltas powering exchange logic. Measurement-based sizing active. One-piece fit analysis working. Chest pad sizing (S/M/L by base size) in use.
- **Partial:** Product metafields synced from Shopify but not surfaced in product recommendation logic.

## Key Files

- `customer-service/lib/sizingEngine.js` — Product classification, size normalization, grading deltas, fabric calculations.
- `customer-service/lib/sizeUtils.js` — Size utility functions.

## Key Decisions

- **Deterministic sizing, not AI:** All size calculations, alias normalization, chart lookups, grading deltas are pure functions. AI only handles fuzzy product matching and natural language.
- **Sizes from SKU, not variant title:** Last segment of SKU is canonical size.
- **Half-size logic is load-bearing:** Odd numeric sizes and plus letters represent actual 1" grading steps, not display variants.

## What's Next

- Measurements plan for graded spec across all designs
