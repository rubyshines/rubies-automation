---
name: Community & Partnerships
description: LGBTQ+ org partnerships, donation routing, free swimwear program
type: project
originSessionId: 76845f16-8454-4953-8882-a8bc486354fb
---
## What's Built

**Donation Partner Registry (SSOT):** `donation_partners` in Supabase is the single source for both CS routing AND the public donation map. Each row carries `mailing_address` (multi-line "RUBIES Returns / c/o ORG" block), `logo_url` (always on cdn.shopify.com), `website_url`, `size_range`, `latitude`, `longitude`, `country_code`, `description`, `active`, `donations_routed`. The website reads a static JSON asset published from this table; CS routing reads the same rows at runtime.

**Geographic Donation Routing:** Google Maps geocoding of customer address → haversine distance to all active partners in customer's country → selects 3 closest → load-balances by fewest prior donations. Fallback: single-item returns suggest local donation. No partners in country → suggest local + ask for referral. `formatDonationText` prefers `mailing_address` from the partner row, with legacy reconstruction as fallback.

**Donation Logging:** Tracks customer email, order number, partner assigned, item count, routing type (partner/local_single/local_no_partner). Enables impact reporting.

**Integration with CS Advisor:** When exchange confirmed, advisor calls `get_donation_partner` tool and composes customer message with org address, description, washing reminder. Framed as "gender-affirming programs" — not charity/waste.

**MCP CRUD + Survey Ingest:** Operator manages partners via MCP tools on the ad-hoc operator console — no more direct SQL. Tools cover list/create/update/delete/publish, plus `list_submissions` (orgs from the Form Responses 1 tab tagged in/out/blank) and `create_from_survey` (preview/confirm flow). `create_from_survey` auto-geocodes the bare submitted address via Google Maps, auto-extracts a logo from the org website via Haiku, and previews the inline rendering before save. `mark_out` records "reviewed, don't ingest" decisions as stub inactive rows.

**Logos always on Shopify CDN:** Both create and update re-host any non-Shopify logo URL through the Shopify Files API (`fileCreate originalSource` for URLs; staged uploads for local files). The registry never depends on a third-party host that could move, expire, or 404.

**Publish pipeline:** `donation_partner_publish` writes `rubies-ecom-v4/assets/donation-partners.json`, then opens + squash-merges a PR via `gh` from an isolated git worktree (so any in-progress theme branch is untouched), so Shopify GitHub integration auto-deploys within ~30s. Surfaces the live page URL on success. Escape hatches: `dry_run: true` (working tree only) and `merge: false` (push branch, leave PR open).

**Free Swimwear Program:** Referenced on website but no explicit automation integration visible in codebase.

## Current Status

- **Production:** Registry is the SSOT. CS routing live. Donation page (rubyshines.com/pages/donate-your-pre-loved-rubies-clothing) reads the published JSON. Partner list is 14 active orgs (US/CA/CH/AU/DE/etc.).

## Key Files

- `customer-service/lib/donationRouting.js` — Geographic routing + load balancing logic.
- `customer-service/donation-partners-schema.sql` — Partner registry schema.
- `customer-service/lib/tools/donationPartners.js` — MCP CRUD tools + publish + survey ingest.
- `customer-service/lib/donationPartnersPublish.js` — Publish helper: write JSON + auto-merge + auto-deploy via worktree.
- `customer-service/lib/donationPartnerSurvey.js` — Reads the Google Form's Form Responses 1 tab.
- `customer-service/lib/shopifyFileUpload.js` — Re-host URLs / local files on Shopify CDN.
- `customer-service/lib/geocoder.js` — Google Maps geocoding helper (lat/lng + country/region/city).
- `customer-service/lib/logoExtractor.js` — Haiku-based logo URL extraction from org websites.

## Key Decisions

- **Single source of truth in `donation_partners`:** Theme reads a published JSON asset, never edits partners through Shopify section blocks. Updates flow only from rubies-automations.
- **Geographic + load-balance hybrid routing:** Closest 3 candidates balanced by prior donation count.
- **Defect exclusion:** Only exchanges get donated, not defects.
- **Match survey submissions to existing partners by website domain:** Org names drift (e.g. "Rainbow Youth Center" vs "Four Corners Rainbow Youth Center"); domains stay stable. Name match is a fallback only.
- **Logos always re-hosted on Shopify CDN:** External hosts (Squarespace, Wix, org sites) move, expire, or hotlink-block. Re-hosting on save keeps the registry self-contained. Backfilled the 5 historical externals; 3 needed manual replacements because the source URLs were already broken.
- **Two-step preview/confirm flow for ingest:** `create_from_survey` defaults to preview (geocoded address + inline logo image + size/description) with no DB write. `confirmed: true` saves. Avoids burning Haiku/Shopify calls on previews that don't ship and lets the operator catch bad auto-extractions visually.
- **Auto-deploy on publish:** Publish opens + merges a PR to the theme repo's main, Shopify auto-pulls within ~30s. Worktree-based so any in-progress theme branch is untouched. `dry_run` and `merge: false` are escape hatches.

## What's Next

- Donation impact reporting/dashboard
- Partner feedback loop (items received, condition)
- Automate free swimwear program
- Expand international donation partner coverage (only US/CA/CH/AU/DE today; intl exchanges still fall back to "donate locally")
