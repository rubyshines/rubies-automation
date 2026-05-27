# Baseline Report — CS Advisor Accuracy (China window, May 8–25)

**N = 200** sent drafts. Ground truth = what Jamie actually sent (`sent_response`) and did (`actions[]`). Judged by Opus on two independent axes. $0 API (Max plan).

> **Caveat — window predates two known fixes.** The drafts were generated May 8–25; the **refund-amount removal** and **Execute & Send** shipped May 26. So wrong-refund-amount errors below (#1051, #1151) are likely *already fixed on current `main`*. Verify in Phase 2 before touching — don't re-fix solved problems.

## Headline numbers

| Axis | Metric | Result |
|---|---|---|
| **Prose** | accurate (IDENTICAL+COSMETIC) | **71.5%** (143/200) |
| **Action** | accurate over all 200 (incl correct no-action) | **94.5%** (189/200) |
| **Action** | accurate among the 71 action-relevant tickets | **84.5%** (60/71) |

Calibration check: 67% IDENTICAL matches the prior 5/26 finding (~62% byte-identical), so the judge is well-calibrated.

## Prose breakdown (200)
- IDENTICAL **134** · COSMETIC **9** → 71.5% clean
- SUBSTANTIVE_PROSE **43** (21.5%) — Jamie materially reworded, no factual error
- FACTUAL_CORRECTION **12** (6%) — draft was *wrong*; highest stakes
- PROSE_ACTION_MISMATCH **2** (1%) — prose described an action that doesn't match what was sent

## Action breakdown (200)
- NO_ACTION_CORRECT **128** · MATCH **51** · MINOR **10** → clean
- EXTRA_ACTION **7** — advisor proposed an action Jamie didn't execute (over-eager)
- MISSING_ACTION **4** — advisor proposed nothing but Jamie executed an action (under-eager)

## The 12 FACTUAL_CORRECTIONS (the dangerous class)
- **Wrong refund amount:** #1051 ($32→$28.80), #1151 ($136.80→$112.50) — *likely already fixed post-window.*
- **Wrong sizing facts:** #1005 (kids even-sizes only), #1226 (L vs L-tall).
- **Wrong product/availability facts:** #1100 (pink availability), #1185 (bikini band vs bra band).
- **Wrong partner/program facts:** #1066 (no WV partner exists), #1175 (return-address branding claim), #1188 (deferred a link it should have supplied).
- **Other:** #920 (corrected street address), #963 (invite time 11am→10am/Weds), #975 (hold failed, order shipped).

## The 11 ACTION errors
- **Over-proposed (EXTRA, 7):** #901, #1048, #974 (proposed warehouse hold / hold-release, none executed), #1132 (proposed exchange not yet done), #1206 (re-proposed an exchange already done), #910, #1019 (proposed full refund; Jamie offered exchange-vs-refund choice instead).
- **Under-proposed (MISSING, 4):** #877 (Jamie placed a warehouse hold advisor didn't propose), #920 (address fix + consolidation), #922 / #960 (Jamie did an exchange advisor proposed none for).

## Emerging clusters (tags fragmented across judges — Phase 2 consolidates)
**Prose:** added_personal_touch (4), removed_donation_info (3), internal_note_stripped (3 — possible measurement artifact: draft contained non-customer-facing notes), wrong_refund_amount (2), wrong_draft_content (2), changed_next_step (2), trimmed_clarification (2).
**Action:** over_proposed_action / hold-release-not-executed cluster, missed_exchange (2), missed_warehouse_hold, cancel_became_refund.

## Reading of the baseline
- **Action accuracy is already strong (94.5%).** The remaining 11 errors split symmetrically into over-proposing (7) and under-proposing (4) — mostly warehouse holds and exchanges. Tractable, narrow.
- **Prose is where the headroom is (71.5%).** Of the 28.5% Jamie edits: most (21.5%) is *style/substance reword* (tone, personal touch, trimming) — partly genuine prompt headroom, partly Jamie's voice that may be hard/undesirable to fully match. The **6% factual corrections are the real prize** — these are drafts that would have gone out *wrong*, and ~2 of the 12 are already fixed.
- **Biggest honest opportunity:** drive down FACTUAL_CORRECTION (sizing facts, product anatomy, partner/program facts, availability) and tighten the over/under-action proposals — rather than chasing byte-identical prose, which conflates real errors with Jamie's personal voice.

## Phase 2 plan (next)
1. Consolidate the fragmented tags into canonical clusters with counts.
2. Verify which factual errors are already fixed on current `main` (refund amounts, Execute & Send).
3. Audit the aiAdvisor.js system prompt for the ambiguity/conflict behind each live cluster (sizing facts, product facts, partner data, action-proposal thresholds).
4. Separate "fixable by prompt/context" (factual grounding, action thresholds) from "Jamie's voice" (personal touch) — only chase the former.
