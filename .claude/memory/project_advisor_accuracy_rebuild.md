---
name: Advisor Accuracy Rebuild
description: Eval-first attack on CS advisor draft quality — measurement repair, founder rulings, prompt-variant A/B
type: project
domain: cs
done_when: >
  Draft quality on inbound advisor drafts is measurably better than the 2026-08-04
  baseline (see Baseline below) on a held-out set, validated on the pinned production
  model (MODELS.OPUS, currently claude-opus-4-8), with the winning change merged and
  the pinned scenario suite green. "The prompt is rewritten" is NOT done_when.
branch: merged 2026-08-10 (wt/eval-land)
last_updated: 2026-08-10
---

## Why this exists

Jamie's read: the advisor improved from launch through mid-May and has been flat
for ten weeks despite continuous prompt work. Confirmed from data (below). He asked
whether the answer is to throw the prompt out and rebuild eval-first, the way you
would when a new model ships.

## Baseline (measured 2026-08-04 — trust these, earlier numbers were wrong)

**Every advisor quality number before today was inflated.** Two independent causes,
both now fixed:

1. **Contaminated population.** `cs_ai_drafts` holds every outbound message. The
   digest edit-rate metric had no source filter at all, counting `auto_follow_up`
   (a fixed template, ~97% byte-identical), `operator_reply` / `manual_send` (Jamie
   composing from scratch — stored into BOTH draft_response and sent_response, so
   each scores as a flawless untouched draft), and `simulator` traffic. Reported
   48.4% edit rate vs 53.1% true. The daily judge had the same problem via
   `draft_kind` alone (43 of 1462 verdicts were on messages the advisor never wrote).
2. **Tolerance.** Jamie often ships drafts he wouldn't have written rather than
   spend time rewriting, so an unedited send is an UNLABELED sample, not a positive.
   Measured: of 40 unedited sends he reviewed, **11 he would have written differently
   (~28%)**.

Corrected picture:

| metric | value |
|---|---|
| edit rate, inbound advisor drafts, 30d | **53.1%** |
| of unedited sends, would have written differently | **~28%** |
| so: drafts actually right as sent | **~34%** (not the ~47% implied) |
| worst turn | **turn 2 — ~25% right** |
| turn-by-turn unedited (poller only) | 41% / 50% / 56% / 54% |
| per draft | ~2.3 API rounds, ~20s, ~$0.23 |
| static prompt | ~24.8k tokens of prose, ~40k with tone samples etc. |

Trend, 2-week bins, poller only: 26% → 41% → 58% → **64% (mid-May peak)** → 49% →
54% → 48% → 43% → 48%. Real improvement to mid-May, flat since. The May peak is
partly the China window (he steered rather than rewrote), so true plateau ≈ low 50s.

Edit rate by type since May: exchange 49% · general_inquiry **65%** · refund 33% ·
closing 7% · shipping **68%** · sizing_inquiry **57%**. **We have only worked on
exchange and refund. Shipping / general_inquiry / sizing are worse and untouched.**

## The two defects (they are separate — do not conflate)

1. **Act-vs-ask.** Advisor asks when the customer already gave it everything.
   Structural signature: unprompted draft stages no action, post-steer draft does.
   **54 of 122 steered drafts since May; 21 are "pure" (short steer adding no fact
   the advisor could not see).**
2. **Padding.** Unrequested sentences bolted onto a correct action — invented warmth,
   redundant procedure, restated facts. **10 of Jamie's 11 flags.**
   **Padding is NOT a length problem** — measured 79–84 words against Jamie's 76 on
   the same cases. Word count is a useless proxy; a judge must score content.

## Key finding

**Every one of Jamie's 11 flags was already an explicit rule in the prompt**, some
marked CRITICAL. Seven were direct violations of written rules. So this is a
*compliance* problem at ~40k tokens, not a *content* problem. Writing better rules
cannot work — that is what the last ten weeks were.

Corroborated by the say-rules audit: he kept **54 of 62** real wording mandates
(87%). The rules are mostly right.

