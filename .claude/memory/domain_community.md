---
name: Community & Partnerships
description: LGBTQ+ org partnerships, donation routing, free swimwear program
type: project
originSessionId: 76845f16-8454-4953-8882-a8bc486354fb
---
## What's Built

**Donation Partner Registry (SSOT):** `donation_partners` in Supabase is the single source for both CS routing AND the public donation map. Each row carries `mailing_address` (multi-line "RUBIES Returns / c/o ORG" block), `logo_url` (always on cdn.shopify.com), `website_url`, `size_range`, `latitude`, `longitude`, `country_code`, `description` (org's full text, website), `description_short` (1-2 sentences, CS emails), `active`, `donations_routed`. The website reads a static JSON asset published from this table; CS routing reads the same rows at runtime.

**Geographic Donation Routing:** Google Maps geocoding of customer address → haversine distance to all active partners in customer's country → selects 3 closest → weighted-random pick, inverse to item volume routed over the trailing 90 days (from the `donation_routings` log). Fallback: single-item returns suggest local donation. No partners in country → suggest local + ask for referral. `formatDonationText` prefers `mailing_address` from the partner row, with legacy reconstruction as fallback.

**Donation Logging:** Tracks customer email, order number, partner assigned, item count, routing type (partner/local_single/local_no_partner). Enables impact reporting.

**Integration with CS Advisor:** When exchange confirmed, advisor calls `get_donation_partner` tool and composes customer message with org address, description, washing reminder. Framed as "gender-affirming programs" — not charity/waste.

**MCP CRUD + Survey Ingest:** Operator manages partners via MCP tools on the ad-hoc operator console — no more direct SQL. Tools cover list/create/update/delete/publish, plus `list_submissions` (orgs from the Form Responses 1 tab tagged in/out/blank) and `create_from_survey` (preview/confirm flow). `create_from_survey` auto-geocodes the bare submitted address via Google Maps, auto-extracts a logo from the org website via Haiku, and previews the inline rendering before save. `mark_out` records "reviewed, don't ingest" decisions as stub inactive rows.

**Logos always on Shopify CDN:** Both create and update re-host any non-Shopify logo URL through the Shopify Files API (`fileCreate originalSource` for URLs; staged uploads for local files). The registry never depends on a third-party host that could move, expire, or 404.

**Publish pipeline:** `donation_partner_publish` writes `rubies-ecom-v4/assets/donation-partners.json`, then opens + squash-merges a PR via `gh` from an isolated git worktree (so any in-progress theme branch is untouched), so Shopify GitHub integration auto-deploys within ~30s. Surfaces the live page URL on success. Escape hatches: `dry_run: true` (working tree only) and `merge: false` (push branch, leave PR open).

**Free Swimwear Program:** Families apply via a Google Form for a free RUBIES bikini bottom (trans/non-binary kids in need). Brought into rubies-automations 2026-06: applications sync into Supabase (`free_swimwear_requests`, the SSOT) with a deterministic eligibility gate at intake (Brazil/excluded-region or not-trans → silently rejected, still listed). The operator reviews the queue on the CS dashboard "Free Swimwear" tab (a one-line Opus summary per application aids scanning); one-click **approve** issues a unique `FIRSTNAME-<16>` code under the existing "Free RUBIES Program" Shopify price rule and emails the family the SendGrid acceptance template (30-day expiry). A daily lifecycle job reconciles accepted → registered (Shopify customer exists) → ordered, expires unredeemed codes at 30 days, and resends every 7 days up to 3 attempts. Replaces the legacy Google Apps Script + manual sheet workflow.

## Current Status

- **Production:** Registry is the SSOT. CS routing live. Donation page (rubyshines.com/pages/donate-your-pre-loved-rubies-clothing) reads the published JSON. Partner list is 18 active orgs (US/CA/CH/AU/DE).
- **Free swimwear:** live in Supabase + the dashboard "Free Swimwear" tab (~1,436 applications after de-duplication). Daily import + lifecycle reconcile run as two `daily-sync-all` sub-pipelines (`Free Swimwear Apps` + `Free Swimwear Lifecycle`). End-to-end verified 2026-06: form → sync → approve → code + acceptance email + sheet row updated. Repeat/duplicate handling runs at intake (see Key Decisions); the queue surfaces returning / possible-2nd-child / repeat badges and filters.

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
- `customer-service/lib/freeSwimwearRepeats.js` — intake repeat-check: Opus recipient-match + pure repeat/duplicate decision.
- `customer-service/lib/tools/freeSwimwear.js` — Free Swimwear MCP tools (list/get/summary/approve/reject/resend).
- `customer-service/sync/freeSwimwearLifecycle.js` — daily register/order/expire/resend reconcile; `syncFreeSwimwearRequests.js` imports new applications.
- `customer-service/lib/freeSwimwearSheet.js` — temporary sheet write-back bridge (live row lookup by email+timestamp).

## Key Decisions

- **Org onboarding is Zoom-first:** every new org inquiry gets a Zoom call to walk through RUBIES and assess fit before anything else; only after the call do we send the partner survey link, and submissions then flow through `create_from_survey`. Partners are also offered direct purchase of gender-affirming clothing at the same country discount tiers as wholesale: 50% where shipments avoid tariffs (US; AU as long as packages stay under the 1000 AUD de minimis), 30% elsewhere (e.g. the Canadian and Swiss partners; UK confirmed 30% as well).
- **Single source of truth in `donation_partners`:** Theme reads a published JSON asset, never edits partners through Shopify section blocks. Updates flow only from rubies-automations.
- **Geographic + load-balance hybrid routing:** Closest 3 candidates, weighted-random by trailing-90-day item volume (from `donation_routings`, not the lifetime counter). Replaced deterministic least-loaded-by-lifetime-count 2026-07: a newly added partner entered at count 0 and monopolized its region until it caught up (Montgomery blacked out Raleigh for two weeks), and counting routings instead of items undercounted big shipments. Weighted random keeps every nearby partner active; the lifetime `donations_routed` counter remains for impact reporting only. Single-item returns default to donate-locally, with two partner-routing overrides: the customer accepts the partner-info offer, or the CS advisor sets include_proof_ask on a refund-pattern-flagged refund (appends the locked donation proof ask; no ask on the no-partner local fallback).
- **CS emails use a short partner description; the website keeps the full one:** `description_short` is AI-generated at ingest (Opus, operator-previewed in the create/survey confirm flow) from the org's verbatim survey text; routing falls back to the full `description` when it's null. Editing the full description never silently regenerates the short one (operator-tuned text must not be overwritten) — regenerate via `scripts/backfillDonationShortDescriptions.js` or pass `description_short` explicitly.
- **Defect exclusion:** Only exchanges get donated, not defects.
- **Match survey submissions to existing partners by website domain:** Org names drift (e.g. "Rainbow Youth Center" vs "Four Corners Rainbow Youth Center"); domains stay stable. Name match is a fallback only.
- **Logos always re-hosted on Shopify CDN:** External hosts (Squarespace, Wix, org sites) move, expire, or hotlink-block. Re-hosting on save keeps the registry self-contained. Backfilled the 5 historical externals; 3 needed manual replacements because the source URLs were already broken.
- **Two-step preview/confirm flow for ingest:** `create_from_survey` defaults to preview (geocoded address + inline logo image + size/description) with no DB write. `confirmed: true` saves. Avoids burning Haiku/Shopify calls on previews that don't ship and lets the operator catch bad auto-extractions visually.
- **Auto-deploy on publish:** Publish opens + merges a PR to the theme repo's main, Shopify auto-pulls within ~30s. Worktree-based so any in-progress theme branch is untouched. `dry_run` and `merge: false` are escape hatches.
- **Free swimwear replicates the legacy Apps Script exactly, just better-wired:** codes are issued under the existing Shopify price rule `1577372680470` ("Free RUBIES Program", $56 off the `rubies-free-donation` collection) — never redefined — and the SendGrid dynamic templates (acceptance `d-397594792d9340da976c6eefbe94ab9e`, resend `d-14e6618cbe9d4a9ab092426b42545988`; legacy brazil-rejection `d-e0e919a0d8014243a9d9b9459efde470` retired) are reused verbatim. Cadence preserved: 30-day expiry, 7-day resend, max 3 attempts.
- **Free-swimwear eligibility is deterministic, not AI:** Brazil/excluded-region or not-trans/non-binary → silently rejected (no email is ever sent on rejection), still shown in the list for audit. AI is used only for a one-line scannable summary (Opus, same wrapper as ticket summaries). The accept/reject decision stays human.
- **Supabase is the free-swimwear SSOT; the sheet is intake-only:** sync is insert-if-absent so the portal/lifecycle own a row's operational state once imported and re-sync never clobbers a decision.
- **Application identity is `(email, submitted_at)` — NEVER sheet position.** The Form Responses tab gets re-sorted, so `sheet_row` is unstable; keying on it duplicated every applicant when the sheet reordered. Critically, the Timestamp column is a naive wall-clock string with no offset, so it MUST be parsed in a fixed timezone (`America/Toronto`, via `parseTimestamp` in `freeSwimwearSurvey.js`) — `new Date(str)` uses the host TZ, which made a Mac (Eastern) and Railway (UTC) disagree and the daily-sync cron re-imported the whole sheet as 1,400+ duplicates. Compare timestamps by instant, not string (`+00:00` vs `…000Z` are the same moment).
- **Sheet write-back is a temporary bridge** (`freeSwimwearSheet.js`, env `FSW_SHEET_WRITEBACK`, default on; `done_when` Jamie trusts the dashboard): every approve/reject/resend + lifecycle change mirrors the operational columns (F:O) back to Form Responses 1. It locates the row by a LIVE `(email, submitted_at)` lookup (rows re-sort, so the stored position is never trusted) and is fail-soft (skips, never guesses, on 0/many matches). Acceptance/resend emails send from **care@rubyshines.com** (domain-authenticated; replies route there), and `last_acceptance_send_date` is stamped only on a real SendGrid 2xx so a failed send is visible, not silent.
- **Repeat/duplicate handling is an intake-time AI + pure-rule split:** a new eligible submission whose email already has prior applications gets an Opus recipient-match (the form's name field is sometimes the parent and ages drift, so recipient identity is fuzzy → AI decides same-vs-different; it fails conservative so two real siblings are never merged), then a pure rule (`freeSwimwearRepeats.js`) routes by the gap to the recipient's last application: same-day resubmit → silent `duplicate` collapse; within a year → closed `repeat` + a friendly reapply-after email (plain email from care@, NOT silent — distinct from the silent ineligible `rejected` path); over a year → active `new` badged returning; different recipient same email → active `new` + possible-2nd-child flag. The window counts from the last application regardless of outcome. Side effects (reapply email, collapsing a prior row) run AFTER the insert keyed by row id, so a retry never double-fires; backfill skips the check.

## What's Next

- Donation impact reporting/dashboard
- Partner feedback loop (items received, condition)
- Expand international donation partner coverage (only US/CA/CH/AU/DE today; intl exchanges still fall back to "donate locally")
