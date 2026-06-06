---
name: lgbtq-partnerships
description: "Expand LGBTQ+ org partnerships — donation closet programs, org purchases using inclusion funding"
metadata: 
  node_type: memory
  type: project
  domains: 
    - community
  last_updated: 2026-05-28
  originSessionId: 5759f460-bb54-4b38-a734-07510ab9ddf3
---

## Goal
Expand LGBTQ+ org partnerships. Get orgs to purchase using their inclusion/donation closet funding. Grow the existing donation program (rubyshines.com/pages/donate-your-pre-loved-rubies-clothing).

## Phases
1. Donation program — live and running (14 partners across US/CA/CH/AU/DE)
2. Expand partner network — ongoing, now driven by Google Form submissions ingested via MCP
3. Org purchasing via inclusion funding — early

## Current Status
Active programs running. As of 2026-05-28, rubies-automations is the SSOT for donation partners — Supabase `donation_partners` table feeds CS routing AND publishes a static JSON asset to the theme. New submissions flow through `donation_partner_create_from_survey` in the ad-hoc operator console (preview-confirm, auto-geocode, auto-extract logo, Shopify-CDN re-host, auto-merge + deploy). All 14 active partner logos are on cdn.shopify.com.

## Decisions Made
- 2026-05-28 — Partner registry is the SSOT in rubies-automations. Theme reads a published JSON asset (`assets/donation-partners.json`); no more hand-edited section blocks. Updates flow only via MCP tools.
- 2026-05-28 — New submissions ingest via MCP with preview/confirm. Auto-geocode (Google Maps), auto-extract logo (Haiku from org website), re-host logo on Shopify CDN, then auto-merge to theme main on publish (Shopify auto-deploys ~30s).
- 2026-05-28 — Submissions match to existing partners by website domain (org names drift; domains stay stable).