## What is built (eval tooling — all on `main` as of 2026-08-10)

- `scripts/publishToleranceSheet.js` — stratified unedited-send sample → sheet.
- `scripts/_mineExemplars.js` — mines Jamie's pre-March from-scratch replies.
  **837 candidate pairs.** His median reply is **45 words** (advisor ~73).
- `scripts/publishExemplarSheet.js` — 78 taught / **751 held out for scoring**.
- `scripts/extractSayRules.js` + `publishSayRulesSheet.js` — wording-mandate audit.
- `scripts/replayTurns.js` — turn-by-turn replay from STORED history.
- `scripts/promptVariants.js` — variants as pure string transforms.
- `scripts/runProbe.js` / `runProbeBatch.js` — A/B on the pinned model.
- `eval/refund-map.js` + `publishRefundMap.js` — 14-step refund map.

Review sheets all live in `KB_REVIEW_SHEET_ID` (tabs: Tolerance Check, Exemplars,
Say-Rules Audit, Refund Map). Convention: blank = agree.

## Results so far

- **2949 turn 2, 3x each ($1.40):** control acted 1/3, `no-large-order` acted 3/3.
  Control run 3 reproduced the original failing draft almost verbatim. **Clean causal
  result: one 683-char block caused it.**
- **11 padding-flagged cases, 1x ($2.70):** control acted 6/11 / 79w;
  `no-overrides` acted 6/11 / 84w. **Null — wrong test set** (padding cases cannot
  show an act-vs-ask fix). Draft 1814 regressed 23w → 94w.
- **21 pure act-vs-ask cases, 3 runs each ($9.50): the carve-out thesis FAILS at
  population level.** Run 1 looked strong (control 5/21, variant 9/21) but p was
  0.289. Runs 2 and 3 came back dead even, 15/42 each. Combined: **control 20/63
  (32%), no-overrides 24/63 (38%)** — within noise. Deleting the five behavioural
  scenario blocks does NOT fix act-vs-ask.
  - **But the specific finding survives.** Ticket 2949 / draft 3050 across two
    independent batches: control acted 2/5, `no-large-order` and `no-overrides`
    acted 5/5. So the large-order rule really did cause that failure; deleting
    carve-outs generally does not generalise to a fix.
  - Read this as a warning about single runs. Run 1 alone would have been reported
    as a win and would have been wrong.

**Spend: ~$14 of the $100 Jamie approved.** Batched runs are ~$0.15/draft (warm
cache) vs ~$0.29 in production.

## Jamie's rulings, applied to the prompt

- Wording struck: "let's get you into a size that works" · "That sounds frustrating" ·
  "I hear you loud and clear" · "You are not the first to make this comment" (claims
  knowledge the advisor cannot have).
- **A real customer's email was hardcoded in the system prompt** (`laura.helpline830@…`),
  shipped on every call. Removed — and this **already shipped to main in #119**, along
  with most of the founder-audit fixes. Only three prompt rules were ever unmerged
  (act-on-a-guess, hold-removal, operator-invisible). A stale "~14 unshipped fixes"
  line in this file was quoted for hours on 08-04 before anyone diffed against main.
- "Act first, then offer a bounded override" **overturned** — never act on a guess and
  invite the customer to countermand it. Kept the urgency variant ("executive decision")
  — the line is real stated urgency, not acting per se.
- Youth/adult crossover: no universal "next size down is kids 9", it varies by product.
- Diagnostic question: ask at the **first opportunity**, not after the refund.
- **Holds: say you placed one, never that you removed one.** Placing is reassurance;
  lifting is inside baseball. General form: *state what the customer gets, not the
  internal steps.* Four exemplars dropped for teaching the opposite.
- Repeat refunders: **stop routing to human**, draft the refund and flag it loudly —
  he reviews everything anyway.
- Refund prose: drop "You'll get a confirmation email with the details" (reverses
  2026-07-20).
- Retention line and donation proof ask are now **mutually exclusive**, gated on
  whether the customer engaged with sizing help.

