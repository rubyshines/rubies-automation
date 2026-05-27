# CS Accuracy — Running Log

Refresh anytime. Newest entries at top. Times ET.

---

## Phase 0 — scaffolding ✓ (2026-05-27)
- Worktree `cs-accuracy` created from main HEAD; `.env` symlinked in.
- `scripts/_evalPullPairs.js` → **200 China-window pairs** (May 8–26) in `eval/pairs.json`.
  - 67 with a proposed action, 63 with an executed action, 129 prose-only.
- Plan: `eval/PLAN.md`. Rubric: `eval/RUBRIC.md`.

## Phase 1 — baseline diagnosis ✓ (2026-05-27)
- 200 pairs judged on two axes by 8 Opus subagents (Max plan, $0 API).
- **Prose accuracy: 71.5%** (143/200 clean) · 43 substantive reword · **12 factual corrections** · 2 prose-action mismatch.
- **Action accuracy: 94.5%** overall (189/200) · 84.5% among the 71 action-relevant · 7 over-proposed, 4 under-proposed.
- Read: `eval/baseline-report.md`. Per-ticket: `eval/baseline.json`.
- Headline read: action is already strong; prose headroom is mostly Jamie's *voice* (21.5%) vs real *factual errors* (6%) — the 6% is the honest prize. 2 of 12 factual errors likely already fixed post-window (refund amounts).
- Target locked: **factual + action errors only** (voice edits out of scope).

