---
name: Opus 5 Migration
description: Qualify Opus 5 for the CS advisor, fix the prompt gaps it exposed, and build a reusable model-swap eval so future model migrations are routine
type: project
domain: cs
done_when: >
  (1) scripts/modelSwapEval.js exists and runs candidate-vs-incumbent with a control arm from one command;
  (2) all 25 scenarios in customer-service/test/scenarios/ pass on claude-opus-4-8 (including the two
  currently-failing ones), so the suite is a trustworthy gate;
  (3) a documented adopt-or-reject decision for claude-opus-5 is recorded here with the eval numbers behind it,
  and MODELS.OPUS matches that decision.
originSessionId: e3e9ccad-b2e9-4080-9615-eb2f0616bc47
---

## Why this exists

Opus 5 shipped 2026-07-28 at the same price as Opus 4.8 ($5/$25), same tokenizer, faster, with `speed:"fast"` available. The intent was a one-line `MODELS.OPUS` flip. The pinned scenario suite caught four regressions and the flip was reverted the same session.

Two separate motivations to finish this properly:

1. **Deprecation is inevitable.** Opus 4.8 has no announced retirement date (Opus 4.1 retires 2026-08-05), so there is runway — but we currently have no repeatable way to qualify a replacement model. The 2026-07-28 evaluation was hand-rolled shell. That is the real gap.
2. **Opus 5 exposed genuine prompt gaps** that exist on 4.8 too. Fixing them improves the advisor regardless of which model we run.

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

### Phase 0 — Verify the name source (do first, blocks nothing else)
Trace where "Kyle" came from on the `refundNoAmount` anchor ticket: customer-typed signature, Gorgias contact record, or Shopify profile. If profile-sourced, this is a live guardrail gap on 4.8 and gets fixed immediately as its own change, independent of the migration.

### Phase 1 — Productize the swap harness
Build `scripts/modelSwapEval.js` replacing the throwaway shell from 2026-07-28. Requirements:
- Takes a candidate model id; runs all `customer-service/test/scenarios/` against candidate and incumbent.
- **Auto-runs the control arm** on every candidate failure — this is the piece that makes results interpretable.
- Per-scenario hard timeout (a hung scenario must not block the suite — `commitmentCalibration` hung >10 min and buffered every other result).
- Writes per-scenario results to disk incrementally so a killed run keeps partial results.
- Prints a candidate-vs-control table.
- Follows the CLI-flag convention (`--candidate <model>`), not env vars.

This is the durable asset: it turns every future model migration from a scramble into a single command.

### Phase 2 — Clean the gate
The suite is only trustworthy if a green run means something.
- `knowledgeFacts` — fails on 4.8 today ("does not name both real adult colors (Black, Pink)"). Diagnose: stale catalog assertion vs genuine grounding failure.
- `commitmentCalibration` — hangs (>240s, killed). It replays real Gorgias tickets; likely a network fetch with no timeout. Fix the hang; consider whether replaying live tickets belongs in a pinned suite at all given the order-state-drift rule.

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