## Gotchas that cost time — do not relearn these

- `cs_ai_drafts.turn_number` stays 1 across multi-round tickets. Derive turn order
  from `created_at` within a ticket.
- `cs_messages.sender_type` is `agent` for EVERYONE including customers. Use
  `sender_name` (`RUBIES Customer Care` / `care@rubyshines.com` = us).
- The quoted reply trail appears in several date formats. Missing one glues the
  customer's words onto Jamie's reply and **doubled the measured reply length**.
- `draft_response` is the LAST regeneration. On a steered turn the honest baseline is
  `draft_history[0]` — the unprompted attempt.
- Replay must **teacher-force**: history carries Jamie's SENT replies, never the
  model's own prior output.
- Tool RESULTS are never persisted (`audit_trail` has names + 100-char inputs only).
- PostgREST needs `.select()` before filters; a permissive test stub hid a query that
  threw in production.
- Testing inside Claude Code runs **Opus 5**, which is NOT production (pinned 4.8) and
  wrote 14% more output on the same prompt. Verdicts must come from the real API.
- Prompt-variant hook (`setPromptTransform`) is deliberately NOT env-var driven.

## Two more defects found late, both undiagnosed

- **Shipping stalls.** 14% of shipping drafts go `route_to_human` (vs 0–1% on
  exchange/refund). 16 drafts wrote "let me look into this and get back to you" and
  **Jamie replaced the stall 14 times out of 16** with a concrete recourse — a
  reship offer, a date to check back. One draft claimed "I've reached out to the
  courier" when it hadn't (anti-hallucination rule 8 violation).
- **Wholesale rewrites.** Classifying every edit by shape: exchange 32% rewritten,
  refund 29%, but **shipping 53% and general_inquiry 55%**. Over half the time
  Jamie discards the draft and writes his own. That is a third defect — the content
  is wrong, not verbose — in the two largest untouched categories (~200 drafts).
  Reading them, the causes look like operator-only knowledge (carrier suspensions,
  a marketing email sent in error) plus the stalling above.

## Agreed plan (2026-08-04): fair Opus 5 test as a 2x2

The July rejection of Opus 5 is not trustworthy — it ran against a prompt tuned to
4.8 for months, on a scenario suite documented as flaky on both models, first-pass
only. Opus 5 was **38% cheaper per call**, 14% slower, 14% more output.

Design: {4.8, Opus 5} x {current prompt, lean prompt}, 20 cases spanning all three
defects, 3 runs each = 240 drafts ≈ **$36**. The diagnostic is the interaction: if
Opus 5 only loses on the current prompt, its regressions were prompt artifacts.

**Decision rule, fixed in advance:**
- Switch to Opus 5 only if it matches or beats 4.8 on the LEAN prompt across all
  three defect types, with the pinned suite green at `--repeat 3`. Cost and latency
  are tiebreakers and cost already favours it.
- Adopt the lean prompt on 4.8 if it beats current on 4.8 — a separate decision,
  not hostage to the model question.
- Abandon both if lean beats current on neither.

## Phase 0 — the lean prompt ✓ (2026-08-04)

`eval/leanPrompt.js`, wired as the `lean` variant in `promptVariants.js`. It is a
**mechanical transform over the shipped prompt**, never a hand-written second
prompt — otherwise the gap between the arms could be anything. It asserts on
every anchor it expects, so a future prompt edit that moves a heading throws
instead of silently changing the experiment. Guarded by
`customer-service/test/leanPrompt.test.js` (7 tests; full suite 1746/1746 green).

What it does:
- **Cuts** `RESPONSE LENGTH & REGISTER` (2.1k t) → a 0.9k compressed core keeping
  only the founder rulings an exemplar cannot carry (one-move, the apology gate,
  one-question, no-restating, performed-empathy, the 08-04 struck wordings).
- **Cuts** the 9 register bullets from `Writing Style Rules`, keeps the 16
  mechanical/safety ones (em-dash, emoji, profile name, they/them, signature,
  tense-vs-structured agreement, tool-calls-precede-prose).
