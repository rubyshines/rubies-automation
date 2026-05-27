# Accuracy Judging Rubric

Ground truth = what Jamie actually sent/did. The advisor's job is to produce a draft Jamie could send as-is and propose the action Jamie actually took. Judge each pair on TWO independent axes.

## Axis 1 — PROSE fidelity (`draft_response` vs `sent_response`)
Classify the relationship of the advisor draft to what Jamie actually sent:

- `IDENTICAL` — same text (ignore trailing whitespace).
- `COSMETIC` — differences a reasonable reader treats as equivalent: whitespace, signature block, greeting/sign-off wording, punctuation, minor reordering, name. No change to facts, offer, tone-stance, or what the customer is told.
- `SUBSTANTIVE_PROSE` — Jamie materially reworded content or shifted tone/stance (added/removed reasoning, softened/hardened, changed what's offered or asked), but no factual error in the draft.
- `FACTUAL_CORRECTION` — Jamie changed a fact: a date, price, policy, size, product, eligibility, quantity, shipping detail, or any claim that was *wrong* in the draft.
- `PROSE_ACTION_MISMATCH` — the draft's prose described an action that doesn't match what Jamie's sent message described (e.g. draft says "I've refunded you" but Jamie's says "I've created an exchange").

Prose is "accurate" when class is IDENTICAL or COSMETIC.

For each pair also record:
- `prose_edit_note`: one short phrase naming WHAT changed (e.g. "removed apology opener", "corrected restock date", "switched offer from refund to exchange", "added sizing explanation"). For IDENTICAL, "".
- `prose_pattern_tag`: a short reusable cluster tag (snake_case) so we can group recurring edits. Examples: `apology_opener`, `over_offered_refund`, `wrong_restock_date`, `tone_too_formal`, `missing_sizing_help`, `added_donation_info`, `signature_only`. Invent consistent tags; reuse across pairs.

## Axis 2 — ACTION fidelity (proposed vs executed)
Only meaningful when at least one side has an action. `proposed_action` = what the advisor proposed (action_type / operator_action_summary / items). `executed_actions` = what Jamie actually did.

- `NO_ACTION_CORRECT` — advisor proposed no action AND Jamie did none (correct restraint; e.g. info reply, needs_info).
- `MATCH` — proposed action type + substance matches what was executed.
- `MINOR` — same action type, differing detail (e.g. slightly different items, summary wording) that wouldn't change the operator's execution materially.
- `WRONG_ACTION` — advisor proposed an action of the wrong type/substance vs what Jamie did.
- `MISSING_ACTION` — advisor proposed nothing (or needs_info) but Jamie executed an action.
- `EXTRA_ACTION` — advisor proposed an action but Jamie executed none (over-eager).

Action is "accurate" when class is NO_ACTION_CORRECT, MATCH, or MINOR.

For each pair also record:
- `action_note`: short phrase on the discrepancy, or "" when MATCH/NO_ACTION_CORRECT.
- `action_pattern_tag`: reusable snake_case cluster tag (e.g. `proposed_refund_jamie_exchanged`, `missed_warehouse_hold`, `over_proposed_action`, `needs_info_was_right`). "" when clean.

## Output format (STRICT JSON array, one object per pair, in input order)
```json
[
  {
    "id": 1102,
    "prose_class": "COSMETIC",
    "prose_edit_note": "signature only",
    "prose_pattern_tag": "signature_only",
    "action_class": "NO_ACTION_CORRECT",
    "action_note": "",
    "action_pattern_tag": ""
  }
]
```
Rules: output ONLY the JSON array, no prose around it. Use the exact `id` from each input pair. Use only the class enums above. Keep notes under ~10 words. Be calibrated and consistent — these tags drive the whole iteration.
