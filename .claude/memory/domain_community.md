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

**Free Swimwear Program:** Families apply via a Google Form for a free RUBIES bikini bottom (trans/non-binary kids in need). Brought into rubies-automations 2026-06: applications sync into Supabase (`free_swimwear_requests`, the SSOT) with a deterministic eligibility gate at intake (Brazil/excluded-region or not-trans → silently rejected, still listed). The operator reviews the queue on the CS dashboard "Free Swimwear" tab (a one-line Opus summary per application aids scanning); one-click **approve** issues a unique `FIRSTNAME-<16>` code under the existing "Free RUBIES Program" Shopify price rule and emails the family the SendGrid acceptance template (30-day expiry). A daily lifecycle job reconciles accepted → registered (Shopify customer exists) → ordered, expires unredeemed codes at 30 days, and resends every 7 days up to 3 attempts. Replaces the legacy Google Apps Script + manual sheet workflow.

## Current Status

- **Production:** Registry is the SSOT. CS routing live. Donation page (rubyshines.com/pages/donate-your-pre-loved-rubies-clothing) reads the published JSON. Partner list is 14 active orgs (US/CA/CH/AU/DE/etc.).
- **Free swimwear:** live in Supabase + the dashboard "Free Swimwear" tab. Full history backfilled (1765 applications). The daily import + lifecycle reconcile run as two sub-pipelines of `daily-sync-all` (`Free Swimwear Apps` + `Free Swimwear Lifecycle`), no separate cron.

## Key Files

- `customer-service/lib/donationRouting.js` — Geographic routing + load balancing logic.
- `customer-service/donation-partners-schema.sql` — Partner registry schema.
- `customer-service/lib/tools/donationPartners.js` — MCP CRUD tools + publish + survey ingest.
- `customer-service/lib/donationPartnersPublish.js` — Publish helper: write JSON + auto-merge + auto-deploy via worktree.
- `customer-service/lib/donationPartnerSurvey.js` — Reads the Google Form's Form Responses 1 tab.
- `customer-service/lib/shopifyFileUpload.js` — Re-host URLs / local files on Shopify CDN.
- `customer-service/lib/geocoder.js` — Google Maps geocoding helper (lat/lng + country/region/city).
- `customer-service/lib/logoExtractor.js` — Haiku-based logo URL extraction from org websites.
- `customer-service/lib/freeSwimwear.js` — Free Swimwear core logic (issue code + acceptance email, resend, lifecycle decision).
- `customer-service/lib/freeSwimwearSurvey.js` — Google Form reader + deterministic eligibility gate.
- `customer-service/lib/tools/freeSwimwear.js` — Free Swimwear MCP tools (list/get/summary/approve/reject/resend).
- `customer-service/sync/freeSwimwearLifecycle.js` — daily register/order/expire/resend reconcile; `syncFreeSwimwearRequests.js` imports new applications.

## Key Decisions

- **Single source of truth in `donation_partners`:** Theme reads a published JSON asset, never edits partners through Shopify section blocks. Updates flow only from rubies-automations.
- **Geographic + load-balance hybrid routing:** Closest 3 candidates balanced by prior donation count.
- **Defect exclusion:** Only exchanges get donated, not defects.
- **Match survey submissions to existing partners by website domain:** Org names drift (e.g. "Rainbow Youth Center" vs "Four Corners Rainbow Youth Center"); domains stay stable. Name match is a fallback only.
- **Logos always re-hosted on Shopify CDN:** External hosts (Squarespace, Wix, org sites) move, expire, or hotlink-block. Re-hosting on save keeps the registry self-contained. Backfilled the 5 historical externals; 3 needed manual replacements because the source URLs were already broken.
- **Two-step preview/confirm flow for ingest:** `create_from_survey` defaults to preview (geocoded address + inline logo image + size/description) with no DB write. `confirmed: true` saves. Avoids burning Haiku/Shopify calls on previews that don't ship and lets the operator catch bad auto-extractions visually.
- **Auto-deploy on publish:** Publish opens + merges a PR to the theme repo's main, Shopify auto-pulls within ~30s. Worktree-based so any in-progress theme branch is untouched. `dry_run` and `merge: false` are escape hatches.
- **Free swimwear replicates the legacy Apps Script exactly, just better-wired:** codes are issued under the existing Shopify price rule `1577372680470` ("Free RUBIES Program", $56 off the `rubies-free-donation` collection) — never redefined — and the SendGrid dynamic templates (acceptance `d-397594792d9340da976c6eefbe94ab9e`, resend `d-14e6618cbe9d4a9ab092426b42545988`; legacy brazil-rejection `d-e0e919a0d8014243a9d9b9459efde470` retired) are reused verbatim. Cadence preserved: 30-day expiry, 7-day resend, max 3 attempts.
- **Free-swimwear eligibility is deterministic, not AI:** Brazil/excluded-region or not-trans/non-binary → silently rejected (no email is ever sent on rejection), still shown in the list for audit. AI is used only for a one-line scannable summary (Opus, same wrapper as ticket summaries). The accept/reject decision stays human.
- **Supabase is the free-swimwear SSOT; the sheet is intake-only:** sync is insert-if-absent on `(source, sheet_row)`, so the portal/lifecycle own a row's operational state once imported and re-sync never clobbers a decision.

## What's Next

- Donation impact reporting/dashboard
- Partner feedback loop (items received, condition)
- Expand international donation partner coverage (only US/CA/CH/AU/DE today; intl exchanges still fall back to "donate locally")