- **Cuts** the 5 behavioural scenario overrides (the existing `no-overrides` set).
- **Swaps** the 32 tone samples for the **78 paired exemplars** (customer message
  + Jamie's reply, greeting and signature stripped). Deliberately a swap, not an
  addition: the tone block's "use Jamie's EXACT phrases" framing is what beat a
  written rule in the 07-22 sorry drift, and two example corpora with different
  framings rebuild that contradiction. The exemplars dominate — same voice,
  pre-advisor from-scratch writing, and each carries the customer message, so
  they teach the act-vs-ask decision the body-only samples cannot.

**Honest limitation, flagged before Phase 2 runs:** lean is not smaller. Static
prompt 31.0k t → 33.4k t; the RULES surface falls 28.4k → 25.5k (−10%) and 7.9k
of exemplars go in. `Key Business Rules` is 42% of the prompt and is untouched
because it is policy. So the 2x2 tests **examples instead of descriptions**, not
"fewer tokens". If lean loses, "the prompt is too big" remains untested.

## Phase 1 — the content judge ✓ (2026-08-04)

`eval/judge.js` + `scripts/calibrateJudge.js`. Three axes — act-vs-ask,
unrequested material, grounding — each requiring a **verbatim quote from the
draft**. Findings whose quote is not in the draft are dropped as hallucinated
citations. The judge emits only citations; the pass/fail is derived in code
(`verdict()`), so the bar re-tunes for free (`--rescore`) and every disagreement
traces to a sentence rather than a mood. Length is banned from the rubric.

Calibrated against the 40 tolerance rows (39 scored; #1745 "I doubt you wrote
this" excluded as a provenance challenge, not a quality ruling):

| | v1 | v2 | **v3 (shipped)** |
|---|---|---|---|
| recall on Jamie's 11 flags | 11/11 | 10/11 | **11/11** |
| flagged in his 28-draft clean set | 14 (50%) | 8 (29%) | **8 (29%)** |

The v1→v3 fixes were all the judge not knowing RUBIES policy: it scored the
advisor down for **obeying** rules — the mandated defect photo ask, the
save-the-sale hold, nudge-first refund, tool-verbatim donation copy, the draft's
own staged action ("I've created your exchange" is not ungrounded, it hasn't
happened yet), and in one case the valediction. Fix was a short policy digest in
the rubric, not a looser bar. **Stop-tuning call taken at v3:** the ~3/39
residual errors are the judge failing to apply rules already in its own rubric,
and restating them louder is the exact failure this project exists to study.

29% flagging on his unlabelled-clean set is the expected shape, not a fault — an
unedited send is an UNLABELED sample and his own measured tolerance gap is 28%.

**Self-consistency 10/10** on a re-judge — far steadier than the advisor, which
flips run to run. So the 2x2 needs repeat DRAFTING, not repeat judging.

### The length scare, and why the judge survived it
Findings correlate with draft length (r = 0.56), and a bare "flag over 69 words"
rule matches the judge on F1 (0.74 vs 0.73) — **even inside a length-matched
40-100w band**. That nearly killed the judge. Observational data cannot separate
the two: complex cases are both longer and likelier to be padded.

An **intervention** can, and it is decisive:
- **REPAIR** — delete exactly the sentence the judge cited: **5/5 cleared**.
- **INJECT** — add ONE invented sentence drawn from Jamie's own complaints to a
  judge-clean draft: **8/8 caught, 8/8 cited by name**, including a 5w→14w and a
  10w→22w draft where no length threshold could fire.

The judge tracks content; the correlation is a property of the population.
(`scripts/_judgeInterventionTest.js`, `scripts/_judgeChecks.js`.) Note the length
rule buys its precision by **missing 4 of Jamie's 11 flags**, at 38-53 words.

## Phase 2 — the 2x2 ✓ (2026-08-04)

`scripts/run2x2.js` + `eval/cases2x2.js`. 240 drafts: 20 cases (7 act-vs-ask,
6 padding, 7 wholesale-rewrite) x 4 arms x 3 runs, judge model pinned to 4.8 so
the instrument is identical in every cell. Zero errors.

| arm | judge-clean | asked unnec. | $/draft | sec |
|---|---|---|---|---|
| 4.8 / current | 11/60 (18%) | 12% | $0.102 | 20.5 |
| 4.8 / lean | 14/60 (23%) | 7% | $0.109 (+8%) | 21.0 (+2%) |
| o5 / current | 21/60 (35%) | 10% | $0.132 (+30%) | 32.8 (+60%) |
| o5 / lean | 10/60 (17%) | 5% | $0.145 (+42%) | 35.2 (+72%) |

**Decision: merge the three founder rulings, keep the CURRENT prompt, do not
switch to Opus 5.** The 2x2 did not produce a winner.

**This table is the SECOND scoring.** The first was run with a judge that
over-flagged warmth, and it read 8% / 22% / 25% / 18% — a "3x win for lean,
consistent across all three runs, p<0.05". That result did not survive fixing
the judge. Lean vs current is now z=0.67, not significant, and lean loses one of
the three runs. **The measurement error was larger than every treatment effect
in the experiment.** That is the finding of the day; the prompt and model
comparisons are secondary and inconclusive.

What survives, weakly: lean asks unnecessarily on 7% of drafts against current's
12%, in the right direction on both scorings but never significant on its own.

Opus 5 on the CURRENT prompt scores best (35%, z=2.06 vs 4.8/current) and is the
only comparison clearing significance. It is not actionable: it contradicts
itself (best on the old prompt, worst on the new one), its three runs climbed
5 → 7 → 9 which reads as drift rather than a stable property, and it costs +30%
and runs +60% slower. July's "38% cheaper" does not reproduce — it wrote 89%
more output.

**The ceiling, measured the same way: Jamie's own replies score 48%** (52%
ignoring grounding, which the data cannot fairly judge him on since he writes
from things he knows and no tool recorded). So ~20% is not "20 out of 100" — the
instrument tops out near 50. He asks unnecessarily on 8% of his own replies,
which is why lean's 7% is interesting even though it is not significant.

Caveat on absolute numbers throughout: 20 deliberately-chosen known failures, not
representative traffic.

## Next

Read this list, NOT the older plan it replaces. Lean is not shipping on the
strength of the 2x2, and every founder-audit prompt fix is already on main
(verified by diff, 2026-08-10). Nothing in this project is waiting on a merge.

1. **Decide whether the sequential lean trial is still alive.** Phase 2's plan was
   three weeks of clean edit-rate baseline on the current prompt, then three on
   lean. It was never protected: ~20 commits landed on main after 08-04, several
   touching the advisor prompt (pad facts, product-comparison grounding, the
   reasoning-leak strip, out-of-office). The baseline window is already
   contaminated — restart it under a prompt freeze, or drop the trial.
2. **Fix the tone-sample contradiction** (see below). Small, and it is teaching
   against a shipped rule right now.
3. **Keep fixing rules on 4.8** regardless of the model question. Next up is the
   shipping stall: 14% of shipping drafts route to human, and Jamie replaced the
   "let me look into this" stall 14 times out of 16 with concrete recourse.
4. **The untouched categories carry the worst numbers** — shipping 68% edit rate,
   general_inquiry 65%, sizing 57%, against exchange 49% / refund 33%, the only two
   ever worked. Over half of shipping and general_inquiry drafts are discarded and
   rewritten wholesale, which is a content defect, not a verbosity one.
5. **Deferred:** revealed-preference sweep across the 66 audited rules (verify each
   hit by reading — a naive presence/absence cut produced a wrong conclusion once);
   tolerance sheets for shipping and sizing; refund policy gates as a tool (no
   measured failure, so only if the map shows real conflicts).

## Open question — `ai_calls` may be under-reporting cost

The 2x2's own token accounting (summed from Anthropic's `usage` on every round)
puts the run's drafting at **$29.24**. The `ai_calls` ledger, over the same
window and with a matching row count (555 rows vs 535 recorded rounds), puts it
at **$17.31**. Row counts reconcile; cost per row does not. This is bigger than
this project — `ai_calls` is the source for the daily digest's per-component
spend, so if it under-reports, every cost number Jamie sees is low. Not chased.

