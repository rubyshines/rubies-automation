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

**Virtual Closet (2026-09-18, low fidelity, live):** `virtual-closet/` is its own Express service (Railway `virtual-closet`, local port 3850). Each LGBTQ+ centre gets a public page at `/<slug>` with three doors (shop with 20% off, request a free pair, sponsor), a private view for its team (accounts, invites, Home with the current box and requests, settings, send the box, history), and a self-service sign-up that also enrols Pass It On (the donation programme's partner-facing name). Money is store sales: sponsorship and add-to-the-box are a hidden Shopify product reached by cart permalink with the centre as order attributes; the 20% is a Shopify discount with a fresh code per click; the ledger is written by the order webhook and a daily reconcile. The operator side is the `/closets` page of the CS dashboard plus `vc_*` MCP tools. Emails are composed in code and sent through SendGrid.

## Current Status

- **Production:** Registry is the SSOT. CS routing live. Donation page (rubyshines.com/pages/donate-your-pre-loved-rubies-clothing) reads the published JSON. Partners exist in US/CA/CH/AU/DE.
- **Virtual Closet:** built and smoke-tested against real data; Railway service created, first pilot centre not yet signed up. Public URL is the Railway domain until a subdomain is pointed at it.
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
- `virtual-closet/server.js` — the Virtual Closet web service (routes in `virtual-closet/routes/`, templates in `virtual-closet/views/`).
- `virtual-closet/lib/operator.js` — everything the CS dashboard's `/closets` page and the `vc_*` tools do.
- `virtual-closet/lib/ledger.js` — box ledger fed from store orders (webhook hook in `webhooks/handlers/shopifyOrders.js`, daily reconcile).
- `virtual-closet/schema.sql` — the `vc_*` tables.

## Key Decisions

- **Onboarding is self-service, with the operator's approval after sign-up (2026-09-18, replaces call-first):** a centre signs up on the Virtual Closet programme page, ticks Pass It On and/or the Virtual Closet, and its admin verifies their email; the operator approves from the dashboard queue before the page and map listing go live, and a Pass It On tick creates the donation partner row through the existing registry tool. A call is offered, never required. The survey-ingest path (`create_from_survey`) stays for partners who came in before this.
- **The donation programme is called Pass It On on every partner-facing surface** so it cannot be confused with the Virtual Closet; the registry and CS routing are unchanged underneath.
- **Virtual Closet money never touches the service:** sponsorships and a centre's own add-to-the-box are ordinary store sales of a hidden product, attributed by order attributes from a cart permalink, and the 20% shopper discount is a Shopify discount with a code per click. Shopify handles cards, tax and receipts; the ledger only reads orders, idempotently.
- **Centre accounts are the service's own tables, not Supabase Auth:** email and password with verification and reset by single-use tokens, sessions as rows so removing a member signs them out everywhere. Chosen so the pilot needed no external configuration; Google and Microsoft sign-in can be added on top.
- **Requesters become store customers on confirmation** (the name they go by, tagged with the programme and centre); the newsletter is an explicit opt-in on the request form. Partners may also buy gender-affirming clothing directly at the same country discount tiers as wholesale: 50% where shipments avoid tariffs (US; AU while packages stay under the de minimis), 30% elsewhere.
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

- Virtual Closet hi-fi pass in the rubyshines.com design system, then the Uniting Pride pilot
- Donation impact reporting/dashboard
- Partner feedback loop (items received, condition)
- Expand international donation partner coverage (intl exchanges outside covered countries still fall back to "donate locally")
