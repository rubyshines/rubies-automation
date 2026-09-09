---
name: Community & Partnerships
description: LGBTQ+ org partnerships, donation routing, free swimwear program
type: project
originSessionId: 76845f16-8454-4953-8882-a8bc486354fb
---
## What's Built

**Donation Partner Registry (SSOT):** `donation_partners` in Supabase is the single source for both CS routing and the public donation map. Rows carry the mailing address block, a Shopify-CDN logo, website, size-acceptance flags, geocoded location, full and short descriptions, pause state, and a lifetime routed counter. The website reads a static JSON asset published from this table; CS routing reads the same rows at runtime.

**Geographic Donation Routing:** Google Maps geocoding of the customer address, then proximity-tiered, load-balanced selection among active partners in the customer's country (see Key Decisions). Single-item returns default to a local-donation suggestion; no partner in country suggests local and asks for a referral. Donation text prefers the partner row's mailing address.

**Donation Logging:** `donation_routings` records customer, order, partner assigned, item count, and routing type. Feeds load balancing and impact reporting.

**CS Advisor integration:** On a confirmed exchange the advisor calls `get_donation_partner` and composes the customer message with org address, short description, and washing reminder, framed as "gender-affirming programs", not charity or waste.

**MCP CRUD + Survey Ingest:** Partners are managed via MCP tools (list/create/update/delete/publish/mark_out) plus `list_submissions` and `create_from_survey`, which reads the partner survey's Google Form responses, geocodes the address, extracts a logo from the org website (Haiku), generates the short description (Opus), and previews before saving.

**Logo re-hosting:** Create and update re-host any non-Shopify logo URL through the Shopify Files API so the registry never depends on a third-party host.

**Publish pipeline:** `donation_partner_publish` writes the JSON asset into the theme repo and opens + squash-merges a PR from an isolated git worktree, so Shopify's GitHub integration auto-deploys and any in-progress theme branch is untouched. `dry_run` and `merge: false` are escape hatches.

**Free Swimwear Program:** Families apply via a Google Form for a free bikini bottom. Applications sync into Supabase (`free_swimwear_requests`, the SSOT) through a deterministic eligibility gate. The operator reviews the queue on the CS dashboard "Free Swimwear" tab (one-line Opus summary per application); one-click approve issues a unique code under the existing "Free RUBIES Program" Shopify price rule and sends the SendGrid acceptance template. A daily lifecycle job reconciles accepted, registered, and ordered states, expires unredeemed codes, and resends on a fixed cadence. Replaces the legacy Google Apps Script + manual sheet workflow.

## Current Status

- **Production:** Registry is the SSOT. CS routing live. Donation page (rubyshines.com/pages/donate-your-pre-loved-rubies-clothing) reads the published JSON. Partners exist in US/CA/CH/AU/DE.
- **Free swimwear:** live in Supabase + the dashboard tab. Daily import + lifecycle reconcile run as two `daily-sync-all` sub-pipelines. Repeat/duplicate handling runs at intake; the queue surfaces returning / possible-2nd-child / repeat badges and filters. Sheet write-back bridge still on.

## Key Files

- `customer-service/lib/donationRouting.js` — geographic routing + load balancing.
- `customer-service/donation-partners-schema.sql` — partner registry schema.
- `customer-service/lib/tools/donationPartners.js` — partner MCP tools, publish, survey ingest.
- `customer-service/lib/donationPartnersPublish.js` — publish helper (JSON + PR + auto-deploy).
- `customer-service/lib/freeSwimwear.js` — free swimwear core (issue code, email, resend, lifecycle decision).
- `customer-service/lib/freeSwimwearSurvey.js` — form reader + eligibility gate.
- `customer-service/lib/tools/freeSwimwear.js` — free swimwear MCP tools.
- `customer-service/sync/freeSwimwearLifecycle.js` — daily lifecycle reconcile (`syncFreeSwimwearRequests.js` alongside imports applications).

## Key Decisions

