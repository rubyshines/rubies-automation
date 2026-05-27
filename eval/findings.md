# Phase 2 Findings — Root-cause + prompt audit (22 error cases)

## Per-case table

| id | class | root_cause | lever | prompt_ref | fix_idea |
|----|-------|------------|-------|-----------|----------|
| 920 | FACTUAL / MISSING_ACTION | `[CORRECTED STREET ADDRESS]` placeholder (no street in context); consolidation done prior session, not surfaced | CONTEXT + PROMPT | 961-968; no consolidation rule | Add multi-order/consolidation rule; if address partial, say can't fill street vs emit placeholder |
| 963 | FACTUAL (time) / MINOR | Parroted customer's wrong day, proposed 11am; Jamie chose 10am Weds | JAMIE_VOICE | 950-953 | None; route_to_human correct |
| 975 | FACTUAL / MINOR | Promised cancel on FULFILLED order (impossible); Jamie refunded. Cancel path doesn't gate on fulfillment | PROMPT | 973-977 | "If FULFILLED, cancel impossible — propose refund_order, say so" |
| 1005 | FACTUAL (kids sizes) / OK-action | Offered odd youth sizes (11,13); underwear even-only. 877 contradicts table 868-873 | CONTEXT + PROMPT | 865-885 | Add "underwear = even youth sizes only"; resolve 877↔table conflict |
| 1051 | FACTUAL (refund $) / MINOR | Exact $32 vs $28.80 | ALREADY_FIXED | 1043-1044 | None |
| 1066 | FACTUAL (no WV partner) / OK | Presented out-of-state MA partner as local | PROMPT | 1058-1068 | "If no partner in customer's state, say so + offer alternative" |
| 1100 | FACTUAL (Sky color) / OK | Said black-only from memory; actually black+pink | CONTEXT | 916-929 | Require compare_products before stating colors; never from memory |
| 1151 | FACTUAL (refund $) / MINOR | $136.80 vs $112.50 | ALREADY_FIXED | 1043-1044 | None |
| 1175 | FACTUAL (packaging) / OK | Claimed no RUBIES name on label; name appears small | CONTEXT | none | Add Packaging & Discretion facts block |
| 1185 | FACTUAL (bikini→bra band) / OK | Used swim-top measurement phrase for a bra (Ava) | PROMPT | 1091 | Split: bras → "bra band"; swim tops → "bikini band" |
| 1188 | FACTUAL (program link) / OK | Deferred instead of supplying free-swimwear URL | CONTEXT | 1107-1109 | Add Known Links block |
| 1226 | FACTUAL (L→L tall) / OK | Recommended Sky L; correct L Tall. Tall not surfaced at initial rec | CONTEXT + PROMPT | 863; 127-136 | Size lookup must return + state Regular/Tall on one-pieces |
| 877 | MISMATCH / MISSING_ACTION | Add-to-order intent → only needs_info; Jamie placed hold | PROMPT | 963 | Modify-unshipped intent → ALWAYS warehouse_hold |
| 901 | IDENTICAL / EXTRA_ACTION | Re-proposed hold-release already executed; no verify-state | PROMPT | gap | Check tags/fulfillment; if already reflected, ready + NO action |
| 910 | SUBSTANTIVE / EXTRA_ACTION | Release already done | PROMPT | gap | Same as 901 |
| 922 | SUBSTANTIVE / MISSING_ACTION | Under-committed (needs_info); Jamie created 1X exchange. Size context-determined | PROMPT | 694-699, 1099 | When prior context names target size, create exchange |
| 960 | SUBSTANTIVE / MISSING_ACTION | Falsely claimed exchange "already processed"; Jamie created it | PROMPT | 803-805 | Never claim done unless tags confirm; else create |
| 974 | IDENTICAL / EXTRA_ACTION | Proposed hold not executed (likely already held) | PROMPT | 975 | Verify-already-held |
| 1019 | MISMATCH / EXTRA_ACTION | Jumped to full $194 refund; Jamie offered choice first | PROMPT | 704-710, 707(d) | "doesn't work" → offer exchange-or-refund unless exchange declined |
| 1048 | IDENTICAL / EXTRA_ACTION | Re-proposed release already done | PROMPT | gap | Same as 901 |
| 1132 | IDENTICAL / EXTRA_ACTION | Re-proposed exchange already created | PROMPT | gap | Same as 901 |
| 1206 | SUBSTANTIVE / EXTRA_ACTION | Re-confirmed exchange already created | PROMPT | gap | Same as 901 |

## Prompt conflicts (line-cited)
1. **Half-size conflict (1005):** line 877 ("half sizes only between XXS and S") vs youth table 868-873 listing 11/13; even-only underwear fact absent.
2. **No verify-already-executed rule (C1, 6+ cases):** Nothing in 689-748 / action-tense block 1096-1099 tells the advisor to check tags/fulfillment before proposing. **Line 1097 FORCES a populated `operator_action_summary` whenever prose is past-tense — actively manufacturing phantom actions.** Highest-leverage.
3. **Refund-immediately vs offer-choice (1019):** 707(d) makes "doesn't work" an immediate-refund trigger; Jamie offers the choice first.
4. **needs_info vs ready on context-steered exchange (922):** 1099 (steer = needs_info) vs 694-699 (create when size explicit) conflict.
5. **Cancel doesn't gate on fulfillment (975):** 973-977 keys only on intent.
6. **No grounding guard for colors/packaging/URLs/partner geography (1100,1175,1188,1066):** "never from memory" exists for donation addresses (674,737) but not these fact types.

## Caveat to validate in Phase 3
C1's EXTRA_ACTION cases assume the action was *already executed in a prior round* (so re-proposing is a phantom). Alternative reading: Jamie simply *deferred* execution during the window and the proposal was fine. Validate on 1-2 cases (check ticket actions[] history / order tags) before over-investing — the regen will also reveal whether the phantom persists.
