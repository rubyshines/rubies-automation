---
name: Exchange scenario testing plan and progress
description: TEMPORARY — Ordered list of exchange/return scenario categories with testing progress. Delete once batch comparison against real conversations is complete.
type: project
done_when: Batch comparison tool built and run against real conversations. Check if customer-service/lib/tools/batchComparison.js exists.
---

## Scenario Testing Plan — Simple → Complex

Based on analysis of 1,489 exchange/return + 1,000 non-exchange conversations (2026-03-24).

### Tier 1 — Single Item, Clear Intent (simplest)
- [x] **1a. Size too small — "a bit tight"** — auto-confirm one size up *(tested with Eline, Jessica)*
- [x] **1b. Size too large — "a bit loose"** — auto-confirm one size down *(tested with Eline)*
- [x] **1c. Size too small — "too tight"** — offer options with delta *(tested with Devorah)*
- [x] **1d. Size too large — "too loose"** — offer options with delta *(tested with Eline 3x AJ 8→6, color expansion fix)*
- [x] **1e. Customer specifies exact desired size** — auto-confirm or confirm with delta *(tested with Jessica M→L)*
- [x] **1f. Defect/quality issue** — simplified: apologize + ask photo + route to human *(tested with Rachel/AJ misshapen leg hole)*
- [x] **1g. Wrong item received** — apologize + send replacement + route to human *(tested with Rachel/Brooke Bra wrong color)*

