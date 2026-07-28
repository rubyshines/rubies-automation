---
name: Opus 5 Migration
description: Qualify Opus 5 for the CS advisor, fix the prompt gaps it exposed, and build a reusable model-swap eval so future model migrations are routine
type: project
domain: cs
done_when: >
  (1) scripts/modelSwapEval.js exists and runs candidate-vs-incumbent with a control arm from one command,
  reporting accuracy AND latency AND cost per scenario;
  (2) all 25 scenarios in customer-service/test/scenarios/ pass on claude-opus-4-8 (including the two
  currently-failing ones), so the suite is a trustworthy gate;
  (3) a documented adopt-or-reject decision for claude-opus-5 is recorded here with the eval numbers behind
  it, and MODELS.OPUS matches that decision. Adopt ONLY if all three founder acceptance criteria hold —
  see "Acceptance criteria" below.
originSessionId: e3e9ccad-b2e9-4080-9615-eb2f0616bc47
---

## Why this exists

Opus 5 shipped 2026-07-28 at the same price as Opus 4.8 ($5/$25), same tokenizer, faster, with `speed:"fast"` available. The intent was a one-line `MODELS.OPUS` flip. The pinned scenario suite caught four regressions and the flip was reverted the same session.

Two separate motivations to finish this properly:

1. **Deprecation is inevitable.** Opus 4.8 has no announced retirement date (Opus 4.1 retires 2026-08-05), so there is runway — but we currently have no repeatable way to qualify a replacement model. The 2026-07-28 evaluation was hand-rolled shell. That is the real gap.
2. **Opus 5 exposed genuine prompt gaps** that exist on 4.8 too. Fixing them improves the advisor regardless of which model we run.

## Acceptance criteria (founder, 2026-07-28)

Opus 5 is adopted only if **all three** hold against the Opus 4.8 incumbent. Any one failing is a reject.

| Dimension | Bar | Measured by |
|---|---|---|
| Accuracy | same or better | All 25 scenarios pass; no regression vs the 4.8 control arm |
| Latency | same or faster | Median + p90 wall-clock per draft, both arms, same run |
| Cost | same or cheaper | `ai_calls` cost per draft, both arms (same $5/$25 rate, so this is a token-volume question) |

Consequences for the plan:

- **The harness must measure all three, not just pass/fail.** Accuracy alone is insufficient; a config that fixes accuracy by inflating thinking tokens fails the cost bar and a slower config fails the latency bar.
- **This is why `xhigh` is diagnostic-only.** Raising effort spends more thinking tokens at $25/MTok on a 1–2 call loop that cannot recoup it by shortening. It can tell us *why* tool use dropped; it cannot be the shipped answer.
- **Adaptive thinking is on probation for the same reason.** It fixed `kbSearchGrounding` but adds thinking tokens and latency. If the prompt fix (Phase 4) achieves the same result at `thinking: disabled`, that is the preferred config on all three axes.
- Opus 5's headline advantage is that it should be *faster* at equal price. If it cannot beat 4.8 on latency once configured for correct behaviour, the main reason to migrate now evaporates — and we wait for the next model, having banked the harness and the prompt fixes.

## Phase 0 result (2026-07-28): resolved, no action needed

The "Hi Kyle," draft was **not** a guardrail violation. The customer signed their own message ("Thanks, Kyle"), and the advisor prompt explicitly permits a name that the customer introduced or signed (`aiAdvisor.js` line ~1363). Opus 5 was compliant; 4.8's bare "Hi," was merely more conservative.

Confirmed while checking: `contextBuilder` does place the Shopify profile name (`firstName`/`lastName`, `name_set_via: "shopify"`) in advisor context. That is intentional — `orderUtils` needs it to build shipping addresses and `customer_profile_update` needs it — and usage is rule-gated rather than the data being withheld. No change made.

Lesson worth keeping: a diff between two models' drafts is not by itself evidence of a regression. Verify against the rule before escalating.

## Evidence from the 2026-07-28 evaluation

Method: run all 25 pinned scenarios against the candidate, then re-run every failure against the incumbent as a control. ~55 live drafts, ~$8, ~40 minutes. **The control arm is load-bearing** — it separates real regressions from order-state drift and pre-existing failures, which candidate-only numbers cannot.

