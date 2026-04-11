---
name: Product Design & R&D
description: Graded specs, measurements, sizing research, product development, fit analysis
type: project
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

## Advisor Prompt Candidates

- Currently empty

## Current Status

- **Production:** Sizing constants and normalization library fully stable. Product classification and grading deltas powering exchange logic. Measurement-based sizing active. One-piece fit analysis working. Chest pad sizing (S/M/L by base size) in use.
- **Partial:** Product metafields (fit_description, comparison_notes, materials_composition) synced from Shopify but not surfaced in product recommendation logic.
- **Gaps:** No historical grading delta audit trail. Metafield-based fitting notes not consumed by AI.

## Key Decisions

- **Waist-primary, height-secondary for one-piece:** Most fit failures are height-related, not waist. Customers more forgiving of loose waist if length is correct.
- **Half-size logic is load-bearing:** Odd numeric sizes (7, 9, 11, 13) and plus letters (XXS+, XS+) represent actual 1" grading steps, not display variants. Affects cumulative delta calculations.
- **Deterministic sizing, not AI:** All size calculations, alias normalization, chart lookups, grading deltas are pure functions. AI only handles fuzzy product matching and natural language intake parsing.
- **Sizes from SKU, not variant title:** Last segment of SKU is canonical size.

## What's Next

- Measurements plan for graded spec across all designs (in progress)
- Surface product metafields (fit_description, comparison_notes) in sizing recommendations
