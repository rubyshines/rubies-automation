---
name: CS Advisor Efficiency
description: Reduce CS system costs and latency — prompt caching, timing instrumentation, shadow Sonnet evaluation, SSE streaming
type: project
domain: cs
done_when: continuous improvement — close when no further optimizations are worth pursuing
originSessionId: 64dfe254-e96b-4b13-b38b-afc1ee898e09
---
## Problem

Deep analysis revealed the CS advisor system costs ~$0.39/draft and ~$0.60/ticket — far higher than the documented $0.08/conversation. Monthly spend: ~$107 ($98 advisor + $9 operator agent). Draft refresh takes ~15 seconds, action submission ~10 seconds.

## Root Cause Analysis

**Cost:** 96% of tokens sent per API call are identical across all tickets. The 16,473-token system prompt (rules: 9,600, tone samples: 3,900, tools: 1,500, product links: 500) gets re-sent and re-processed from scratch on every call. No prompt caching was being used. Two redundant tools (`get_tone_samples` — never called, 0% in production; `get_order_context` — called 10% of the time despite data already being in the system prompt) wasted tokens and triggered unnecessary tool loops.

**Latency:** Bottleneck is Opus API calls (6-12s per call). 30% of drafts trigger tool loops adding a second full API round (5-8s). Network/DB overhead is only ~1.5s total.

## Key Data (from analysis of 251 drafts, 39 actions, 30-day window)

- 70% of drafts make zero tool calls (1 API call)
- 30% make 1-3 tool calls (2 API calls)
- Average 1.3 API calls per draft
- Most-used tools: get_donation_partner (18%), get_order_context (10%), compare_products (10%)
- 48 of 161 tickets had multiple drafts (1.54 draft:ticket ratio)
- Message type distribution: general_inquiry 32%, refund 16%, sizing 14%, exchange 14%, defect 10%, shipping 6%
- 44% of drafts arrive in isolation (>5min gap from next) — limits prompt cache effectiveness
- Caching helps most on redrafts (same ticket, same system prompt, guaranteed warm cache)

## What Was Built (deployed 2026-04-19)

### 1. Prompt Caching (aiAdvisor + operatorAgent)
- Split system prompt into static (cached) + dynamic (order context) parts
- Static part gets `cache_control: { type: 'ephemeral' }`
- Modest savings on tool loops and quick redrafts (not dramatic due to scattered traffic)
- Reliable win on operatorAgent since it always makes 2+ calls within seconds

### 2. Redundant Tool Removal
- `get_tone_samples` removed from TOOLS array (never called — all 51 samples already in system prompt)
- `get_order_context` removed when preContext exists (data already embedded in system prompt — was causing 10% of drafts to waste a full extra API round)

### 3. Timing Instrumentation (permanent)
- Every advisor call records `structured._timing`: tone fetch, context build, each API call (duration, input/output tokens, cache read/write tokens), each tool execution
- Every operator action records `_timing` in the result
- Stays permanently on draft records for ongoing monitoring

### 4. Shadow Model Evaluation (reusable infrastructure)
- After every Opus advisor draft, a background call runs with a candidate model using identical inputs
- After every Opus operator action, same pattern
- Opus AI judge compares both outputs on: tone, action accuracy, structured output correctness, response length, rule compliance
- Auto-detects divergences: different message_type, status, action_type, item states, tool calls
- Results stored in `cs_diagnostic_runs` Supabase table
- Disabled via `CS_DIAGNOSTICS_DISABLED=true` env var in Railway (set 2026-04-24)
- Candidate model hardcoded as `claude-sonnet-4-6` in `aiAdvisor.js:runShadowEvaluation()` and `operatorAgent.js:runOperatorShadowEval()` — change these to test a different model
- Operator shadow eval blocks mutation tools via `SHADOW_BLOCKED_TOOLS` set — safe to run against any model

### 5. SSE Streaming (advisor redraft + operator action-chat)
- New endpoints: `/api/tickets/:id/refresh-stream` and `/api/tickets/:id/action-chat-stream`
- aiAdvisor uses `client.messages.stream()` when `onStream` callback provided
- operatorAgent uses `client.messages.stream()` when `onEvent` callback provided
- Dashboard frontend updated to consume SSE — draft text appears word-by-word, tool calls show in real-time
- Perceived latency drops from ~15s to ~1-2s (time to first visible text)