| Scenario | Opus 4.8 | Opus 5 (thinking off) | Opus 5 (adaptive + 16k) |
|---|---|---|---|
| donationToolCall | PASS | FAIL — `action_type: null` | FAIL |
| refundNoAmount | PASS | FAIL — `action_type: null` | FAIL |
| kbSearchGrounding | PASS | FAIL — skipped KB search | **PASS** |
| wrongOrderPreorderLink | PASS | FAIL — `order_modification` not `warehouse_hold` | FAIL — invented order composition |
| knowledgeFacts | FAIL | FAIL | not run |
| commitmentCalibration | TIMEOUT | TIMEOUT | not run |

> ⚠️ **This table is single-run and therefore provisional.** Phase 1 established that advisor scenarios are non-deterministic (see below). `noMirroring` passed Opus 5 in this run and failed a later one; on `--repeat 3` it scored 2/3 on **both** arms — flaky, not a regression. **Every row above must be re-validated with `--repeat 3` before any adopt/reject decision.** The split-brain finding is still qualitatively real (the draft text was read directly), but its frequency is unmeasured.

Config was matched on the first Opus 5 arm (both thinking-off, `max_tokens` 4096, effort default) — so this is **not** a config artifact. Drafts were inspected directly; it is **not** a parser/format artifact either (contrast with the 2026-07-17 Sonnet 5 harness bug, where `action_type` null WAS a harness fault — that possibility was checked and ruled out here by reading the raw drafts).

### The most serious finding: split-brain drafts

On `refundNoAmount`, Opus 5 wrote the full donation-routing block ("please send the items you are returning to: …") with **`action_type: null`** — telling the customer their return is in motion while staging no refund for the operator to execute. Opus 4.8 on the same ticket produced the refund sentence and `action_type: refund`.

This is a new failure class and the reason "operator review will catch it" is insufficient justification for skipping validation: operator review reliably catches bad *prose*, not a missing `action_type` behind plausible prose.

### Needs verification (may be independent of Opus 5)

On `refundNoAmount`, Opus 5 opened **"Hi Kyle,"** where 4.8 opened "Hi,". If that name came from the Shopify profile it violates the pronoun/dead-name guardrail in CLAUDE.md. **Unverified** — the name's source was never traced. This must be checked first, and it matters on 4.8 too: if the prompt's name rule is weak, the exposure exists in production today.

## Root cause

Per Anthropic's migration guide, Opus 5 follows instructions more literally and reaches for tools less often than 4.8. Our advisor prompt was tuned over months against Opus 4.x, which filled gaps by inference.

**Primary hypothesis (untested):** the "one move per message" rule shipped 2026-07-20 (`RESPONSE LENGTH & REGISTER`) instructs the model to pick one move per issue — act, ask, or explain. Opus 4.8 reads this as tone guidance. Opus 5 appears to apply it literally: it picks exactly one move and sometimes picks the wrong one (answering a pleasantry instead of processing the refund; emitting donation info instead of the refund action). This fits all four failures and is testable by ablating that rule.

**Known-adjacent, already-observed bug:** `donationToolCall` failed because the customer's closing message was warm and Opus 5 answered only the pleasantry. This is the parked item "Advisor classification overridden by closing-message tone" (parked 2026-04-15), now absorbed into this project. Opus 5 did not create this bug — it made an existing one reliably reproducible, which is useful.

## Phases

Ordered cheap → expensive. Each phase is independently valuable.

### Phase 0 — Verify the name source — **DONE 2026-07-28**, no violation (see Phase 0 result above)

### Phase 1 — Productize the swap harness
Build `scripts/modelSwapEval.js` replacing the throwaway shell from 2026-07-28. Requirements:
- Takes a candidate model id; runs all `customer-service/test/scenarios/` against candidate and incumbent.
- **Auto-runs the control arm** on every candidate failure — this is the piece that makes results interpretable.
- Per-scenario hard timeout (a hung scenario must not block the suite — `commitmentCalibration` hung >10 min and buffered every other result).
- Writes per-scenario results to disk incrementally so a killed run keeps partial results.
- **Captures latency and cost per scenario, not just pass/fail** — required by the acceptance criteria. Source: `ai_calls` rows (joined on the run window) and/or the `_timing` block the advisor already records.
- Prints a candidate-vs-control table across all three dimensions.
- Follows the CLI-flag convention (`--candidate <model>`), not env vars.

