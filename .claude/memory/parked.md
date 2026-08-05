---
name: Parked Items
description: Single capture+discussion journal for everything deferred — bugs, ideas, half-formed plans, decisions-needed. Filter by domain, type, or priority.
type: parked
originSessionId: 76845f16-8454-4953-8882-a8bc486354fb
---
# Parked Items

Minimum entry is title + Parked date + Domains. Everything else is optional. See CLAUDE.md Memory Protocol for the lifecycle (captured → discussed → planned → executing → validated).

## Merge duplicate company rows (same org, two records)
- Parked: 2026-08-05
- Domains: b2b_sales, community
- Type: bug
- Priority: high
- Notes: The imports created two rows for the same org on seven domains: BAGLY (active donation partner + bare row), Hugh Lane (three rows), Oasis Youth Center, Skipping Stone, OUT MetroWest, TransFamily Support Service, Self Serve Toys. Each carries a different contact address, so both would receive outreach. Cadence now suppresses the cold opener when a same-domain sibling is already engaged (`ctx.hasEngagedSibling`), which removes the immediate hazard — but the data is still duplicated, order/thread history is split across rows, and the panel shows both. Real fix: merge on domain, keeping the richest row, moving contacts and threads onto it, marking the other `lost` with a triage_reason. Related: the sheet-import contact-association audit entry below.

## Dormancy is never derived, so `reactivation` cannot fire
- Parked: 2026-08-05
- Domains: b2b_sales
- Type: bug
- Priority: medium
- Notes: `reactivation` gates on `relationship_state === 'dormant'`, but nothing writes that value — `syncB2bCompanyState` promotes and never demotes, and the "derived at queue time" dormancy the design assumed was never built. The branch has been unreachable since it was written; it is kept (with a comment saying so) because the revival behaviour is wanted. Fix: derive dormancy in the queue from `last_order_date` vs the company's reorder threshold, rather than storing a state that goes stale. The sibling case `affiliate_reactivation` was deleted outright 2026-08-05 for the same reason plus no attribution feed.

## B2B lead supply — remaining plan phases (vetting UI, enrichment, send rate)
- Parked: 2026-08-05
- Domains: b2b_sales, community, tech
- Type: idea (planned)
- Priority: high
- Plan: .claude/plans/b2b-lead-supply-and-vetting.md
- Notes: Phases 0, 1 and 3 shipped 2026-08-05. Remaining: (2) **vetting UI** — the panel needs keep/drop/snooze controls so the 41 sheet retailers can be triaged; `b2b_triage` and `vetted_at` exist, only the UI is missing, and until it lands those 41 stay invisible because `re_approach` requires `vetted_at`. (4) **CenterLink enrichment** — ~120 org rows are a name slug plus an email; websites are now derived from contact domains, so `b2b-discovery/lib/researcher.js` can run over them, auto-dropping dead sites and non-orgs, survivors becoming vetted prospects. (5) **send rate + sender reputation** — a daily cap enforced in `sendB2bEmail` (not a prompt), pre-send email verification (bounce rate is what actually burns reputation), and the open decision on whether cold B2B keeps riding rubyshines.com alongside Klaviyo customer mail or moves to a separate sending domain. The plan file holds the full spec.

## Outreach browse surfaces: first page only, and relationship_state needs cleaning
- Parked: 2026-07-29
- Domains: b2b_sales, community
- Type: idea
- Notes: Two deferred bits from the 2026-07-29 browse/search build. (1) **Paging** — the Companies directory caps at 50 rows and the Activity feed at 60; `fetchActivity` already returns a `next_before` cursor that nothing consumes, and the directory has no cursor at all. Both say what they dropped rather than truncating silently, so this only bites once volume grows past a screen or two. (2) **`relationship_state` cleanup** — see the domain Key Decision: `in_contact` is carried by 180 companies of which 172 are untouched imports, and nothing ever writes `dormant`, so the `reactivation` / `affiliate_reactivation` cadence branches are unreachable. The directory derives its stage filter instead of trusting the column, which makes the UI honest but leaves the data wrong for anything else that reads it. Fix is a backfill pass (imported-and-never-contacted -> a real prospect state) plus deciding what should set `dormant` and when.

## Advisor drops the exchange action when the customer confirms ("yes please")
- Parked: 2026-07-29
- Last touched: 2026-07-29
- Domains: cs
- Type: bug
- Priority: high
- Notes: On Opus 4.8 in production, **~40–60% of runs**. This is the `noMirroring` scenario's *second* test, not the mirroring one — measured 2026-07-29, the mirroring assertions passed 7/7 on 4.8 and only the turn-2 check fails. (An earlier note here mischaracterised this as a mirroring bug; mirroring was the *Opus 5* failure mode.) Repro: `node customer-service/test/scenarios/noMirroring.js` — turn 1 asks to exchange a too-small bra, turn 2 is "Great, yes please go ahead with that!". On failure the draft is the donation-info block alone with `action_type: null`, so nothing is staged for the operator; on success it is "Done! Your Brooke in size L will ship tomorrow." with the action set. Same visible signature as the Opus 5 refund defect (donation prose, no action), though a fix targeting that hypothesis did NOT help — see below.
- Attempted and reverted 2026-07-29: added "Donation info is an attachment to an action, never a message on its own…" to the "When to mention DONATION" section, on the theory that the section presents donation info as its own deliverable rather than subordinate to the action. Result: 5/8 failing vs 3/7 baseline — no benefit, possibly worse, all inside the noise band. Reverted, not shipped.
- **Methodology warning for whoever picks this up:** this scenario's variance is ~40–60%, so n=8 cannot distinguish a moderate effect from noise. Budget n≥20 per arm (~35 min, ~$10 at 3 advisor calls per run), or find a cheaper single-call repro of the same confirm-drops-action behaviour first. Also: check `node --check` after any prompt edit and assert on **exit code**, not just the absence of "✗" — a syntax error inside the template literal produces neither, and silently reads as a pass (cost an entire batch of false results on 2026-07-29).