## Harness bug worth not repeating

A shard must draft and STOP. Judging and reporting merge every shard file, so
letting a shard run them made each of six shards pull in all the others and
re-judge the union: six copies of the same 240 drafts in six files. It cost ~$5
of duplicate judging and made the monitoring arithmetic report **$173 spent
against a real $43**, because every draft was counted once per shard. The
drafting itself was never duplicated. Fixed in `run2x2.js`.

## Live contradiction found while building (independent of the eval)

Active tone sample `refund_with_donation` still ends "You'll get a confirmation
email with the details" — **the exact line Jamie struck on 2026-08-04**. Tone
samples outrank rules (the documented 07-22 mechanism), so the prompt rule is
being taught against by its own example data. `address_reship_confirm` also trips
the on-its-way check and wants a read. Fix the sample data, not the rule.

## Merged 2026-08-04

Three prompt rules (never act on a guess then offer to undo it; say you placed a
hold, never that you removed one; the operator is invisible to the customer) plus
the two measurement repairs (`advisorEditRate.js`, `judgeDaily.js`). **The lean
prompt was NOT merged** — no measured benefit, and merging it would have muddied
the first trustworthy edit-rate baseline this system has ever had.

Plan: three weeks of clean baseline on the current prompt, then three weeks on
lean, and compare edit rate. Sequential rather than a 50/50 traffic split because
cache writes are **53% of advisor spend** ($58.75 of $111.75 over 7 days, 16% of
calls arriving cold) — two live prompts means two caches, each kept warm by half
the traffic, costing roughly **+$8/day**. Sequential is confounded by time; it is
also free.