This is the durable asset: it turns every future model migration from a scramble into a single command.

### Phase 1 result (2026-07-28): **DONE** — `scripts/modelSwapEval.js`

One command runs candidate + control and reports accuracy, latency, and cost against the acceptance criteria. Design notes worth keeping:

- **Model override via an eval-only preload** (`scripts/lib/modelSwapShim.js`, injected with `NODE_OPTIONS=--require`), NOT an env var read inside `aiPricing.js`. Nothing in the production path reads `MODEL_SWAP_EVAL_MODEL`, so a stray env var in a Railway runtime cannot change which model serves customers. This is the direct lesson from the shadow-eval leaks.
- **Control arm is automatic** on every candidate failure — the step that separates regressions from pre-existing failures and drift.
- **Cost and latency come from `ai_calls`**, measured per arm, not estimated.
- Per-scenario hard timeout; results stream to `temp-analysis-data/model-swap-<ts>/` (gitignored) so a killed run keeps partial results.

**Key discovery — the scenarios are non-deterministic.** The same scenario, same model, can pass one run and fail the next. `noMirroring` scored 2/3 on both Opus 5 and Opus 4.8. Consequences:
- `--repeat <n>` added; a scenario passes only if ALL runs pass, and mixed results report as `FLAKY` rather than being silently read as pass or fail.
- **Use `--repeat 3` minimum before trusting any regression call.** Single-run output now prints an explicit warning.
- This retroactively undermines the single-run evidence table above, and it means the "clean gate" in Phase 2 must mean *consistently* green, not green once.

**Early measured signal (small samples, n=1–3 scenarios):** Opus 5 ran **13–26% faster** but **9–45% more expensive** per scenario. Same $/token, so that is pure token volume. This is the sharpest risk to the acceptance criteria: the latency bar looks achievable, the cost bar does not, and anything that fixes accuracy by adding thinking tokens makes the cost gap worse.

### Full-suite measurement (2026-07-28, `--full-control`, all 25 scenarios both arms)

The representative run. **Opus 5 fails all three acceptance criteria.**

| | Opus 4.8 | Opus 5 | |
|---|---|---|---|
| Accuracy | 25/25 baseline | 20/25 | ✗ |
| Latency, median API call | 7.6s | 9.3s (+22.5%) | ✗ |
| Latency, p90 | 12.9s | 18.2s | ✗ |
| Cost per scenario | $0.1745 | $0.2011 (+15.3%) | ✗ |

**Correction to the earlier small-sample reading:** the failing-subset runs showed Opus 5 13–26% *faster*. That was an artifact of measuring only scenarios where it was behaving pathologically. On the full suite Opus 5 is **slower**, not faster. Never quote latency or cost from a failure-only subset.

**Signal vs noise across every run today.** Only two scenarios regress consistently; most single-run "failures" are variance:

| scenario | Opus 5 | Opus 4.8 | read |
|---|---|---|---|
| `donationToolCall` | FAIL, FAIL | PASS | **consistent regression** |
| `refundNoAmount` | FAIL, FAIL, FAIL | PASS, PASS | **consistent regression** |
| `wrongOrderPreorderLink` | FAIL ×3 | PASS, FAIL | Opus 5 always fails; 4.8 flaky |
| `kbSearchGrounding` | FAIL, PASS, PASS | PASS | noise |
| `noApologyForThirdParty` | PASS, FAIL | PASS | noise |
| `knowledgeFacts` | FAIL, PASS | FAIL, FAIL | **pre-existing 4.8 bug** |
| `noMirroring` | 2/3 | 2/3 | flaky on both |
| `commitmentCalibration` | TIMEOUT | TIMEOUT | structural |

**The real Opus 5 defect is one thing, and it is reproducible:** on refund tickets the advisor produces plausible customer-facing prose while `action_type` comes back `null` — no money-moving action staged. Both consistent regressions are this. It matches the "one move per message" literalism hypothesis and is exactly the class operator review does not catch.