## Advisor can't reliably name the Sky adult colourways
- Parked: 2026-07-29
- Domains: cs
- Type: bug
- Notes: `knowledgeFacts` fails on Opus 4.8 — asked which colours the Sky one-piece comes in for adults, the draft does not name both Black and Pink. Assertion verified correct 2026-07-28 against `product_variants`: Black and Pink are the only Sky colourways with adult (letter-size) stock; Navy and UNI have none. So the test is right and the advisor is wrong — a grounding/tool-use gap, not stale test data. Worth checking whether it is failing to call the catalog tool at all (the adjacent `kbSearchGrounding` failure mode was deflection with `tools: []`).

## Split commitmentCalibration into three scenario files
- Parked: 2026-07-29
- Domains: cs
- Type: refactor
- Notes: It makes three sequential advisor calls plus Gorgias fetches in one file, so it runs ~3× a normal scenario and blows a 240s timeout under concurrency (looks like a hang, isn't). Split into one file per case (ambiguous-refund, needed-by-date, stalled-transit) so failures isolate and the suite parallelises; extract the shared `ticketToInput` helper, also used by `exchangeMoney`. Also reconsider whether replaying live Gorgias tickets belongs in a pinned suite given the order-state-drift rule — two of the three cases already self-skip when their shipments have since delivered.

## Revisit Opus 5 (or the next model) for the advisor — REJECTED 2026-07-29
- Parked: 2026-07-29
- Domains: cs, tech
- Type: decision (closed, revisit on trigger)
- Notes: Evaluated and rejected against the founder acceptance criteria (same-or-better accuracy, same-or-faster latency, same-or-cheaper cost). **The rejection rests on a config trade-off, not on any single measurement** — see the numbers caveat below before quoting figures.
- **Why rejected — no configuration satisfies all three.** The two knobs trade directly against each other on our workload, and both corners were measured: with `thinking` disabled (config-matched to 4.8) Opus 5 produced 4 accuracy failures; with adaptive thinking it produced 3 but cost and latency rose. Turning thinking down degrades accuracy; turning it up (adaptive, or `xhigh` as Anthropic recommends for restoring tool use) spends more thinking tokens at $25/MTok on a 1–2 call loop that cannot recoup it by shortening. `xhigh` is therefore never a shippable answer here, only a diagnostic. There is no middle setting left to find.
- **⚠️ Numbers caveat — the headline cost/latency figures are confounded; do not quote them as the model's baseline.** The full-suite run recorded accuracy 20/25 vs 25/25, latency +22.5% (9.3s vs 7.6s median) and cost +15.3% ($0.2011 vs $0.1745/scenario) — but the advisor omits the `thinking` parameter, which means **no thinking on Opus 4.8 and adaptive thinking ON for Opus 5** (a documented default change). So that comparison measured a thinking-enabled model against a thinking-disabled one and attributed the delta to the model. The like-for-like cost/latency number (Opus 5 pinned to `thinking: {type:"disabled"}` at default `high` effort — valid, since disabling is only rejected at `xhigh`/`max`) was never measured. Deliberately not re-run: it would confirm a decision already sound on the trade-off argument. **Measure it properly at the next real trigger rather than trusting these figures.** Accuracy is on firmer ground — it failed in both thinking configurations.
- Opus 4.8 has no announced retirement date (Opus 4.1 retires 2026-08-05). The `claude-opus-5` RATES row is already in `shared/aiPricing.js` and `MODELS.OPUS` carries a warning comment. **Resume when:** a retirement date is announced for Opus 4.8, or a new model ships — then run `node scripts/modelSwapEval.js --candidate <model> --repeat 3` (one command, ~$30–50, ~40 min) and decide on the numbers. **Opus-5-specific defect to re-test if we ever adopt:** on refund tickets it produced plausible customer-facing prose with `action_type: null`, staging no refund — reproducible on `donationToolCall` and `refundNoAmount`, consistent across every run, while both pass on 4.8. Suspected cause is the "one move per message" rule (RESPONSE LENGTH & REGISTER, shipped 2026-07-20) being followed more literally than 4.8 does.

## Forgot-discount-code tool: refund the discount equivalent
- Parked: 2026-07-17
- Last touched: 2026-07-29
- Domains: cs
- Type: idea
- Notes: Jamie (facts review): customers forget to apply a code and ask after the fact; we refund the equivalent but eat the processing fee, and invalid-code complaints need manual investigation. Fact about the current manual process is loaded in kb_candidates. **DONE 2026-07-29: the burn-the-code and why-was-it-invalid halves** — `revoke_discount_code` kills one code without touching its pool siblings, and its lookup phase reports status / this code's usage vs limit / expiry as the invalid-code diagnosis. Remaining scope: refunding the discount equivalent on the order in the same step (today that's a separate `refund_order` call with a hand-computed amount).

## Corpus-harvest leftovers (small, founder-side)
- Parked: 2026-07-18
- Domains: cs, community
- Notes: (1) 3PL/Passport answer on whether international packages still carry an external customs invoice (discreet-packaging promise; KB stays silent on it until answered). (2) ValidUSA address: registry shows Tucson PO Box #14061 but Jamie earlier said 122 N Craycroft Rd is new - confirm which, then republish donation page. (3) Site edits Jamie plans: remove free-swimwear age limit; update or unpublish stale Friendships page (KB already marks it paused). Weekly KB refresh auto-absorbs the site edits once made.


