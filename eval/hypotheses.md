# Phase 3 Hypotheses — ranked by (impact × ease)

Scoreboard: drive **factual-error count** (10 live, excl. 2 already-fixed refund cases + 1 voice) and **action-error count** (11) toward zero, without regressing the 189 clean cases.

---

### H1 — Verify-already-executed; stop forcing a phantom action on past-tense prose  ⭐ top leverage
**Targets:** 901, 910, 974, 1048, 1132, 1206 (EXTRA_ACTION) + partial 960. ~6-7 action errors.
**Root cause:** No rule to check whether an action is already reflected before proposing it; worse, **line 1097 forces a populated `operator_action_summary` whenever prose is past-tense**, manufacturing phantom actions on second-round tickets. Ties directly to `project_structured_output_consistency.md`.
**Fix:** (a) Add a rule: before proposing hold/release/exchange, check order tags / fulfillment / prior actions in context; if already reflected → status=ready, prose-only confirmation, NO proposed action. (b) Exempt the 1097 past-tense→populated-action coupling for the already-done case. (c) Ensure context surfaces enough order/hold/tag state for the advisor to know.
**Effort:** medium (prompt + possibly context enrichment). **Validate first:** confirm these were actually already-done vs merely deferred (check 1-2 tickets' history).

### H2a — "Never state product facts from memory; look them up"  ⭐ high, prompt-only
**Targets:** 1100 (colors), 1226 (Tall variant). 2 factual errors (+ generalizes).
**Root cause:** Advisor recalled colors/variants from memory; the "never from memory, always look up" discipline today only covers donation addresses (674, 737).
**Fix:** Extend the grounding guard — before stating available colors or size variants (incl. Regular/Tall on one-pieces), call the catalog/compare_products tool and state only what it returns. Prompt-only; uses existing tools (aligns with "use the real tools").
**Effort:** low. **Impact:** high (this class recurs).

### H3 — Sizing-fact corrections (prompt-only)
**Targets:** 1005 (kids even-only), 1185 (bra vs bikini band phrase). 2 factual errors.
**Fix:** (a) Add "youth underwear = even sizes only" and resolve the line-877↔youth-table half-size conflict. (b) Split the band-measurement phrase: bras → "where a bra band sits", swim tops → "where a bikini band sits" (line 1091).
**Effort:** low. **Need to confirm:** the even-youth-only fact (I'll verify via sizing engine / catalog).

### H4 — Act-vs-ask thresholds
**Targets:** 877 (missed hold), 922 (under-committed exchange), 1019 (over-refunded). 3 errors (mixed).
**Fix:** (a) Any modify-unshipped intent → set warehouse_hold, not needs_info (line 963). (b) When prior context names the target size, create the exchange rather than re-asking (694-699 vs 1099). (c) Tighten 707(d): "doesn't work" → offer exchange-or-refund choice unless an exchange was explicitly declined.
**Effort:** medium — **highest regression risk** (these thresholds touch many clean cases). Test against siblings hard.

### H5 — Cancel gates on fulfillment status
**Targets:** 975. 1 error.
**Fix:** Cancel path (973-977) → if order is FULFILLED, cancel is impossible; propose refund_order and say so.
**Effort:** low. **Impact:** low but unambiguously correct.

### H6 — Static facts block (needs Jamie's real values)
**Targets:** 1175 (packaging discretion), 1188 (free-swimwear program URL), 1066 (partner geography), 920 (consolidation/address).
**Fix:** Add a small Known-Facts block: packaging/discretion facts, program/returns URLs, and a "partner must match customer's state" rule (partner data exists in donation routing). 920's consolidation rule is separate.
**Effort:** low-medium. **Blocked on:** actual packaging facts + canonical program URL from Jamie. Partner-geography and consolidation parts are not blocked.

---

## Proposed iteration order
1. **H2a + H3 + H5** together (cheap, prompt-only, low regression risk, 5 factual errors) → regen subset → measure.
2. **H1** (top action leverage, after validating the already-done assumption) → regen → measure.
3. **H4** (careful, sibling-tested) → regen → measure.
4. **H6** once Jamie supplies packaging facts + program URL.

Each step: change prompt in worktree → regen advisor on a stratified subset (the affected error tickets + a clean-case control sample) → re-judge both axes → log delta in PROGRESS.md → keep if it fixes targets without regressing controls, else revert.