**`knowledgeFacts` is a 4.8 bug, not an Opus 5 one.** Verified against the catalog: Black and Pink are genuinely the only Sky colours with adult-size stock (Navy/UNI have none), so the assertion is correct and the advisor is wrong. We have been carrying this.

### Phase 2a finding (2026-07-28): the suite is mostly RIGHT — the advisor is genuinely inconsistent

Investigated each flaky scenario individually rather than loosening assertions in bulk. **Only one of five was a bad test.** The rest catch real run-to-run variance in the advisor, on Opus 4.8 as well as Opus 5:

| scenario | verdict | evidence |
|---|---|---|
| `noApologyForThirdParty` | **bad test — FIXED** | Draft said "Card approvals are handled by the payment network and your issuing bank rather than our checkout" — states the boundary perfectly, but patterns only accepted "payment processor/provider/gateway". Broadened to match *who* is named; also removed a `/unfortunately/i` pattern that would pass any draft containing the word. 4/4 green after. |
| `noMirroring` | test correct, model inconsistent | Failing draft opened "I hear you loud and clear, you paid extra for expedited and it didn't get to you" — genuine mirroring. Passing runs go straight to new information. ~1/3 failure rate on BOTH models. |
| `kbSearchGrounding` | test correct, model failed | Failing draft was "Let me look into this and get back to you" with `tools: []` — deflected without searching the KB. |
| `knowledgeFacts` | test correct, advisor wrong | Catalog verified: Black and Pink really are the only Sky colours with adult-size stock. |
| `wrongOrderPreorderLink` | test correct, model inconsistent | Same input yields `warehouse_hold` on one run and `order_modification` on the next — on Opus 4.8. |

**Do not "de-flake" by loosening assertions.** Four of five would have hidden real defects. The correct response to genuine model variance is a statistical gate (`--repeat`, already built), not weaker tests.

### ⚠️ Production exposure found while doing this (Opus 4.8, independent of any migration)

`wrongOrderPreorderLink` inconsistency is not cosmetic. The governing policy is that ANY change to an unfulfilled order freezes it with a warehouse hold. The backstop that guarantees the hold lands — `reconcilePendingHolds` in [holdReconcile.js](../../customer-service/lib/holdReconcile.js) — selects drafts with `action_type IN ('warehouse_hold','cancellation')`. When the advisor emits `order_modification` instead, **no hold is proposed and the backstop never fires**, leaving the order free to ship with the wrong items before an operator executes the change.

So the advisor intermittently drops the protective hold on unshipped-order edits, in production, today. Frequency unmeasured — measure with `--repeat 5` on this scenario before deciding the fix. This likely deserves priority over the Opus 5 question.

### Phase 2 — Clean the gate — **now the top priority, ahead of any model decision**

Flakiness is the blocking problem. At least five scenarios flip between runs on an unchanged model, which means the suite cannot currently support *any* adopt/reject call — this one or the next. Fix this before spending on prompt work or further model runs.

- **Flakiness itself.** Advisor drafts are irreducibly stochastic (`temperature` is not settable on Opus 4.8/5 — removed from the API), so the gate must be statistical, not binary. Options: require k-of-n passes per scenario; tighten over-specific assertions (several match on exact phrasing where any equivalent phrasing should pass); or split assertions so one brittle check cannot fail an otherwise-correct draft. Prefer loosening assertions first — a test that fails on valid output is a bad test, not a flaky model.
- `knowledgeFacts` — **diagnosed**: the assertion is correct (catalog verified), the advisor genuinely fails to name both adult colours. A real 4.8 grounding bug to fix on its own merits.
- `commitmentCalibration` — **diagnosed**: not a hang. It makes three sequential advisor calls plus Gorgias fetches in one file, so it is ~3× a normal scenario and exceeds a 240s timeout under concurrency. Split into three scenario files (matching suite convention), which also isolates which case failed. Extract the shared `ticketToInput` helper (also used by `exchangeMoney`).