## Phase 2 — root-cause + prompt audit ✓ (2026-05-27)
- 22 error cases analyzed vs the 1,980-line prompt (Opus subagent, Max plan, $0 API).
- 7 root-cause clusters → `eval/findings.md`. Ranked hypotheses → `eval/hypotheses.md`.
- Top finding: **prompt line 1097 forces a populated action whenever prose is past-tense → manufactures phantom actions** (the biggest action-error cluster; ties to project_structured_output_consistency).
- 2nd: facts recalled from memory (colors, Tall variants) instead of looked up — extend the existing "never from memory" guard.
- Iteration order: H2a+H3+H5 (cheap prompt-only, 5 factual) → H1 (top action) → H4 (careful) → H6 (needs Jamie's facts).
- **GATE PASSED — Jamie said go, proposed order.**

## Phase 3 — rule confirmations (2026-05-27)
Verified facts against the live catalog (Jamie's principle: the system knows these facts, the advisor must check them, never recall from memory):
- **Colors:** Sky = Black + Pink (advisor said black-only → wrong). Fix = look up.
- **Tall (#1226):** Sky DOES have "L Tall" (SKU SKY2-BLK-LT, 14 Tall variants) — but Tall lives in `product_variants.selected_options`, NOT in the summarized `products.adult_sizes`. So advisor missed it. Fix = ground size recs in the real variant list incl. Tall. (Jamie was right.)
- **Youth sizes are product-specific, NOT uniformly even-only:** AJ/Charlie/Mia/Brooke even-only; Ruby/Serena/Sky/Stella include odd (7,9,11,13); Flo mixed. So #1005 (advisor offered "10 or 11" for AJ/Charlie, which are even-only) was a real error — but a blanket "even only" rule would be wrong. Fix = look up the specific product's sizes.
- **Ava (#1185)** is a bra (confirmed); product_type is null so rule must key off title. Fix = "bra band" for bras vs "bikini band" for swim tops.

Confirmed judgment rules from Jamie:
- **#1019 refund:** default = nudge to alternative (offer exchange-or-refund) unless they ask firmly/aggressively for refund. High nuance — Jamie wants me to study many cases incl. pre-China examples before writing the rule. (→ iteration 3)
- **#877:** always place warehouse hold on any change/add to an unshipped order.
- **#1066:** if no partner in customer's state, say so honestly + offer an alternative; never present out-of-state as local.

**Iteration 1 (grounded, no further input needed):** product-fact grounding rule (colors/sizes/Tall/variants → always look up) · bra-vs-bikini band phrasing · cancel-gate on fulfillment · auto-hold on modify-unshipped · partner-geography honesty.
**Iteration 2:** phantom-action (verify-already-executed + line-1097 past-tense coupling).
**Iteration 3:** refund nudge nuance (#1019) — study many cases first.

Experimental design: regen CURRENT-main prompt once on the subset (control) + each new prompt (treatment) on the same subset, judge both vs Jamie's sent ground truth, compare deltas. Subset = ~22 error tickets + ~25 clean control tickets.

## ⚠️ Phase 3 course correction (2026-05-27) — action metric was flawed
Building the regen harness surfaced that the action ground truth (`cs_ai_drafts.actions[]`) is INCOMPLETE — Jamie's manual actions (hold releases, holds, exchanges done outside the tracked path) aren't all logged. Re-judging the 11 "action errors" against Jamie's **sent prose** (what he said he did):
- **5 were NOT errors — advisor was correct, tracking just missed it:** #901, #910, #1048 (proposed hold-release; Jamie's reply confirms he released it), #974 (proposed hold; Jamie placed it), #1132 (proposed exchange; Jamie created it).
- **H1 (phantom-action / line-1097 exemption) is KILLED** — line 1097 is correct: when prose is past-tense ("I've released the hold"), surfacing the action is right. Fixing it would break correct behavior. Over-fit trap caught before any API spend.
- **Real action errors ≈ 6:** under-proposing (#877 hold, #960/#922 exchange, #920 address/consolidation), over-proposing (#1019 refund-not-choice, #1206 re-proposed already-done).
- Real action accuracy is HIGHER than the reported 94.5% (actions[] undercounts).

**Correction to method:** the action axis must be re-judged using **sent-prose as ground truth**, not actions[]. Re-judging the full 200 on the action axis (free, Max plan) before resuming.
**Revised hypotheses:** DROP H1. Keep H2a (product-fact grounding), H3 (sizing facts via lookup), H5 (cancel-gate), H6 (facts block), and H4 (under/over-proposing thresholds — now the main action work). Prose axis (71.5%) unaffected — it compares draft text to sent text directly.

## Phase 3 — harness validated + control regen running (2026-05-27)
- `scripts/_evalRegen.js` built + validated. Key fix: **anchor reconstruction at the draft's triggering `gorgias_message_id`** (not "first Jamie reply") so multi-round tickets regen faithfully. Smoke: #901 now correctly regenerates "I've released the hold" + action (confirming H1-kill); #1100 regenerates "Pink and Black, not red" (correct).
- Subset = 47 (22 error + 25 control), enriched with customer_email + gorgias_message_id.
- **Control regen RUNNING in background** (47 tickets, current-main prompt, ~12 min, ~$18 — first API spend). → `eval/regen/control/results.json`.
- Existing system already has Tall logic (sizeUtils + sizingEngine height-variant lookup) and got #1100 right in smoke — so control may show several "errors" are already fixed on current main. **Won't draft any fix until control shows which errors actually persist** (avoid re-fixing solved problems, per the refund-amount lesson).
- Next on control completion: judge control (prose + corrected action-via-prose), identify the real persistent error set, then targeted fixes.

## ⚠️⚠️ Phase 3 — MAJOR methodological finding: live-regen is confounded (2026-05-27)
Judged the 47-ticket control regen. Two confounds make the live-regen-vs-sent number unreliable:
1. **Order-state drift (decisive):** China-window orders have since been shipped/cancelled/refunded. Regen reads TODAY's order state, so the advisor correctly-for-now says "already shipped/refunded/cancelled" — but that contradicts the May conversation. CONFIRMED: #30604 now FULFILLED (was on-hold in May), #30704 FULFILLED+PARTIALLY_REFUNDED, #30873 cancelled+REFUNDED. This invalidates regen for ALL order-state-dependent cases (holds, cancels, refunds, exchanges, fulfillment) — the majority of action cases.
2. **Routing variance + stochastic/voice noise:** get_donation_partner geo-routes (regen picks a different valid partner → false "factual" flag); advisor temperature + Jamie's voice make prose diverge run-to-run. Control group (originally-CLEAN tickets) only regen'd 9/25 prose-clean — high noise floor.

**Conclusion:** the stored-May-draft baseline (Phase 1) IS faithful (generated in production at conversation time) and remains the valid accuracy measurement. But REGEN (re-running to test a change) is confounded → cannot be the iteration metric.

**Also confirmed:** advisor's TRUE accuracy is materially higher than the raw baseline implied — most "errors" were artifacts (incomplete actions[] tracking + order drift + routing variance + voice noise).

**Real, order-state-INDEPENDENT advisor weaknesses worth fixing (from the faithful stored baseline):**
- Packaging discretion facts (#1175): overclaims "no brand anywhere"; reality = name on return address. (needs Jamie's exact facts)
- Partner-geography honesty (#1066): present out-of-state partner honestly, not as local. (rule confirmed)
- Sizing-lookup discipline (#1005): per-product even/odd sizes — look up, don't recall.
- Link-giving (#1188): supply program link vs defer. (needs URL)
- Bra-anatomy phrasing (#1185): "bra band" for bras.
- Action thresholds: auto-hold on modify-unshipped (#877), offer-choice-vs-immediate-refund (#1019).

**Recommended pivot:** stop chasing a noisy full-regen accuracy number. Fix the small confirmed set above and validate each with TARGETED SCENARIO TESTS (controlled input → assert the specific behavior), the existing test/scenarios/ pattern — zero drift/noise confound, minimal API. Reserve regen only if truly needed. Awaiting Jamie's call.

## Phase 3 — fixes implemented + validated (2026-05-27)  [Jamie chose: fix + scenario tests]
Prompt changes in `customer-service/lib/aiAdvisor.js` (all order-independent, additive):
1. **RUBIES FACTS block** (new, verbatim, positive-framed): discreet-packaging truth (name IS on return address in small font — no more fabricated "Shipment"/brand-free claim), Free-Swimwear program URL, bra-vs-bikini band phrasing.
2. **Extended anti-hallucination rule 2:** never state sizes/COLORS/variants (incl. Tall) from memory — look up the specific product (sizes/colors vary per product).
3. **Partner-geography honesty:** if get_donation_partner returns an out-of-state partner, frame honestly as an alternative, don't present as local.

Validated via new `customer-service/test/scenarios/knowledgeFacts.js` (synthetic, order-free → no drift):
- **Program link (#1188): FAIL→PASS confirmed** (before: "I'm not familiar with a free swimwear program"; after: gives the URL). Clean win.
- Packaging (#1175): improved (after-draft states the name-on-return-address truth). Test assertion is loose — tighten before relying on it.
- Colors (#1100): already passed on current main — grounding rule is harmless reinforcement.
Facts come from Jamie's own sent replies (ground truth).

**KB data-quality issues found (→ park):** "RUBIES Shipping Information" article says AUSTRALIA domestic shipping (wrong, ships from US); KB articles are raw web-page scrapes with cart/UI junk.

**Deferred (need care / Jamie input):** refund-vs-choice nuance (#1019 — Jamie wants a multi-case study incl. pre-China); auto-hold on modify-unshipped (#877 — needs a current-unshipped-order scenario to test without drift); sizing even/odd mapping (#1005 — partly covered by the grounding rule).

**Spend so far ≈ $20 API** (1 control regen + scenario runs). Work is on branch `cs-accuracy` (NOT pushed — these go live on merge to main).

## Phase 3b — hard-facts grounding (Jamie's DB-as-source-of-truth principle) (2026-05-27)
Sweep of DB-backed "hard facts" vs advisor tools vs KB → `eval/hard-facts-sweep.md`. Key finds: advisor has 11 tools, never reads the KB; biggest gaps were shipping-policy facts and a DEAD tool reference.
Implemented + validated:
- **Fixed dead `delivery_estimate` reference (real bug):** prompt told the advisor to call delivery_estimate but it wasn't in the TOOLS array. Wired it to the existing handler (order_delivery_times, thousands of real shipments). Validated: UK question now returns data-backed "10-12 days, most within 14" instead of a memory guess. Scenario: `test/scenarios/deliveryGrounding.js`.
- **Fact-precedence rule (anti-hallucination rule 7):** operational facts (delivery times, stock, pre-order restock dates) come from tools, never memory; for an OOS/pre-order item, look up + state the restock date rather than only suggesting an order split (the Naomi lesson); don't guess shipping rates/countries.
- NOTE: caught + fixed a backtick bug — the system prompt is a template literal, so tool names in `backticks` broke the file. No backticks in prompt prose.

**shipping_info advisor tool — DONE (2026-05-27, commit b1bf0a2):** added `lookupShippingZone(country)` to lib/tools/shippingInfo.js (raw shipping_zones facts, no nested AI call; reuses detectCountry, falls back when a 2-letter input isn't the ISO code e.g. UK→GB). Registered shipping_info tool + executeToolCall case. 7 unit tests + scenario shippingPolicy.js. Validated: US "free shipping?" → "$99 threshold, else $10.50/$24" from DB. **Full unit suite 770/770 pass.**

**Remaining hard-facts work (scoped, not done):**
- **KB cleanup (→ park):** quarantine/fix the wrong "RUBIES Shipping Information" (Australia) + "Shipping Policy" (Portland, buyer-pays-duties) articles — they still feed the MCP `cs_get_knowledge` tool on OTHER surfaces.
- Verify compare_products / check_unfulfilled_order actually return restock dates so rule 7's pre-order nudge has data to state.

**Still deferred:** auto-hold on modify-unshipped (#877); refund-vs-choice nuance (#1019, needs multi-case study).