**Separate and probably worth more than anything else here:** cache writes being
half the advisor bill has never been looked at. A longer cache lifetime may cut
the single largest line item in the AI spend. Not investigated.

## When 4.8 is deprecated — the migration is a tuning job, not a downgrade

Trigger: Anthropic publishes a retirement date for `claude-opus-4-8`. Retirement
history runs 12-22 months from release (Opus-tier skews long: Claude 3 Opus got
22), and deprecation is always announced with a date months ahead — Opus 4.1 was
announced a year out. On that pattern 4.8 retires around mid-to-late 2027. Do
NOT pre-tune: it means maintaining a second prompt for a model you are not
running, and it goes stale as the live prompt moves.

What the 2x2 established: Opus 5 matches 4.8 on accuracy but cost +30-42% and ran
+60-72% slower. **Both penalties have one cause — it wrote 89% more output**
(2285 vs 1210 tokens/draft). Anthropic's own migration guidance says Opus 5 is
more verbose by default, that an explicit conciseness instruction cuts response
length ~20%, and that lowering `effort` does NOT reliably shorten output — the
prompt is the lever. So the gap is a tuning gap, not a model tax, and nobody had
tuned for it: the 2x2 ran Opus 5 on a prompt written for 4.8.

The migration when it comes: add the conciseness instruction, re-run
`scripts/run2x2.js` on the same 20 cases, confirm accuracy holds and the cost gap
closes. `MODELS.OPUS` in `shared/aiPricing.js` is the only place the ID lives.

## Everything prompt-side is live (verified 2026-08-10)

Re-diffed the branch against main before landing the eval tooling: **all of the
founder-audit prompt changes are on main.** The leaked-customer-email removal, the
overturned act-first rule, the youth/adult crossover fix, the hold rule, the
operator-invisible rule, the struck wordings and the refund-map rulings all shipped
in #119. A "Superseded" section here claimed the opposite for six days; it was the
same stale "~14 unshipped fixes" line the file warns about above, and it is now
deleted. When this file and `main` disagree, diff — do not quote the file.
