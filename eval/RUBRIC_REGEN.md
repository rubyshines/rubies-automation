# Regen Judging Rubric (control & treatment runs)

Each item: a freshly regenerated advisor draft (`regen_draft`) + its proposed action (`regen_action`), to be judged against **what Jamie actually sent** (`sent_response`). Jamie's sent reply is the ground truth for BOTH what to say and what action he took. Judge two axes.

## Axis 1 — PROSE fidelity (`regen_draft` vs `sent_response`)
Would Jamie have sent this regenerated draft essentially as-is?
- `IDENTICAL` — same substance/wording (ignore whitespace).
- `COSMETIC` — equivalent: whitespace, signature, greeting, punctuation, minor reorder. No change to facts/offer/what the customer is told.
- `SUBSTANTIVE_PROSE` — materially different content/tone/offer, but no factual error (Jamie's voice differs; not wrong).
- `FACTUAL_CORRECTION` — the regen draft states something factually WRONG vs what Jamie sent: wrong size/color/availability, wrong product anatomy, wrong policy/date/partner/program fact, wrong refund detail.
- `PROSE_ACTION_MISMATCH` — regen prose describes an action that contradicts what Jamie's sent reply did.

Prose accurate = IDENTICAL or COSMETIC.

## Axis 2 — ACTION fidelity (`regen_action` vs the action implied by `sent_response`)
**Ground truth = what Jamie's sent_response says/implies he did** (e.g. "I've released the hold" = a hold-release action; "I've created your exchange for the 2X" = an exchange; a question with no commitment = no action). IGNORE any tracking arrays — read Jamie's prose.
- `NO_ACTION_CORRECT` — Jamie's reply committed no action (asked a question / gave info) AND regen proposed none.
- `MATCH` — regen's proposed action matches the action Jamie's reply committed to (type + substance).
- `MINOR` — same action, trivially different detail.
- `WRONG_ACTION` — regen proposed a different action type/substance than Jamie did.
- `MISSING_ACTION` — Jamie's reply committed/executed an action; regen proposed none (or only asked).
- `EXTRA_ACTION` — regen proposed an action; Jamie's reply committed none (he asked/offered a choice instead).

Action accurate = NO_ACTION_CORRECT, MATCH, or MINOR.

## Output (STRICT JSON array, input order, exact ids)
```json
[{"id":901,"prose_class":"IDENTICAL","prose_note":"","action_class":"MATCH","action_note":""}]
```
Notes <10 words. Output ONLY the JSON array. Be calibrated and consistent.
