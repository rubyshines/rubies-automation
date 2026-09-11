---
name: Parked Items
description: Single capture+discussion journal for everything deferred — bugs, ideas, half-formed plans, decisions-needed. Filter by domain, type, or priority.
type: parked
originSessionId: 76845f16-8454-4953-8882-a8bc486354fb
---
# Parked Items

Minimum entry is title + Parked date + Domains. Everything else is optional. See CLAUDE.md Memory Protocol for the lifecycle (captured → discussed → planned → executing → validated).

## Commitments in the daily sync digest
- Parked: 2026-09-11
- Domains: b2b_sales, tech
- Type: build (small)
- Notes: The digest's On Me section should become the commitments list — what Jamie owes (overdue first) and a waiting-on-them fold — so the day starts with it without opening the dashboard. Jamie: not yet, but eventually. Data is `b2b-outreach/lib/commitments.js` `listCommitments`.

## CS tickets as a commitment source
- Parked: 2026-09-11
- Domains: cs, b2b_sales
- Type: idea
- Notes: The commitments table is not B2B-specific in shape (company optional). CS keeps its own On Me and follow-up logic for now; fold tickets in only if Jamie finds himself wanting one list. Seed of the supervisor's first question ("what does Jamie owe, what is he waiting on").

## Chase aged waiting-on-them commitments, and a quiet "gave up" close
- Parked: 2026-09-11
- Domains: b2b_sales, community
- Type: idea
- Notes: A their-item open for N days is an honest cadence condition (surface the company with an operator-written nudge, not an AI one); decide after watching the To do fold for a few weeks. Related: a third close for theirs besides done/delete — "gave up" — so the recap and the October check-in know they never came through (Blue Mountain's agreement may simply never be signed).

## Commitment extraction refinements
- Parked: 2026-09-11
- Domains: b2b_sales, tech
- Type: idea
- Notes: (1) Due dates from meeting Next Steps — the parse is deterministic and carries none; a narrow Sonnet pass over the parsed lines could attach them ("for the Oct 18 event"). (2) Pass the advisor's `open_commitments` on a just-sent draft to the summariser as a hint if extraction turns out to miss our own promises. (3) Post-call template pre-fill from the call summary was rejected on purpose (Sonnet text into a partner email; Jamie writes those) — revisit only with a human-in-the-loop design.

## Address-hold resolver should seed a care@ confirmation outreach when its rules fail
- Parked: 2026-09-09
- Last touched: 2026-09-09
- Domains: logistics, cs
- Type: build (medium)
- Priority: high
- Notes: Every PO Box fails all three resolver rules (no prior order to the address, not ROOFTOP-geocodable, no Street View), so the order sits in Urgent until a human asks the customer, and a personal-Gmail ask is outside every queue (replies were archived as legacy threads and sat unread for a week). Build: when the resolver cannot release, seed an address-confirmation outreach the way the unnotified pre-order drafter does — pending care@ draft via `seedOutboundDraft()`, Gorgias ticket, waiting note on the order, idempotent through an `author='auto'` note. The reply then lands as a ticket where the advisor already has `release_address_hold`.
- Resume when: the next PO Box hold shows in Urgent, or the next CS dashboard session.

## The stored balance-sheet snapshots are all wrong and need re-running
- Parked: 2026-08-27
- Domains: finance
- Type: bug
- Priority: medium
- Notes: `getBalanceSheet` used to send `end_date` without `start_date`, and QBO silently ignores the as-of date unless both are present, so every stored `BalanceSheet` snapshot from the 2022 backfill onward holds balances as of whenever the sync ran, not its labelled `period_end`. The call is fixed (`BALANCE_SHEET_EPOCH` in `finance/lib/qbo.js`) so new snapshots are correct; the ~354 existing rows were never rewritten. Point-in-time queries against live QBO are correct today and are the workaround.
- Resume when: someone needs balance-sheet history (trend analysis, equity or loan-balance time series, `runway_projection` / `financial_health` over anything but the present).
- Fix shape: re-run the BalanceSheet leg of `finance/sync/backfillHistory.js` over the full period range. Transactions and P&L snapshots are unaffected.

## `product_costs` holds one cost snapshot, so historical margin is un-computable
- Parked: 2026-08-27
- Domains: finance, inventory
- Type: gap
- Priority: medium
- Notes: Essentially all rows carry one effective date (2026-03), so the time-of-order COGS lookup prices every historical order at current cost. Any pre-2026 margin figure is an approximation, and it skews in a known direction: current rows carry the tariff-era 23% duty rate, so applying them to 2024–25 overstates COGS for those years. Surfaced while restating 2025 profitability, where it forced a wide band instead of a number.
- Resume when: a margin or valuation question needs defensible historical figures. Worth doing before any sale process (a buyer's quality-of-earnings review restates COGS).
- Fix shape: backfill `product_costs` with dated rows from supplier invoices per cost change; the lookup already picks the latest `effective_date <= order.created_at`. This is Tier 2 of the COGS roadmap (capture actual supplier invoices → per-batch rows with real freight/duties allocation). Tier 3 (per-batch inventory tracking, FIFO/weighted-average per outbound order) stays deferred until unit-level margin optimization matters. Today's Tier 1 is a manual Google Sheet → `syncCosts.js` → `product_costs`.

## In-year capital-flow tracking straight from the bank feeds
- Parked: 2026-08-27
- Domains: finance, tech
- Type: idea
- Priority: medium
- Notes: Because the books are written up annually (see `domain_finance.md` Key Decisions), a mid-year flush is invisible in our tooling until the year-end write-up, so capital planning runs on figures up to twelve months stale. The transactions exist in the bank feeds (Wise, TD) the whole time; only the categorization is annual. Idea: read transfers to the known related-party destinations (the trust, JATA, shareholder) directly from the bank feed so the flush ledger is current year-round. Cheaper alternative: ask AZ Accounting for a quarterly catch-up, which may make this unnecessary.
- Resume when: the annual-cadence question is settled and AZ will not catch up more often.

## Size the 2025 dual-3PL overlap properly
- Parked: 2026-08-27
- Domains: finance, logistics
- Type: gap
- Priority: low
- Notes: 2025 carried a one-time event: tariff-driven inventory movement from Canada to the US, with Think Logistics running alongside Nitrologistics for several months. The abnormal fulfillment spend is estimated at roughly $41K from payment data alone; the true duplicate cost cannot be separated without per-provider shipment volume, which is in Warehance and not in QBO.
- Resume when: a normalized-earnings figure needs to be defensible rather than indicative (valuation, sale process, lender). Pull per-provider shipment counts for Mar–Sep 2025 from Warehance.

## The manual-send threads nobody answered — re-approach, retire, or leave
- Parked: 2026-08-26
- Last touched: 2026-09-08
- Domains: b2b_sales, community
- Type: decision-needed
- Priority: medium
- Notes: Deliberately left out of the automatic follow-up ladder, which only chases engine sends under 90 days old. ~51 companies have an unanswered last outbound that was a manual Gmail send, reconciled in with `message_type` null, so nothing records what was asked. The largest block is a ~32-retailer batch from early 2026, all silent, all `in_contact` with `vetted_at` null and no `next_action_date`, which makes them invisible to the queue entirely (vetting one is enough to queue it as a `re_approach`). Beyond that, org threads running back to 2022.
- Per Jamie: case by case, not a campaign. Routes: a `re_approach` round, bulk retire via `b2b_triage` action `pause` with `source:'cadence'`, or leave them. The retailer batch also has the open vetting-UI decision underneath it (see *B2B lead supply — remaining plan phases*).
- Resume when: Jamie wants to work the retailer channel again, or the automatic ladder has run long enough to trust with a wider anchor. Widening `CHASEABLE_SOURCES` in `cadence.js` is NOT the fix; the manual sends need classifying first.

## Gmail historical backfill has never run — pre-March-2026 B2B history is unsynced
- Parked: 2026-08-24
- Domains: b2b_sales, tech
- Type: bug
- Priority: medium
- Notes: `gmail_sync_state.backfill_pass` is 0 (re-verified 2026-09-09), so `email_messages` only holds mail from roughly 2026-03 onward. Every established retailer relationship predates that window, so first-touch → first-order timing is unobservable and no un-referred cold intro exists in the synced data. Opener reply-rate and conversion baselines cannot be computed from our own history until this runs.
- Resume when: someone wants B2B outreach baselines, message-type A/B evaluation, or conversion timing grounded in real history. Running the backfill is cheaper than any workaround.

## Ask Warehance to expose per-line-item allocation in the API
- Parked: 2026-08-25
- Domains: logistics, cs, tech
- Owner: Jamie (reaching out to the Warehance team)
- Notes: The UI shows which items on an order are allocated; the API does not (verified against the full OpenAPI spec: only per-SKU `allocated` totals and the order-level `has_unallocated_products` boolean). The ask: an allocated/backordered quantity on `order_items`.
- Resume when: they confirm. If it ships, `reports/lib/orderAllocation.js` gets deleted and its three callers (pre-order drafter, `get_order_allocation`, `fulfillmentChecker`) read the field instead.

## Ask donation partners what volume they can absorb
- Parked: 2026-08-24
- Domains: community
- Type: decision-needed
- Priority: medium
- Notes: Routing balances load between partners but has no idea what any of them can handle; a student centre and a regional coalition are weighed identically. Size acceptance became a routing constraint after a partner complaint; capacity is the same shape of problem with no equivalent yet. Two halves: (1) check in with the newest corridor partner about volume as part of the partner re-engagement round; (2) a capacity field on `donation_partners` (items/month or small/medium/large) fed by the onboarding survey and read by the weighting, plus a way for a partner to say "pause us."
- Resume when: the partner check-in sweep goes out, or a partner asks us to slow down.

## Storefront kids/adults review filter
- Parked: 2026-08-19
- Domains: marketing, tech
- Type: idea
- Priority: medium
- Notes: Every review carries an internal `audience` tag (kids / adults / both / unclear) in `judgeme_reviews`, feeding `find_review_quotes`, campaign copy, and the Reviews tab filter, but nothing a shopper sees. The ask is for the site's adults/kids toggle to also filter reviews, since most SKUs sell in both youth and adult sizes. Blocker is Judge.me: their API has no tag or custom-field endpoint, so their widget cannot filter on our tag. Doing it means a public read endpoint plus a custom reviews component in the theme repo replacing the Judge.me widget (pagination, star summaries, photos). Check first whether the audience mix on the highest-traffic PDPs is lopsided enough to be worth the swap.
- Cheaper half-step: use the tag to pick which reviews get *featured* (Judge.me has a featured flag we already sync).

## `parse_wholesale_input` mangles a real retailer PO and fails silently
- Parked: 2026-08-17
- Domains: b2b_sales
- Type: bug
- Priority: high
- Notes: Fed a genuine Lightspeed-generated purchase order (CSV with a header row, one line per SKU), the tool reported `format: "simple_text"`, matched the header row to a gift card, reset every quantity to 1, and resolved plus sizes to YOUTH numeric sizes (a 2X bra came back as a size-6 kids bra) with `errors: []`. The standing rule is "never manually parse CSV, always pass raw to `parse_wholesale_input`", so this sits in the path of every wholesale order and the failure survives a skim. Workaround used: resolve each exact SKU against the catalog.
- Resume when: next wholesale order arrives as a CSV/PO. Fix wants the CSV detector to recognise a per-line (not matrix) PO layout, a header-row skip, and size resolution that never silently crosses the adult/youth boundary.

## A bounced reply auto-closes the ticket and the customer silently disappears
- Parked: 2026-08-12
- Domains: cs
- Type: decision
- Priority: medium
- Notes: When an agent message fails to deliver, the daily reconciler closes the ticket both sides so it never reaches the follow-up queue. No retry, no operator surface; the digest bounce line is the whole safety net. Worst case is a first-contact prospect with no order and no account. Open question is what SHOULD happen: leave it open as On Me, stage a correction attempt, or accept the loss.
- Measured base rate is under 1% and not a sender-reputation problem. The signal is channel: chat offline-capture addresses (hand-typed, unvalidated) bounce at roughly three times the rate of email, so a syntax/MX check at capture time is where a fix would pay.
- Diagnostic note: Gorgias bounce wording is not equally informative. "doesn't appear to exist" is a real nonexistent-mailbox signal; "mailbox isn't accepting messages right now" is what Microsoft consumer domains return for both nonexistent and blocked users, so read `is_retriable` and the sent-to-failed gap instead (a synchronous rejection in seconds is permanent). A second bounce on the same ticket is usually our own ESP suppression list firing.

## Advisor drafts a form submission as if it were an email
- Parked: 2026-08-06
- Domains: b2b_sales, community
- Type: idea
- Priority: low
- Notes: Form-contact companies get a normal email draft (greeting plus full signature block), which reads oddly pasted into a form with separate name and email fields. Left alone until a real one has been sent; it may want a shorter form-shaped variant. The advisor is not told the delivery channel today; `queueEntry` would be the place to pass it.

## Nothing stops duplicate company rows re-appearing on the next import
- Parked: 2026-08-11
- Last touched: 2026-08-11
- Domains: b2b_sales, community
- Type: idea
- Priority: medium
- Notes: The 2026-08-11 merge cleared the backlog, but `addProspect` and the sheet importers do not check for an existing row on the same domain before inserting. Add that check at intake (one query) instead of merging after the fact. The merge tool is `scripts/_mergeDuplicateCompanies.js` (gitignored one-off; promote it if this recurs). It merges only WITHIN a `relationship_type`, since a retailer and an org can legitimately share a domain.

## Dormancy is never derived, so `reactivation` cannot fire; `relationship_state` needs a backfill
- Parked: 2026-08-05
- Domains: b2b_sales
- Type: bug
- Priority: medium
- Notes: `reactivation` gates on `relationship_state === 'dormant'`, but nothing writes that value: `syncB2bCompanyState` promotes and never demotes, and the "derived at queue time" dormancy the design assumed was never built, so the branch has been unreachable since it was written (kept, with a comment, because the revival behaviour is wanted). Fix: derive dormancy in the queue from `last_order_date` vs the company's reorder threshold rather than storing a state that goes stale. Related cleanup: `in_contact` is carried by ~180 companies of which most are untouched imports; the directory derives its stage filter instead of trusting the column, which leaves the data wrong for anything else that reads it. Fix is a backfill pass (imported-and-never-contacted → a real prospect state).

## B2B lead supply — remaining plan phases (vetting UI, enrichment, send rate)
- Parked: 2026-08-05
- Domains: b2b_sales, community, tech
- Type: idea (planned)
- Priority: high
- Notes: The original plan file was retired 2026-09-09; this entry is the spec. Phases 0, 1 and 3 shipped 2026-08-05. Remaining: (2) **vetting UI** — the panel needs keep/drop/snooze controls so the ~41 sheet retailers can be triaged; `b2b_triage` and `vetted_at` exist, only the UI is missing, and until it lands those retailers stay invisible because first touch requires `vetted_at`. (4) **CenterLink enrichment** — largely done by `b2b-discovery/enrichOrgs.js` (2026-08-28); what remains is running survivors through as vetted prospects. (5) **send rate + sender reputation** — the daily cap and pre-send address verification shipped (autoFollowUp cap, Kickbox verification at intake); the open decision is whether cold B2B keeps riding rubyshines.com alongside Klaviyo customer mail or moves to a separate sending domain.

## Outreach browse surfaces show the first page only
- Parked: 2026-07-29
- Domains: b2b_sales, community
- Type: idea
- Notes: The Companies directory caps at 50 rows and the Activity feed at 60; `fetchActivity` already returns a `next_before` cursor that nothing consumes, and the directory has no cursor at all. Both say what they dropped rather than truncating silently, so this only bites once volume grows past a screen or two.

## Advisor drops the exchange action when the customer confirms ("yes please")
- Parked: 2026-07-29
- Last touched: 2026-07-29
- Domains: cs
- Type: bug
- Priority: high
- Notes: On Opus 4.8 in production, ~40–60% of runs. Repro: `node customer-service/test/scenarios/noMirroring.js`, turn 2 ("Great, yes please go ahead with that!"). On failure the draft is the donation-info block alone with `action_type: null`, so nothing is staged for the operator. One prompt fix (making donation info explicitly subordinate to the action) was tried and reverted with no benefit.
- Methodology warning: this scenario's variance is wide, so n=8 cannot distinguish a moderate effect from noise. Budget n≥20 per arm, or find a cheaper single-call repro first. Run `node --check` after any prompt edit and assert on exit code, not the absence of "✗": a syntax error inside the template literal silently reads as a pass.

## Advisor can't reliably name the Sky adult colourways
- Parked: 2026-07-29
- Domains: cs
- Type: bug
- Notes: `knowledgeFacts` scenario fails on Opus 4.8: asked which colours the Sky one-piece comes in for adults, the draft does not name both Black and Pink (verified correct against `product_variants`). A grounding/tool-use gap, not stale test data. Check whether it is failing to call the catalog tool at all.

## Split commitmentCalibration into three scenario files
- Parked: 2026-07-29
- Domains: cs
- Type: refactor
- Notes: It makes three sequential advisor calls plus Gorgias fetches in one file, so it runs ~3× a normal scenario and blows a 240s timeout under concurrency (looks like a hang, isn't). Split into one file per case, extract the shared `ticketToInput` helper (also used by `exchangeMoney`), and reconsider whether replaying live Gorgias tickets belongs in a pinned suite given order-state drift.

## Revisit the advisor model when Opus 4.8 retires or a new model ships
- Parked: 2026-07-29
- Domains: cs, tech
- Type: decision (closed, revisit on trigger)
- Notes: Opus 5 was evaluated 2026-07-29 and rejected: no configuration satisfied all three founder criteria (same-or-better accuracy, latency, cost). Thinking off lost accuracy; thinking on cost more. The headline cost/latency numbers were confounded by a thinking-default difference, so do not quote them; accuracy failed in both configurations. Sonnet 5 (plain and with thinking) was separately found not viable for the advisor and the operator agent. The Anthropic advisor-tool pattern (Sonnet loop calling Opus for guidance) was considered and not tested; savings would be modest at current volume.
- Resume when: a retirement date is announced for Opus 4.8, or a new model ships. Run `node scripts/modelSwapEval.js --candidate <model> --repeat 3` (~$30–50, ~40 min) and decide on the numbers. Opus-5-specific defect to re-test: on refund tickets it produced plausible prose with `action_type: null`, staging no refund (reproducible on `donationToolCall` and `refundNoAmount`); suspected cause is the "one move per message" rule being followed more literally.

## Forgot-discount-code tool: refund the discount equivalent
- Parked: 2026-07-17
- Last touched: 2026-07-29
- Domains: cs
- Type: idea
- Notes: Customers forget to apply a code and ask after the fact; we refund the equivalent but eat the processing fee. The burn-the-code and why-was-it-invalid halves shipped as `revoke_discount_code`. Remaining scope: refunding the discount equivalent on the order in the same step (today a separate `refund_order` call with a hand-computed amount).

## CS advocacy Phase B — /help share page + P.S. link + effectiveness tracking + provider capture
- Parked: 2026-07-06
- Last touched: 2026-07-06
- Type: idea (planned)
- Domains: cs, marketing, community
- Notes: Phase A shipped 2026-07-06 (standardized signature + link-less advocacy P.S., once-ever dedup via `advocacy_asks_sent`). Phase B: (1) build the rubyshines.com/help share page (tell another parent, tell your therapist/clinic, connect an LGBTQ+ org, share on social); (2) append "Here are some ways you can help: [link]" to the P.S. (`ADVOCACY_PS` in signatures.js); (3) effectiveness tracking via an owned tracked-redirect route + `advocacy_events` table surfaced in the daily digest; (4) provider capture form → `provider_leads` → fold into the B2B outreach system as a "providers" channel. Once-ever dedup means Phase-A recipients won't get the link version later (accepted). Next concrete step: draft the /help page content for Natta. The original plan file no longer exists; this entry is the spec.

## Per-shipment reconcile tab + multi-shipment hardening
- Parked: 2026-07-03
- Last touched: 2026-08-05
- Domains: logistics, inventory
- Type: idea (planned)
- Notes: The transfer-number half is done: `receive_shipment` allocates `<code>`, `<code>-2`, … per consignment, takes carrier + tracking, and accepts explicit `items` for a courier parcel with no packing list. Remaining: a scoped "Shipment — <transfer>" reconcile tab per inbound shipment (SKU | Ordered | This Shipment | Cumulative | Remaining | Flag | Note, plus OUTSTANDING and FABRIC/QUALITY blocks; Jamie chose scoped-per-shipment over per-shipment columns), the `qty_produced` mirror summing across shipments (cosmetic; reconcile already uses lots), and a `seed_order_from_held` helper that starts a replacement order from an order's held lots.
- Resume when: an order actually splits into ocean+air or a later batch arrives.

## Production order revision history
- Parked: 2026-07-04
- Domains: logistics, inventory
- Type: idea
- Notes: Order quantities change after placement and today the adjustment lands directly on `production_order_items` with only a notes-field summary. A revisions log (who/when/why per line change) would make a run's evolution traceable. Schema + tooling change; design when the next order revision happens.

## Local storage to organize production discussions/decisions per order & product
- Parked: 2026-06-30
- Domains: logistics, inventory, product_design, tech
- Type: idea
- Notes: A single production order spawns many scattered email threads (SKU corrections, sticker approvals, fabric issues, QC bookings, shipping lists), and tracing one issue means a long Gmail sweep each session. Idea: capture production-related discussions/decisions in Supabase (per-order/per-product notes, possibly linking the already-synced `email_messages` threads to an order or product).

## New-product / new-colourway tool (guided dev → first-order workflow)
- Parked: 2026-06-27
- Domains: product_design, inventory, logistics
- Type: idea (planned)
- Notes: Implements Rule 5 of the ordering algorithm (new items bypass the velocity formula; see initiative_production_pipeline.md). Two cases: **new colourway** (existing product, analog = a sibling colour, auto; founder gives a launch quantity and the tool applies the sibling's size spread from backfilled order history) and **new product** (full dev run-up: define → tech pack → grading → sample rounds → first run; first order uses a founder-chosen analog). Building blocks exist (`tech_packs`, `tech_pack_specs`, suppliers); the gap is the guided workflow. Worth its own focused session.

## Use AI (not heuristics) to separate customer text from boilerplate/quoted chains
- Parked: 2026-06-14
- Last touched: 2026-08-18
- Type: idea
- Domains: cs
- Priority: high
- Notes: The dashboard and intake separate the customer's free text from form metadata, bot-flow markup and quoted chains with regex heuristics (`isHelpCenterForm`/`splitHelpCenterForm`/the email-branch boilerplate strip in `dashboard/public/intakeParse.js`, plus `extractCleanBody`/`cleanHelpCenterBody` in `intake/processGorgiasTickets.js`). Four shape-specific fixes have shipped (form-then-metadata ordering, chat offline-capture subject line, help-center `<br>` read as a flow marker that corrupted stored `conversation_history`, first-contact forward rendered blank); each was another special case, and the failure mode escalated from "operator sees less" to "the stored record is wrong". Jamie's call: this is exactly what the AI-first principle says shouldn't be regex. Replace the split with an AI pass (Haiku is acceptable; it is pre-extraction, not customer-facing) returning {customer_message, order_metadata, quoted_history}. Scope whether it belongs at intake (one parse, stored structured) vs render time. The parsers now have unit tests, which lowers the cost of porting.
- Required scope: **first-contact forwards.** Gorgias's stripper drops the quoted block, which is right for a normal reply and wrong when the customer forwards or quotes a prior message on first contact ("following up on the below"). The render side now recovers the customer's words and offers the forwarded block behind a toggle; the ADVISOR half is not fixed. The AI pass must return the forwarded/quoted block as usable background on a first customer message. Closed PR #32 (unmerged, on Jamie's call) is the reference implementation and its `extractForwardedContext.test.js` a ready-made behaviour spec; recover from `gh pr diff 32`.

## Event donation follow-up: photo collection → collaborations page + Instagram
- Parked: 2026-05-29
- Last touched: 2026-09-02
- Type: idea (planned)
- Domains: community, b2b_sales, marketing
- Priority: medium
- Notes: After we donate or discount product for a specific event, ask for photos once the event has happened; photos build the public record of community work (collaborations page + Instagram). **Scoped 2026-09-02 with Jamie, v1 is the ASK only, on existing cadence rails:** (1) event-date capture is operator-confirmed, never silently extracted (the advisor spots "event on <date>" and suggests tracking it; one click while approving the discount stores it); (2) new `event_followup` message type due ~10 days after a stored event date where we contributed product, drafted by the community advisor with the thread in context; (3) photo intake and content routing stay manual. A handful of events a year, so a convenience build that earns its keep on never missing the moment.
- Related decision (2026-09-02, Jamie): corporate ERGs are NOT a segment to pursue; treat an inbound ERG as `lgbtq_org` with the ERG noted, org discount when the product is destined for community distribution.

## Unified B2B Outreach — unbuilt remainder (discovery fixes, affiliate onboarding, rename)
- Parked: 2026-05-28
- Last touched: 2026-07-24
- Type: idea (planned)
- Domains: community, b2b_sales, tech
- Priority: medium
- Notes: The system is built and live (see domain_b2b_sales.md); the original design plan file was retired 2026-09-09 and code is truth. Deliberately unbuilt remainder: (1) discovery pipeline fixes — aiClient.js port, Haiku pre-filter for the discovery backlog, org routing fix for mis-dismissed orgs, scheduled cron; (2) affiliate onboarding flow (GoAffPro); (3) A/B variant evaluation loop; (4) wholesale→B2B rename (last, after everything is proven); (5) CS→outreach transfer tool (one-click move of a community_outreach Gorgias ticket into b2b_companies + thread; done by hand so far, automate when inbound org volume justifies it).

## Audit sheet-imported B2B contact associations
- Parked: 2026-07-24
- Domains: b2b_sales, community
- Type: idea
- Notes: The Main Contacts sheet import created chimeric records: free-mail contacts attached to company rows by the old Gmail-scanning system's guesses, plus column-shift mess (a street address in the website field). Trustworthy pattern: contact email domain matches company domain. Audit sweep: flag companies whose contacts are free-mail AND whose order ship-to addresses mismatch the company address; review flagged rows before outreach touches them.

## Remove the name fallback from syncB2bCompanyState's partner matching
- Parked: 2026-08-11
- Last touched: 2026-08-11
- Domains: community, b2b_sales
- Type: bug
- Priority: medium
- Notes: `syncB2bCompanyState` matches org companies to active donation_partners by website domain with a name fallback, and the fallback has fused two unrelated orgs with similar names onto one record. The advisor's own matching was changed to domain-only (`fetchDonationRouting`), but the sync still carries the fallback and is what sets `program_flags.donation_closet`. Fix: domain-only there too; let an unmatched partner stay unmatched rather than guess.

## Passport shipping-delay rework — re-check live tracking before escalating
- Parked: 2026-05-23
- Last touched: 2026-07-20
- Type: idea (planned)
- Domains: logistics
- Notes: **Problem (data-backed):** the daily "likely lost" trigger and the Passport investigation emails were pure noise: every Passport claim ever filed resolved as delivered, most before we emailed. Root cause: the trigger keyed off staleness of our own cached tracking, not the delivery window, and cached Passport tracking is chronically stale (parse failures on stub/"expired" pages freeze orders at the handoff, and the hourly scrape only refreshes a handful a day). The same stale data reaches customer-facing advisor drafts (a cached "cancelled" that the live link contradicted).
  **Already shipped:** auto-email to Passport disabled (`sendPassportEmail` call commented out in `reports/lib/shippingDelays.js`); Passport sections removed from the daily report. `checkShippingDelays` still creates/reconciles claims in the DB and customs duty notices still send.
  **Plan:** re-centre detection on *past expected delivery window* (the existing business-days vs zone window logic). On window-cross, trigger a fresh live scrape and read what Passport actually says before any escalation. Then: delivered/normal transit → nothing; real exception (customs hold, bad address, RTS) → draft to the customer for operator approval; no movement well past window (~25–30d) → surface to Jamie as a one-click reship/refund decision. No automated emails to Passport at any step. Separable win underneath: fix scrape/parse reliability so the local-carrier leg lands in `orders.fulfillments[].events`. Promote to a project when Jamie decides to execute.

## Watch: does extractCleanBody's reply-parser path drop customer content?
- Parked: 2026-04-27
- Last touched: 2026-08-05
- Type: bug-watch
- Domains: cs
- Notes: `extractCleanBody` runs email-reply-parser on the raw body and, when the library strips something, writes the parsed text to `body` and nulls `body_html`, and `body` is what the advisor reads. If a future report says "the advisor missed an address the customer clearly typed" or "exchange shipping address was wrong", compare raw `body_text` from `gorgias.getTicketMessages(ticketId)` against the stored `conversation_history[].body`. If the raw has it and the stored doesn't, the reply-parser ate it; the fix is a lazy raw-fetch in the tool that needs the address (refund_order, create_exchange_order), not a change to the shared parser.

## Bundle dynamic pricing — adult variants check out at youth (lowest) price
- Parked: 2026-04-28
- Last touched: 2026-04-28
- Type: bug
- Domains: marketing, tech
- Notes: Simple Bundles 2.0 dynamic pricing resolves to the cheapest variant regardless of selection: a customer picks adult sizes but the cart charges the youth-tier price (Bikini Set, Matching Set, Shaping Bundle). Root cause in the theme: `assets/product-custom.js` `updateBundleValue()` sends the variant display string to Simple Bundles instead of the variant ID. Fix: pass variant_id so Simple Bundles can resolve per-variant pricing; then product cards on collection pages should show a price range. Handed to the theme repo 2026-04-28.

## Holistic refactor of MCP tool catalog (organization, not just names)
- Parked: 2026-05-01
- Last touched: 2026-05-01
- Type: refactor
- Domains: cs, tech
- Notes: Step back from the organically grown catalog (now well over 100 tools) and redesign it as a coherent surface. Three north stars: consistency (naming, input/output shape, error handling follow one rule); AI ergonomics (the model should discover and pick the right tool fast, and adding tools shouldn't require re-deriving conventions); domain-mapped, not system-mapped (group by operator expertise such as shipping, inventory, customer history, sizing, rather than by vendor system). Vendor leakage in tool boundaries is a smell; the AI's mental model is the operator's domain, not our infra.

## Security review sweep of the whole codebase
- Parked: 2026-07-02
- Last touched: 2026-07-02
- Type: idea
- Domains: tech
- Resume when: a session with fresh token budget.
- Notes: Run a security-lens multi-agent review, same shape as the July 2026 bugs/DRY workflow (per-subsystem finders + adversarial verification). Lenses: webhook auth (HMAC/secret verification on every route, incl. Gmail Pub/Sub), dashboard endpoint authn/authz + the ngrok preview exposure, secrets hygiene, injection surfaces (SQL via Supabase/pg, prompt injection through customer emails reaching tool-calling agents), PII handling (customer data in logs, `ai_calls` payloads, dead-letter tables), dependency audit. The prompt-injection surface is the RUBIES-specific one: customer-controlled email text feeds an Opus agent holding refund/exchange tools.

## 2026-07 comprehensive review — small deferred remainders
- Parked: 2026-07-08
- Last touched: 2026-07-08
- Type: bugs/refactors (small)
- Domains: tech, cs
- Notes: The July 2026 whole-codebase review is fully remediated (all highs, model policy, shared `runToolLoop` extraction). Still open, deliberately deferred: dashboard app.js order money-summary dedup + focus-timer/notification bugs (need the dashboard running for visual verification); `conversation_history` 3-writer read-modify-write race (needs a merge-semantics decision); aiAdvisor legacy-output-mode default flip (advisor behaviour; holdout first). Full finding list lives in `temp-analysis-data/` (gitignored, local to Jamie's machine).

## Stale-draft guard — block send when executed actions contradict the draft
- Parked: 2026-07-09
- Last touched: 2026-07-09
- Type: build (small)
- Domains: cs
- Notes: ~10% of draft/sent divergences are pipeline artifacts: operator actions executed or failed AFTER the draft was written (address change on a fulfilled order, OOS discovered mid-swap, invoice instead of refund). The action summary already carries a "you'll want to update the draft" marker, but the draft stays sendable and Jamie hand-rewrites every time. Build: when a filed `actions[]` entry carries the divergence marker, set a `draft_stale` flag that blocks one-click send and offer a "Redraft from actions" button (one Opus call, fires a few times a week). Detection is deterministic (marker text in the action summary).
- Resume when: next dashboard session.

## Curate the advisor tone samples down to the ones that earn their tokens
- Parked: 2026-09-09
- Domains: cs
- Type: refactor (small)
- Notes: The only open item from the closed CS Advisor Efficiency project. `cs_tone_samples` carries ~50 active samples injected on every advisor call; curating to roughly half saves ~2K tokens per call with no model change. Sweep for contradictions with current voice rulings at the same time (see domain_cs.md: tone samples outrank rules).