### Phase 3 — Exhaust config levers (bounded, ~$5, one run)
Before touching the prompt, rule out configuration:
- `effort: "xhigh"` — Anthropic's documented remedy for reduced tool use. **Diagnostic only.** See "Cost constraint" below.
- Schema output mode (`ADVISOR_SCHEMA_OUTPUT=1`) — removes `<structured>` parsing fragility entirely. Note the 2026-06-13 finding still applies: schema mode is 3–20x slower and first to be load-shed, so this is an experiment, not a likely production answer.

### Phase 4 — Prompt work (the expected real fix)
Targets, in order of confidence:
- **Operational intent outranks closing tone.** Classification must reflect what the ticket is operationally about, not the tone of the last message. (Absorbs the 2026-04-15 parked item.)
- **"One move per message" literalism.** Ablate/reword so it cannot drop a required money-moving action. The rule was worth shipping (it fixed real verbosity) — it needs a guard, not removal.
- **Tool-use triggering.** Per Anthropic guidance, make tool descriptions prescriptive about *when* to call, not just what they do. Measurable lift on recent Opus models.
- **Action/prose coupling.** A draft whose prose asserts an action must carry the matching `action_type`. Prefer a prompt fix; a deterministic guard is a fallback (see Open risks).

Every change validated by scenario test, never live regen on historical tickets (order-state drift — this bit the pinned scenarios in the 2026-07-09 sweep).

### Phase 5 — Decide and record
Re-run Phase 1 harness. Adopt or reject with numbers. Update `MODELS.OPUS` and record the verdict here, then merge learnings into `domain_cs.md` and delete this file.

## Decisions already made (do not re-litigate)

- **Stay on `claude-opus-4-8` until this project completes.** Reverted 2026-07-28.
- **Keep the `claude-opus-5` RATES row** in `shared/aiPricing.js` — correct whenever we adopt, inert until then. `MODELS.OPUS` carries a comment warning not to flip without a control run.
- **No shadow eval for this.** The shadow harness (Sonnet arms, `cs_diagnostics` flag) answers *downgrade* questions over ~10 days and ~$40. Scenario-suite-plus-control is cheaper, faster, and directly tests the failure modes that matter. The shadow infra stays for its original purpose.
- **The control arm is mandatory.** Candidate-only results are uninterpretable — two of six failures on 2026-07-28 were pre-existing and would have been misattributed to Opus 5.
- **Cost constraint on `xhigh`:** it is a diagnostic lever, not a production default. Effort raises thinking tokens billed at $25/MTok, and the advisor is a 1–2 call loop, so it will not recoup cost by shortening the loop the way long agentic runs do. If Phase 3 shows `xhigh` restores tool use, the shipped fix is the Phase 4 prompt change at `high`, not a permanent effort bump. Any production effort change requires a measured before/after from `ai_calls` and explicit founder sign-off.

## Out of scope

- Opus 5 for non-advisor components (b2b outreach, reports, finance). Same flip risk, but the advisor is the highest-stakes surface and the one with the scenario suite. Revisit after this lands.
- Opus 5 for Jamie's Claude Code sessions — different workload, no tuned-prompt legacy, unaffected by these findings.
- `speed:"fast"` evaluation. Attractive (Opus 5 supports it, 4.8 does not) but a separate question from correctness.

## Open risks

- **The prompt may not be cleanly fixable without regressing 4.8 behavior.** Every Phase 4 change must pass the full suite on 4.8 as well as the candidate — a fix that only works on Opus 5 is a fork, not a fix.
- **A deterministic prose↔action guard would violate the AI-first principle** ("fix the prompt, not the code"). It is listed as a fallback only. If reached, it needs explicit justification as a safety guard on a money path, not a reasoning workaround. Related: the parked "Stale-draft guard" entry covers an adjacent draft/action divergence and may share an implementation.
- **Scenario suite coverage is 25 scenarios.** A green run is necessary, not sufficient. Post-adoption, the closeness-to-final judge remains the continuous check (watch substantive-divergence vs the ~28.5% prose-edit baseline).

## Key files

- `shared/aiPricing.js` — `MODELS.OPUS`, RATES table
- `customer-service/lib/aiAdvisor.js` — advisor prompt; `RESPONSE LENGTH & REGISTER` section holds the "one move per message" rule
- `customer-service/test/scenarios/` — the 25 pinned scenarios (the gate)
- `scripts/modelSwapEval.js` — to be built in Phase 1