## CS advocacy Phase B — /help share page + P.S. link + effectiveness tracking + provider capture
- Parked: 2026-07-06
- Last touched: 2026-07-06
- Type: idea (planned)
- Domains: cs, marketing, community
- Plan: .claude/plans/cs-email-signature-advocacy.md
- Notes: Phase A shipped 2026-07-06 (standardized signature + link-LESS advocacy P.S., once-ever dedup via `advocacy_asks_sent`; see domain_cs.md). Phase B: (1) build the rubyshines.com/help share page — tell another parent (with a ready-to-paste blurb), tell your therapist/doctor/clinic, connect an LGBTQ+ org, share on social; (2) append " Here are some ways you can help: [link]" to the P.S. (constants in signatures.js `ADVOCACY_PS`); (3) effectiveness tracking — an owned tracked-redirect route + `advocacy_events` table (sent → click → page actions), surfaced in the daily digest; (4) provider capture — a form on the page → `provider_leads` → community/B2B outreach (fold into the Unified B2B Outreach system as a "providers" channel, don't build parallel). Revenue attribution rides the EXISTING referral program on the peer avenue. Note: once-ever dedup means Phase-A recipients won't get the link version later (accepted). Next concrete step: draft the /help page content for Natta. Dependencies: sample cards/one-pager for providers (Creative), tracked links/UTMs. Full design + decisions in the plan file.

## Per-shipment reconcile tab + multi-shipment hardening
- Parked: 2026-07-03
- Last touched: 2026-08-05
- Domains: logistics, inventory
- Type: idea (planned)
- **DONE 2026-08-05: the transfer-number half.** `receive_shipment` now allocates `<code>`, `<code>-2`, … per consignment (shipment 1 keeps the bare code, whose reference is already live in Warehance), takes carrier + tracking, and accepts explicit `items` for a courier parcel with no packing list. Remaining here: the per-shipment reconcile tab, the `qty_produced` sum-across-shipments, and the seed-from-held helper.
- Notes: Extend the receiving reconcile (see domain_logistics Key Decisions) so each distinct inbound shipment of an order gets its own scoped "Shipment — <transfer>" tab (SKU | Ordered | This Shipment | Cumulative | Remaining | Flag | Note; + OUTSTANDING and FABRIC/QUALITY blocks). Jamie chose scoped-per-shipment over per-shipment columns. A pure `buildShipmentRows` was drafted then reverted (unwired) — re-derive from the design here. Also harden multi-shipment: auto-number `transfer_number` (`<code>-1/-2`) so a second shipment can't overwrite the first, and make the `qty_produced` mirror sum across shipments (reconcile already uses lots, so it's cosmetic). Plus a `seed_order_from_held`/next-order helper that starts a replacement order from an order's held lots. Use when the order actually splits into ocean+air / a later batch arrives.

## Production order revision history
- Parked: 2026-07-04
- Domains: logistics, inventory
- Type: idea
- Notes: Order quantities now change after placement (the KALI-2606 adjustment for KALI-2601 production deltas was applied directly to production_order_items with only a notes-field summary). A revisions log (who/when/why per line change) would make a production run's evolution traceable and support "track history of order updates for the same production run". Schema + tooling change; design when the next order revision happens.

## Local storage to organize production discussions/decisions per order & product
- Parked: 2026-06-30
- Domains: logistics, inventory, product_design, tech
- Type: idea
- Notes: Surfaced during the merchandising receiving-tool build. A single production order spawns many scattered email/decision threads (SKU corrections, barcode/sticker approvals, fabric issues, QC bookings, shipping lists) — e.g. tracing the sports-bra SB→SPB mislabel required a long sweep across Gmail. Idea: capture and organize production-related discussions/decisions in local storage (Supabase table and/or a per-order/per-product notes surface) so context isn't re-derived from Gmail each session. Ties to production_orders / tech_packs / suppliers and possibly the already-synced email_messages table (link threads to an order/product).

## New-product / new-colourway tool (guided dev → first-order workflow)
- Parked: 2026-06-27
- Domains: product_design, inventory, logistics
- Type: idea (planned)
- Notes: Surfaced during the production-pipeline algo work (see initiative_production_pipeline.md June 2026 update). Two cases: **(1) New colourway** — existing product, new color: no development, grading known, analog = a sibling color of the same product (auto). For ordering, founder gives a launch quantity and the tool applies the sibling color's **size spread** (size % distribution from the backfilled 2023-2026 orders in `production_orders`). **(2) New product** — whole new style: needs the full dev run-up (define → tech pack → grading → sample rounds via P&T studio → first run → scale to Kali), then first order uses a founder-chosen **analog** for the spread. Building blocks exist (`tech_packs`, `tech_pack_specs`, suppliers, R&D flow in `temp-analysis-data/production-rnd-process.md`); gap is the guided workflow. Implements **Rule 5** of the ordering algorithm (new items bypass the velocity formula). Worth its own focused session.