## Prompt Caching Analysis (2026-04-21)

Prompt caching is effectively a no-op at current volume. 44% of drafts arrive in isolation (>5min gap), so the Anthropic cache (5-min TTL) expires before the next request. Even redraft cache hits are an artifact of Jamie's current testing workflow (system changes → redraft cycles), not a real production pattern. In steady state: ticket arrives, gets one draft, approved, next ticket is minutes/hours later — cache is cold every time.

Caching infrastructure is deployed and not hurting anything. It will become valuable if/when volume increases enough for requests to cluster within 5-min windows.

## Shadow Evaluation: Sonnet 4.6 vs Opus 4.6 (2026-04-18 → 2026-04-24)

**Model tested:** claude-sonnet-4-6 against production claude-opus-4-6
**Run period:** April 18–24, 2026 (~6 days)
**Data:** 57 runs (52 advisor, 5 operator) stored in `cs_diagnostic_runs`

**Advisor (52 runs):**
- 30% B_WORSE verdict rate — too high for production use
- Failures are reasoning gaps: structured output errors, rule compliance misses, action classification mistakes
- These are model capability issues, not prompt issues — a Sonnet-specific verbose prompt was considered but would need to be significantly longer, erasing the cost savings
- **Verdict: Not viable** for plain Sonnet. Revisit when Sonnet-class models improve reasoning on complex structured tasks.
- **Caveat:** this run used plain Sonnet 4.6 with no extended thinking. Extended thinking is a meaningfully different inference mode (planning budget, tool-chain deliberation) and could plausibly close the failure gap. See "Sonnet 4.6 + Extended Thinking Re-evaluation" below.

**Operator agent (5 runs):**
- 4 B_ACCEPTABLE + 1 EQUIVALENT, zero B_WORSE or MAJOR_DIFF
- Promising but sample too small to be conclusive
- Operator actions are human-confirmed (Jamie approves before execution), so model judgment gaps are lower risk
- Potential savings only ~$7/mo — not worth the risk at current volume
- **Verdict: Not worth switching.** Revisit if volume grows or cost pressure increases.

**Latency:** Sonnet only 1.16x faster than Opus on average — not a meaningful UX improvement, especially with SSE streaming already reducing perceived latency to ~1-2s.

**Decision (2026-04-24):** Stay on Opus for everything. Shadow eval intended to be disabled via `CS_DIAGNOSTICS_DISABLED=true`. Infrastructure preserved for future model evaluations.

**Note (discovered 2026-04-27):** the kill-switch env var was never actually set — `CS_DIAGNOSTICS_DISABLED` remained undefined on the webhook service after Apr 24. Plain-Sonnet shadow eval continued running silently and accumulated **114 additional runs** between Apr 24 and Apr 28 02:13 UTC, total 234 advisor runs.

