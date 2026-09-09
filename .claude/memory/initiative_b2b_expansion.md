---
name: B2B Expansion
description: Grow retailer partnerships and wholesale channel
type: project
domains: [b2b_sales]
last_updated: 2026-09-09
---

## Goal
Grow retailer partnerships and wholesale revenue.

## Phases
1. Prospect discovery (Tier 1 & 2) — complete (discovery backlog triaged June 2026 into qualified retailers and community orgs)
2. Outreach engine — built June 2026 (queue, cadence, advisors, send tool, dashboard panel; see domain_b2b_sales.md)
3. Active outreach — LIVE since July 2026 (warm-first); follow-ups auto-send since late August; retailer channel round 1 sent 2026-09-09
4. Tier 3 custom searches — not started

## Current Status
Outreach runs on the engine end to end: nightly initiating drafts for operator review, an automatic follow-up ladder, calendar-driven meeting rows, and Gmail kept in sync both ways. Progress since go-live, newest first:

- **2026-09-09 — The retailer channel is live, round 1 sent.** The worked-but-never-converted retailer book had been invisible to the engine (unvetted, pre-engine history). Both retailer emails locked line by line with Jamie; a sample kit overrides the six-month fresh-intro rule; the unpaused retailers were vetted in one sitting and 30 sent (sampled re-approaches and cold intros), a handful handled by hand, the dead ends dropped. Kickbox went live first. Found underneath: a customer email change had silently dropped later orders from the mirror (fixed on both sync paths plus a cascade migration; see domain_tech.md). Drop/Restore joined the panel.
- **2026-09-09 — Calendar is the record of every call.** Partner-booked calls, reschedules and RSVPs land in `b2b_meetings` from Google Calendar; no-shows are an operator outcome with a fixed reschedule template.
- **2026-09-02 — Cold intro round 1 for orgs on a locked template** with A/B subject lines; initiating drafts machine-written, replies operator-written (see initiative_lgbtq_partnerships.md).
- **2026-08-28 — Org list is workable by area.** Enrichment reads each org's own site, so region, reachability and whether they run a clothing closet are real. Ready prospects exist in many states and provinces with no partner. `prospect` state is derived nightly. Three re-approaches are owed donations, not leads; the re-approach framing explains the gap rather than apologising. Partner check-ins consolidated into one October sitting.
- **2026-08-26 — Follow-up ladder live in push mode** (follow-ups only): chase after 5 business days (10 for a check-in), once more 10 business days later, then retire a lead or hand a live partner to Jamie. Guards: fresh-reply re-check, address health, daily cap. The manual-Gmail-send cohort is excluded (parked).
- **2026-08-20 — Bounces are queue work.** A hard bounce returns as Tier-1 work carrying the approved draft. Contact churn confirmed as the org failure mode. Bulk address verification (Kickbox) built and run 2026-09-09; verification now runs at intake.
- **2026-08-19 — Nightly Gmail thread discovery** for every company, so the advisor reasons from real history instead of an empty record.
- **2026-08-13 — Per-company relationship summary** rebuilt on `b2b_messages`; the shared-Gmail-thread fix surfaced overdue partner replies that had been filed under other orgs.
- **2026-08-05 — The queue has work in it.** Tier-4 first touch exists; supply is admitted cohort by cohort behind `vetted_at`.
- **2026-07-24 — First real engine send** (a UK org intro). Send flag ON since 07-23.

Next: the retailer ladder chases from mid-September and the org A/B round reads on 22 Sep; lock the round-2 cold-intro rewording; the qualified discovery retailers need an importer and a vetting screen before round 2; the affiliate decision (two stores have asked) is still open; the manual-send cohort (parked). Plan: `.claude/plans/b2b-retailer-outreach.md`.

## Decisions Made
- 2026-08-26 — Follow-ups auto-send with no click and no shadow period, guarded on targeting rather than prose. The review a human would do is not what makes a chase safe; a reply that landed since, a dead address and an oversized batch are. Scheduling into their business hours leaves a review window anyway.
- 2026-08-26 — Prospects retire (a reversible cadence-set pause, never `lost`); active partners are handed to Jamie's On Me list with a note. An org we ship boxes to going quiet must be visible now, not next season.
- 2026-08-05 — Prospect supply is admitted by cohort, not switched on. Tier-4 first touch requires `vetted_at`, so imported rows of uneven quality can't arrive in the panel at once. Vetting is a triage decision (keep/drop/snooze, no draft), applied only where the machine genuinely can't decide.
- 2026-07-24 — Gmail is a supported reply surface, not a violation: the engine reconciles manual sends instead of demanding panel-only discipline. Rule that remains: NEW conversations start in the panel.
- 2026-07-23 — Send flag ON. Operating model was pull-mode first (Tier-1 replies + operator-initiated outreach only); push-mode was earned for follow-ups on 2026-08-26 and for nightly initiating drafts on 2026-09-02. Everything reply-shaped still waits for an operator.
- 2026-06-10 — Warm-first migration order: partners → re-routed orgs → cold retailers. Cold sends only after the engine proves itself on friendlies.
