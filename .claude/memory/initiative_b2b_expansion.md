---
name: B2B Expansion
description: Grow retailer partnerships and wholesale channel
type: project
domains: [b2b_sales]
last_updated: 2026-08-13
---

## Goal
Grow retailer partnerships and wholesale revenue.

## Phases
1. Prospect discovery (Tier 1 & 2) — complete (3,537-row backlog triaged 2026-06-11 → 41 qualified retailers, 144 community orgs)
2. Outreach engine — built 2026-06-11 (queue, cadence, advisors, send tool, dashboard panel; see domain_b2b_sales.md)
3. Active outreach — LIVE as of 2026-07 (warm-first)
4. Tier 3 custom searches — not started

## Current Status
**2026-08-13: the per-company summary is back.** The recap + next step the old Google Sheet carried had been missing from the panel since the migration — not removed, orphaned: the summariser still runs daily but writes a store the engine doesn't read, reaching 11 of 242 companies. Rebuilt company-level on `b2b_messages`, updating incrementally as messages land, and the Outreach detail pane restructured around it so relationship state is answered before the composer instead of buried under it. Next: watch the summaries against real threads for a few weeks before deciding whether the suggested next step should drive the queue.

**2026-08-13: four partners were waiting and the queue could not see them.** Fixing the shared-Gmail-thread constraint (see domain Key Decision) repointed 105 mis-parented messages onto 27 new thread rows. Four orgs immediately surfaced as Tier 1 "waiting on us" — Transponder (replied **332 days** ago with an impact update and got nothing back), SoCirC (70d), Oasis Youth Center (64d), She Bop (51d). Their replies had been filed under another org's relationship, so the cadence read them as silent. Queue is 28 rows. These four are the most overdue work in the system and should be answered before any new outreach.

**2026-08-05: THE QUEUE HAS WORK IN IT.** The panel was empty because the queue returned zero rows — Tier 4 was wired but no cadence branch ever produced a first touch, so the entire discovery backlog was invisible by construction. Fixed, along with two other causes: seven cadence branches gated on context that was never assembled, and $0 sample-kit orders were counted as purchases (15 retailers read as customers). Queue now 38 rows. Import data repaired across ~370 row-updates. Lane 1 (25 donation-form orgs) admitted through the new `vetted_at` gate; the ~120 CenterLink rows stay out until enrichment. Still pull-mode — nothing auto-sends. Next: work the Tier-4 org intros and the 5 pending follow-ups, then the 41-retailer vetting pass (needs the panel UI, not yet built).

**2026-07-24 (session 2): FIRST REAL SEND** — the Mermaids UK intro went out through the engine. Panel matured in one day: CS-aligned UX (sidebar company card + orders, editable draft, one-click send), fact-verify checklist with corrections, conversation history with Gmail thread discovery, deep links, frequency-aligned reorder cadence + advisor `next_touch_days` override, auto-responder guard, clickable-link HTML sends, `b2b_add_prospect` intake tool. Operating plan: opportunistic outreach first (stagger the UK sends; TGV + Uniting Pride replies pending), then B2B retailer outbound as the next phase.

Active again after a month dormant. 2026-07-23/24 re-entry: queue triaged against Gmail ground truth (16 threads → 2 real items), `b2b_send_enabled` flipped ON (go-live), first real drafts staged (Transgender Victoria reply, Uniting Pride org onboarding). Panel hardened so it stays trustworthy: manual Gmail replies auto-reconcile into the engine, conversation history visible in the panel, company order/program state synced daily from Shopify. Next: work the warm queue (partners + existing retailers), then UK org outreach (first objective: establish UK donation partners — none exist today; partner-referred org list pending from Jamie).

## Decisions Made
- 2026-06-10 — Warm-first migration order: partners → re-routed orgs → cold retailers. Cold sends only after the engine proves itself on friendlies.
- 2026-07-23 — Send flag ON. Operating model: pull-mode first (Tier-1 replies + operator-initiated outreach only; daily cadence sweep stays unscheduled), push-mode cadence earned later.
- 2026-08-05 — Prospect supply is admitted by cohort, not switched on. Tier-4 first touch requires `vetted_at`, so ~200 imported rows of wildly uneven quality can't arrive in the panel at once. Vetting is a triage decision (keep/drop/snooze, no draft), applied only where the machine genuinely can't decide.
- 2026-07-24 — Gmail is a supported reply surface, not a violation: the engine reconciles manual sends instead of demanding panel-only discipline. Rule that remains: NEW conversations start in the panel.
