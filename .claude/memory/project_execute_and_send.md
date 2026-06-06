---
name: Execute & Send (one-click background operator action + send)
description: A dashboard button that runs the operator action (auto-confirming phase 2 when nothing is flagged different) and sends the draft email, in the background, so Jamie can move on. Collapses the execute → confirm → send dance into one click. Precursor Phase 0 removes the manufactured refund-amount divergence.
type: project
domain: cs
done_when: |
  Phase 0 — advisor no longer states an exact dollar amount in customer-facing refund/cancellation prose, and operator_action_summary for refunds/cancellations lists items (not a precomputed amount); a refund scenario asserts both; test_cs_conversation spot-check passes;
  Phase 1 — Execute & Send button live on drafts with a pending action, for ALL two-phase action types, running in the background (ticket leaves the queue on click, multiple can run at once);
  the gate auto-confirms phase 2 only when the operator agent returns AUTO_CONFIRM: SAFE, and HOLDs (nothing executed, nothing sent, stops at phase 1) on a divergence note, a clarifying question, a business/infra error, or more than one previewed write;
  email is sent only after a confirmed action; phase 2 failure sends no email; send failure after a successful action surfaces a "retry send" state with the action already filed;
  every outcome fires a clickable toast (sent / hold / error / half-state); held & failed tickets reappear in their original tab (New / Follow-up) with a short reason badge;
  tests cover gate logic (SAFE vs HOLD vs error/question/multi-write) and orchestration ordering (no send on phase 2 failure);
  domain_cs.md Key Decisions updated with the Execute & Send flow + the refund-amount rule
originSessionId: orient-2026-05-26
---

## Goal

Collapse the three-step operator dance — (1) trigger the operator action / phase 1 preview, (2) confirm phase 2, (3) send the draft email — into a single **Execute & Send** button that runs in the background so Jamie can immediately move to the next ticket. Human-in-the-loop is preserved: Jamie still reviews the draft + proposed action and decides to click. The button only automates the mechanical sequence after he's decided to go.

This came out of a 2026-05-26 analysis of operator deviance. Key findings that shaped the design:
- The advisor's `confidence` field has **no** correlation with whether Jamie edits a draft (high/medium/low all ~31% verbatim) — so it cannot gate anything.
- ~62% of high-confidence drafts are sent byte-identical; ~17% are major rewrites. Edits are a mix of factual corrections (~20%), AI overcommit/premature recommendations (~30%), and acceptable Jamie-voice/BD additions + warmth trims (~50%).
- Because Jamie stays the gate (he clicks), we do NOT need a correctness predictor for this project. The button just needs to (a) not auto-confirm when the action diverges from what the draft promised, and (b) be safe on errors.

## Phase 0 — Remove the manufactured refund-amount divergence (ships first)

**Why first:** The single most common divergence is the advisor stating an exact refund dollar amount that differs from what `refund_order` actually computes (shipping/tax inclusion). In the sample: 18% of refund drafts state an amount in customer-facing prose (36% of those get edited/corrected by Jamie — e.g. draft "$32.00" vs actual "$28.00"), and `operator_action_summary` states a precomputed amount in 36% of refund drafts. Every one of these would force the Execute & Send gate to HOLD. Killing the guess removes the divergence at the source.

**The amount is computed by the tool anyway.** `refund_order` (customer-service/lib/tools/refundOrder.js) calculates the refund from the line items in phase 1 — the operator passes `items: [{sku, quantity}]`, NOT a dollar figure. The explicit `amount` parameter is only for custom refunds (DDP duties, goodwill) that don't map to line items.

**Edits (prompt-only, customer-service/lib/aiAdvisor.js):**
1. Cancellation confirmation template (~line 972): drop the `$Y` — "I've cancelled order #X and refunded you to your original payment method. You'll get a confirmation email with the details."
2. New positive rule in `### Refunds (additional rules)`: never state an exact dollar amount in customer-facing refund/cancellation prose; say "I've processed your refund to your original payment method. You'll get a confirmation email with the details."
3. New rule: `operator_action_summary` for a refund/cancellation names the order + items, never a precomputed amount; explicit amount only for custom refunds where `refund_order`'s `amount` param is used.

**Do NOT touch:** the invoice_kept_items rule (~line 1051-1052) — invoices set an exact total we control, and the prose total must match the invoice. That's a different flow with no divergence risk.

**Validation:** prompt change → scenario assertion (per technical rules, not a unit test). Add/extend a refund scenario asserting (a) the draft contains no `$` figure, (b) `operator_action_summary` lists items rather than a dollar amount. Spot-check a real refund conversation via `test_cs_conversation`.

## Phase 1 — Execute & Send button (background)

