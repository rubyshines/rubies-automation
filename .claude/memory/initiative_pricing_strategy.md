---
name: Pricing Strategy 2026
description: Price increases, fixed bundle pricing, DDP optimization
type: project
domains: [marketing, inventory]
last_updated: 2026-09-09
originSessionId: 92b09cb7-a9a6-4a53-89f7-c693b5fe3f65
---
## Goal
Execute 2026 pricing strategy to improve margins and simplify pricing.

## What Rolled Out
- **2026-04-16 — Pricing on 16 products with a youth/adult split.** Adult sizes (12+ and letter) +$3-6; youth sizes (4-11) held.
- **2026-04-18 — US standard shipping rate $9 → $10.50.**
- **~2026-04-18 — DDP free shipping expanded**: a free-shipping option was added to DDP zones, and the free-ship share of DDP orders rose sharply.
- **Bundle repricing:** fixed dollar prices live ($79 bikini, $62 matching, $119 shaping). 3-pack skipped (youth/adult spread).
- **2026-08-12 — Nordics market.** Norway market renamed Nordics; Sweden and Denmark moved into it out of International, local currencies on, price adjustment +20%. Done by editing the existing market, not creating one: the store holds 11 markets against a standard limit of 3, so slots look grandfathered and are never deleted. Watch SE/DK volume over a quarter (low order counts, so a month proves nothing). **Poland is the same unclosed gap** (still International/USD at 0% while every EU neighbour is +10%); not yet actioned.

## Validated Findings (April 2026 rollout)
- Per-order economics improved as designed: AOV up ~15% (half price, half basket size), contribution margin per order up, margin percentage up; total contribution dollars roughly flat in the first weeks.
- The post-change weeks were statistically normal against the 90-day baseline; the pre-change window was the elevated one. The 2025 April surge was a tariff sale, so YoY without controlling for it misleads.
- Several early alarm findings (demand down 20%, direct channel collapse, email collapse, returning-customer and youth-volume drops) were retracted after cross-validation as GA4 or attribution artifacts.

## Open Issues
- **Bundle dynamic-pricing bug:** adult bundle picks still resolve to youth prices in the cart, an active margin leak on every adult-size bundle order (parked, handed to the theme repo).

## Decisions Made
- Fixed dollar bundle prices instead of % off display
- 3-pack can't work with a single fixed price due to the youth/adult spread
- DDP free-shipping expansion shifted AU/DE conversion materially up; keep as-is
- US shipping increase to $10.50 not rolled back (no demand evidence to justify)
- **Market price uplift is set against the duty burden, not picked as a round number.** Duty is charged on declared value, so it scales with price and only ~70-75% of an uplift survives in high-VAT markets. Size an increase from the country's customs-as-%-of-revenue, not from a target headline price.
- **Switzerland is not a DDP decision to make.** It sits in the DDU zone and always has; Passport stopped prepaying Swiss VAT around May 2026, so customers now pay at the door. Nothing to configure, but it explains Swiss customs complaints.
