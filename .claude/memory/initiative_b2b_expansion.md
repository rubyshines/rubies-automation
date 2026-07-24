---
name: B2B Expansion
description: Grow retailer partnerships and wholesale channel
type: project
domains: [b2b_sales]
last_updated: 2026-07-24
---

## Goal
Grow retailer partnerships and wholesale revenue.

## Phases
1. Prospect discovery (Tier 1 & 2) — complete (3,537-row backlog triaged 2026-06-11 → 41 qualified retailers, 144 community orgs)
2. Outreach engine — built 2026-06-11 (queue, cadence, advisors, send tool, dashboard panel; see domain_b2b_sales.md)
3. Active outreach — LIVE as of 2026-07 (warm-first)
4. Tier 3 custom searches — not started

## Current Status
**2026-07-24 (session 2): FIRST REAL SEND** — the Mermaids UK intro went out through the engine. Panel matured in one day: CS-aligned UX (sidebar company card + orders, editable draft, one-click send), fact-verify checklist with corrections, conversation history with Gmail thread discovery, deep links, frequency-aligned reorder cadence + advisor `next_touch_days` override, auto-responder guard, clickable-link HTML sends, `b2b_add_prospect` intake tool. Operating plan: opportunistic outreach first (stagger the UK sends; TGV + Uniting Pride replies pending), then B2B retailer outbound as the next phase.

Active again after a month dormant. 2026-07-23/24 re-entry: queue triaged against Gmail ground truth (16 threads → 2 real items), `b2b_send_enabled` flipped ON (go-live), first real drafts staged (Transgender Victoria reply, Uniting Pride org onboarding). Panel hardened so it stays trustworthy: manual Gmail replies auto-reconcile into the engine, conversation history visible in the panel, company order/program state synced daily from Shopify. Next: work the warm queue (partners + existing retailers), then UK org outreach (first objective: establish UK donation partners — none exist today; partner-referred org list pending from Jamie).

## Decisions Made
- 2026-06-10 — Warm-first migration order: partners → re-routed orgs → cold retailers. Cold sends only after the engine proves itself on friendlies.
- 2026-07-23 — Send flag ON. Operating model: pull-mode first (Tier-1 replies + operator-initiated outreach only; daily cadence sweep stays unscheduled), push-mode cadence earned later.
- 2026-07-24 — Gmail is a supported reply surface, not a violation: the engine reconciles manual sends instead of demanding panel-only discipline. Rule that remains: NEW conversations start in the panel.