### Flow
On a draft with a pending proposed action, a new **Execute & Send** button:
1. Submits the prefill command (`structured_output.operator_action_summary` via `buildActionPrefill`) to the operator agent → **Phase 1** preview.
2. Reads the gate (below). **HOLD** → stop: nothing executed, nothing sent; ticket returns to its tab flagged. **SAFE** → continue.
3. **Phase 2**: re-call the same tool with `confirmed: true` + the carried-forward args (`draft_order_id` / `_refund_data` / etc.), execute the write, file into `actions[]`.
4. On phase 2 success → run the existing `apiSendDraft` logic (sends to Gorgias, marks draft sent, snooze default, uses edited text if Jamie changed it).

Runs **detached in the background**: the ticket leaves the current list immediately on click; Jamie moves on; multiple can run concurrently.

### The gate — "nothing flagged as different"
Auto-confirm phase 2 ONLY when the operator agent returns `AUTO_CONFIRM: SAFE`. HOLD on any of:
- Phase 1 did not reach a clean "awaiting confirmation" (agent asked a clarifying question, hit a business error like order-not-found / OOS / partial-fulfillment, or previewed no write).
- Phase 1 flagged a divergence (the existing "⚠️ Note:" — executed action ≠ what the draft email promises the customer).
- Phase 1 previewed more than one write tool (ambiguous / multi-step).

**Signal mechanism (AI-first, per CLAUDE.md):** the operator agent emits a structured verdict line at the end of its phase 1 response — `AUTO_CONFIRM: SAFE` or `AUTO_CONFIRM: HOLD — <short reason>`. Positive-form instruction in the operator system prompt: set HOLD whenever it would add a ⚠️ note, ask a question, or sees anything unexpected; SAFE only for a single clean awaiting-confirmation preview that matches the draft. The dashboard parses + **strips** this line from the operator-facing preview (same pattern as `splitThinkingFromDraft`), so manual action-chat flows look unchanged. The existing `awaiting confirmation` regex detection stays as the mechanical backstop (a missing/garbled verdict defaults to HOLD).

### Outcomes (each fires a clickable toast)
| Outcome | State | Toast | Ticket |
|---|---|---|---|
| Sent ✓ | action confirmed + email sent + snoozed | "Order #X — <action> done + sent" (green) | stays out of queue (now snoozed) |
| Hold ⚠️ | gate held — nothing executed/sent | "Order #X needs review — <reason>" (amber) | returns to New/Follow-up, flagged |
| Error ✕ | phase 2 write failed — no email | "Order #X — <action> failed: <error>" (red) | returns to tab, flagged |
| Half-state ✕ | action succeeded, send failed | "Order #X — <action> done, send failed, retry send" (red) | returns to tab, flagged; reopening shows action filed, just send |

Toast is **clickable** to jump back to that ticket.

### Ordering & failure
Action before send. Phase 2 failure → no email sent. Send failure after a successful action → half-state: action is filed in `actions[]`, draft NOT marked sent; reopening shows the action complete so Jamie just sends (never double-executes, never shows "sent" when it wasn't).

### Reload robustness — simple v1
Detached `fetch` from the browser; no server-side job queue. The server work completes correctly regardless of the client (sent tickets leave the queue, held/failed ones were never marked sent so they stay). If Jamie reloads/closes mid-run he just won't see the toast — the queue is still correct on next load. (Upgrade path if needed later: persist a job-status row + show missed outcomes on load.)

### Reason badge
Held/failed tickets reappear flagged. Store the outcome on the draft's `action_result` (e.g. `action_result.execute_send = { status: 'hold'|'error'|'half', reason, at }`) — already read by the panel; the queue endpoint surfaces it as a short badge ("needs review: amount differs", "send failed"). Cleared when Jamie opens/handles the ticket or successfully sends.

### Touchpoints
- customer-service/lib/operatorAgent.js — emit + (server) strip the `AUTO_CONFIRM` verdict on phase 1 previews (prompt + parse on the returned result).
- customer-service/dashboard/server.js — new `apiExecuteAndSend(draftId, body)` orchestrator + `POST /api/drafts/:id/execute-and-send` route; reuses `operatorAgent`, the awaiting-confirmation detection, `apiSendDraft`. Surface `execute_send` outcome on the queue/draft payloads.
- customer-service/dashboard/public/app.js — the button (only on drafts with a pending action), detached fetch + optimistic queue removal, toast (4 outcomes, clickable), reason badge rendering on the queue rows.
- customer-service/test/ — gate logic tests (SAFE vs HOLD vs error/question/multi-write) and orchestration ordering (no send on phase 2 failure; half-state on send failure).

## On completion
- domain_cs.md Key Decisions: add the Execute & Send flow (background one-click, AUTO_CONFIRM gate, HOLD-returns-to-queue) + the refund-amount rule (no customer-facing or operator-instruction dollar amount; tool computes it).
- initiative_cs_automation.md Current Status: progress bullet (one-click background execution reducing per-ticket operator time; human still the gate).
- Delete this project file; remove from MEMORY.md Active Projects.
