---
name: lgbtq-partnerships
description: "Expand LGBTQ+ org partnerships — donation closet programs, org purchases using inclusion funding"
metadata: 
  node_type: memory
  type: project
  domains: 
    - community
  last_updated: 2026-08-20
  originSessionId: 5759f460-bb54-4b38-a734-07510ab9ddf3
---

## Goal
Expand LGBTQ+ org partnerships. Get orgs to purchase using their inclusion/donation closet funding. Grow the existing donation program (rubyshines.com/pages/donate-your-pre-loved-rubies-clothing).

## Phases
1. Donation program — live and running (14 partners across US/CA/CH/AU/DE)
2. Expand partner network — ongoing, now driven by Google Form submissions ingested via MCP
3. Org purchasing via inclusion funding — early
4. Free swimwear program — migrated into rubies-automations (Supabase SSOT + dashboard tab), full history backfilled

## Current Status
Active programs running. As of 2026-05-28, rubies-automations is the SSOT for donation partners — Supabase `donation_partners` table feeds CS routing AND publishes a static JSON asset to the theme. New submissions flow through `donation_partner_create_from_survey` in the ad-hoc operator console (preview-confirm, auto-geocode, auto-extract logo, Shopify-CDN re-host, auto-merge + deploy). All 14 active partner logos are on cdn.shopify.com.

## UK Expansion (2026-07-24)
Started via the outreach engine's referred-prospect intake. First objective: establish the UK donation partner network (none exist; 30% purchase tier). Five active prospects: **Mermaids** (intro SENT 2026-07-24 — the engine's first real send; auto-reply received, human reply pending; referred by Arianna Bernucci, who has the personal history with them — NOT Jamie's story), TransActual + Not A Phase (Arianna), The Clare Project + Trans Pride Brighton (customer donation thread; TPB has a formal partner programme). AllSorts Youth Project: declined via a customer — marked lost, do not outreach. Drafts #15-#18 pending in the Outreach queue, to send staggered. Uniting Pride (Illinois) call-first onboarding draft #11 also pending.

## Partner Re-Engagement Round (2026-08-11)
First check-in sweep across all 18 active partners. Drafts written and grounded in real
history: `.claude/plans/org-checkin-2026-08.md`. Sends are manual, none gone out yet.
- Most partners had genuinely gone quiet: 12 of 18 last heard from us between Dec 2024 and Nov 2025, while donations kept flowing the whole time. Our three highest-volume partners (MassTPC 15 packages, BAGLY 13, Raleigh 13) were among them.
- Six are not check-ins but things WE owe: an unanswered asset request, an unanswered second program at a partner org, a promised meeting, a promised follow-up, an unfinished listing rename, an unacknowledged contact handoff. Consistent with the "the org failure mode is ours" read already in the advisor prompt.
- Contact churn confirmed as the standing risk: Oasis handed off in June, Carleton's is a student post that turns over yearly, Valid USA's contact left the state and the org is renaming to Reach Pluto.
- Engine can now draft these itself (donation facts + discount rate in advisor context). Next: send the 18, then decide whether the seasonal `community_checkin` cadence should run in push mode for partners.

## Size-Aware Routing (2026-08-20)
A partner reported that the donations we route them include sizes they cannot distribute.
Sizes an org accepts are now a routing constraint rather than a display field: partners are
filtered on size before proximity, and a mixed box only goes to an org that can take all of
it. See domain_community.md. The onboarding form's size question was recut into two
categories at the same time; the existing network was backfilled from the old answers, with
seven orgs landing on teen-and-adult only. Five of those seven were inferred rather than
asked, so their check-in is the moment to confirm it.

## Decisions Made
- 2026-08-20 — Partner size acceptance recut into two categories and enforced in routing. The old three-checkbox survey question had overlapping ranges and was never read by anything, so an org's stated limits had no effect on what we sent them.
- 2026-05-28 — Partner registry is the SSOT in rubies-automations. Theme reads a published JSON asset (`assets/donation-partners.json`); no more hand-edited section blocks. Updates flow only via MCP tools.
- 2026-05-28 — New submissions ingest via MCP with preview/confirm. Auto-geocode (Google Maps), auto-extract logo (Haiku from org website), re-host logo on Shopify CDN, then auto-merge to theme main on publish (Shopify auto-deploys ~30s).
- 2026-05-28 — Submissions match to existing partners by website domain (org names drift; domains stay stable).
- 2026-06-24 — Free swimwear program (free bikini bottom for trans/non-binary kids in need) moved off the legacy Google Apps Script + manual sheet into rubies-automations: Supabase `free_swimwear_requests` SSOT, deterministic eligibility (Brazil/non-trans silently rejected), one-line Opus summary, one-click approve (issues a code under the existing Shopify price rule + SendGrid acceptance email), daily lifecycle reconcile. 1765 applications backfilled. See domain_community.md.
- 2026-06-29 — Free swimwear repeat/duplicate handling shipped (PR #24): intake-time Opus recipient-match (fuzzy identity, fails conservative so siblings aren't merged) + pure rule — collapse same-day resubmits, close within-year repeats with a friendly reapply-after email, badge returning families and possible second children. See domain_community.md.
