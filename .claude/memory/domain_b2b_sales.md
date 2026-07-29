---
name: B2B Sales
description: Retailer discovery, web scraping, lead scoring, wholesale orders, B2B outreach, pricing
type: project
originSessionId: 76845f16-8454-4953-8882-a8bc486354fb
---
## What's Built

**Prospect Discovery Pipeline:** Google Maps searches across tier-1/tier-2 cities with targeted search terms (LGBTQ friendly boutique, swimwear shop, etc.). Deduplicates by Google Place ID and website domain.

**Scraping Pipeline:** Puppeteer scrapes homepage + key pages (about, shop, contact) for each prospect with a website. Browser instance recycled every 10 pages for memory management. Rate limiting: 1s between domains, 2s same-domain subpages.

**Contact Finder:** Regex + DOM parsing extracts email, phone, contact form URL. Classifies email type (business/personal) for scoring.

**AI Analysis:** Claude analyzes scraped HTML. Returns structured JSON: subcategory (bra-fitting, online-trans-retail, etc.), trans/gender-affirming mentions, product type, ownership (independent vs chain), presence, brand list, outreach angle.

**Lead Scoring:** Points-based 1-10 scale. Positive: trans mention (+3), LGBTQ/inclusivity (+2), carries gender products (+2), underwear/swimwear (+1), independent (+1), physical store (+1). Negative: chain (-2), no website (-2). Threshold: score >= 5 = qualified.

**Google Sheets Sync:** Exports qualified prospects for sales outreach.

**Wholesale Orders (MCP tool):** Two-phase confirmation like exchanges. Pricing: US/AU 50% off, others 30% off, free shipping, AU auto-splits at $1k AUD. Currency override: hello@sockdrawerheroes.com always USD.

**Store Locator (MCP tools):** `store_locator_*` tools (list/create/update/delete/publish) manage the rubyshines.com/pages/store-locator map. Data lives in `b2b_companies` (9 new `locator_*` columns + `on_store_locator` flag). Publish writes `rubies-ecom-v4/assets/store-locators.json` via worktree + auto-merge, same pattern as donation partners. Haiku auto-extracts store descriptions from the website. 7 retail partners live as of 2026-06-08.

