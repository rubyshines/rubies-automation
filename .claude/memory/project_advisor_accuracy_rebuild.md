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
- **21 pure act-vs-ask cases:** RUNNING at time of writing → `eval/replay/batch-no-overrides.json`.

**Spend: ~$4.10 of the $100 Jamie approved.** Batched runs are ~$0.15/draft (warm
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

## Next

1. Read the running act-vs-ask batch result. If `no-overrides` beats control there,
   the 2949 finding generalises and the carve-out layer is the act-vs-ask cause.
2. Build the exemplar candidate (78 exemplars replacing the register lectures) and
   test it against **padding** with a content-based judge, not word count.
3. Revealed-preference sweep across all 66 audited rules — does the mandated phrase
   survive into what Jamie sends? **Verify each hit by reading before reporting**: a
   naive presence/absence cut produced a wrong conclusion once already.
4. Tolerance sheet for **shipping and sizing_inquiry** (68% / 57% edited, never looked at).
5. Open question Jamie raised: move refund policy gates into a tool. Architecturally
   right, but no measured refund failure exists — do it only if the map shows real
   conflicts.