## Use AI (not heuristics) to separate customer text from boilerplate/quoted chains
- Parked: 2026-06-14
- Last touched: 2026-08-03
- Type: idea
- Domains: cs
- Priority: high
- **Third recurrence 2026-08-03 — and the first one that corrupted stored state, not just the render.** `cleanHelpCenterBody` treats `>` as a bot-flow marker and drops everything before the first one. Gorgias sends help-center contact-form `body_text` as HTML, so the `>` of `<br>` read as a marker: greeting eaten on 8 tickets, and on a single-paragraph message (whose only `<br>` is trailing) the entire message, leaving `conversation_history` holding the literal string `<br>`. The advisor was unaffected — it reads `extractCleanBody` directly, not the snapshot — so this was invisible until an operator opened the ticket. Fixed by normalising markup before parsing and only honouring `>` at line start; measured across all 57 stored help-center messages, all 189 flow markers are line-start and every non-line-start `>` is a tag closer. **The escalation is the point:** three fixes in, the failure mode has moved from "operator sees less" to "the stored record is wrong", and each fix has been another special case. Treat the AI-pass rewrite as the actual fix now, not an idea.
- **Second recurrence 2026-07-30 (same class, different shape).** The chat widget's offline capture sends `<subject>\n-----\n<body>`, and the email-branch strip deleted the first line as boilerplate. Right when the subject is a category chip ("Product Question"), wrong whenever the customer typed their own — 56 of 122 tickets on that path lost real customer words, worst case the entire question with a one-word bot answer left as the whole card. Fixed by rendering both halves instead of guessing which is boilerplate. The parsers moved to `customer-service/dashboard/public/intakeParse.js` and now have unit tests (app.js is browser-only and had no harness, which is why this class ships twice). That lowers the cost of the AI-pass rewrite below — there's now a tested seam and a pinned behaviour spec to port — but does not remove the reason for it: every fix so far has been another special case bolted onto a guess.
- Notes: The dashboard separates the customer's free-text from auto-appended order-form metadata and quoted reply chains using brittle regex heuristics (`isHelpCenterForm`/`splitHelpCenterForm`/`isOrderFormOutput`/the email-branch boilerplate strip in [app.js](../../customer-service/dashboard/public/app.js), plus `extractCleanBody`/`cleanHelpCenterBody` at intake in [processGorgiasTickets.js](../../customer-service/intake/processGorgiasTickets.js)). These break on shape variations — e.g. a single-message chat "edit my order" form routed to the email-intake path had its question stripped because the strip assumed header-then-divider-then-content when it was question-then-divider-then-metadata (fixed 2026-06-14 by routing through splitHelpCenterForm, but the underlying approach is fragile). Jamie's call: this is exactly the kind of parsing our AI-first principle says shouldn't be regex. Replace the heuristic split with an AI pass (cheap Haiku triage is acceptable per CLAUDE.md — it's a pre-extraction, not a customer-facing decision) that returns {customer_message, order_metadata, quoted_history}. Note the intake stores Gorgias `stripped_html` already; scope whether this belongs at intake (one parse, stored structured) vs render-time. Relates to the "customer signature/address missing from advisor view" watch item.

## Event donation follow-up: photo collection → collaborations page + Instagram
- Parked: 2026-05-29
- Last touched: 2026-05-29
- Type: idea
- Domains: community, b2b_sales, marketing
- Priority: medium
- Notes: After an event donation ships and the event happens, send a follow-up asking for photos. Photos received → operator routes to content pipeline → added to rubyshines.com/pages/collaborations and queued for Instagram. Over time builds a public record of community work (see collaborations page as the target format). Touches three systems: B2B outreach (follow-up message type), community (org relationship), marketing (site content + Instagram). Not part of V1 message type catalog — design after the core outreach system is running.

## Unified B2B Outreach — unbuilt remainder (discovery fixes, affiliate onboarding, rename)
- Parked: 2026-05-28
- Last touched: 2026-07-24
- Type: idea (planned)
- Domains: community, b2b_sales, tech
- Priority: medium
- Plan: .claude/plans/b2b-outreach-system.md
- Notes: The system itself is BUILT (2026-06-11) and LIVE (send enabled 2026-07-23) — see domain_b2b_sales.md. This entry now tracks only the deliberately unbuilt remainder from the design: (1) discovery pipeline fixes — aiClient.js port, Haiku pre-filter for the 3,537-row backlog, org routing fix (285 mis-dismissed orgs), scheduled cron; (2) affiliate onboarding flow (GoAffPro); (3) A/B variant evaluation loop; (4) wholesale→B2B rename (last, after everything is proven); (5) CS→outreach transfer tool (one-click move of a community_outreach Gorgias ticket into b2b_companies + thread — done manually for Uniting Pride 2026-07-23, worth automating when inbound org volume justifies it); (6) scheduling the daily cadence sweep (deliberate pull-mode decision — see initiative_b2b_expansion.md). The plan file remains the spec for these.

## Audit sheet-imported B2B contact associations
- Parked: 2026-07-24
- Domains: b2b_sales, community
- Type: idea
- Notes: The Main Contacts sheet import created chimeric records — free-mail contacts attached to company rows by the old Gmail-scanning system's guesses (found: Kelly Harrington fused onto Zoe and Company — a VA retail customer on an RI shop; the lgbtq-gmail/yahoo/hotmail domain-grouped junk). Trustworthy pattern: contact email domain matches company domain. Audit sweep: flag companies whose contacts are free-mail AND whose order ship-to addresses mismatch the company address; review flagged rows before outreach touches them. Also import column-shift mess (Zoe's street address sat in the website field) — spot-fix as found.

## Backfill donation partners missing from b2b_companies
- Parked: 2026-07-24
- Domains: community, b2b_sales
- Type: idea
- Notes: `syncB2bCompanyState` flags org companies matching active donation_partners (by website domain, name fallback), but some of the 18 active partners have no b2b_companies row at all (candidates spotted: RISE @ LA LGBT Center, Trans Healthkit Projekt, Yellow House, Carleton GSRC — verify by diffing registry vs companies). Until they exist, the outreach engine can't run community cadence for them. Small backfill: create rows + contacts from the partner registry/survey sheet, set program_flags.donation_closet, relationship_state active.

