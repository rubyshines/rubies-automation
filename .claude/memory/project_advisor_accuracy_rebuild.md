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
branch: wt/advisor-eval
last_updated: 2026-08-04
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

## What is built (all on `wt/advisor-eval`, nothing merged)

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
  shipped on every call. Removed.
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

## Next

1. **Phase 0 — build the lean prompt.** 78 exemplars replacing the register
   lectures; policy and anti-hallucination rules intact. Free.
2. **Phase 1 — build and calibrate a content judge.** Word count is useless (see
   above). Score: did it act when it should, did it add unrequested material, is
   every claim grounded in a tool result. **Validate it reproduces Jamie's 11
   tolerance flags and his exemplar approvals before trusting it.** This is the
   step that can quietly invalidate everything downstream — the July test skipped
   its equivalent. Free.
3. **Phase 2 — run the 2x2** (~$36).
4. In parallel, keep fixing rules: they land on 4.8 now regardless of the model
   outcome. Next up is the shipping stall.
5. Deferred: revealed-preference sweep across the 66 audited rules (verify each hit
   by reading — a naive presence/absence cut produced a wrong conclusion once);
   tolerance sheets for shipping and sizing; refund policy gates as a tool (no
   measured failure, so only if the map shows real conflicts).

## Open decision for Jamie

**The ~14 prompt fixes on this branch are NOT live.** Only the advisor_facts
changes went live (they are read from the DB at draft time). The branch holds the
leaked-customer-email removal, the overturned act-first rule, the youth/adult
crossover fix, the hold rule, the operator-invisible rule and the refund-map
rulings. They ship on merge, and they are independent of anything the eval decides.