### Tier 2 — Single Item, Needs Clarification
- [x] **2a. "Doesn't fit" without direction** — ask product-specific question *(tested: AJ bottom, Brooke Bra top, Sky One-Piece. Fixed: issue clarification upgrade, isABit false positive on "a bit short")*
- [x] **2b. "Doesn't work" / shaping not working** — self-diagnosed path added *(tested with Jade)*
- [x] **2c. Tight legs** — style switch *(tested: AJ 14→Flo, Ruby M→Cheeky, Charlie 8→Flo (third party), Sassy L→size up (same product), Flo 16→Sassy (boundary), Flo 14→Sassy alt offered. Fixed: size 16 as adult, Sassy→Sassy size up, measurement ask when waist not confirmed, adult equiv size in crossover)*
- [x] **2d. Way off sizing** — measurement needed *(tested with Erin "much too small" + measurement, Rachel "way too big" + 24" waist → size 10 → confirmed. Fixed: _pendingSize for confirmation, intakeItem reference in measurement path)*
- [x] **2e. Refund request** — now probes first, then offers exchange, then refund if declined

### Tier 3 — Multi-Item Exchanges (239 convos total)
- [x] **3a. Same product, same size, multiple qty** — multi-item expansion *(tested with Eline 3x AJ)*
- [x] **3b. Same product, different sizes** — try-size-return flow with swap offer *(tested with Nico 3X/4X Charlie)*
- [x] **3c. Different products, same size** — between-sizes note *(tested with Nico AJ+Charlie 2X)*
- ~~3d. Different products, different sizes~~ — not a realistic scenario
- [x] **3e. Mix of exchange + keep + return** — per-item response composition *(tested with Marie Stella+pads, Christine tankini+shorts)*

### Tier 4 — Product/Context Variations
- [x] **4a. Tops/bras** — different fit wording *(tested with Sarah Brooke bra + Ruby)*
- [x] **4b. Swimwear — odd sizes** — half-step options, measurement ask, bridge text *(tested with Caleb Serena 9→7, Michelle Ruby 11→10 x2)*
- [x] **4c. One-pieces** — height variant (Tall/Regular), two-part fit question, height+waist measurement *(tested with Jo Lloyd Sky L Tall→M Tall, Marie Sky L→L Tall)*
- [x] **4d. Youth/numeric sizing** — even/odd split *(tested with Eline size 10→8)*
- [x] **4e. Boundary crossover** — youth 16 → adult, adult XXS → youth *(tested: 16 too tight → L with crossover note, XXS too loose → 16, 16 a bit tight → auto-confirm L + crossover. All 3 scenarios validated.)*
- [x] **4f. International customer** — cm not inches *(Jo Lloyd GB confirmed cm works. Pre-purchase: 58cm → size 8 in kids AJ.)*
- [ ] **4g. Out of stock** — recommend similar product (not yet in tree)
- [x] **4h. Product category mismatch** — youth product on adult customer → recommend adult product *(tested with Nico, partially working — see pending issues)*

### Tier 5 — Multi-Factor
- [x] **5a. Third-party buyer** — pronoun adaptation *(tested with Eline/daughter, Christine/daughter, Devorah/daughter)*
- [x] **5b. Mixed refund + exchange intent** — per-item processing *(tested with Marie, Christine)*
- [ ] **5c. Safety override** — now uses AI parser detection

### Tier 6 — Complex Multi-Order (most complex)
- [ ] **6a. Multiple orders, single exchange** *(partially tested with Devorah — cross-order question)*
- [ ] **6b. Return some + exchange others, single order**
- [ ] **6c. Return + exchange across multiple orders**

### Tier 7 — Non-Exchange Conversations (1,000+ convos)
- [ ] **7a. Shipping / tracking inquiry** — stub routes to human. Shipping subsystem planned (Shopify fulfillments + Passport for international).
- [x] **7b. Pre-purchase sizing question** — BUILT: cs_advisor routes sizing_inquiry to prescribePrePurchaseSizing. Tested: adult/kids/cm, one-piece with height (exact/wiggle/separates), cross-product reference sizing (AJ 8→Ruby with odd sizes), no measurement asks, no product asks. Fixed: height-based kid/adult detection, shared analyzeOnepieceFit, alt chart height analysis.
- [ ] **7c. Order status / modifications** — stub routes to human
- [ ] **7d. Product questions** — stub routes to human (could use cs_get_knowledge)
- [x] **7e. Thank you / positive feedback** — warm acknowledgment, no action needed
- [ ] **7f. Wholesale inquiry** — stub routes to human
- [ ] **7g. Discount / promo code**

## Pending Issues from 2026-03-26/27 Session

### Nico scenario (product category mismatch) — partially working
- [x] Product switch: youth chart miss → try adult chart → recommend AJ 2X
- [x] Multi-size expansion: "both too small" → creates intake items for both sizes
- [x] Quantity: "I'll send 2 pairs out as an exchange"
- [x] Youth line acknowledgment: "is actually our youth line"
- [ ] **Message 2 doesn't acknowledge youth/adult confusion** — when customer says "I found there are adult sizes", the tree should recognize this and redirect to adult products proactively (before measurement)
- [ ] **Donation count with product switches** — 2 items should route to a named partner, not "donate locally"
- [ ] **Duplicate response text** — product switch text appears twice (once per intake item) instead of being deduplicated
- [ ] **Need unit tests** for product category mismatch path

### Sonnet polish quality
- Switched from Haiku to Sonnet — better quality
- Added tone samples from Supabase for voice grounding
- Added "no reinterpret sizing" rule — mostly working but Sonnet occasionally still rephrases
- Raw composer text is now clean enough that polish failures (API errors) produce acceptable output

### Multi-item flag improvements
- Swim and underwear are now separate body groups (don't cross-flag)
- One-piece is its own body group
- Multi-item flags hold order creation until customer responds
- `_crossProductComparison` flag suppresses flags (parser hook not yet implemented)
- `_multiItemAnswered` flag releases the hold (advisor hook not yet implemented)

## Key Changes Made (2026-03-26/27)

### Architecture
- **AI tone pass upgraded** — Haiku → Sonnet, tone samples from Supabase, no-reinterpret-sizing rule
- **Half-step product logic** — swim_bottom and onepiece always present options with deltas (never auto-confirm desired size)
- **Variant modifier system** — parseSizeVariant/getSizeModifier extract Tall/Regular from SKU (e.g., SKY2-BLK-LT → L + Tall)
- **Measurement cross-reference** — when customer provides measurement + desired size, look up chart and include note
- **Product category mismatch** — when measurement doesn't fit current product's chart, try alternate chart (youth↔adult) and recommend the right product
- **initCsConfig guard** — advisor auto-initializes product config for standalone usage
- **AI parser: desired_size not promoted to resolved_size** — let the decision tree handle confirmation

### Decision Tree Changes
- **`height_variant_check`** — new action for one-piece too_short/too_long, asks for height+waist
- **Height + waist lookup** — clean match, size-up wiggle room (±1 size), or suggest separates
- **One-piece always asks for height** alongside waist in all sizing paths
- **Refund probe** — asks what went wrong before offering swap (new `_returnProbed` state)
- **One-piece return probe** — includes measurement offer + "we can always find an alternative"
- **Multi-item body groups** — swim_bottom, underwear_bottom, swim_top, underwear_top, onepiece (5 groups, was 3)
- **Multi-item flag holds order** — `_multiItemAnswered` required to release
- **`_crossProductComparison`** — suppresses multi-item flags when customer compared products
- **Options cap at 2** — never show more than 2 size alternatives
- **Bridge text** — "Since we have half sizes..." when presenting options different from requested
- **"compared to the [size]"** — all delta descriptions reference the current size
- **Multi-size expansion** — "both too small" expands to one intake item per size
- **Legacy product deactivated** — "No-Tuck Underwear" config set to draft (keyword "no-tuck" collided)
- **Nickname-based isSameProduct** — fixes phantom multi-item flags

### Tests
- 219 tests passing (was 181)
- Added: half-step options, measurement cross-reference, one-piece height variant, parseSizeVariant, multi-item body groups, order hold, refund probe, nickname matching
- Added 7 end-to-end walkTree tests for complex scenario chains