## CS accuracy — finish the deferred fixes from the cs-accuracy branch
- Parked: 2026-05-27
- Last touched: 2026-07-22
- Type: idea (planned)
- Domains: cs
- Notes: From the 2026-05-27 accuracy push (branch `cs-accuracy`, see initiative_cs_automation.md + domain_cs.md). Remaining deferred fixes: (1) **Refund-vs-choice nuance (#1019)** — when a customer is dissatisfied but hasn't firmly demanded a refund, nudge to an alternative (offer exchange-or-refund) before a full refund; Jamie wants a multi-case study across China + pre-China refund tickets before writing the prompt rule (high nuance). (2) Verify `compare_products`/`check_unfulfilled_order` return restock dates so the pre-order nudge (advisor rule 7) has data to state. Validate each via scenario test, not live regen. **DONE 2026-07-22: #1019** — the requested multi-case study ran as the refund-abuse assessment (2,219 return conversations classified, first-time vs repeat): the exchange-first nudge already existed in the prompt (SHAPING EXPECTATIONS + refund-nudge rules) and the study validated it; what shipped instead is visibility — refund-pattern flags, refund-history context line, serial-refunder routing with routing_reason, digest watch. Remaining here: only item (2). **DONE 2026-06-16: auto-hold on modify-unshipped (#877)** — all item modifies on unshipped orders (vague AND specific) now route to warehouse_hold; same-country address changes auto-apply with geocode validation, cross-border/invalid fall back to a hold. Also fixed the latent bug that made all auto-holds fail (handleWarehouseHold was never exported). See domain_cs.md Key Decisions.


## Passport shipping-delay rework — re-check live tracking before escalating
- Parked: 2026-05-23
- Last touched: 2026-07-20
- Type: idea (planned)
- Domains: logistics
- Notes: **Problem (data-backed):** the daily order-alerts "likely lost" trigger and Passport investigation emails were pure noise. Every Passport claim ever filed (49/49) resolved as delivered — 0 actually lost — and 86% (36/42 resolved) were already delivered *before* we emailed Passport. Root cause: the trigger keyed off tracking *staleness* of our own cached data, not the delivery window, AND our cached Passport tracking is chronically stale/failed. ~71 of 73 in-flight Passport orders dead-end at "Los Angeles, CA" or the handoff stub with `localCarrier` null. Live-scraping #30550 (we'd emailed "likely lost" May 22) showed it was actually DELIVERED May 20 with full NZ Couriers history — the scraper *can* get rich local-carrier data, but `syncPassportDelivery` (hourly, `--limit 50`, 24h cooldown) only lands ~10 fresh scrapes/day and parse failures ("expired"/stub pages, e.g. commit f106d25 stub detection) freeze orders at the handoff stub indefinitely. So stale data masquerades as "likely lost." 2026-07-20 addition (from the verbosity-fix edit assessment): draft 2628 — the advisor read our cached tracking as "shipment cancelled July 1" and offered a reship, while Jamie's sent reply said the tracking info was simply wrong and gave the correct live Passport link. Same stale-tracking root cause now reaching customer-facing advisor drafts, not just the daily report.
  **Already shipped (2026-05-22/23):** (1) disabled the auto-email to partners@passportglobal.com — `sendPassportEmail` call commented out in [shippingDelays.js](../../reports/lib/shippingDelays.js), function left in place; (2) removed all Passport sections from the daily report (Claims—Lost, Shipping Emails Sent Today, Waiting on Response, Tracking Sync) + the mid-report re-scrape pass in [dailyOrderAlerts.js](../../reports/dailyOrderAlerts.js). `checkShippingDelays` still creates/reconciles claims in the DB and customs duty notices to customers still send — only surfacing/email is gone.
  **Plan (the proper rework):** re-center detection on *past expected delivery window* (the existing row-6 `business_days` vs zone window logic), not staleness. On window-cross: trigger a *fresh live scrape* and read what Passport actually says before any escalation. Then branch: delivered/normal-transit → nothing (self-resolves); real exception (customs hold / bad address / return-to-sender) → draft to the **customer** for operator approval (not an email to Passport); genuinely no movement well past window (~25-30d) → surface to Jamie as a one-click **reship/refund** decision. No automated emails to Passport at any step. Bigger separable win underneath: fix the scrape/parse reliability so the local-carrier leg actually lands in `orders.fulfillments[].events` (parser robustness on stub/"expired" pages, cooldown/coverage so all in-flight orders stay fresh) — this improves daily visibility AND removes the false-lost signal at the source. Promote to project_*.md when Jamie decides to execute.

## syncCosts.js hangs on Google Sheets API
- Parked: 2026-05-10
- Last touched: 2026-05-10
- Type: bug
- Domains: finance, tech
- Notes: `customer-service/sync/syncCosts.js` hung indefinitely when run from a VPN connection (Hong Kong exit). Service account permissions on the supplier pricing sheet are correct (verified via share dialog). Other Google APIs (auth dance) are likely the choke point — Supabase + Warehance + most non-Google HTTPS work fine. Workaround used during the GAF/Naomi cost addition: insert directly into `product_costs` via `scripts/sb.js`. Test to confirm: run `node customer-service/sync/syncCosts.js` from a non-VPN connection — if it succeeds, VPN is the cause and we can either (a) document "run from clean network", (b) add a pre-flight network probe with timeout + clear error, or (c) drop the Sheet dependency by capturing supplier prices through a different channel (Tier 2 of the COGS roadmap discussed in this session).

## Forward-looking COGS plan — Tier 2 / Tier 3
- Parked: 2026-05-10
- Last touched: 2026-05-10
- Type: idea
- Domains: finance
- Notes: Current state (Tier 1) — manual Google Sheet → `syncCosts.js` → `product_costs` with temporal `effective_date`; report uses time-of-order cost. Sufficient for now but has known weaknesses: sheet drift, single average cost per SKU prefix (no batch variance), freight/duties are estimates not actuals, new SKUs silently miss until report flags them. **Tier 2** = capture actual supplier invoices (manual entry form in dashboard or auto-parse invoice emails) → write per-batch `product_costs` rows with real freight/duties allocation. **Tier 3** = full per-batch inventory tracking, FIFO/weighted-avg allocation per outbound order, true cost-per-unit-shipped. Tier 2 is the right next step; Tier 3 deferred until margin optimization at unit level becomes a priority.

## Advisor-pattern eval — Sonnet + Opus `advisor_20260301` tool
- Parked: 2026-05-11
- Last touched: 2026-05-11
- Type: idea
- Domains: cs
- Priority: low
- Notes: Anthropic shipped the advisor pattern as a beta API tool (`advisor_20260301`, header `advisor-tool-2026-03-01`, April 2026). Sonnet runs the agentic loop and calls Opus as a tool when stuck; Opus returns 400-700 tokens of guidance. Architecturally would be one tool entry in [aiAdvisor.js](../../customer-service/lib/aiAdvisor.js). Different shape from the prior Sonnet evals (plain Sonnet 30% B_WORSE, Sonnet+thinking mean 2.67 — both failed on structured output fields), and Anthropic explicitly pitches it at "long-horizon agentic workloads where most turns are mechanical but having an excellent plan is crucial," which matches the failure mode we saw. Caveats: (1) Anthropic's published benchmarks compare Sonnet+advisor to Sonnet alone (+2.7pts SWE-bench, -11.9% cost), not to Opus alone — parity with Opus is unproven and our bar is matching Opus on dashboard-critical structured fields, not beating Sonnet; (2) absolute savings modest (~$70-80/mo from current $107) — meaningful but not urgent at this volume; (3) Sonnet has to know *when* to call the advisor, which is itself a planning skill it failed on before. Resume when: CS volume grows enough that the savings matter more, or when next-gen Sonnet ships and we re-run the model eval anyway. Re-eval would reuse the existing shadow infra and the in-progress closeness-to-final judge from `project_cs_efficiency.md`. Sources: [The Advisor Strategy blog](https://claude.com/blog/the-advisor-strategy), [Advisor Tool API docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool.md).

## Bundle dynamic pricing — adult variants check out at youth (lowest) price
- Parked: 2026-04-28
- Last touched: 2026-04-28
- Type: bug
- Domains: marketing, tech
- Notes: Simple Bundles 2.0 dynamic pricing resolves to the cheapest variant regardless of selection. Customer picks adult sizes (12+/letter) but cart charges youth-tier price. Affects Bikini Set (Ruby+Mia), Matching Set (AJ+Brooke), Shaping Bundle (3xAJ+Ruby). Root cause in theme: `assets/product-custom.js` `updateBundleValue()` sends the variant display string ("Ruby Bikini - Black / L") to Simple Bundles instead of the variant ID; the variant data in `sections/main-product.liquid:334-346` also lacks a `price` field. Fix: pass variant_id (already in JS bundle variant array) so Simple Bundles can resolve per-variant pricing. Step 2: product cards on collection pages should show price range. Handed to theme repo 2026-04-28 — awaiting response.

## Voice input for standalone operator console (mobile)
- Parked: 2026-04-28
- Last touched: 2026-04-28
- Type: idea
- Domains: cs
- Notes: Add Web Speech API voice input to the standalone operator console — would make ad-hoc CS commands much faster on the phone (e.g. dictate "refund order 12345 for $20" while away from desk). Surfaced when designing the standalone operator advisor; deferred to keep v1 scope tight.

## GA4 funnel pipeline build (3 layers)
- Parked: 2026-04-28
- Last touched: 2026-04-28
- Type: idea
- Domains: marketing
- Notes: Three-layer extension: (1) ga4_daily +5 funnel cols (add_to_carts, checkouts, purchases, revenue, cart_to_view_rate), (2) ga4_items_daily per-product joined to Shopify catalog via itemId parse `/^shopify_([A-Z]{2})_(\d+)_(\d+)$/` → product_id, variant_id, (3) ga4_channels_daily per-channel funnel. Backfill to 2023-04-06. No longer gated on data-quality fix (resolved 2026-04-28). When recording GA4-reported numbers anywhere user-facing, note that GA4 capture rate ≈ 70% of Shopify web orders by design.

## klaviyo_flows table doesn't exist (no flow metrics synced)
- Parked: 2026-04-28
- Last touched: 2026-04-28
- Type: bug
- Domains: marketing
- Notes: [klaviyo-tracking/supabase-schema.sql](../../klaviyo-tracking/supabase-schema.sql) defines klaviyo_flows but the table was never created and no sync writes to it. Klaviyo flows (welcome series, abandoned cart, post-purchase) are typically 30-50% of email-attributed revenue. Big visibility gap. Build similar to campaigns: extend klaviyoClient.js + daily-email-tracking.js, backfill historical. Supersedes the older "Add flow-level granularity to email tracking" parked item below.

## cs_conversations.category is null on all recent records
- Parked: 2026-04-28
- Last touched: 2026-04-28
- Type: bug
- Domains: cs
- Notes: 231/231 records since Apr 1 have category=null. Total 322/3688 null. Classification not running on recent intake. Limits CS analysis (can't filter by exchange/refund/shipping/etc.). Investigate intake pipeline classification step.

## ga4_daily is filtered to Organic Search only (misleading table name)
- Parked: 2026-04-28
- Last touched: 2026-04-28
- Type: refactor
- Domains: marketing
- Notes: [seo-tracking/daily-seo-tracking.js:387-392](../../seo-tracking/daily-seo-tracking.js#L387-L392) hard-filters sessions to sessionDefaultChannelGroup='Organic Search'. Latest row 122 sessions vs ~580 full property. Either rename table to ga4_organic_daily, or remove filter and add channel column. Affects any future analysis assuming ga4_daily = full traffic.

## klaviyo_daily_metrics has only 49 days of history
- Parked: 2026-04-28
- Last touched: 2026-04-28
- Type: idea
- Domains: marketing
- Notes: Earliest 2026-03-10. Account-level daily metrics started recently. Limits historical engagement trend analysis. Worth backfilling like we did for klaviyo_campaigns. Klaviyo's metrics-aggregate-query API supports custom timeframes.

## Brooke PDP view→ATC rate halved post-pricing (PDP friction)
- Parked: 2026-04-28
- Last touched: 2026-04-28
- Type: bug
- Domains: marketing, product_design
- Notes: GA4 view→ATC for THE BROOKE SHAPING BRA went 13.46% → 6.61% PRE→POST. Only product showing real PDP-level friction (most products' ATC rate IMPROVED post-pricing). Worth investigating: price display ($42 new vs $39 old), hero image, copy, stock-out variants. Single-product issue — not part of the broader pricing analysis.

## Watch: does extractCleanBody's reply-parser path drop customer content?
- Parked: 2026-04-27
- Last touched: 2026-08-05
- Type: bug-watch
- Domains: cs
- Notes: The 2026-04-27 form of this watch asked whether Gorgias's `stripped_html`
  cuts customer sign-offs carrying shipping addresses. Answered 2026-08-05: yes,
  it cuts trailing lines. But it only ever fed `body_html` (the operator's view),
  never the advisor — `conversation_history[].body` comes from `body_text`, so
  the advisor always had the full text. The operator half is fixed (Key Decision
  in domain_cs.md). What stays open is the narrower version: `extractCleanBody`
  runs email-reply-parser on the raw body and, when the library strips something,
  writes the parsed text to `body` and nulls `body_html` — and `body` IS what the
  advisor reads. If a future report says "the advisor missed an address the
  customer clearly typed" or "exchange shipping address was wrong", compare raw
  `body_text` from `gorgias.getTicketMessages(ticketId)` against the stored
  `conversation_history[].body`. If the raw has it and the stored doesn't, the
  reply-parser ate it — fix is a lazy raw-fetch in the tool that needs the
  address (refund_order, create_exchange_order), not a change to the shared parser.

## Remove legacy walkTree/prescribe functions from sizingEngine.js
- Parked: 2026-04-15
- Last touched: 2026-04-15
- Type: refactor
- Domains: cs
- Notes: Requires migrating test assertions.

## Clean up Nitro fulfillment cost data
- Parked: 2026-04-15
- Last touched: 2026-04-15
- Type: refactor
- Domains: finance
- Notes: Related-party data needs reconciliation.

## Make one-time project exclusions configurable in margin report
- Parked: 2026-04-15
- Last touched: 2026-04-15
- Type: refactor
- Domains: finance
- Notes: Currently hardcoded in generate-margin-report.js.

## Add flow-level granularity to email tracking
- Parked: 2026-04-15
- Last touched: 2026-04-15
- Type: idea
- Domains: marketing
- Notes: Klaviyo daily sync has campaign stats but not flow-level metrics.

## Automate SEO strategy roadmap updates
- Parked: 2026-04-15
- Last touched: 2026-04-15
- Type: idea
- Domains: marketing
- Notes: Strategy roadmap items currently manually updated in Supabase — should flow from analysis pipeline.

## Surface product metafields in sizing & product recommendations
- Parked: 2026-04-15
- Last touched: 2026-04-15
- Type: idea
- Domains: product_design, inventory
- Notes: fit_description, comparison_notes, materials_composition are synced from Shopify but not used by the advisor when recommending products or explaining fit differences.

## Clean up remaining JSON product cache references
- Parked: 2026-04-15
- Last touched: 2026-04-15
- Type: refactor
- Domains: inventory
- Notes: Legacy cache path from pre-Supabase architecture.

## Automate shipping zone sync from Shopify DeliveryProfile API
- Parked: 2026-04-15
- Last touched: 2026-04-15
- Type: refactor
- Domains: logistics
- Notes: Replace manual table seeding. Code exists but currently unused.

## Expand international donation partner coverage
- Parked: 2026-04-15
- Last touched: 2026-04-15
- Type: idea
- Domains: community
- Notes: Only US/CA/CH have partners — international exchanges fall back to "suggest local donation."

## Add webhook circuit breaker / rate limiting
- Parked: 2026-04-15
- Last touched: 2026-04-15
- Type: idea
- Domains: tech

## Add idempotency tokens for webhook dedup
- Parked: 2026-04-15
- Last touched: 2026-04-15
- Type: idea
- Domains: tech
- Notes: Daily sync currently reconciles missed/dup webhooks; idempotency tokens would fix at the source.

## Automate Shopify webhook registration on domain change
- Parked: 2026-04-15
- Last touched: 2026-04-15
- Type: bug
- Domains: tech
- Notes: Requires manual re-run if domain changes.

## Holistic refactor of MCP tool catalog (organization, not just names)
- Parked: 2026-05-01
- Last touched: 2026-05-01
- Type: refactor
- Domains: cs, tech
- Notes: Step back from the organically-grown ~75-tool catalog and redesign it as a coherent surface. Three north stars: (1) **consistency** — naming, input/output shape, error handling all follow one rule; (2) **AI ergonomics** — Opus should be able to discover and pick the right tool fast, and adding new tools shouldn't require re-deriving conventions each time; (3) **domain-mapped, not system-mapped** — tools should group by knowledge domain / operator expertise (shipping, inventory, customer history, sizing, fulfillment) rather than by underlying vendor system (Shopify, Warehance, Gorgias, Supabase). The vendor leakage in some current tool boundaries is a smell — the AI's mental model is the operator's domain, not our infra.

## AI cost dashboard widget (last-30-days by component)
- Parked: 2026-05-27
- Last touched: 2026-05-27
- Type: idea
- Domains: tech, cs
- Notes: The deferred optional piece from the AI observability work. `ai_calls` + `ai_costs_daily` now hold per-component cost/latency; the daily ops digest already shows yesterday's per-component line + MTD spend + cap warning. A dashboard widget (stacked bar by component over 30 days, latency curves) would make trends visible at a glance instead of only in the daily email. Add a `/api/ai-costs` route on the existing dashboard server reading `ai_costs_daily`. Not urgent — the email covers the alerting need.

## Security review sweep of the whole codebase
- Parked: 2026-07-02
- Last touched: 2026-07-02
- Type: idea
- Domains: tech
- Resume when: next session with fresh token budget (follow-up to the 2026-07-02 comprehensive review workflow)
- Notes: Run a security-lens multi-agent review, same shape as the July 2026 bugs/DRY workflow (per-subsystem finders + adversarial verification). Lenses worth covering: webhook auth (HMAC/secret verification on every route, incl. Gmail Pub/Sub), dashboard server endpoint authn/authz + the ngrok preview exposure, secrets hygiene (keys in code/logs/committed files), injection surfaces (SQL via Supabase/pg, prompt injection through customer emails reaching tool-calling agents), PII handling (customer data in logs, ai_calls payloads, dead-letter tables), and dependency audit (npm audit). The prompt-injection surface is the RUBIES-specific one: customer-controlled email text feeds an Opus agent holding refund/exchange tools.

## 2026-07 comprehensive review — small deferred remainders
- Parked: 2026-07-08
- Last touched: 2026-07-08
- Type: bugs/refactors (small)
- Domains: tech, cs
- Plan: .claude/plans/can-you-write-a-serialized-flute.md
- Notes: The 2026-07-02 whole-codebase multi-agent review (183 confirmed issues) is fully remediated: all 25 highs (PRs #56–#63), Phases 2b/7/8 (PRs #65/#67/#68), Phase 6 model policy (PR #70), and Phase 4 shared `runToolLoop` extraction (the last phase, shipped 2026-07-08) — all 5 duplicated tool-loop bodies (operatorAgent main+shadow, operatorAgentStandalone, aiAdvisor main+shadow) now run on `customer-service/lib/runToolLoop.js`. Full finding list + per-PR manual-test checklist in `temp-analysis-data/` (GITIGNORED — local to Jamie's machine; regenerate via the review workflow script if lost).
  Still open from the review (small, deliberately deferred): dashboard app.js order money-summary dedup + focus-timer/notification bugs (need the dashboard running for visual verification); `conversation_history` 3-writer read-modify-write race (needs a merge-semantics decision); aiAdvisor legacy-output-mode default flip (advisor behavior — holdout first). sizingEngine dead-code deletion and b2b queueContext cadence fields have their own parked entries.

## Stale-draft guard — block send when executed actions contradict the draft
- Parked: 2026-07-09
- Last touched: 2026-07-09
- Type: build (small)
- Domains: cs
- Notes: ~10% of divergences in the 2026-07-09 sweep were pipeline artifacts: operator actions executed/failed AFTER the draft was written (address change on fulfilled order, OOS discovered mid-swap, invoice-instead-of-refund), the action summary already carries a "⚠️ you'll want to update the draft" marker, but the draft stays sendable and Jamie hand-rewrites every time. Build: when a filed `actions[]` entry carries the divergence marker, set a `draft_stale` flag that blocks one-click send and offer a "Redraft from actions" button (one Opus call ~$0.13, fires ~3×/week). Server-side detection is deterministic (marker text in action summary).
- Resume when: next dashboard session.

## edit_order Phase-2 settlement is wrong for add+remove edits (auto-refund / invoice)
- Parked: 2026-07-23
- Last touched: 2026-07-23
- Type: bug
- Domains: cs
- Notes: Found live on ticket 2745 / order #32584 (first duplicate-variant add+remove edit after the `allowDuplicates` fix). Two defects in [editOrder.js](../../customer-service/lib/tools/editOrder.js) Phase 2: (1) delta = `totalPriceSet` vs `currentTotalPriceSet`, but Shopify's `totalPriceSet` GROWS to include lines added in the edit (observed $109.92 → $132.54), so the reported delta was −$45.80 when the customer was actually owed $23.18; correct measure is `currentTotal − netPayment`. The same skew can make delta ≈ 0 on add-heavy edits and silently skip the invoice the customer owes. (2) The refund branch calls `suggestedRefund(suggestFullRefund:false)` with no refundLineItems, which returns $0 on order edits → `createRefund` fails "Refund amount must be greater than 0"; the refund must be computed as `netPayment − currentTotal` and issued in PRESENTMENT currency against the parent sale transaction. Related pricing learnings for the fix (verified live): added lines don't inherit bundle pricing; the order's discount code MAY auto-apply and STACKS on top of a custom line discount; `orderEditAddLineItemDiscount` fixedValue is interpreted in presentment currency even when passed with shop currencyCode (passed $12.31 USD, applied as 12.31 CAD = $8.74 USD). Net effect on 2745: added AJ landed at $21.54 vs $20.36 target; trued up in the manual refund. Fix wants unit/scenario tests around the settlement math before touching this money path — failure today is loud ("process manually"), never wrong-money.
