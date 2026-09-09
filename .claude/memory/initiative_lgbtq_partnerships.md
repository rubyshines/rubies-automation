---
name: LGBTQ+ Partnerships
description: Expand LGBTQ+ org partnerships — donation closet programs, org purchases using inclusion funding
type: initiative
domains: [community]
last_updated: 2026-09-09
originSessionId: 5759f460-bb54-4b38-a734-07510ab9ddf3
---

## Goal
Expand LGBTQ+ org partnerships. Get orgs to purchase using their inclusion/donation closet funding. Grow the existing donation program (rubyshines.com/pages/donate-your-pre-loved-rubies-clothing).

## Phases
1. Donation program — live and running (partners across US/CA/CH/AU/DE)
2. Expand partner network — ongoing: Google Form submissions ingested via MCP, plus outreach-engine cold intros and referred prospects
3. Org purchasing via inclusion funding — early
4. Free swimwear program — migrated into rubies-automations (Supabase SSOT + dashboard tab), full history backfilled

## Current Status
Active programs running. rubies-automations is the SSOT for donation partners: Supabase `donation_partners` feeds CS routing AND publishes the JSON asset the theme reads. New submissions flow through `donation_partner_create_from_survey` (preview-confirm, auto-geocode, auto-extract logo, CDN re-host, auto-merge + deploy). Org outreach runs through the B2B outreach engine (see initiative_b2b_expansion.md for engine progress).

- **UK expansion (started 2026-07-24):** first objective is a UK donation partner network (none exist; 30% purchase tier). Prospects came through referrals and a customer donation thread; the first engine send was a UK org intro. One org declined via a customer and is marked lost.
- **Cold intro round 1 (2026-09-02):** the org cold intro is a locked template (founder story, program offer with donations + discount bullets, call CTA) with two fixed subject lines A/B tested by alternation, locked line by line with Jamie. Measurement: reply within 14 days by subject variant, bounces excluded, cumulative across rounds. Drafting policy (auto-draft initiating, Jamie writes replies, Sonnet + edit-rate tripwire) is a domain_b2b_sales.md Key Decision.
- **Partner re-engagement round (2026-08-11):** first check-in sweep across all active partners, drafts grounded in real history (`.claude/plans/org-checkin-2026-08.md`). Most partners had genuinely gone quiet for a year while donations kept flowing; several items were things WE owed (unanswered requests, promised follow-ups). Contact churn confirmed as the standing org risk. Check-ins are now one October sitting on the cadence.
- **Size-aware routing (2026-08-20):** sizes an org accepts are a routing constraint, not a display field; the onboarding form's size question was recut into two categories and the network backfilled (a few inferred rather than asked; confirm at check-in).
- **Routing weighting fix (2026-08-24):** load compares rates rather than totals and distance weights the national tiers, so a new corridor partner settles at its natural share rather than taking every box. Open: nobody has asked partners what volume they can absorb (parked).

## Decisions Made
- 2026-09-02 — Corporate ERGs are not a segment to pursue; treat an inbound ERG as an org with the ERG noted.
- 2026-08-24 — Load balancing compares rates rather than totals, and distance weights the tiers that can span it.
- 2026-08-20 — Partner size acceptance recut into two categories and enforced in routing; the old survey question had overlapping ranges and was never read by anything.
- 2026-05-28 — Partner registry is the SSOT in rubies-automations. Theme reads a published JSON asset; updates flow only via MCP tools. Submissions match existing partners by website domain (names drift, domains stay stable). New submissions ingest with preview/confirm, auto-geocode, logo extraction and CDN re-host, then auto-merge to the theme.
- 2026-06-24 — Free swimwear program moved off the legacy Apps Script + sheet into rubies-automations: Supabase SSOT, deterministic eligibility, one-line Opus summary, one-click approve, daily lifecycle reconcile. See domain_community.md.
- 2026-06-29 — Free swimwear repeat/duplicate handling: intake-time recipient match (fails conservative) + a pure rule for same-day resubmits, within-year repeats, and returning families.
