---
name: Structured Output Consistency
description: Catch advisor drafts where prose and structured block disagree (action claimed but items/operator_action_summary/status don't reflect it)
type: project
domain: cs
done_when: holdoutTest records structured fields per ticket AND a steer-aware scenario covers "operator redirects to product, customer hasn't picked color" with assertions on status/operator_action_summary/items
originSessionId: orient-2026-04-27
---

## Problem

The advisor returns customer-facing prose AND a structured JSON block (status, items[], operator_action_summary, action_type). The dashboard prefills the operator action panel from the structured block. When prose and structured block drift, the operator sees a draft that says "I've created an exchange" but the action box is empty — wasted review cycles, risk of sending a draft that promises something that won't execute.

Bitten twice in production:
- **Ticket 581** (2026-04-26): 3 needed items in prose, only 1 emitted in items[]. Operator action prefill broken while prose looks fine.
- **Ticket 621 / gorgias 95334055** (2026-04-26): Operator steered exchange to Serena. Prose "I've created an exchange for the Stella 1X to the Serena Shorty Shorts in 1X" (past tense, action committed). Structured: status=needs_info, action_type=null, items=undefined, but operator_action_summary populated. Internally inconsistent — three signals disagreeing in one draft. Root cause: customer hadn't picked color yet, so model partially committed.

The holdout/scenario harnesses (runHoldout, holdoutTest, runOneConvo) judge customer-facing prose only via AI judge. None inspect structured output shape — so this class of regression slips through.

## Scope

### Phase 1: Prompt fix (DONE 2026-04-27)
Strengthened [aiAdvisor.js:923-926](../../customer-service/lib/aiAdvisor.js#L923-L926) to enforce internal consistency between status, prose tense, items[], and operator_action_summary. Added explicit "operator-steered exchange with pending color/size choice = needs_info" trap. Updated operator_action_summary doc at [aiAdvisor.js:972](../../customer-service/lib/aiAdvisor.js#L972) to require null when status is needs_info/gathering.

### Phase 2: Holdout visibility (Option C) — DONE 2026-04-27
Extended [customer-service/test/holdoutTest.js](../../customer-service/test/holdoutTest.js) to record per-ticket: status, message_type, action_type, operator_action_summary present/null, items_count, item_states, item_products, item_resolved_sizes. Added regex-based prose-tense detection (past/future/mixed/none) and a consistency checker that emits drift flags for known mismatch patterns (past_tense_with_needs_info, oas_populated_with_needs_info, action_committed_but_no_items, ready_action_no_oas, future_tense_with_ready_action, past_tense_no_oas, needs_info_but_all_items_confirmed). Final report prints a flag-count breakdown and per-ticket drift list. No assertions — visibility only. Run: `node customer-service/test/holdoutTest.js [count]`.

### Phase 3: Steer-aware scenario harness (Option A)
The current harness can't simulate operator steers ([operatorSteer in dashboard/server.js](../../customer-service/dashboard/server.js) only). Add a small scenario file with pinned cases:
- "Operator steers to Serena, customer hasn't picked color" → expect status=needs_info, operator_action_summary=null, items[].state=AWAITING_DECISION, prose future tense
- "Operator steers to Serena, customer specified color in earlier message" → expect status=ready, operator_action_summary populated, items[].state=CONFIRMED, prose past tense
- "Multi-item exchange, all resolved" → expect items_count matches prose mentions

Hard pass/fail assertions on structured shape. Run in CI alongside unit tests.

**Status (2026-04-28):** Scenario directory infrastructure now exists at [customer-service/test/scenarios/](../../customer-service/test/scenarios/). First scenario [steerProseLoss.js](../../customer-service/test/scenarios/steerProseLoss.js) added — covers a *different* failure mode (multi-round prose loss on steer, ticket 95626032) not the three structured-drift scenarios above. The three originally-planned scenarios still need to be written; the infrastructure pattern (load real Gorgias ticket → call aiAdvisor with operatorSteer → assert on result._structured) is established and reusable.

### Phase 4 (optional): Dashboard guard
If the model still occasionally drifts, add a dashboard-side warning when prose past tense + status≠ready, or operator_action_summary populated + status≠ready. Surface as a yellow banner on the draft, not a block — operator decides. Only build this if Phase 1-3 don't reduce drift to near-zero.

## Decisions

- **Prompt-first per CLAUDE.md.** No regex/code-level prose-tense detection in the live path. The model owns consistency; the harness verifies; the dashboard displays.
- **Visibility before assertions.** Phase 2 ships first to learn the actual drift surface area before pinning specific assertions in Phase 3.
- **Steer simulation is harness-only.** Don't touch advisor code to support tests — just call aiAdvisor with operatorSteer arg directly from the scenario runner.

## Validation

After Phase 1 prompt change: re-run any saved holdout that includes operator-steered exchanges (or Phase 3 scenarios once built). Pull recent production drafts from cs_ai_drafts where action_type=null but operator_action_summary IS NOT NULL — that's the smoking-gun query for this drift.

```sql
SELECT id, gorgias_ticket_id, advisor_status,
       structured_output->>'operator_action_summary' AS oas,
       structured_output->>'action_type' AS atype,
       jsonb_array_length(COALESCE(structured_output->'items', '[]')) AS items_count
FROM cs_ai_drafts
WHERE structured_output->>'operator_action_summary' IS NOT NULL
  AND (structured_output->>'status') IN ('needs_info', 'gathering')
ORDER BY created_at DESC LIMIT 20;
```

## Open Questions

None — Phase 1 is done. Phase 2 is the next ticket of work; promote to in-progress when picking it up.
