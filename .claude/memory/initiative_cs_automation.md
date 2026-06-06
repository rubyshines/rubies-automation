---
name: CS Automation
description: AI advisor reducing Jamie's CS time, currently human-in-the-loop, moving toward autonomy
type: project
domains: [cs]
last_updated: 2026-06-02
originSessionId: 5fa69c00-27d5-40ef-9c88-8f188fbf3c12
---
## Goal
Reduce Jamie's ~1hr/day CS time using AI advisor.

## Phases
- AI advisor built and handling all ticket types — complete
- Human-in-the-loop via dashboard (Jamie reviews/approves drafts) — active
- Increasing autonomy as quality improves — future

## Current Status
Active. AI drafts responses, Jamie reviews and approves via ops dashboard. ~$0.39/draft, ~$0.60/ticket. 95% action accuracy on 198 held-out conversations. SSE streaming deployed (perceived latency ~1-2s). Efficiency project running — prompt caching deployed but minimal impact at current volume.

- 2026-06-02: Dashboard — On Me tab (`pending_operator` status) for tickets where Jamie owes a response; auto-follow-up suppressed, customer reply returns ticket to open. Send & On Me button. Pre-order auto-drafter tightened: timing gate (next business day 5pm PT) + per-order Warehance `ready_to_ship` check eliminated false-positive drafts. Order alert "Waiting on Response" now surfaces post-shipment operator notes (Passport tracking, pending decisions). Bulk-resolved 31 stale fulfillment-phase notes. Passport mishandled shipment outreach sent to 5 customers.
- 2026-05-27: Accuracy push (branch `cs-accuracy`, not yet deployed). Used the ~2.5-week China window (stable prompt) as a clean draft↔sent baseline. Built the operator-action eval that never existed (we only graded prose before). Headline: the advisor is materially MORE accurate than raw numbers showed — most "errors" were measurement artifacts (incomplete `actions[]` logging; live-regen order-state drift; donation-routing variance; voice variance). Killed a proposed fix that would have broken correct behavior. Shipped grounded fixes validated by scenario tests: fixed a dead `delivery_estimate` tool reference, added a `shipping_info` tool over shipping_zones, a fact-precedence rule (DB hard facts > KB/memory), plus packaging/program-link/colors/Tall/partner-geography grounding. Established a change-driven accuracy-sweep cadence (see domain_cs.md). **Merged to main + deployed 2026-05-27.** Deferred: refund-vs-choice nuance + auto-hold (#877).
- 2026-05-26: Shipped one-click background "Execute & Send" (run operator action + auto-confirm phase 2 when nothing diverges + send draft, in the background). Human stays the gate. Cuts the per-action operator dance toward the ~111s/ticket-avg time-reduction goal. Also removed the most common operator divergence (advisor-stated refund amounts). Deviance analysis this session: advisor `confidence` field has no correlation with whether Jamie edits a draft, so it can't gate autonomy; ~62% of high-confidence drafts go out byte-identical; the dangerous edits are factual corrections (~20%), pointing future autonomy work at a correctness verifier rather than a confidence threshold.

## Decisions Made
- Agentic loops, not decision trees
- Human-in-the-loop for foreseeable future until quality proven
