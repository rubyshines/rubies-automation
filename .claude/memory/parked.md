---
name: Parked Items
description: Single capture+discussion journal for everything deferred — bugs, ideas, half-formed plans, decisions-needed. Filter by domain, type, or priority.
type: parked
originSessionId: 76845f16-8454-4953-8882-a8bc486354fb
---
# Parked Items

Minimum entry is title + Parked date + Domains. Everything else is optional. See CLAUDE.md Memory Protocol for the lifecycle (captured → discussed → planned → executing → validated).
## New-product / new-colourway tool (guided dev → first-order workflow)
- Parked: 2026-06-27
- Domains: product_design, inventory, logistics
- Type: idea (planned)
- Notes: Surfaced during the production-pipeline algo work (see initiative_production_pipeline.md June 2026 update). Two cases: **(1) New colourway** — existing product, new color: no development, grading known, analog = a sibling color of the same product (auto). For ordering, founder gives a launch quantity and the tool applies the sibling color's **size spread** (size % distribution from the backfilled 2023-2026 orders in `production_orders`). **(2) New product** — whole new style: needs the full dev run-up (define → tech pack → grading → sample rounds via P&T studio → first run → scale to Kali), then first order uses a founder-chosen **analog** for the spread. Building blocks exist (`tech_packs`, `tech_pack_specs`, suppliers, R&D flow in `temp-analysis-data/production-rnd-process.md`); gap is the guided workflow. Implements **Rule 5** of the ordering algorithm (new items bypass the velocity formula). Worth its own focused session.

## Use AI (not heuristics) to separate customer text from boilerplate/quoted chains
- Parked: 2026-06-14
- Last touched: 2026-06-14
- Type: idea
- Domains: cs
- Notes: The dashboard separates the customer's free-text from auto-appended order-form metadata and quoted reply chains using brittle regex heuristics (`isHelpCenterForm`/`splitHelpCenterForm`/`isOrderFormOutput`/the email-branch boilerplate strip in [app.js](../../customer-service/dashboard/public/app.js), plus `extractCleanBody`/`cleanHelpCenterBody` at intake in [processGorgiasTickets.js](../../customer-service/intake/processGorgiasTickets.js)). These break on shape variations — e.g. a single-message chat "edit my order" form routed to the email-intake path had its question stripped because the strip assumed header-then-divider-then-content when it was question-then-divider-then-metadata (fixed 2026-06-14 by routing through splitHelpCenterForm, but the underlying approach is fragile). Jamie's call: this is exactly the kind of parsing our AI-first principle says shouldn't be regex. Replace the heuristic split with an AI pass (cheap Haiku triage is acceptable per CLAUDE.md — it's a pre-extraction, not a customer-facing decision) that returns {customer_message, order_metadata, quoted_history}. Note the intake stores Gorgias `stripped_html` already; scope whether this belongs at intake (one parse, stored structured) vs render-time. Relates to the "customer signature/address missing from advisor view" watch item.

## Event donation follow-up: photo collection → collaborations page + Instagram
- Parked: 2026-05-29
- Last touched: 2026-05-29
- Type: idea
- Domains: community, b2b_sales, marketing
- Priority: medium
- Notes: After an event donation ships and the event happens, send a follow-up asking for photos. Photos received → operator routes to content pipeline → added to rubyshines.com/pages/collaborations and queued for Instagram. Over time builds a public record of community work (see collaborations page as the target format). Touches three systems: B2B outreach (follow-up message type), community (org relationship), marketing (site content + Instagram). Not part of V1 message type catalog — design after the core outreach system is running.

## Unified B2B Outreach & Prospect System — design in progress
- Parked: 2026-05-28
- Last touched: 2026-05-28
- Type: idea (planned)
- Domains: community, b2b_sales, tech
- Priority: high
- Plan: .claude/plans/b2b-outreach-system.md
- Notes: Full design session in progress. Three channels (retailers, LGBTQ+ orgs, affiliates), one spine. Core concept: same draft+steer+send loop as CS advisor applied to outbound. Gmail direct (not Gorgias). Supabase SSOT (retire the sheet). Full wholesale→B2B rename (deferred to last). Two advisors: prospect + outreach. One signal-based priority queue across all channels. Empirical audit of existing discovery system completed (6,649 rows, ran once Feb/March 2026, never since; 285 dismissed community-orgs belong in LGBTQ+ pipeline; top-10 qualified look strong). Nine design areas still to work through before implementation: state machine, discovery pipeline deep-dive, queue loop, dashboard, advisor split, send flow, evaluation, migration order, rename. Resume by reading the plan file — it has all locked decisions and audit findings.

