# CS Advisor Accuracy Improvement

**Created:** 2026-05-27
**Domain:** cs
**Worktree:** `cs-accuracy` (isolated, rollback-safe; branched from main HEAD)
**Goal:** Improve the CS advisor's accuracy by measuring divergence between what the advisor drafted/proposed and what Jamie actually sent/did, during the clean ~2.5-week China window (May 8–25), then iterating on the prompt/context until both prose and action accuracy improve.

## Why now / why the China window
Jamie was in China May 8–25 making only limited changes — a stable prompt, not a moving target. The 200 sent drafts in that window (vs 394 in the noisier before-period back to Mar 30) are a uniquely clean baseline: stored `draft_response` was produced by essentially the current prompt, so production data *is* a faithful measure of current accuracy with zero re-runs.

## Two independent metrics (we only have prose evals today, never action)
The existing holdout (customer-service/test/runHoldout.js) only graded customer-facing prose on exchange/return tickets — it never scored the operator action. We grade **both, separately**, each against Jamie's ground truth:

1. **Prose fidelity** — `draft_response` (advisor) vs `sent_response` (Jamie). Judge classifies each diff:
   IDENTICAL / COSMETIC (whitespace, signature, greeting) / SUBSTANTIVE_PROSE (materially reworded content or tone) / FACTUAL_CORRECTION (changed a fact, date, policy, number) / PROSE_ACTION_MISMATCH (prose described the wrong action).
   **Prose accuracy = % IDENTICAL + COSMETIC.**
2. **Action fidelity** — advisor's proposed action (`structured_output.action_type` / `items[]` / `operator_action_summary`) vs what was actually executed (`cs_ai_drafts.actions[]`). Judge classifies:
   MATCH / MINOR (same action, different detail) / WRONG_ACTION / MISSING_ACTION (advisor proposed none, Jamie did one) / EXTRA_ACTION (advisor proposed one, Jamie did none).
   **Action accuracy = % MATCH + MINOR.**

   **Data confirmed (200 China-window pairs):** 63 have an executed action, 67 have a proposed action; action-type vocabularies align. ~133 are no-action (info/needs_info) → graded on prose only + a "correctly proposed no action" check. The proposed(67) vs executed(63) gap is itself signal. This action eval does **not exist today** — building it is core to the project.

## Cost architecture (Max plan vs API)
- **Baseline (200 pairs):** judging only, no advisor re-run → Claude/subagents on the **Max plan**. **$0 API.**
- **All judging in the iteration loop:** Max plan. **$0 API.**
- **Prompt audit, hypotheses, clustering:** Max plan. **$0 API.**
- **Faithful advisor regen after a prompt change:** must use the real production code path (aiClient → API), or the number doesn't transfer. **API-billed, the only cost pool.** Minimized via stratified subset (~40–50 tickets/iteration ≈ $12–20).
- Scripts do the heavy work and write compact summaries to disk; Claude reads deltas only.
- Estimated total API: **~$150–200**; baseline + all judging free on Max.

## Phases (gated; running log in eval/PROGRESS.md)

### Phase 0 — Worktree + scaffolding  ← (in progress)
- Worktree `cs-accuracy` created. ✓
- `scripts/_evalPullPairs.js` → 200 China-window pairs into `eval/pairs.json`. $0 API.
- `eval/` dir + `eval/PROGRESS.md` running log.

### Phase 1 — Baseline (diagnosis) — Max, $0 API
- Judge all 200 pairs on both axes (batched subagents).
- `eval/baseline.json` + `eval/baseline-report.md`: headline prose & action accuracy, edit-category distribution, clustered patterns of substantive/factual/action edits, China-vs-before stability sanity check.
- **GATE.**

### Phase 2 — Hypotheses + prompt audit — Max, $0 API
- Subagent audits aiAdvisor.js system prompt for ambiguity, contradictions, conflicting/stale rules; maps each edit cluster to a likely prompt cause.
- Hypotheses about context gaps. `eval/hypotheses.md`, ranked by impact × ease.
- **GATE.**

### Phase 3 — Iteration loop (highest-leverage first)
Per hypothesis: change prompt/context → regen advisor on stratified subset (~40–50) [API] → judge vs sent ground truth [Max] → log delta → keep if improves without regressing siblings, else revert. **GATE** every few iterations.

### Phase 4 — Validation
- Best prompt on full 200 [API], confirm both numbers up vs baseline, no regression.
- `node --test customer-service/test/*.test.js` + scenarios. Final report. **GATE before merge → main.**

## Guardrails
- Prompt-first (no code workarounds for AI mistakes). Positive verbatim templates beat "DO NOT". Don't overfit — test against sibling cases. Faithful regens. Worktree isolation + rollback. Diagnose with data before iterating.

## Open question before merge
Overlap with unfinished Phase 3 scenarios in project_structured_output_consistency.md — fold in if relevant.