- **Org onboarding is call-first, on Google Meet:** every new org inquiry gets a video call to walk through RUBIES and assess fit before anything else; only afterwards do we send the partner survey link, and submissions flow through `create_from_survey`. Partners may also buy gender-affirming clothing directly at the same country discount tiers as wholesale: 50% where shipments avoid tariffs (US; AU while packages stay under the de minimis), 30% elsewhere.
- **Single source of truth in `donation_partners`:** the theme reads a published JSON asset and never edits partners through Shopify section blocks. Updates flow only from rubies-automations.
- **Proximity-tiered routing, load-balanced inside whichever tier fires:** local (same metro) first, then same state/province only when the nearest partner is already in it, then the closest few nationally. The in-state gate is load-bearing: an ungated "same state wins" would ship a return past a closer out-of-state partner. Deliberately trades some national spread for shorter shipping and items staying in the customer's own community.
- **Load is a trailing-window rate of items, weighted-random, not a lifetime count:** deterministic least-loaded-by-lifetime let a newly added partner monopolize its region until it caught up, and counting routings rather than items undercounted big shipments. A partner younger than the window has its volume projected to a full-window equivalent so it is compared fairly. Outside the local tier, candidates are also weighted by distance so the farthest option is not the likeliest pick just because it is quietest. The lifetime `donations_routed` counter is for impact reporting only.
- **Single-item returns default to donate-locally,** with two partner-routing overrides: the customer accepts the partner-info offer, or the CS advisor requests a donation proof ask on a refund-pattern-flagged refund.
- **CS emails use a short partner description; the website keeps the full one:** the short one is AI-generated at ingest from the org's survey text and operator-previewed. Editing the full description never silently regenerates the short one, since operator-tuned text must not be overwritten.
- **Partner size acceptance is two categories, split where the two size scales physically meet:** kids 4-11, and kids 12-16 plus adult XXS-4X. The old free-text size range came from overlapping survey checkboxes that said nothing actionable and nothing read it. Garments are categorized by their own label's scale, not by measurement. Routing filters partners on this before the proximity tiers so an ineligible org cannot hold a local slot, and a mixed box requires a partner taking both categories. Display text is derived from the flags, never stored.
- **Anything parsed out of a Google Form matches on the data, not the option wording.** Form text is operator-editable and drifts; key on the part that carries meaning and pin the current option strings in a test so an edit fails loudly at build rather than silently at ingest.
- **Pausing donations and pausing outreach are different axes, on different tables.** `donation_partners` pause stops the boxes; `b2b_companies` outreach pause stops the email. Orgs routinely want one and not the other (stop receiving returns, keep buying). Both pauses are indefinite with a mandatory reason. Whoever asks to be paused, ask which axis they mean.
- **Defect exclusion:** only exchanges get donated, not defects.
- **Match survey submissions to existing partners by website domain:** org names drift, domains stay stable. Name match is a fallback only.
- **Logos always re-hosted on Shopify CDN:** external hosts move, expire, or hotlink-block. Re-hosting on save keeps the registry self-contained.
- **Two-step preview/confirm flow for ingest:** `create_from_survey` defaults to a no-write preview so the operator can catch bad auto-extractions visually and no Haiku/Shopify calls are spent on previews that don't ship.
- **Free swimwear replicates the legacy Apps Script exactly, just better-wired:** codes issue under the existing "Free RUBIES Program" Shopify price rule (never redefined) and the existing SendGrid dynamic templates are reused verbatim, with the original expiry and resend cadence preserved.
- **Free-swimwear eligibility is deterministic, not AI:** excluded-region or not-trans/non-binary applications are silently rejected (no email ever sent on rejection) but remain listed for audit. AI is used only for the one-line scannable summary. The accept/reject decision stays human.
- **Supabase is the free-swimwear SSOT; the sheet is intake-only:** sync is insert-if-absent so the portal and lifecycle own a row's operational state once imported and re-sync never clobbers a decision.
- **Application identity is `(email, submitted_at)`, never sheet position:** the responses tab gets re-sorted, so row position is unstable. The form timestamp is a naive wall-clock string and must be parsed in a fixed timezone and compared by instant, or hosts in different timezones disagree on identity.
- **Sheet write-back is a temporary bridge** (`done_when` Jamie trusts the dashboard): approve/reject/resend and lifecycle changes mirror back to the sheet by a live `(email, submitted_at)` lookup and are fail-soft (skip, never guess, on zero or many matches). Acceptance/resend emails send from care@rubyshines.com so replies route there.
- **Repeat/duplicate handling is an intake-time AI + pure-rule split:** a new eligible submission whose email has prior applications gets an Opus recipient-match (names may be the parent's and ages drift, so identity is fuzzy; it fails conservative so two real siblings are never merged), then a pure rule routes by the gap since the recipient's last application: same-day resubmit collapses silently as a duplicate; within a year closes as a repeat with a friendly reapply-after email (not silent, unlike the ineligible path); over a year is a new application badged returning; a different recipient on the same email is new with a possible-2nd-child flag. The window counts from the last application regardless of outcome.

## What's Next

- Donation impact reporting/dashboard
- Partner feedback loop (items received, condition)
- Expand international donation partner coverage (intl exchanges outside covered countries still fall back to "donate locally")