## CS accuracy — finish the deferred fixes from the cs-accuracy branch
- Parked: 2026-05-27
- Last touched: 2026-06-16
- Type: idea (planned)
- Domains: cs
- Notes: From the 2026-05-27 accuracy push (branch `cs-accuracy`, see initiative_cs_automation.md + domain_cs.md). Remaining deferred fixes: (1) **Refund-vs-choice nuance (#1019)** — when a customer is dissatisfied but hasn't firmly demanded a refund, nudge to an alternative (offer exchange-or-refund) before a full refund; Jamie wants a multi-case study across China + pre-China refund tickets before writing the prompt rule (high nuance). (2) Verify `compare_products`/`check_unfulfilled_order` return restock dates so the pre-order nudge (advisor rule 7) has data to state. Validate each via scenario test, not live regen. **DONE 2026-06-16: auto-hold on modify-unshipped (#877)** — all item modifies on unshipped orders (vague AND specific) now route to warehouse_hold; same-country address changes auto-apply with geocode validation, cross-border/invalid fall back to a hold. Also fixed the latent bug that made all auto-holds fail (handleWarehouseHold was never exported). See domain_cs.md Key Decisions.

## CS knowledge base — stale/wrong articles feeding cs_get_knowledge
- Parked: 2026-05-27
- Last touched: 2026-05-27
- Type: bug
- Domains: cs
- Notes: Found during the accuracy hard-facts sweep. `cs_knowledge_base` has wrong/stale articles: "RUBIES Shipping Information" describes AUSTRALIA domestic shipping + buyer-pays-duties (wholly wrong — RUBIES ships from US, covers DDP); "Shipping Policy" says ships from Portland, Oregon and $99-everywhere. Most KB articles are raw web-page scrapes with cart/UI junk. The advisor does NOT read the KB, but the `cs_get_knowledge` MCP tool does on other surfaces, so these can surface wrong info elsewhere. Fix: quarantine/correct the shipping articles; consider replacing shipping/policy facts with DB-backed lookups (shipping_zones). DB is the source of truth; KB must not contradict it.

## Passport shipping-delay rework — re-check live tracking before escalating
- Parked: 2026-05-23
- Last touched: 2026-05-23
- Type: idea (planned)
- Domains: logistics
- Notes: **Problem (data-backed):** the daily order-alerts "likely lost" trigger and Passport investigation emails were pure noise. Every Passport claim ever filed (49/49) resolved as delivered — 0 actually lost — and 86% (36/42 resolved) were already delivered *before* we emailed Passport. Root cause: the trigger keyed off tracking *staleness* of our own cached data, not the delivery window, AND our cached Passport tracking is chronically stale/failed. ~71 of 73 in-flight Passport orders dead-end at "Los Angeles, CA" or the handoff stub with `localCarrier` null. Live-scraping #30550 (we'd emailed "likely lost" May 22) showed it was actually DELIVERED May 20 with full NZ Couriers history — the scraper *can* get rich local-carrier data, but `syncPassportDelivery` (hourly, `--limit 50`, 24h cooldown) only lands ~10 fresh scrapes/day and parse failures ("expired"/stub pages, e.g. commit f106d25 stub detection) freeze orders at the handoff stub indefinitely. So stale data masquerades as "likely lost."
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

## Watch: customer signature/address missing from advisor view (Gorgias stripped_html)
- Parked: 2026-04-27
- Last touched: 2026-04-27
- Type: bug-watch
- Domains: cs
- Notes: As of 2026-04-27 (commit 108f16a), intake stores Gorgias's `stripped_html`
  for customer messages — trusting Gorgias to separate new content from quoted
  reply chains. The Apr 23 swap to `body_html` was reverted because re-deriving
  this client-side broke on email links inside "On … wrote:" lines and template
  markers nested in quoted blocks. Open question: does Gorgias's stripped_html
  ever cut customer sign-offs that contain shipping addresses (e.g. customer
  types "Please ship to 123 Main St" right above their name)? If a future bug
  report says "the advisor missed an address the customer clearly typed" or
  "exchange shipping address was wrong" or "refund went to old address despite
  customer providing new one in email", check the raw `body_html`/`body_text`
  via `gorgias.getTicketMessages(ticketId)` against the stored
  `conversation_history[].body` for that ticket. If the raw has the address
  and the stored doesn't, this is the cause — implement option B from the
  2026-04-27 conversation: lazy raw-fetch in the specific tool (refund_order,
  create_exchange_order) when an address is needed but the stripped body
  doesn't contain one.

## Advisor classification overridden by closing-message tone
- Parked: 2026-04-15
- Last touched: 2026-04-15
- Type: bug
- Domains: cs
- Notes: Final-message tone (e.g. "thanks!") can override operational message_type, causing refund/exchange tickets to classify as positive_feedback or general_inquiry. Observed on ticket id=7 — advisor saw customer's closing gratitude and lost earlier exchange/refund context. Fix belongs in advisor prompt (classification should reflect operational purpose, not conversational closing tone).

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
