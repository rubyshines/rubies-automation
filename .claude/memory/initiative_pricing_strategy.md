---
name: Pricing Strategy 2026
description: Price increases, fixed bundle pricing, DDP optimization
type: project
domains: [marketing, inventory]
last_updated: 2026-08-13
originSessionId: 92b09cb7-a9a6-4a53-89f7-c693b5fe3f65
---
## Goal
Execute 2026 pricing strategy to improve margins and simplify pricing.

## What Rolled Out (2026-04-16 / 2026-04-18)
- **Apr 16 — Pricing on 16 products with youth/adult split.** 542 variants changed. Adult sizes (12+ and letter) +$3-6; youth sizes (4-11) held. Affected products: AJ, Charlie, Sassy, Flo, Ruby, Mia, Brooke, Ava, Cheeky, Stella, Serena, Sunny Tankini, Sky one-piece, Naomi gaff, Chest pads, plus the legacy NO-TUCK SHAPING line.
- **Apr 18 — US standard shipping rate $9 → $10.50** (+16.7%).
- **~Apr 18 — DDP free shipping expanded.** Free-ship rate on DDP orders jumped from 8.6% → 48% of orders. Mechanism: free-shipping option added to DDP zones.
- **Bundle repricing:** fixed dollar prices live ($79 bikini, $62 matching, $119 shaping). 3-pack skipped (youth/adult spread).

## What Rolled Out (2026-08-12) — Nordics market
- **Norway market renamed Nordics; Sweden and Denmark moved into it, out of the International catch-all.** Local currencies on (SEK/DKK/NOK off one market), price adjustment +10% → +20%. Net shelf effect: Sweden +20%, Denmark +20%, Norway +9%. Modelled at ~$1,240/yr contribution, with break-even at 24% (SE) / 27% (DK) volume loss.
- **Done by editing the existing Norway market, not creating one.** The store is on the Shopify plan with 11 markets against a standard limit of 3, so the market slots look grandfathered and are treated as non-replaceable: never delete one to make room. Rollback state saved at the time of the change.
- **Watch:** volume in SE/DK over the next quarter — 33 and 21 orders/yr respectively, so this reads slowly and a single month proves nothing.
- **Poland is the same unclosed gap** — still International/USD at 0% while every EU neighbour is +10%. 8 orders/yr, not yet actioned.

## Initial 11-Day Results (PRE Apr 5-15 vs POST Apr 16-26, ex-China)
- Orders 275 → 221 (-19.6%); revenue $23,182 → $21,324 (-8%)
- AOV $84.30 → $96.49 (+14.5%) — half from price, half from basket size
- Contribution margin / order +$10.63 (+16.7%); margin % 71.2% → 72.9% (+1.7pp)
- Total contribution dollars roughly flat (-1 to -6%)

## Validated Findings
- **Pricing change worked at unit level.** Per-order economics improved as designed.
- **POST Apr 20 week is statistically normal** vs 90-day baseline (orders z=+0.04, revenue z=+0.14, AOV z=+0.14, CR z=+0.21). PRE was the elevated window.
- **2025 April surge was driven by the "Beat The Tariff Sale" 20% off Apr 18-27.** 2026 doesn't have an equivalent promo. YoY comparison without controlling for the sale is misleading.
- **Bundle ATC events spiked** (3-AJ +69%, Matching Set +13%) — likely tied to the unfixed bundle dynamic-pricing bug making adult bundles look cheaper than standalone.

## Retracted Claims (didn't survive cross-validation)
- "Pricing hurt demand by 20%" — POST is within normal weekly variance.
- "Direct channel collapsed -24%" — GA4-China-bot artifact; Shopify shows -1.3%.
- "Email program collapsed because of pricing" — campaign content shifted (reviews vs product launches), not pricing reaction.
- "Returning customers dropped 31%" — derived from same channel attribution that didn't survive.
- "Youth volume crashed 57%" — POST youth-share (7.5%) is in line with Mar 14-24 (7.3%); PRE was the outlier.

## Open Issues
- **Bundle dynamic-pricing fix not deployed** ([bundle-pricing-fix-brief.md](../../bundle-pricing-fix-brief.md) is uncommitted). Adult bundle picks still resolve to youth prices in cart → active margin leak on every adult-size bundle order. Highest-priority fix.
- **Brooke PDP view→ATC halved** in GA4 (13.5% → 6.6% PRE→POST). Only product showing real PDP-level friction. Worth investigating image/copy/stockouts.
- GA4 data quality investigated and resolved 2026-04-28. ~70% capture rate is structural (web-pixel-only). itemId format is `shopify_<COUNTRY>_<PRODUCT_ID>_<VARIANT_ID>`. Earlier item-level findings (Brooke view→ATC halved, bundle ATC +69%) are more trustworthy than caveated.

## Decisions Made
- Fixed dollar bundle prices instead of % off display
- 3-pack can't work with single fixed price due to youth/adult spread
- DDP free-shipping expansion shifted AU/DE conversion materially up — keep as-is
- US shipping increase to $10.50 not rolled back (no demand evidence to justify)
- **Market price uplift is set against the duty burden, not picked as a round number.** Duty is charged on declared value, so it scales with price and only ~70-75% of an uplift survives in high-VAT markets. Sizing an increase means starting from the country's customs-as-%-of-revenue, not from a target headline price.
- **Switzerland is not a DDP decision to make.** It sits in the DDU zone and always has; Passport prepaid Swiss VAT anyway until ~May 2026 then stopped, at the same time its freight fell 66%. Customers now pay at the door. Nothing to configure, but it explains any Swiss customs complaints.