**Plain-Sonnet baseline (all 234 runs, migrated to 1–5 scale):**
- Score 1 (significantly worse): 24.6%
- Score 2 (modestly worse): 14.2%
- Score 3 (equivalent): 61.3%
- Score 4–5: 0% (old judge structurally couldn't detect upside — capped at 3)
- **Mean score: 2.37**

This is the proper baseline for the Sonnet+thinking comparison.

**Score migration:** the 318 historical rows (234 advisor + 84 operator) were back-mapped from the old 3-bucket verdict to the 1–5 score by `scripts/migrate-diagnostic-runs-to-score.js`. Mapping is lossy in the upper half — old judge had no B_BETTER signal so historical 4s and 5s are not retrievable. Migrated rows carry `judge_result.score_source: 'migrated'` for traceability. New runs after Apr 28 02:13 UTC carry true judge-emitted scores with no `score_source` field.

### How to re-run this experiment
1. Set `CS_DIAGNOSTICS_DISABLED=false` in Railway env vars
2. Ensure `cs_diagnostic_runs` table exists in Supabase (schema: `customer-service/drafter/diagnostic-runs-schema.sql`)
3. To test a different model, change `'claude-sonnet-4-6'` in `aiAdvisor.js:runShadowEvaluation()` and `operatorAgent.js:runOperatorShadowEval()`
4. Let it run for 5+ days, then query `cs_diagnostic_runs` for verdict distribution

## Methodology pivot: ground-truth comparison (2026-04-27)

The prior shadow eval method (Opus judge comparing Opus draft A vs Sonnet draft B) has a structural ceiling: the judge is the same model class as Draft A, which biases against detecting cases where Sonnet outperforms Opus. Self-preference is real and known in LLM-as-judge work.

**Better method:** anchor the comparison externally. The human-approved final sent message is ground truth (the operator reviewed/edited the draft before it went to the customer). Score *each* candidate against the final independently — whoever lands closer wins. Same pattern applies to operator actions: operator command + final-executed action plan = ground truth; both candidate models scored on closeness.

**Edit-distance prior (last 200 sent advisor drafts):**
- 47.5% sent unchanged (zero edit distance — Opus nailed it)
- 4% near-exact, 8% light, 13% medium edits
- 27.5% heavy rewrite (this is where the comparison has the most signal)

So ~52% of tickets give no comparative signal (Opus already perfect) and ~48% are informative. With 50 shadow runs we'd expect ~25 to be differentiating — workable but lean. The 27.5% heavy-rewrite cases are where Sonnet+thinking would need to demonstrably win to be considered.

**Implementation status:**
- `cs_diagnostic_runs` schema: added `ticket_id` (gorgias_ticket_id) and `draft_id` (cs_ai_drafts.id) columns. Schema file [diagnostic-runs-schema.sql](../../customer-service/drafter/diagnostic-runs-schema.sql) is idempotent — must be run in Supabase SQL editor before backfill.
- `aiAdvisor()` and `runShadowEvaluation()` updated to thread ticket_id/draft_id through. Both call sites (intake, dashboard refresh) updated.
- Backfill script [scripts/backfill-diagnostic-runs-ticket-id.js](../../scripts/backfill-diagnostic-runs-ticket-id.js) joins existing 318 rows on customer_email + created_at proximity to populate the new columns.
- **Not yet built:** the closeness-to-final judge. Premature until we have enough Sonnet+thinking runs paired with sent_response to score. Once 30+ thinking-enabled rows are linked, build a daily backfill that joins to `cs_ai_drafts.sent_response` and scores both candidates against it (1–5 each, plus token-level edit distance).

**Current shadow eval continues running** with the 1–5 score and Sonnet+thinking. Data is biased upward (judge can detect Sonnet worse, can't detect Sonnet better) but still informative as a lower bound — if Sonnet+thinking mean rises meaningfully above the plain-Sonnet baseline of 2.37, that's signal even with the bias.

## Sample Methodology (canonical for future model evals)

The shadow eval fires on every `aiAdvisor()` invocation, which means a single ticket can produce many rows: each customer reply, each operator-steered redraft, each manual refresh, each re-intake all generate fresh shadow runs. Don't change this — redrafts are real production load and they test whether the candidate follows operator steers as well as Opus.

**Analyze in two layers:**
1. **Primary metric — first draft per ticket.** One observation per unique conversation. Cleanest signal for "does the candidate produce acceptable initial drafts." Decision rules apply to this metric.
2. **Secondary metric — all rows.** Includes redrafts/steers. Tests "does the candidate follow operator steering as well as Opus." Useful as a tiebreaker when the primary is borderline.

**Sample-size targets** apply to the primary metric (unique tickets), not row count:
- 50+ unique tickets minimum to apply the decision rules confidently
- At current volume (~6 unique tickets/day), that's ~10 days of data, not 5–6
- The 2026-04-27 → 04-29 Sonnet+thinking run hit 61 rows / 18 unique tickets in 49 hours — too thin on unique tickets, but the failure pattern was consistent enough with the prior plain-Sonnet eval to make the call

**Tooling:** [scripts/analyze-shadow-runs.js](../../scripts/analyze-shadow-runs.js) runs both layers and surfaces score distribution, latency, divergences, and (with `--show-better`) the candidate-better cases with judge reasoning. Use this for every future model eval.

## Sonnet 4.6 + Extended Thinking Re-evaluation (started 2026-04-27)

**Hypothesis:** the 30% B_WORSE rate from the plain-Sonnet eval was driven by planning failures (tool-call ordering, structured output, action classification) — exactly the failure mode extended thinking is designed to address. With a thinking budget, Sonnet may match Opus on accuracy while preserving 60–75% cost savings.

**Setup:**
- `runShadowEvaluation()` Sonnet call updated with `thinking: { type: 'enabled', budget_tokens: 4000 }` and `max_tokens: 8192` (commit b5e5677)
- `CS_DIAGNOSTICS_DISABLED=false` set on webhook-server at **2026-04-27 22:13 ET** (2026-04-28T02:13:27Z) — use this as the `created_at` floor when querying `cs_diagnostic_runs`
- Same shadow method as the prior eval — A/B against live Opus drafts, same Opus AI judge, same verdict scale
- Target sample size: 50 runs (matches prior eval; ~5–6 days at current volume)

**Decision rules (set in advance, on the new 1–5 scale):**
- Mean score ≥3.5 *and* <5% rated 1 → strong signal, plan migration to Sonnet+thinking
- Mean score <3.0 *or* ≥15% rated 1 → not viable, stay on Opus
- In between → judgment call, sample more or examine failure pattern

A 1–5 score with 3 = baseline (tied with Opus) replaced the prior 3-bucket verdict (EQUIVALENT/B_ACCEPTABLE/B_WORSE) so we can detect *upside* (Sonnet outperforming Opus, scores 4–5), not just downgrade.

**Cost during experiment:** ~$0.10–$0.15 per shadow run on top of normal advisor cost. Total experiment cost ~$5–10.

**Results (2026-04-30):**
- 61 total advisor rows from **18 unique tickets** over ~49 hours (41 of 61 rows were redrafts/steers on the same conversations — original target of "50 runs" should have been "50 unique tickets," see Sample Methodology below)
- **Primary metric (first draft per ticket, n=18):** mean 2.67. Distribution: 5.6% / 50.0% / 22.2% / 16.7% / 5.6%
- **Secondary metric (all rows, n=61):** mean 2.62. Distribution: 9.8% / 39.3% / 32.8% / 14.8% / 3.3%
- Both metrics agree on the shape: ~half of fresh drafts rated worse, ~22% tied, ~22% better. Plain-Sonnet baseline was 2.37 — extended thinking moved the mean up modestly but didn't close the gap to Opus (3.0 = tied).
- Latency: 15.7s vs Opus 14.6s — thinking tokens make it *slower*, killing one of the main migration motivations.
- Top divergences: item-state differences (16), status field disagreements (gathering↔needs_info, ready↔needs_info, ~10 cases). Same structural-output failure mode as plain Sonnet.
- The 11 "better" cases (score 4–5) cluster on tone/empathy wins ("more conversational," "more body-aware sizing explanation," "warmer apology"). Operationally not capturable since operator already edits drafts before sending.
- Operator-agent rows (n=10, mean 3.00) — tied with Opus on a small sample. Same conclusion as the plain-Sonnet eval: not worth switching for ~$7/mo.

**Verdict (2026-04-30): Not viable.** Mean 2.67 lands in the "judgment call" band, but the pattern is consistent with the plain-Sonnet eval and the failures land on structured fields the dashboard depends on. Sample size (n=18 unique tickets) is too thin for the original decision rules to apply confidently, but extending the run wouldn't change the call: even at the optimistic end (mean creeping toward 3.0 with more data), it's still tied-or-worse on a model that's now slower. Cost savings (~$30/mo) don't justify shipping wrong status/item-state classifications on ~half of fresh drafts.

**Tuning options considered, none pursued:**
| Option | Why not |
|---|---|
| Bigger thinking budget (4k → 16k) | Erases latency advantage further. Failures look more like rule-recall gaps than planning gaps — diminishing returns expected. |
| Sonnet-specific verbose prompt | Would need to be significantly longer (erasing cost savings) and creates a maintenance burden — two versions of the system prompt to keep in sync. Same conclusion reached in plain-Sonnet eval. |
| Hybrid: Sonnet prose + Opus structured fields | Two API calls per draft, single-digit dollar/month savings, integration risk on dashboard. Complexity not worth it. |
| Wait for next-gen Sonnet/Haiku | Right move. Infrastructure preserved — one-line model-string change to re-run. |

**Decision: Stay on Opus for everything.** Shadow eval disabled via `CS_DIAGNOSTICS_DISABLED=true` on Railway webhook-server (2026-04-30). Infrastructure preserved for next-gen model evaluations.

## Sonnet 5 shadow eval (started 2026-07-10)

Next-gen Sonnet shipped — the trigger the 2026-04 verdict was waiting for. Candidate: `MODELS.SONNET_5` (claude-sonnet-5, intro $2/$10 per MTok through 2026-08-31, then $3/$15). Both shadow functions updated (aiAdvisor + operatorAgent); Sonnet 5 API surface change handled (budget_tokens thinking 400s — adaptive thinking now). Gate is the `cs_diagnostics` flag in `system_flags` (DB flag, all runtimes — the env-var leak class is closed). Stakes: advisor+operator = 87% of AI spend ($216/mo); Sonnet 5 viable ≈ $150+/mo saved.

**Decision rules (pre-registered, same as 2026-04, 1–5 scale):** primary metric = first draft per unique ticket, 50+ unique tickets before deciding (~10 days at current volume). Mean ≥3.5 and <5% rated 1 → plan migration. Mean <3.0 or ≥15% rated 1 → not viable. Between → judgment/extend. Analyze with `scripts/analyze-shadow-runs.js`. Also lean on the closeness-to-final method (sent_response ground truth) now that ticket_id/draft_id are threaded.

**Stopped 2026-07-17 — advisor arm invalid (harness bug), operator arm not viable.**

- **Harness bug invalidated the advisor arm.** Production runs legacy output mode by default (`SCHEMA_OUTPUT_ENABLED` off since the 2026-06-13 grammar load-shed finding), so Opus got `legacySystemBlocks` (with the `<structured>` template) — but the shadow call passed the schema-note `systemBlocks` with no `output_config`. The candidate was never told what output shape to emit: `sonnet_structured` was null on all 190 advisor rows, and the judge scored ~90% of first drafts a 1 for "broken structured output" even where the customer prose was identical or judged better. Advisor numbers from this run (primary mean 1.10, n=58 tickets) say nothing about Sonnet 5. Fixed same day: shadow call site now always passes `legacySystemBlocks` (the shape its parser reads).
- **Operator arm was fair** (production `systemPrompt` passed straight through, no dual-mode prompt): primary mean 2.82 (n=39 tickets), 15.4% rated 1, 44% rated 4–5. Hits the pre-registered not-viable band (mean <3.0 AND ≥15% rated 1), consistent with both 2026-04 verdicts — and the wide spread (judge-detectable upside now visible) still doesn't clear baseline. Not migrating the operator agent.
- **Cost:** the 7.5-day run burned ~$34 (~$4.50/day, an ~80% surcharge on the ~$5.60/day production CS spend) — this was the July bill spike. Flag `cs_diagnostics` set false 2026-07-17.
- **To re-run the advisor eval** (worth doing — the question "is Sonnet 5 viable for the advisor" is still open and unstained data doesn't exist): flip `cs_diagnostics` to true in `system_flags`. Harness is fixed; same pre-registered decision rules apply; analyze with `scripts/analyze-shadow-runs.js --since <flag-enable ISO timestamp>` (script now actually exists in the repo — the April one was never committed). Budget ~$4–5/day for ~10 days.
- **Harness lesson (generalizes):** a shadow candidate must receive the exact prompt variant + output-enforcement combination that matches what the harness's parser expects — when production has multiple output modes, "same inputs as production" is ambiguous and the mismatch fails silently as a 100% candidate-loss signal. A judge distribution with zero 3s across 190 rows was the tell.
- **Prevention (shipped 2026-07-17):** [shadowEvalGuard.js](../../customer-service/lib/shadowEvalGuard.js) runs after every shadow-run insert and auto-kills `cs_diagnostics` (+ emails Jamie) when the data since flag-enable is degenerate: advisor `sonnet_structured` null on ≥80% of ≥10 runs, or ≥20 judge-scored runs in a source with zero scores ≥3. A broken harness now costs hours, not a week. **Eval-start checklist (process half of the fix):** after enabling the flag, verify the FIRST diagnostic row end-to-end — `sonnet_structured` populated, judge score plausible — before walking away. Never trust an eval you haven't watched produce one valid row.

## Sonnet 5 clean re-run (2026-07-17 → 2026-07-23): NOT VIABLE — question closed

Re-run with the fixed harness (flag re-enabled 2026-07-17T14:15Z; use that as the `--since` floor). Harness verified healthy this time: 0 of 207 advisor rows had null `sonnet_structured`, and no score-1 row was a harness artifact — the failures are genuine content divergences.

- **Advisor: not viable.** Primary mean **2.33** on **n=58 unique tickets** (sample target of 50+ met — this is a confident call). Distribution 1–5: 7/28/20/3/0; 12.1% rated 1. The mean lands well inside the pre-registered not-viable band (<3.0), *below* the plain Sonnet 4.6 baseline (2.37) and Sonnet 4.6+thinking (2.67). Also slightly slower than Opus (16.6s vs 15.9s) — no latency consolation.
- **Operator: not viable**, again (mean 2.62, n=21, 19% rated 1) — consistent with the 07-17 fair arm and both 2026-04 verdicts.
- **Decision (2026-07-23): stay on Opus for everything.** `cs_diagnostics` flipped false same day (verdict recorded in the flag note). Run cost ~$25-27 over 6 days. Infrastructure preserved — next candidate model is a flag flip + model-constant change; follow the eval-start checklist above.

## Opus 5 evaluated and REJECTED for the advisor (2026-07-28)

Opus 5 shipped (same $5/$25 rate as 4.8, same tokenizer, faster, `speed:"fast"` available). Intent was a straight `MODELS.OPUS` flip, skipping the shadow eval on the reasoning that a same-tier/same-price upgrade is already covered by operator review + the closeness judge + one-line rollback. **The pinned scenario suite caught what that reasoning would have shipped.**

**Method (new, cheap, and now the standard for same-tier model swaps):** run `customer-service/test/scenarios/` against the candidate, then run every failure against the incumbent as a control. Two arms × ~30 live drafts ≈ $8 and ~30 minutes — vs ~$40 and 10 days for a shadow eval. The control arm is the load-bearing part: it separates real regressions from order-state drift and pre-existing failures, which the raw candidate numbers cannot.

**Result (full suite, both arms, `--full-control`):** accuracy 20/25 vs 25/25, latency **+22.5%** (9.3s vs 7.6s median), cost **+15.3%** ($0.2011 vs $0.1745 per scenario). Fails all three founder acceptance criteria — same-or-better accuracy, same-or-faster, same-or-cheaper.

**Two measurement lessons, both learned the expensive way:**
- **Never quote latency or cost from a failure-only subset.** Early runs over the failing scenarios alone showed Opus 5 13–26% *faster*; that was an artifact of measuring it while it was flailing. On the representative full suite it is slower.
- **Advisor scenarios are non-deterministic, so single-run accuracy claims are noise.** An initial "4 regressions" list shrank to two on repeat runs; `wrongOrderPreorderLink` turned out to fail on 4.8 as well, and `knowledgeFacts` is a pre-existing 4.8 bug. Only `donationToolCall` and `refundNoAmount` regress consistently, and both are one defect: plausible refund prose with `action_type: null`, so no money-moving action is staged.

**Root cause (per Anthropic's migration guide, matching the observed failures):** Opus 5 follows instructions more literally and reaches for tools less often than 4.8. Prime suspect is our own "one move per message" rule (shipped 2026-07-20) being applied literally.

**Decision (2026-07-29): stay on `claude-opus-4-8`; project closed, not paused.** The deciding point is that cost and latency are token-volume properties of the model on our workload — prompt work cannot close them, so even a perfect accuracy fix leaves two of three criteria failing. Full detail and the resume trigger are in `parked.md` ("Revisit Opus 5 (or the next model) for the advisor").

**What the attempt paid for, all of which improves Opus 4.8 today:** `scripts/modelSwapEval.js`; a fixed production bug where the advisor dropped the protective warehouse hold on ~20–60% of unshipped-order edits (no hold AND no backstop — the order could ship wrong); one genuinely bad test corrected; and measured evidence that the advisor is inconsistent on rules previously assumed solid (mirroring ~1/3, Sky colourway grounding). Parked separately.

**Scope note:** shadow eval remains right for its original question — long-horizon A/B of a *downgrade* candidate, where quality risk is real and many paired samples are needed. It is the wrong tool for qualifying a same-tier replacement, where suite-plus-control is faster, cheaper, and measures cost and latency directly. Keep both; choose by whether the candidate is a downgrade or a replacement.

**Generalizes:** "same tier + same price + strong downstream review" is NOT sufficient reason to skip pre-deploy validation. Operator review catches bad *prose*; it does not reliably catch a wrong `action_type`, which drives real money/warehouse operations. The scenario suite is the cheap gate that does.

## Shadow eval cost leak + gate inversion (2026-05-27)

Investigating a jump to ~$15/day in CS API spend, a per-day reconstruction from `_timing` token fields (the `ai_calls` observability table, now described in domain_tech.md, was built right after and supersedes this manual method) over a 14-day window found the spend was dominated by the shadow eval that was supposed to be off since Apr 30:

- **Production advisor: ~$4.63/day (~$139/mo)** — real tokens, the actual service.
- **Shadow eval: ~$9.60/day (~$288/mo)** — Sonnet draft + Opus judge on every advisor call. ~64% of spend, zero capability value. (Judge cost estimated — tokens not stored.)

**Root cause of the recurring leak:** the toggle was `CS_DIAGNOSTICS_DISABLED` (default-ON, disable-via-env). `aiAdvisor` runs in three Railway runtimes — webhook server (intake), daily-order-alerts cron (unnotifiedPreOrder calls the advisor), and the dashboard. Env vars only propagate from the main service to others via `scripts/copy-railway-vars.js`; the disable flag never reached all three, so the cron kept running shadow eval. Env-var toggles are fragile on this multi-service infra.

**Fix shipped:** gate inverted to opt-in — shadow eval runs ONLY when `CS_DIAGNOSTICS_ENABLED=true` is explicitly set (both `aiAdvisor.runShadowEvaluation` and `operatorAgent.runOperatorShadowEval`). A forgotten/reset env var now costs $0.

**Before re-enabling for the next model eval:** move the toggle out of env vars into a single Supabase flag read by all runtimes (so re-enable is consistent across all three services and visibly queryable), or the inverse failure mode (partial/incomplete eval data from a missed service) applies.

## Projected Cost Impact

| Optimization | Monthly Savings | Status |
|---|---|---|
| Prompt caching | Negligible at current volume | Deployed, no impact |
| Remove redundant tools | ~$5-8 | Deployed, working |
| Sonnet for operator agent | ~$7 | Not worth it — tiny savings, small sample, low volume |
| Sonnet for advisor | ~$30 | Not viable — 30% failure rate |

## What's Left

1. ~~Let diagnostic run to ~April 24~~ — **Done 2026-04-24.** Findings conclusive. Shadow eval disabled via `CS_DIAGNOSTICS_DISABLED=true`.
2. ~~Drop `cs_diagnostic_runs` table~~ — **Keeping.** Table and schema preserved for future model evaluations. Drop manually when no longer useful.
3. **Curate tone samples** from 51 to ~25 (saves ~2K tokens/call) — low-risk, doesn't depend on model switching
4. ~~Sonnet 4.6 + extended thinking shadow eval~~ — **Done 2026-04-29.** Not viable, see verdict in re-evaluation section above. Shadow eval disabled.
5. ~~Sonnet 5 shadow eval~~ — **Done 2026-07-23.** Not viable (advisor AND operator), see clean re-run section. Next revisit: when the next model generation ships.
6. ~~Update documented cost per conversation~~ — done 2026-04-21 (domain_cs.md + initiative_cs_automation.md updated to ~$0.39/draft)