**Outreach Engine (2026-06-11):** the unified B2B outreach system (design record + unbuilt-remainder spec: `.claude/plans/b2b-outreach-system.md` — code is truth for what's built). One spine, three channels (retailers / LGBTQ+ orgs / affiliates): 6-tier signal-based queue, cadence engine (per-message-type due conditions), two Opus advisors (`b2b_sales_advisor`, `b2b_community_advisor`) drafting into `b2b_drafts` with enforced output schema (facts_to_verify + open_commitments fields instead of "don't hallucinate" rules), Gmail reply correlation (inbound → company thread, bounce/departure detection pauses cadence), and a two-phase send tool **hard-gated by the `b2b_send_enabled` system flag (default OFF — go-live is a Jamie-only act)**. Surfaces: operator-console tools (`b2b_queue`, `b2b_draft`, `send_b2b_email`) + dashboard Outreach panel. Tables: `b2b_threads`/`b2b_messages`/`b2b_drafts` + outreach columns on `b2b_companies`. Engine outbound `b2b_messages` rows are written by the send tool; manual Gmail sends are reconciled in as `source='manual_send'` (see below).

**Panel truth layer (2026-07-24):** the queue and history are kept honest against Gmail. `manualSendReconcile.js` backfills messages the engine didn't send — Jamie's manual Gmail replies (`manual_send`) and pre-correlation inbound (`gmail_backfill`) — idempotent on `gmail_message_id`, DRAFT-labeled messages skipped (the checkpoint-poison guard), 15-min per-thread cooldown, runs on queue/history fetch. Reply-rate/A-B metrics still count only `source='send_tool'` rows. Closed threads never produce Tier-1 "waiting on us". Dashboard panel shows full conversation history per company (`GET /api/b2b/companies/:id/threads`). `syncB2bCompanyState.js` (daily-sync-all sub-pipeline, after Orders) keeps `b2b_companies` order fields, `relationship_state` promotions, and org `program_flags` true from the orders mirror + donation_partners registry — cadence never nudges from stale order data.

**Browse surfaces (2026-07-29):** the Outreach panel answers three questions, one sidebar mode each — **Queue** (what's due, the original 6-tier view), **Activity** (`GET /api/b2b/activity`, every message newest-first across all companies), **Companies** (`GET /api/b2b/companies`, searchable directory of all of them, filtered on two independent axes: relationship stage and conversation state). Search spans company name/slug/domain/general email, contact email + name, and thread subject, and returns *which* matched. Closed threads carry Reopen (flips status open + drafts the follow-up threaded on that conversation) and its mirror, Close. Same `queueService.js` functions back the panel and the `b2b_search` / `b2b_activity` / `b2b_reopen_thread` console tools.

## Current Status

- **Production:** Outreach LIVE (send flag ON 2026-07-23, first drafts staged: TGV reply + Uniting Pride onboarding). Queue triaged to ground truth 2026-07-24. Operating model: pull-mode (Tier-1 replies + operator-initiated) — the daily cadence sweep is deliberately NOT scheduled on Railway yet; push-mode cadence is a later, explicit decision. Discovery backlog fully researched (41 qualified retailers, 144 community orgs waiting). Wholesale orders working via MCP tools.
- **Partial:** Sheet sync exists but unclear if continuous or one-time. Contact-loss auto-re-intro draft flow not yet wired (detection + cadence pause + general_email fallback are live). Three junk domain-grouped company rows (Gmail/Yahoo/Hotmail) marked `lost` 2026-07-24 — individuals from an old import, not companies.

## Key Files

- `b2b-outreach/` — outreach engine: cadence, queue, advisors, send tool, sweep.
- `b2b-discovery/discover.js` — Prospect discovery pipeline entry point (+ `prefilter.js`, `researchSurvivors.js`).
- `customer-service/lib/tools/b2bOutreach.js` — console/MCP outreach tools.
- `customer-service/lib/tools/wholesaleOrder.js` — Wholesale order MCP tool.
- `customer-service/lib/tools/storeLocator.js` — Store locator MCP tools.

## Key Decisions

- **`relationship_state` is not a funnel stage (2026-07-29):** 180 of 238 companies carry `in_contact`, and 172 of those have never had a conversation or placed an order — discovery imports land there, so the value means "imported prospect", not "in contact". Nothing ever writes `dormant` (`syncB2bCompanyState` says so explicitly), so the two `reactivation` cadence branches cannot currently fire. Anything presenting a pipeline stage must derive it, and must keep *relationship* (account / lead / lost) separate from *conversation* (talking / closed / never): folding them into one filter hid active retailers whose threads had all concluded, which is exactly the set worth working. Fixing the data itself is the real answer and hasn't been done.

- **The queue stays due-only; browsing is a separate surface (2026-07-29):** the 6-tier queue answers "what needs action" and nothing else. Reaching a company the cadence hasn't surfaced is the directory's job, and drafting from there is explicitly operator-initiated (`force`), never a relaxation of the cadence rules. The advisor is told which of the three it is — a typed cadence message, an operator revival, or a genuine Tier-1 reply — because its default framing ("they are waiting on a reply from us") is false for the first two and shows up in the copy.

- **Only the per-company view guarantees a complete conversation (2026-07-29):** `reconcileThreads` skips closed threads by default (a concluded thread can't change what's due, and the queue-wide sweep would otherwise cost a Gmail call per thread); the panel's one-company sync passes `includeClosed`. Discovery repairs threads it already knows rather than skipping them, and never re-derives status on an existing thread — the operator may have just closed or reopened it by hand.

- **Reorder cadence is frequency-aligned, not flat (2026-07-24):** nudge threshold = 0.75 × the company's LATEST order interval, clamped 90-365d, computed by the daily sync (last interval beats median/mean because bursty histories lie in both directions — Transting: monthly cluster then a 402d gap). The advisor can override timing per-send via `next_touch_days` when the thread gives a concrete reason (stated timeline, rough-patch-then-comeback), bounded 7-365d. Math sets the default; thread judgment bends it; the operator sees the override before sending.

- **Never manually parse CSV data** — always pass raw CSV to `parse_wholesale_input` tool.
- **Order creation tool selection:** `create_wholesale_order` requires an existing Shopify customer ID — use it for established wholesale accounts. For one-off bulk or community orders where the customer may not be in the system yet, use `create_order` with `discount_percent: 50` — it finds or creates the customer automatically from email + name + address.
- **Two-tier discovery:** Google Maps for breadth, then deep research for depth.
- **Domain dedup:** Merge sources if domain already exists, don't duplicate.
- **Shipping speed driven by Shopify shipping method title.** All order-creation tools (`create_order`, `create_exchange_order`, `create_invoice_order`, `create_wholesale_order`) take `shipping_speed: 'standard' | 'expedited'`. The Shopify shipping line title is set via `getShippingMethodTitle(country, speed)` (in `orderUtils.js`) at price `$0.00` — Warehance auto-maps the title to the correct carrier (US Standard / US Expedited / Passport DDP / Passport DDU / Fedex). No FedEx tags. Wholesale defaults: standard for US, expedited for non-US (preserves the prior "non-US wholesale = FedEx" rule). Post-creation `update_shipping_speed` is fully programmatic: US standard ↔ US Expedited; non-US standard maps zone → Passport DDP (Canada / DDP) or Passport DDU (DDU / unknown); non-US expedited → Fedex. Incoterms is implicit in the Passport method name and handled automatically by Warehance for Fedex orders.

- **`pre_increase_pricing` flag on `create_wholesale_order`:** When set, per-line prices use `price_history.previous_price` from the Apr 16 2026 rollout row × country discount, instead of current retail. SKUs without an Apr 16 row fall back to current retail silently. No draft-level `appliedDiscount` when flag is on — discount is baked into per-line prices. When all partners have transitioned to current pricing, remove the flag (park a cleanup entry at that time).

## What's Next

- Outreach tracking (contacted status, response tracking)
- Sales results feedback loop to improve scoring
- Tier 3 custom searches
