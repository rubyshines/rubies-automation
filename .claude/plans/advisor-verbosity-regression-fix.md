# Advisor verbosity/voice regression fix (post voice-rules degradation)

Status: EXECUTED 2026-07-20 (branch wt/advisor-verbosity). All 6 changes + Step 0 case-matrix review shipped; new pinned scenario shapingExplanationGating.js; memory close-out done. Post-ship follow-up: re-run the edit-shape assessment ~07-27.
Domain: cs. Worktree per protocol; advisor prompt changes validated by pinned scenarios only (never live-regen on historical tickets).

## Diagnosis (evidence: temp-analysis-data/edit-assess-2026-07.json — 30 edited drafts since 7/16)

- 27/30 of Jamie's edits SHORTENED drafts (avg −30 words from 73-word drafts). Raw edit rate unchanged vs baseline (52%); the shape changed — deletions of unsolicited explanation.
- Root cause: the 17 voice rules (PR #95) each individually match Jamie but the model STACKS several per draft (validate + causal explanation + option menu + diagnostic + backstop). Jamie uses ONE move per message. Prompt bloat also revived "sorry" drift (2 production instances: draft 2727 fit, 2653 third-party) despite green pinned scenarios.
- Tracking-line clutter: "you'll get tracking by email once it's on the way" came from the PR #101 verbatim template (11/58 drafts); Jamie removes it on exchanges but KEPT "confirmation email with the details" on a refund (draft 2680) — objection is exchange-tracking promises specifically.
- Bare-size refs ("the large" with no product, 2 drafts): interaction with the "don't itemize products back" rule; donation/return asks should say "the item(s)".
- Separate non-voice finding: draft 2628 claimed shipment cancelled + offered reship; Jamie's sent said tracking info was wrong + gave correct Passport link. Investigate Passport tracking correctness separately (not part of this fix).

## Step 0 — REVIEW EXISTING SIZING-RESPONSE RULES FIRST (Jamie 2026-07-18: do not lose the early nuance)

Significant early work established WHEN to ask for a measurement vs WHEN to just offer the next size (with fabric deltas) vs WHEN to explain. Before editing anything, inventory every existing case and confirm the new gating COMPOSES with them rather than overwriting:

- Prompt sections to map: "When to ACT immediately" (explicit target size → create; too loose/too big w/o target → offer 1-2 size options with deltas OR ask for a measurement — find the existing criteria for choosing between those two), the "doesn't work / shaping expectations" carve-out, measurement-ask verbatim shape (waist around belly / under belly button; bra-band vs bikini-band phrasing rule), boundary/between-sizes ruling (solidly-in-range vs on-the-line; kids size up), adjacent-size + fabric-delta tool usage rules, one-question-per-response rule, and Jamie's ruled facts (less-stretch clarification, riding-up/seam heuristics).
- Pinned scenarios that encode the nuance (must all stay green and be re-read for intent before changes): waistLooseLegsTight.js, commitmentCalibration.js, noApologyForFit.js, exchangeMoney.js, plus test/scenarios/ generally.
- Historical reference: the sizingEngine/decision-tree era rules and domain_cs Key Decisions (sizing from SKU, related rules). Also Jamie's edited sends in the evidence file — 2679/2684/2703 show the target behavior per case.
- Deliverable of step 0: a short written case matrix (customer says X → advisor does Y: ask measurement / offer size+delta / explain shaping / create exchange), confirmed against the current prompt, BEFORE any edits. If any case is ambiguous, ask Jamie rather than inferring.

## Changes (all in customer-service/lib/aiAdvisor.js prompt unless noted)

1. **Governing rule (new, top of RESPONSE LENGTH & REGISTER section): "One move per message."**
   Pick the single most useful move — act, ask, or explain — never stack. If the customer's intent is clear from their message, do the thing and confirm in 1-2 sentences. Explanations are a MOVE with a trigger, not default furniture.

2. **Explanation gating (Jamie's exact ruling 2026-07-18):**
   - Customer says the shaping "doesn't work / isn't working / not what I expected from shaping" → GIVE the shaping-expectations explanation (they need to understand how the shaping works). This is the existing "~170 words doesn't work/shaping expectations" carve-out — keep it.
   - Customer says too big / too small / too tight / too loose (plain fit complaint) → NO lecture. Suggest a size/measurement: ask for the waist measurement or offer the adjacent size with its fabric delta, one question. (Jamie's edited sends 2679/2684/2703 are the reference shapes.)
   - Gate the explanation-flavored voice rules to their stated triggers: "validate + causal explanation" ONLY for legitimate complaints about RUBIES' service/product failures (not fit); "full causal explanation" ONLY for upset customers; diagnostic question ONLY on refunds (existing); snag-menu ONLY on stock/timing problems.

3. **REMOVE numeric word-count targets entirely** (the 35-80 words / median ~55 / 170-word lines). Jamie: "def removing target word count." Replace with: the one-move rule + "when intent is clear, short and sweet: 1-2 sentences" + keep the existing per-situation shape rules (post-action closing <20 words stays — it's a shape, not a budget). Rationale: numeric targets cause budget-filling (avg drafts sat at 73 ≈ the cap).

4. **Tracking clause off the exchange template** (PR #101 shape): change to "I've created your exchange for the [item] in [size]. It'll ship [ship-day word from TODAY]." — full stop. KEEP the refund "confirmation email with the details" line (Jamie kept it). Keep the deterministic ship-day word injection (TODAY section) — that part works.

5. **Generic item references in return/donation asks:** "send the item(s) back" / "donate the items" — never bare sizes ("the large") and no need to re-itemize products. Add as a shape under the donation-boilerplate rules.

6. **Sorry drift guardrail (code, discussed & accepted):** deterministic post-draft check — if draft contains \bsorry\b/apolog and the conversation context is fit/preference/third-party (message_type or intent heuristic is NOT the gate; simplest robust: flag ANY sorry-containing draft), push an entry into prescription.flags (existing ⚠️ banner channel in dashboard renderActionPanel) so the operator sees "Draft apologizes — check fault" before sending. FLAG ONLY, never auto-strip. Keep the prompt rules as-is otherwise.

## Validation

- Update/extend pinned scenarios:
  - noApologyForFit.js: should still pass; also assert NO shaping lecture on a plain "too snug" complaint (add lecture-pattern negative assertions: /shaping is (a )?balance|two reasons|mismatch of expectations/i etc.).
  - NEW scenario shapingExplanationGating.js: (a) "it doesn't work / shaping isn't doing anything" → explanation present; (b) "too tight" → no explanation, one question/size suggestion.
  - exchangeMoney.js: re-run; assert template now ends without tracking clause.
  - Re-run all pinned scenarios (kbSearchGrounding, retentionLineGating, noApologyForThirdParty) — prompt shrinks, expect improvement, verify no regressions.
- Full suite: node --test customer-service/test/*.test.js
- Post-ship: re-run the edit-shape assessment after ~1 week (query in this plan's Diagnosis section; compare avg word-delta of Jamie's edits, target: deletions no longer dominant). The 7/25 accuracy sweep (initiative next-steps) will also read this.

## Memory close-out (with the ship)

- domain_cs Key Decisions: replace any stale register/word-count description; record "one move per message + explanation gating (doesn't-work vs plain fit)" as the governing register decision; note sorry-flag guardrail channel.
- Update voice-rules proposal sheet DECISIONS header: note post-adoption correction (dosage: rules gated under one-move governor after 2026-07-18 edit regression).
- initiative_cs_automation: progress bullet.
- Close this plan's parked entry.
