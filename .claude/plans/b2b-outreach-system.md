# Unified B2B Outreach & Prospect System — Design Record + Remainder Spec

**Status:** Build shipped 2026-06-11 (queue, cadence engine, both advisors, `b2b_drafts`/`b2b_threads`/`b2b_messages`, send tool gated by `b2b_send_enabled`, Gmail reply correlation, dashboard Outreach panel). For what's built, the code is the source of truth — see `b2b-outreach/` and domain_b2b_sales.md. This file remains the spec ONLY for the unbuilt remainder: discovery pipeline fixes (Design #2: aiClient port, Haiku pre-filter, org routing fix, cron), affiliate onboarding flow, A/B variant evaluation loop (Design #7), and the wholesale→B2B rename (Design #9). The message-type catalog and trigger tables below are the reference if drafts drift from the locked openers.

**Last updated:** 2026-07-22 (demoted from active design SSOT after build; design locked 2026-06-04)

---

## What this is

A unified prospect-and-stay-in-touch system for all of RUBIES' non-consumer-facing relationships, replacing:

- A Google Sheet ("Main Contacts") tracked manually with two scripts in `rubies-utilities/`
- A discovery pipeline (`b2b-discovery/`) that ran once in Feb/March 2026 and stopped
- Disparate donation-partner logic, B2B wholesale orders, and community org outreach that don't share a common pipeline

**Three channels, one spine:**

1. **Retailers (B2B)** — stores that stock and sell RUBIES, or run affiliate/referral programs
2. **LGBTQ+ orgs** — orgs that purchase for community programs, receive event donations, refer members to RUBIES, or are community presence touchpoints
3. **Individual affiliates** — FB group mods, influencers, creators with relevant audiences

**Core operating concept:** every relationship behaves like a CS ticket. The advisor drafts the next outbound message. Operator steers in chat. Operator sends. State transitions. Next draft regenerates. Same dashboard, same draft+steer+send loop as the CS advisor — applied to the outbound side.

---

## Locked Decisions

These are confirmed and should not be re-litigated without data.

### Infrastructure

**1. Gmail direct, not Gorgias, for all B2B outbound.**
Gorgias is built for inbound support tickets; B2B is outbound-initiated. Wrong model, wrong pricing (ticket-volume priced = expensive at scale), wrong from-address (don't want B2B relationships mixed with help@ reputation). Gmail API direct: compose, thread, reply-correlate. New send tool, new threading tables.

**2. Supabase is SSOT. Retire the Google Sheet.**
The sheet (`1YKENjS6mJXXHUW4GeCV4kuODtEx96u-PCMkkrP0vBMM`, "Main Contacts") is the current working CRM. It gets replaced by Supabase `b2b_companies`. A one-time migration script moves it over. After that, no automation reads or writes the sheet. It stays as a historical archive.

**3. Full wholesale → B2B rename.**
Rename in memory, code, tables, and tool names. `create_wholesale_order` → `create_b2b_order`, `relationship_type='wholesale'` → `'retailer'`, `domain_b2b_sales.md` rewritten, etc. Do this AFTER new system is working and tested (lowest risk, highest churn — do it last). Exception: `pre_increase_pricing` flag stays as-is (mid-rollout, persisted in Shopify order tags).

**4. Primary operator surface: MCP tools in the ad-hoc operator console (chat-driven).**
No dedicated dashboard panel in V1. Operator asks "show me today's followups", "draft a follow-up to Kim at Spectrum", "log that I called Sarah, left voicemail". Same pattern as donation_partner_* tools. The console is already built; we add new tools to it.

**5. Affiliate commercial layer: Shopify app (Collabs / GoAffPro / Refersion).**
The app handles code generation, attribution, payout. We only own the contact/relationship layer — affiliates live in `b2b_companies` with `relationship_type='affiliate'`. No payout code in this repo.

### Architecture

**6. One continuous queue, signal-based 6-tier priority. Channel does NOT hierarchically rank.**
A retailer's hot reply beats a generic affiliate check-in regardless of channel. The signal determines urgency, not the channel. Channel defines what *triggers* each tier and the tiebreaker *within* a tier.

Six tiers (universal, in order):
1. They replied — waiting on us. No-response count = 0 + has prior thread + no draft sent since reply. Oldest unanswered first.
2. Time-sensitive channel signal: retailer = first sell-through window (14-30d post-ship) or restock signal; org = event/fundraiser within 30 days; affiliate = sales spike/drop.
3. Healthy-relationship cadence due: retailer = 30-180d post-order windows; org = quarterly touch; affiliate = monthly check-in.
4. Active prospect, warm + qualified, due. Any channel. First-touch or follow-up nudge.
5. Overdue follow-up. `next_action_date` past. Qualified lead → lead → cold. Most overdue first.
6. Cold revival / long-silent. Channel tiebreaker: retailer = LTV, org = past engagement, affiliate = past attributed sales.

Optional `channel_weight` config (default 1.0) as a tunable dial — not architecture.

**7. Channel-aware at the content layer only — one spine, three channels.**
Same data model, same queue, same send infrastructure, same operator gestures. Channels differ in: allowed states + valid transitions, message-type catalog entries, prompt templates, cadence trigger definitions, from-address, "healthy" definition.

**8. Draft + steer + send loop (inherited from CS advisor).**
Advisor reads context → drafts next message → operator steers in chat (or sends as-is) → two-phase confirm → send → state transitions → next draft regenerates. This is the battle-tested CS pattern applied to outbound. Operator authority is final.

**9. Two advisors: `b2b_prospect_advisor` and `b2b_outreach_advisor`.**
Likely (to be confirmed in Design #5). Different jobs → different prompts → different scenario sets. Sharing infrastructure (wrapper, dashboard plumbing, callClaude, cost tracking) but not prompts.
- `b2b_prospect_advisor`: reads enriched discovery data → qualification verdict + draft intro pitch
- `b2b_outreach_advisor`: reads thread history + company context → drafts next message for existing thread

**10. Gmail threading.**
Per outbound message: store `gmail_thread_id`, `gmail_message_id`, `in_reply_to`. Reply lands → classifier tags as `b2b_retailer`/`lgbtq_org`/`affiliate` → matched to thread → contact's state transitions → next draft generated → appears in queue.

**11. Existing `b2b_companies` + `b2b_contacts` Supabase tables are the spine.**
Already exist in `gmail-management/b2b-schema.sql`. Extend with missing columns (no_response_email_count, last_customer_email_*, last_us_email_*, initial/last_reach_out, campaign, primary_contact_name mirror). Don't replace.

**12. Discovery → enrich → qualify → promote → first draft in queue.**
Promotion is the seam. When a prospect promotes: new `b2b_companies` row, new `b2b_thread` (type=intro), advisor immediately drafts intro, row appears in queue as Tier 4. Original `b2b_prospects` row marked `promoted` with FK. Operator's first interaction is reviewing the draft — no separate "start outreach" step.

**13. Low-variance message types auto-send; high-variance require individual review.**
Not all messages need operator eyes. The advisor classifies each draft as `standard` (auto-send eligible) or `needs_review` (individual approval required).

- **Auto-send eligible:** low-variance types where customization is minimal and relationship is healthy — `new_collection`, `restock_alert`, `content_prompt`. Advisor flags as standard when: clean relationship history, no recent issues, product/content fit is clear.
- **Always individual review:** high-variance types where the draft depends on relationship nuance — `intro_pitch`, `intro_outreach`, `intro_invite`, `post_samples_checkin`, `reactivation`, `purchase_pitch`, `donation_closet_pitch`.
- **Advisor-flagged review:** any message the advisor marks `needs_review` regardless of type — new relationship, recent issues, product fit uncertain, anything unusual in thread history.

Operator UX for batch events (e.g. new product launch): "20 new collection emails ready — 17 standard, 3 need your review." One-click send the 17, open the 3 individually.

Drafts are only generated when an event triggers them (new product published, cadence due, reply received) — never speculatively pre-generated. This keeps generation cost tied to actual outreach volume.

---

## Audit Findings — Existing Discovery System

Run 2026-05-28 via `scripts/_b2b_discovery_audit.js`. **Read before designing the discovery pipeline.**

### Counts
| Status | Count | % |
|---|---|---|
| found (never processed) | 3,537 | 53.2% |
| dismissed | 3,005 | 45.2% |
| qualified | 76 | 1.1% |
| community-partner | 31 | 0.5% |
| **Total** | **6,649** | |

### Score distribution (2,720 researched rows)
- Heavily skewed: 2,226 scored 1 (81.8% of researched)
- Only 123 scored ≥5 (qualifying threshold) = 4.5% of researched
- 76 actually marked qualified (gap = borderline cases that didn't get promoted)
- Top scores (8-10): 25 rows — these look genuinely strong

### Key issues found

**Issue 1: System ran once and stopped.**
All 6,649 rows discovered Feb 27 – Mar 5, 2026. Nothing since. No scheduled re-run. The discovery pipeline is not a running system — it was a one-time batch.

**Issue 2: 285 dismissed community-orgs belong in the LGBTQ+ pipeline.**
The analyzer correctly classified them as `community-org` but the router dismissed them because the question was "is this a retail partner?" — the wrong question for LGBTQ+ orgs. 193 of those also have `mentions_lgbtq=true`, 117 have `mentions_trans=true`. These are the LGBTQ+ pipeline seed data sitting in the dismissed bucket.

**Issue 3: community-partner bucket (31 rows) is unused gold.**
UCLA LGBTQ Campus Resource Center, PFLAG LA, PFLAG SF, PFLAG National, William Way LGBT Community Center, DC LGBTQ+ Community Center, Life Is Work Resource Center, Prism Health North Texas, Beth Israel (gender-affirming care), North County LGBTQ Resource Center, etc. These were correctly routed but never acted on. The LGBTQ+ pipeline can start here.

**Issue 4: 3,537 "found" rows are noisy — never processed.**
Sample includes: hotels, resorts, spa retreats, clothing boutiques with no trans focus. Search terms were too broad and captured irrelevant businesses. These need a pre-filter before research runs (save Haiku/Sonnet calls on junk rows).

**Issue 5: Analyzer used Haiku directly, not through aiClient.js.**
`b2b-discovery/lib/analyzer.js` line 66: `model: model || 'claude-haiku-4-5-20251001'` called via raw Anthropic SDK. Violates the technical rule (all AI calls must go through `shared/aiClient.js` with component tag). Zero cost tracking for discovery — no rows in `ai_calls` with b2b_* components. Same issue in the rubies-utilities scripts (used `claude-sonnet-4-5` via `new Anthropic()`).

**Issue 6: discovery_progress has no city/term columns.**
293 completed searches, 10,475 raw results, but `city` and `search_term` columns are null — can't tell which geographies/terms have been covered.

### What the samples showed
- **Top 10 qualified look genuinely strong.** Gender-affirming boutiques (My Changing Room Boston, Red Vault Chicago, Cantiq LA), adult retailers with explicit trans inventory (Bondesque, Kiss & Ride ATL, HUMANITY! San Diego). The scorer + analyzer qualitatively work for retailers.
- **Borderline (score=5) is mixed.** Some real opportunities (Just Like A Woman Portland, 1 Stop Pleasure Shop Miami). Some questionable fits (Sexploratorium, LEATHER 64TEN).
- **Top dismissed by score:** Several community-orgs with score=5 correctly dismissed as "not retail" (Finn's Place, one·n·ten, Boycott Bar) — these should be LGBTQ+ pipeline, not dismissed.
- **Dismissed with high score (score=6):** (dis)obedience Denver — adult/sexual wellness but not apparel. Plausible false negative worth human review.

---

## Open Design Areas

Work through these in order. Each should produce a section in this file before implementation starts.

### Design #1 — State machine + message types ✓ LOCKED

**Relationship states: 4 universal states, same across all three channels**

```
in_contact  → outreach underway, relationship not yet established
              covers: intro drafted-not-sent, sent-no-reply, in active conversation, following up
active      → relationship established:
              retailer = placed first order
              org = enrolled in at least one program
              affiliate = code active + at least one attributed sale
dormant     → went quiet past channel-specific threshold
              (retailer ~6mo no reorder; org ~12mo no activity; affiliate ~3mo no code usage)
lost        → explicitly declined or disqualified
```

**Why only 4 states:**
- More states = edge cases when contacts skip steps (e.g. order placed before samples)
- Detail lives in threads + program flags + enrichment profile, not the relationship state
- Advisor reads thread history to know "samples were sent 2 weeks ago" — doesn't need a `samples_sent` state
- Champion dropped — it's an active org in multiple programs, expressed through data not a label
- Negotiating dropped — flat 50% off for retailers, no negotiation phase

**LGBTQ+ org model: two-layer**
- Layer 1: relationship state (the 4 above — sequential, mutually exclusive)
- Layer 2: program flags (independent, can be active simultaneously):
  - `donation_closet` — receives returned exchanges, ongoing
  - `event_donations` — receives product for events/auctions (REACTIVE ONLY — inbound requests only, no proactive outreach)
  - `purchases` — buys with inclusion/grant funding (real: Transformation Closet grant order is proof point; check Shopify for more examples)
  - `affiliate` — same Shopify app as other affiliates; commission framed as "funds for your programs" not personal income

**Giveaway:** NOT a state. A message type / tool the advisor can use at any stage as a first-touch or relationship-deepening move. Low-commitment outbound opener for cold orgs.

**Key cross-channel transition:** `in_contact (retailer)` → `in_contact (affiliate)` when inventory commitment isn't feasible. Named transition, not an edge case. Hello Gorgeous is the live example — samples sent, loved them, can't do inventory, transitioning to affiliate. Can upgrade back to retailer later.

**Entity model:** `b2b_companies` handles both companies AND individuals. Add `entity_type: 'company' | 'individual'`. Affiliates can be either (Regina = individual, Hello Gorgeous = company).

**Real affiliate prospects to add manually (pending):**
- Regina Rodriguez (reginarodriguezxoxo@gmail.com) — individual, trans, Early2Bed employee, influencer. Warm signal: already knows RUBIES via Early2Bed.
- Cassie Brighter — individual, Facebook group mod. Group name TBD (Jamie to confirm).
- Hello Gorgeous (info@hellogorgeousbrashop.com, Kim) — company, update relationship_type from wholesale → affiliate in b2b_companies.

---

**14. Three entity types, three programs, three tracks.**

Entity types:
- **Retail stores** — stock and sell RUBIES (wholesale), or refer customers (affiliate)
- **LGBTQ+ orgs** — participate in community programs (donation closet, purchase, affiliate fundraising)
- **Individuals** — influencers, group mods, creators (affiliate only)

Programs (three, not four — grant purchasing = wholesale, same 50% pricing and same `create_b2b_order` flow):
- **B2B purchase** — 50% off wholesale pricing. Retail stores buying to stock AND orgs buying with grant/inclusion funding. Same Shopify order, same tool, same fulfillment. Framing differs by entity type; mechanics are identical.
- **Affiliate** — earn commission on referred sales via Shopify app. Shared across all three entity types. Retail stores that cannot stock inventory, orgs using it as a fundraising stream, individual creators. Same onboarding flow for all.
- **Donation closet** — orgs only. Receive returned exchanges on an ongoing basis. No equivalent for retailers or individuals. Existing `donation_partner_*` tools handle onboarding.

Tracks (message types organized around these, not channel silos):
- **Retailer track** — relationship messages for stores stocking RUBIES
- **Org track** — relationship messages for LGBTQ+ orgs
- **Affiliate track** — shared across all entity types once enrolled as affiliate; retail stores that transition from wholesale join this track alongside org affiliates and individuals

Retailer→affiliate transition: when a retail store cannot commit to inventory (`relationship_type` changes from `retailer` to `affiliate`), they leave the retailer track and join the affiliate track. Retailer messages stop; affiliate messages start. Hello Gorgeous is the live example.


**15. A/B testing baked into every message type.**
The system continuously improves opener and message performance through built-in A/B testing. Not a one-off experiment — a permanent operating layer.

How it works:
- Each message type can have 2-3 opener variants (Variant A, B, C) stored alongside the canonical opener
- When the advisor generates a draft, it selects a variant (randomly or via systematic rotation)
- Every sent message records: which variant was used, message type, entity type, channel
- Primary metric: reply rate (did the message get a response?) tracked per variant
- Secondary metrics: time-to-reply, which program the reply leads to
- Operator surface: over time, show which variants are outperforming — "Variant B for org_intro is getting 2x replies vs Variant A"
- Winning variants get promoted to canonical; losing variants retired; new challengers introduced

This applies to: openers, subject lines, timing (e.g. does 21-day vs 28-day post_samples_checkin perform better), and framing variants (donation closet pitch leading with scarcity vs. leading with impact).
The infrastructure cost is low — one extra column per sent message (`variant_id`), one aggregation query for results. The compounding improvement over time is high.

---

### Message Type Catalog

Format per type: state(s) it applies to, queue tier + specific trigger condition, verbatim opener, notes.

**Rules:** Positive-only openers with verbatim templates. Negative rules drift. Each type has one opener the advisor fills in — advisor reads thread history to adjust tone for follow-up attempts, not a separate message type.

**No-reply follow-ups:** Not a separate message type. Advisor sees thread history (e.g. intro_pitch sent 10d ago, no reply) and adjusts draft tone accordingly. Same type, iteration N.

**Three tracks:** Retailer track (stores stocking RUBIES), Org track (LGBTQ+ orgs), Affiliate track (shared — retail affiliates + org affiliates + individuals). Entities move between tracks as relationships evolve.

---

#### RETAILER TRACK

**`intro_pitch`** ✓ LOCKED
- State: `in_contact` (entry point)
- Queue: Tier 4 — fires on promote from discovery pipeline
- Opener: *"Hi [name], I came across [store] and think your customers would love RUBIES. We make gender-affirming underwear and swimwear for trans women and girls — no tucking, no compression, just everyday underwear that fits right. I'd love to send you a sample kit, and whether that leads to carrying our styles or joining our affiliate program, I'm happy to explore whatever makes sense for you."*
- Notes: Two-door framing. Samples are the ask, not a commercial commitment. Affiliate mention removes the "can't hold inventory → no reply" blocker for smaller stores without underselling wholesale for strong candidates.

**`post_samples_checkin`** ✓ LOCKED
- State: `in_contact`
- Queue: Tier 2 — `samples_delivered_at IS NOT NULL AND business_days_since(samples_delivered_at) >= 5`. Fallback: if no delivery confirmation within 10 calendar days of `samples_shipped_at`, assume delivered and start the 5-biz-day clock from day 10 (fires ~15 calendar days after ship at worst).
- Opener: *"Hi [name], just checking in — did the RUBIES samples arrive okay? I'd love to hear what you think, and happy to answer any questions."*
- Notes: Delivery-triggered, not ship-date-triggered. Shopify fulfillment events (synced nightly) populate `samples_delivered_at`. Sample order is created by the outreach advisor as an operator action alongside the intro email draft — same two-phase confirm as CS advisor (advisor drafts email + proposes create sample order action, operator confirms both). `b2b_companies` carries: `samples_shopify_order_id`, `samples_shipped_at` (from fulfillment webhook), `samples_delivered_at` (from fulfillment events). V1: fields on `b2b_companies` directly; normalize to separate table only if multi-round samples becomes real.

**`first_order_checkin`** ✓ LOCKED
- State: `active` (first order only — never fires again after a repeat order is placed)
- Queue: Tier 2 — ~3-4 weeks after confirmed delivery of first order. Same delivery-trigger logic as post_samples_checkin (Shopify fulfillment events + 10-day calendar fallback).
- Opener: *"Hi [name], it has been a few weeks since your first RUBIES order arrived and I wanted to check in. How have your customers been responding? Would love to hear how it is going."*
- Notes: Relationship message, not a sales push. No reorder ask. Goal is to understand how the product landed, gather feedback, and show genuine interest in their success. If they respond positively the advisor follows up naturally in thread — the reorder nudge comes later via its own cadence. Always individual review, never auto-send.

**`reorder_nudge`** ✓ LOCKED
- State: `active` (repeat orders only — first order has its own type: first_order_checkin)
- Queue: Tier 3 — ~90d since last order. Also Tier 2 when retailer has a pending restock flag AND that SKU is now in stock — pending demand elevates priority.
- Opener: *"Hi [name], it has been a little while since your last RUBIES order. If you are running low on anything, I would love to get a restock going."*
- Restock enrichment: at nudge-generation time, advisor checks current inventory for any SKUs flagged as pending demand for this retailer. If in stock, includes in the draft body: "Also wanted to let you know [style] is back in stock — I know you asked about it before."
- Notes: General opener — no SKU callouts. Specifics belong in the reply thread. This is a commercial nudge for established retailers, not a relationship check-in.
**`new_collection`** ✓ LOCKED
- State: `active` or `dormant`
- Queue: Tier 3 — event-triggered on new product publish in Shopify. Fires for active retailers where product fits their catalog. Also fires for dormant retailers — a new product is the strongest reactivation hook because it is genuinely new information, not a generic revival ping.
- Auto-send: eligible for active retailers with clean relationship history and clear product fit. Needs-review for dormant retailers, new relationships, or uncertain product fit.
- Opener: *"Hi [name], exciting news: we just launched [product/collection] and I think your customers are going to love it. I would love to send you the details."*
- Notes: Relevance filter — advisor cross-references retailer order history against new product category. A swimwear-only retailer does not get a new underwear style email. Samples offer belongs in the draft body for dormant retailers only, not as a default line. Active retailers who have already ordered know the product quality.

**`restock_alert`** — REMOVED. Folded into `reorder_nudge` as context enrichment. When a retailer has a pending demand flag and the SKU is back in stock at nudge-generation time, the restock info is included in the nudge draft. No separate message type or alert trigger needed.

**`reactivation`** ✓ LOCKED
- State: `dormant`
- Queue: Tier 6 — ~6mo no reorder, and no new_collection event has already pulled them back.
- Opener: *"Hi [name], it has been a while and I wanted to reach out. We have launched [X] since your last order and I think your customers would love what is new. Want me to send over a look?"*
- Notes: Advisor fills [X] from actual product launches since their last order (has Shopify history + product catalog). If nothing significant has launched, falls back to: "A lot has grown since your last order — new sizing, expanded range." Tone is warm and confident — RUBIES B2B relationships have been universally positive, retailer went quiet because of timing/budget, not a problem. Advisor reads thread history for context to make the draft specific, not to look for issues. One clear CTA: "want me to send over a look" — easy yes, low commitment.

**`price_change_notice`** ✓ LOCKED (2026-06-10 — added from historical findings: the past
price-change email directly drove pre-deadline orders)
- State: `active` (and `dormant` — a deadline is a legitimate reactivation hook)
- Queue: Tier 2 — event-triggered when wholesale pricing changes are scheduled (pricing
  initiative will fire this soon)
- Opener: *"Hi [name], a heads-up before it takes effect: our wholesale pricing changes on
  [date]. Any order placed before then is at current pricing, so if you have been thinking
  about a restock, now is a great moment."*
- Notes: Port tone from the proven historical thread (see b2b-historical-findings.md) when
  writing the advisor prompt. Always individual review. Never framed as pressure — it is a
  courtesy with a real deadline.

**`sample_feedback_request`** ✓ LOCKED (2026-06-10 — recurring real motion in historical
threads; the only message type that feeds product R&D)
- State: `in_contact` or `active`, retailer and org tracks
- Queue: Tier 3 — fires ~3-4 weeks after post_samples_checkin got a reply but no order/
  enrollment followed, or on advisor judgment when a thread mentions community feedback
- Opener: *"Hi [name], I would love to hear how the RUBIES samples have been landing — what
  did [your customers / your community] think? Honest feedback helps us make these better,
  and if anyone would like to be part of our tester group, I would love that too."*
- Notes: Relationship + R&D, not a sales push. Always individual review.

**`referral_ask`** ✓ LOCKED (2026-06-10, Jamie: "for sure important")
- State: `active`, ALL tracks (retailer, org, affiliate)
- Queue: Tier 3 — advisor judgment, fired ONLY after a genuinely positive moment (first
  reorder, glowing sample/program feedback, an enthusiastic reply). Never cold, never after
  a neutral exchange. At most once per relationship per ~6 months.
- Opener: *"Hi [name], one small ask — is there anyone else you think should know about
  RUBIES? A store, an organization, a person doing this work. Referrals from people we trust
  are how our best relationships have started, and I would really value yours."*
- Notes: Referrals are the ONLY cold channel with proven wins in the entire corpus (She Bop
  and THProjekt both arrived via referral). This type deliberately cultivates the channel.
  Always individual review.

**Commercial facts (locked 2026-06-10, Jamie):** wholesale order floor is **$300 USD**
(historical emails show both $300 and $400 — $300 is current policy; goes in the advisors'
verbatim facts block).

**Considered and PARKED (2026-06-10, Jamie):** `invoice_followup` (real once — an unpaid
invoice stalled a thread — but accounting hygiene at a few invoices/quarter doesn't warrant a
message type; revisit if unpaid invoices become a pattern) and `event_partner_coordination`
(the RUBIES-hosted Pride party was bespoke relationship work that SHOULD be human-written;
the queue may remind, the words stay Jamie's).

---

#### ORG TRACK

**`intro_outreach`** ✓ LOCKED
- State: `in_contact` (entry point — single first-touch type for all org cold outreach)
- Queue: Tier 4 — fires on promote from discovery pipeline
- Opener: *"Hi [name], I am Jamie, the founder of RUBIES. We make gender-affirming underwear and swimwear for trans women and girls, and we support LGBTQ+ organizations in a few different ways: we have a donation closet program where partner orgs receive returned exchanges to pass along to community members, we make it easy for orgs with inclusion grants or program budgets to purchase directly, and we have an affiliate program where your community shops and [org] earns a commission as a real fundraising stream. Would any of those be a fit? I would love to connect."*
- Notes: Three-door framing — orgs self-select the program that fits. The reply tells the advisor which path to pursue. No giveaway in the cold intro — giveaway is a reactive fallback the advisor offers when an org replies but does not fit any of the three programs (no closet infrastructure, no grant funding, small community). Always individual review, never auto-send.
**`giveaway_offer`** — REMOVED. Folded into `intro_outreach` as the standard first-touch hook for all org cold outreach. See intro_outreach notes.
**`donation_closet_pitch`** ✓ LOCKED
- State: `in_contact` or `active` (after at least one exchange — never cold)
- Queue: Tier 3 — advisor surfaces only after determining org has an active closet program with staff/resources to manage and distribute product. Trigger is advisor judgment from thread context. Not fired from discovery data alone.
- Opener: *"One thing I wanted to mention — we have an ongoing program where returned RUBIES exchanges go directly to partner organizations to pass along to community members. We only work with a small number of partners at a time, and based on what you have shared about [org], I think you would be a great fit. Would you be interested in learning more?"*
- Notes: Formal partnership only. Org gets added to donation_partners table (existing), receives recurring supply of returned exchanges. Scarcity (limited partners) + personal selection creates urgency — program is genuinely capacity-constrained. Distinct from simple giveaway (one-time, no infrastructure needed) — do not pitch this to orgs that lack an active closet program. Always individual review.
**`purchase_pitch`** ✓ LOCKED
- State: `in_contact` or `active` (follow-up only — never cold; purchase option already mentioned in intro_outreach)
- Queue: Tier 3 — advisor surfaces when org has signalled interest in the purchase path but has not followed through (e.g. mentioned grants/budget in reply but no order placed). Also fires for active orgs who have purchased before and may have a new funding cycle.
- Opener: *"I wanted to follow up on the purchasing option I mentioned — a number of organizations we work with use inclusion grants or programmatic funding to purchase RUBIES for community members directly. If you have a budget cycle coming up or funding available, I would love to make it easy for you."*
- Notes: Same 50% pricing as wholesale B2B — same `create_b2b_order` tool, same Shopify order, same fulfillment. Framing differs (grant funding → community programs vs. wholesale → resale) but mechanics are identical. Transformation Closet is the live example. Reframe is key: this is not "buy our product" — it is "your existing grant funding can go directly to gender-affirming basics for your community."
**`event_donation_response`** ✓ LOCKED
- State: any (inbound-triggered — reactive only, no proactive outreach for event donations)
- Queue: Tier 1 — inbound event donation request received
- Opener: *"Hi [name], thanks so much for reaching out — we would love to support [event name]. Here is what we can send..."*
- Structure: (1) warm yes + confirm what we are sending and timing; (2) light mention of donation closet as a door-opener — "also wanted to mention we have an ongoing program for partner organizations if that is something [org] would find useful" — not the full pitch, just enough to invite a follow-up.
- Notes: Org reaching out for event donations is self-qualifying — they have community events, someone to coordinate, and direct member access. That is the donation closet profile. Mentioning it while saying yes is natural. Do NOT mention the purchase program in this response — they asked for a donation, adding a purchase pitch shifts energy from generous to transactional. Purchase path comes later after relationship is established. Always individual review.
**`community_checkin`** ✓ LOCKED
- State: `active`
- Queue: Tier 3 — seasonal triggers only, not calendar interval. Natural moments: Pride season (March-June), year-end giving (November-December), back-to-school (August). Cadence: orgs in an active program (donation closet, purchase, affiliate) every 6-8 months at seasonal moments. Giveaway-only orgs: annually, seasonal hook required.
- Opener: *"Hi [name], just wanted to check in and see how things are going at [org]. [Specific question or seasonal hook]. Is there anything we can do to support your work right now?"*
- Cross-program nudge: advisor checks which of the three programs (donation closet, purchase, affiliate) the org is NOT enrolled in and includes a light mention of the most relevant one. Pick one only — do not mention all missing programs. Natural logic: donation closet only → mention affiliate fundraising angle; affiliate only → mention donation closet if they have physical space; purchase only → mention affiliate; two programs active → mention third lightly if contextually appropriate.
- Notes: Advisor fills the middle with something specific — a program milestone, a seasonal angle, or a RUBIES update worth sharing. Generic check-in with no hook does not drive replies. Always individual review.
**`affiliate_invite`** ✓ LOCKED
- State: `active` (org already in donation closet or purchase program)
- Queue: Tier 3 — advisor surfaces for active orgs not yet enrolled in affiliate, after relationship is established through another program
- Opener: *"Hi [name], one thing I wanted to mention that might be useful for [org]'s fundraising — we have an affiliate program where your community can shop RUBIES using your link and [org] earns a commission on every sale. At our price points it works out to roughly $7-10 per order. Would that be worth setting up?"*
- Notes: Fundraising framing, not commission framing. Concrete number ($7-10/order) rather than vague "meaningful amounts." Org already trusts RUBIES — their community is already getting product. This is the natural next step. After they say yes: affiliate_onboarding flow via GoAffPro.

---

#### AFFILIATE TRACK

Shared across all entity types once enrolled as affiliate — retail stores that cannot stock inventory, LGBTQ+ orgs using affiliate as a fundraising stream, and individual creators. Relationship history and tone differ by entity type; the program mechanics and message types are identical.

**`affiliate_intro`** ✓ LOCKED
- State: `in_contact` (entry point for individuals only — retail stores and orgs enter affiliate via their own track intro then transition)
- Queue: Tier 4 — fires on promote for individual prospects (influencers, group mods, creators)
- Opener: *"Hi [name], I am Jamie, the founder of RUBIES. We make gender-affirming underwear and swimwear for trans women and girls, and I came across your [work/platform/group] and immediately thought you would be a great fit for our affiliate program. I would love to tell you more."*
- Notes: Only a cold first-touch for individuals. Retail stores get retailer_intro first; orgs get org_intro first. Both transition onto this track after agreeing to affiliate.

**`affiliate_onboarding`** — OPERATIONAL FLOW, not a message type
- Same flow for all entity types: send program info + physical or digital signposting → get them signed up to the GoAffPro Shopify app (selected: handles mixed individual + company/org affiliates, bank transfer payments, ~$24/mo)
- Advisor drives the flow as operator actions, not as outbound messages
- Not yet built — needs to be designed before affiliate path is fully functional

**`content_prompt`** ✓ LOCKED
- State: `active`
- Queue: Tier 3 — monthly cadence for active affiliates across all entity types
- Opener: *"Hi [name], hope you are doing well! I had a content idea for this month — [angle/hook]. Happy to send samples or anything you would need to make it happen."*
- Notes: Advisor fills the hook from context — seasonal angle, new product, a story that fits their audience. Generic prompt with no hook does not drive action. Auto-send eligible when relationship is healthy and hook is clear.

**`performance_checkin`** ✓ LOCKED
- State: `active`
- Queue: Tier 2 (sales spike or drop signal) or Tier 3 (monthly cadence)
- Opener (strong performance): *"Hi [name], just wanted to share a quick update — your link has been performing really well lately and we are so excited. Thank you!"*
- Opener (drop): *"Hi [name], checking in this month — things have been a little quieter lately on the affiliate side. Is there anything we can do differently, or anything useful I can send your way?"*
- Notes: One type, two openers — advisor picks based on performance signal. Always individual review.

**`affiliate_reactivation`** ✓ LOCKED
- State: `dormant`
- Queue: Tier 6 — ~3mo no code usage across all entity types (shorter than retailer dormant threshold because affiliate activity is easier to restart)
- Opener: *"Hi [name], it has been a little while and I wanted to reach out. We have some new styles you might love, and I would love to get things going again if you are up for it."*
- Notes: Tone adapts by entity type — warmer/community for orgs, content-focused for individuals, business-focused for retail affiliates. Advisor reads entity profile.

### Design #2 — Prospect discovery & qualification pipeline ✓ LOCKED

**Discovery strategy: three phases**
1. **Selective backlog flush (one-time):** Run cheap Haiku pre-filter on 3,537 unprocessed "found" rows ("could this business conceivably carry or promote RUBIES?"). Estimate ~60-70% culled as junk (hotels, resorts, spas). Process remaining ~1,000-1,200 through full analyzer. Expected yield: 50-60 qualified prospects for Jamie to review.
2. **Targeted sweeps:** Once qualifier is calibrated on Jamie's verdicts, run sweeps for specific gaps (new cities, tighter terms, LGBTQ+ org directories).
3. **Steady trickle:** Weekly Railway cron, new geography/term each week, deduped. Target velocity: 3-5 approved prospects/week across all channels — matched to outreach capacity.

**Feedback loop / active learning:**
- MCP tool `b2b_review_prospect` — shows one prospect at a time: website link, AI analysis, outreach angle, score
- Jamie opens website, approves (→ promote) or rejects with reason (→ dismiss, reason logged)
- Verdicts stored in `b2b_qualification_verdicts` table
- Verdicts feed back into qualifier prompt as few-shot examples (positive + negative)
- After ~20-30 verdicts: qualifier starts predicting Jamie's judgment reliably
- Eventually: auto-promote high-confidence cases, Jamie reviews borderlines only
- Review IS the promotion step — no extra work

**Immediate LGBTQ+ pipeline seed (zero new discovery needed):**
- 31 community-partner rows: re-route to LGBTQ+ pipeline immediately
- 285 dismissed community-orgs (193 with mentions_lgbtq=true, 117 with mentions_trans=true): re-evaluate and re-route
- donation_partners table (14 active partners): seed the purchase/event side
- Main Contacts sheet has existing LGBTQ+ org relationships already synced to b2b_companies

**Routing: three paths, not two**
Current system only asks "is this a retail partner?" — wrong for orgs and affiliates. New routing:
1. Brand-aligned store, willing to stock → retailer pipeline
2. Brand-aligned store, signals "can't/won't hold inventory" → affiliate pipeline (this emerges from conversation, not discovery — default is retailer candidate)
3. Community org, LGBTQ-relevant → LGBTQ+ pipeline
4. Not a fit → dismiss with reason (feeds qualifier training)

**Key cross-channel transition:** `retailer_prospect → affiliate` is a valid named transition, not an edge case. Happens when inventory commitment isn't feasible. Can upgrade back to retailer later (e.g. Hello Gorgeous). Sock Drawer Heroes and Illusions are examples of online retailers who DO commit to inventory — online vs physical is not the distinguishing factor; inventory commitment is.

**Entity model:** `b2b_companies` handles both companies AND individuals (affiliates can be either). Add `entity_type: 'company' | 'individual'` field. Same pipeline, same tools, same queue for both.

**Affiliate enrichment shape:**
- Individual: social handles + primary platform, estimated audience size + engagement quality, content fit (do they actually post about trans/gender-affirming topics?), geography, existing brand relationships, warm signal (existing RUBIES customer/employee/community member?)
- Company: why they can't/won't hold inventory, current product catalog (what's adjacent?), audience/customer base, existing affiliate relationships, web/social presence quality

**LGBTQ+ org enrichment shape:**
- Org type: community center / clinic / support group / Pride org / advocacy
- Programs they run: closet, youth, housing, health, etc.
- Donation/partnership precedent (have they worked with brands before?)
- Contact name + role (program director, executive director, etc.)
- Purchase funding signals (grants, inclusion budget, programmatic funding)
- **Bespoke arrangements (locked 2026-06-10):** one-off deals live as profile notes the
  advisor reads before drafting — NOT new schema. Known: Fenway Health gift-card
  arrangement; GRTF annual discount code. The advisor must never draft to these orgs
  unaware of their arrangement.

**Known affiliate prospects to add manually:**
- Regina Rodriguez (reginarodriguezxoxo@gmail.com) — individual, trans, Early2Bed employee, influencer. Warm signal: already has relationship with RUBIES via Early2Bed samples.
- Cassie Brighter — individual, Facebook group mod (group TBD — Jamie to confirm). Check if in existing data.
- Hello Gorgeous (info@hellogorgeousbrashop.com, Kim) — already in b2b_companies as qualified_lead/wholesale. Update relationship_type to affiliate. Warm: samples sent, loved them, call already happened.

**Fixes needed in existing code:**
- `b2b-discovery/lib/analyzer.js`: port to aiClient.js with component='b2b_prospect_enrich_retailer'
- Add pre-filter step before full research
- Fix `discovery_progress` to populate city + search_term columns
- Fix routing: community-org + LGBTQ-relevant → LGBTQ+ pipeline (not dismiss)
- Schedule the discovery cron on Railway (it ran once in Feb/March 2026 and stopped)

### Design #3 — Queue + draft generation loop ✓ LOCKED (UX deferred)

**Draft persistence — `b2b_drafts` table:**
One active draft per company at a time. Key columns: `company_id`, `thread_id`, `message_type`, `variant_id` (A/B), `subject`, `body`, `queue_tier`, `queue_reason` (human-readable), `status` (`pending` → `sent` or `dismissed`), `operator_edited` (boolean, tracks edit rate for evaluation), `generated_at`, `sent_at`. If a new trigger fires while a draft is already pending: regenerate and replace — advisor always drafts the most urgent next message, not multiple competing drafts.

**Regeneration vs. reuse:**
Reuse unless: reply received after draft generated, relationship state changed, or operator explicitly steers (steer input → regenerate). Drafts stale 7+ days auto-regenerate when operator opens them.

**"Nothing to send today":**
Companies not due for a touch have `next_action_date` in the future and no pending draft. They do not appear in the queue. Queue = companies with `status=pending` in `b2b_drafts`. No noise.

**Cron frequency — real-time + daily sweep (not daily-only):**
- Real-time: reply received → draft surfaces immediately (webhook). New product published → new_collection drafts fire immediately. Delivery confirmed → post_samples_checkin timer starts immediately. These cannot wait for a daily run.
- Daily sweep (6am): cadence triggers only — 90d since last order, seasonal checkin due, dormant threshold crossed, prospect review due. "Due today" conditions.

**State feedback loop:**
Send → write `b2b_messages` row (direction=outbound, message_type, variant_id, gmail_thread_id) → update `b2b_companies.last_outbound_at` → await reply via Gmail Pub/Sub → inbound message classified → state transitions → new draft generated → surfaces as Tier 1.

**Contact changes (especially LGBTQ+ orgs — high staff turnover):**
Detection: hard email bounce → flag `contact_unknown`; auto-reply containing "no longer with" → same flag; operator manual update. On flag: pause all outbound drafts for that company, surface as special queue item ("Contact may have left [org] — verify before sending"). Operator finds new contact, updates `b2b_contacts` as new primary. Advisor generates warm re-intro (not cold org_intro): "I wanted to reach out and introduce myself — we have been working with [org] on [program] and wanted to make sure you have our contact." Old contact stays in history, new contact is primary going forward.

**Operator interaction — dedicated queue panel (UX deferred to separate session):**
One queue panel across all B2B channels (CS stays separate — already its own system). Four action buckets: Inbox (they replied, Tier 1 — check first), Due (cadence/signal triggers, Tiers 2-5), Prospects (discovery pipeline qualify/promote decisions), Snoozed (manually deferred). Filter chips: All / Retailer / Org / Affiliate. Row shows: company name, channel chip, tier reason, draft preview snippet, message type label. Queue UX detail (visual design, interaction patterns) deferred to a dedicated session.

**Four trigger types:**

**Trigger 1 — Promote event (✓ LOCKED)**
Fires when a new entity enters `b2b_companies` ready for first-touch outreach. Three distinct scenarios:
- A. **Discovery pipeline approval:** Jamie reviews via `b2b_review_prospect` tool and approves → new `b2b_companies` row created → cold intro draft generated (retailer_intro / org_intro / affiliate_intro based on entity type) → surfaces as Tier 4.
- B. **Manual add:** operator tells console to add a known contact not in the discovery pipeline (e.g. "add Regina Rodriguez as an individual affiliate prospect") → MCP tool creates `b2b_companies` + `b2b_contacts` rows → intro draft generated → Tier 4.
- C. **Track transition:** existing `b2b_companies` entity changes `relationship_type` (e.g. retailer → affiliate for Hello Gorgeous) → transition draft generated. NOT a cold intro — advisor reads full thread history and bridges to new program: "Given the samples went well, I wanted to revisit the affiliate angle..." Draft acknowledges prior relationship.
No draft expiry for promote events — promote drafts stay valid until actioned (won't go stale in practice).

**Trigger 2 — Reply received (✓ LOCKED)**
Most important trigger. Gmail Pub/Sub fires on new inbound email → classifier checks sender against `b2b_contacts` emails → if matched, it is a B2B reply → surfaces immediately as Tier 1, does not wait for daily sweep.
Flow: match to `b2b_threads` via `gmail_thread_id` → write inbound `b2b_messages` row → advisor reads full thread including new reply → classifies reply (interested / asking question / not now / declining) → state transition if warranted (e.g. "yes to donation closet" → update `program_flags`) → generate next draft immediately.
Ambiguous replies ("this sounds interesting"): no state change, advisor drafts a response that gently moves toward specifics — advisor judgment, not a mechanical rule.
Multiple emails before we respond: dedupe — second message updates the existing thread, does not create a second draft. Advisor reads full thread including all messages when generating the response.

**Trigger 3 — Cadence trigger ✓ DRAFTED 2026-06-10 (mechanical derivation of locked
cadences — Jamie to skim, not re-decide)**

The daily 6am sweep evaluates, per company, the highest-priority due condition and generates
at most ONE draft (locked #3: one active draft per company). All conditions additionally
require: state not `lost`, no pending draft, `contact_unknown` not flagged, and
`snoozed_until` (nullable column on b2b_companies) either null or past — a snoozed company
re-enters the cadence naturally on the first sweep after its snooze lapses.

| Message type | Due condition (sweep SQL shape) |
|---|---|
| post_samples_checkin | `samples_delivered_at IS NOT NULL AND business_days_since(samples_delivered_at) >= 5 AND no prior post_samples_checkin in thread` (fallback: 10 calendar days after samples_shipped_at when no delivery event) |
| sample_feedback_request | prior post_samples_checkin got an inbound reply ≥21d ago AND state still `in_contact` (no order/enrollment) AND no prior sample_feedback_request |
| first_order_checkin | retailer order_count = 1 AND first order delivered ≥21d AND ≤45d AND no prior first_order_checkin |
| reorder_nudge | retailer `active`, last_order_at ≤ now()−90d |
| reactivation | retailer `dormant` (≥180d no order) AND no new_collection draft generated since dormancy began |
| community_checkin | org `active`, last outbound touch ≥180d, AND current date inside a seasonal window (Pride Mar 1–Jun 30; back-to-school Aug 1–Sep 15; year-end Nov 1–Dec 31). Giveaway-only orgs: ≥330d + seasonal window |
| purchase_pitch | org signalled purchase interest (program_flag candidate or thread marker) AND ≥30d since signal with no order; OR org has purchased before AND ≥330d since last purchase (annual funding cycles) |
| affiliate_invite | org `active` in ≥1 program, affiliate flag off, ≥60d since relationship became active |
| content_prompt | affiliate `active`, ≥30d since last content_prompt |
| performance_checkin (cadence form) | affiliate `active`, ≥30d since last performance_checkin |
| affiliate_reactivation | affiliate `dormant` (≥90d no attributed sales) |

**next_action_date writing:** set at send time by the send tool, per type: reorder_nudge →
+90d; community_checkin → +180d; content_prompt/performance_checkin → +30d; intro/pitch types
→ +7d (follow-up nudge window, Tier 5 if passed unanswered); reactivation types → +180d.
A reply always recomputes (Tier 1 supersedes any next_action_date). The sweep treats
next_action_date as the cheap pre-filter (`next_action_date <= today`) before evaluating the
full per-type conditions above.

**Trigger 4 — Signal trigger ✓ DRAFTED 2026-06-10 (mechanical — Jamie to skim)**

Event-driven, outside the sweep. Routing rule: every signal resolves to a set of company_ids,
then per company the same one-draft rule applies (signal draft replaces a pending
lower-tier draft).

| Signal | Source | Routing |
|---|---|---|
| New product published | existing Shopify product webhook (webhooks/server.js already receives products) → on `published` transition | active retailers with category fit (advisor cross-references order history) + dormant retailers → new_collection draft |
| Samples delivered | existing Shopify fulfillment-event sync (nightly) populates samples_delivered_at | starts the post_samples_checkin clock (consumed by sweep — no immediate draft) |
| First-order / reorder delivered | same fulfillment-event sync | starts first_order_checkin clock |
| Restock of flagged SKU | nightly inventory sync: SKU back in stock AND any b2b_companies.pending_demand_skus contains it | enriches the next reorder_nudge (Tier 3→2 promotion); no standalone draft |
| Affiliate sales spike/drop | weekly GoAffPro/attribution check: ±50% vs trailing 4-week mean | performance_checkin draft (Tier 2) |
| Reply received | Gmail Pub/Sub (Trigger 2 — already locked) | immediate, Tier 1 |
| Pricing change scheduled | manual flag set when pricing initiative fixes a date (system_flags or config) | price_change_notice drafts for all active retailers (batch event — the "20 ready, 3 need review" UX from locked #13) |

### Design #4 — Dashboard surface ✓ UNLOCKED FOR V1.1 (2026-06-11, Jamie)

Chat-first V1 lasted one interaction — Jamie wants a visual queue. Building the panel:
an "Outreach" section in the existing CS dashboard. Rows: tier badge, channel chip, company,
message-type label, reason, draft snippet. Filters: All / Retailer / Org / Affiliate. Row
click → draft view (subject, body, facts-to-verify, commitments) with Regenerate-with-steer,
Dismiss, Snooze, and Send (two-phase; shows the b2b_send_enabled gate state plainly while
off). Endpoints are thin wrappers over b2b-outreach libs. Console tools remain (same
operations, two surfaces).

Original open questions (for reference):
- One queue or two? (outreach queue + "prospects to review" queue are different mental modes)
- Where does the new tab live in the existing dashboard?
- What does a row look like? (company name, channel chip, tier/reason, draft preview snippet, next action label)
- Filter chips: All / Retailer / LGBTQ+ / Affiliate, and "Tier 1-2 only" toggle
- Prospect review sub-queue: separate tab showing enriched prospects awaiting qualify/reject decision
- Does the operator chat panel look the same as CS action-chat? (probably yes — same component)

### Design #5 — Advisor split ✓ LOCKED

Two advisors for the B2B system. Prospect vs. outreach is not the right split — each advisor handles its own prospecting through ongoing relationship.

**Sales Advisor (`b2b_sales_advisor`)** — retailers and affiliates, commercial relationships. Cold qualification through ongoing cadence. Prompt is commercial: product fit, margins, inventory commitment, reorder timing, affiliate performance. Cost tracking: `component='b2b_sales_advisor'`.

**Community Advisor (`b2b_community_advisor`)** — LGBTQ+ orgs, mission-driven partnerships. Cold qualification through ongoing program management. Prompt is relational: mission alignment, program capacity, funding cycles, staff turnover, framing commission as fundraising not commerce. Cost tracking: `component='b2b_community_advisor'`.

**Shared infrastructure:** same wrapper, same callClaude, same cost tracking pattern, same draft+steer+send loop, same queue plumbing. Advisors share tools — any advisor can call any tool (b2b_get_company, b2b_get_thread, b2b_search_prospects, etc.). Tools are agent-agnostic by design.

**Scenario bootstrapping:** pull historical Gmail threads for known B2B and org contacts (Design #7) before writing either prompt. Successful threads become positive examples; stalled threads become negative examples. Do not write prompts until this analysis is done.

**Context:** These are two of the eight advisors in the RUBIES advisor architecture (see CLAUDE.md). They share the supervisor coordination model — when Sales and Community touch the same entity (e.g. a store with an affiliate enrolled org contact), supervisor routes.

### Design #6 — Gmail send flow

**From-address ✓ LOCKED (2026-06-10, Jamie): `jamie@rubyshines.com` for all three tracks.**
Founder-personal is the brand's superpower — every converting historical thread was Jamie
personally; orgs respond to "I'm Jamie, the founder" (it's the locked intro_outreach opener).
A fresh partners@ would start with zero sender reputation (deliverability risk) and add Gmail
plumbing for no relationship gain. Jamie's inbox is the transport, not the workspace — the
engine reads and routes replies into the queue. Revisit only if volume outgrows the name.

**Send-flow spec ✓ DRAFTED 2026-06-10 (mechanical — Jamie to skim):**

- **`send_b2b_email` MCP tool** (agent-agnostic, two-phase like every order tool):
  - Phase 1 (no `confirmed`): inputs `{ company_id, thread_id?, message_type, variant_id?,
    subject?, body }` → returns rendered preview (resolved recipient from b2b_contacts
    primary, falls back to general_email; subject derived from thread if replying). No send.
  - Phase 2 (`confirmed: true`): sends via Gmail API as jamie@rubyshines.com (proper
    `In-Reply-To`/`References` headers when thread_id present) → writes `b2b_messages` row →
    updates `b2b_drafts.status='sent'`, `b2b_companies.last_outbound_at`, `next_action_date`
    (per Trigger-3 table) → returns gmail ids.
- **Schemas:**
  - `b2b_threads`: id, company_id, thread_type (intro/order/program/support), subject,
    gmail_thread_id UNIQUE, status (open/closed), created_at, last_message_at.
  - `b2b_messages`: id, thread_id, company_id, direction (outbound/inbound), message_type,
    variant_id, gmail_message_id UNIQUE, in_reply_to, sent_at, from_email, to_email,
    body_text, created_at. The UNIQUE gmail_message_id is the idempotency key (Pub/Sub is
    at-least-once).
- **DRAFT-CHECKPOINT DEDUPE (hard requirement from b2b-historical-findings.md):**
  `b2b_messages` outbound rows are written ONLY by `send_b2b_email` at send time — NEVER
  synced from the Gmail Sent folder. (Gmail auto-save persists draft checkpoints that look
  like multiple sent messages — one historical thread showed 64 "sent" rows for ~4 real
  sends; any sync-based approach poisons reply-rate metrics and A/B data.) Manual
  out-of-band sends by Jamie are reconciled by the reply-correlation path only (a thread
  whose latest inbound references an unknown outbound gets a placeholder outbound row,
  flagged `manual_send`).
- **Reply correlation:** Gmail Pub/Sub → sender match against b2b_contacts.email +
  b2b_companies.general_email → gmail_thread_id match to b2b_threads (fallback: create
  thread if sender known but thread new) → insert inbound b2b_messages (idempotent) →
  classifier tags reply intent + checks for inbound-order shape (known B2B sender + line-item
  content → route as inbound order with parse_wholesale_input prefill, Tier 1) → state
  transition if warranted → advisor drafts next message → queue Tier 1.
- **Multiple topics, same contact:** separate `b2b_threads` per topic (thread_type); new
  topic = new email thread (fresh subject), never buried in an old thread.

**Inbound order handling (added 2026-05-29):**
Retailers send orders by email or by pasting a PDF/email into the operator. Currently Jamie routes these manually through the ad-hoc operator console using `parse_wholesale_input` + `create_wholesale_order`. In the B2B system this should be first-class.

When an inbound email from a known B2B contact contains an order, the Gmail classifier should recognize it as an inbound order event and route it into the B2B queue. The advisor parses the order (same `parse_wholesale_input` logic), surfaces it as a two-phase confirm — operator reviews the parsed line items, confirms, order placed, confirmation sent back to retailer. Same pattern as a CS ticket action. No manual copy-paste routing required.

This is an inbound thread type, not an outbound message type. Design #6 must specify how the Gmail classifier distinguishes inbound order emails from general replies.

**General email + contact email (added 2026-06-06):**
Every `b2b_companies` row stores a `general_email` (info@, hello@, the front door) alongside the individual contact in `b2b_contacts`. This applies to all entity types — retailers and orgs alike. When a contact is flagged `contact_unknown` (hard bounce, "no longer with" auto-reply), the advisor drafts a re-intro to the general email to find the new contact rather than pausing outreach entirely. For retailers the general email is often the same as the contact email — store it anyway for consistency and fallback.

### Design #7 — Evaluation strategy

**Historical conversation analysis (run BEFORE writing advisor prompts):**
Pull all Gmail threads involving known B2B and LGBTQ+ org contacts (email addresses from `b2b_companies` + `b2b_contacts` + `donation_partners`). Run a Claude Code analysis pass — not production API, run locally so token cost is not a constraint.

Per thread, extract:
- Message type (what kind of outreach was this?)
- Did it get a reply? How quickly?
- How many touches before relationship advanced?
- What was the key moment that moved it forward?
- What objections came up? How were they handled?
- Language/tone that worked vs. fell flat

Aggregate findings:
- Real opener performance data — A/B baseline before we launch a single message
- Common objection patterns and how they resolved (feeds advisor prompt)
- Timing patterns (how long from first touch to first order / program enrollment)
- Gaps in message type catalog — did historical conversations reveal types we haven't designed?
- Scenario set for advisor evaluation (successful threads become positive examples, stalled threads become negative examples)

Source data:
- **B2B retailers:** Gmail threads for all email addresses in `b2b_companies` (synced from Main Contacts sheet). Substantive dataset — real history of retailer relationships from first touch through orders.
- **Donation partners:** Gmail threads for the 14 active partners in `donation_partners`. Smaller but real.
- **LGBTQ+ orgs:** No compiled contact list exists yet. Discovery pipeline has org URLs but most are cold prospects with no prior conversation. Org advisor prompt writing relies primarily on design decisions, not empirical history. Gap to fill over time as org relationships are established.
- `rubies-utilities/scripts/update-sales-leads.js` output — AI-generated follow-ups from the old system and whether they landed.

**This analysis gates advisor prompt writing.** Do not write outreach advisor prompts until findings are in.

**Standard evaluation (after historical analysis):**
- For prospect advisor: qualification scenario set from audit (known-good and known-bad enriched rows)
- For outreach advisor: initial bar is operator approves draft without editing — measure edit rate
- Minimum bar before go-live: run 10 real prospects through prospect advisor, Jamie grades each draft
- Eventually: holdout with judge scoring (same framework as CS advisor)

### Design #8 — Migration order ✓ LOCKED (2026-06-10, Jamie)

**Warm first. Cold never — until the engine proves itself on friendlies.**
Learn on relationships that can absorb a clumsy email; spend the unforgiving ones last.
Capability-first spine (build once for all three channels), exercised in this contact order:

1. **Phase 1 — warm (engine shakedown + highest-conversion plays):** the 17 active donation
   partners, the ~12 live org contacts missing from b2b tables (backfill is a Phase-1
   prerequisite — see b2b-historical-findings.md), and existing retailers (reorder_nudge +
   first_order_checkin — the She Bop arc validated this motion end-to-end). Includes the
   inclusion-funding purchase_pitch to existing partners: the single highest-conversion play
   in the design.
2. **Phase 2 — warm-adjacent:** the 285 mis-dismissed LGBTQ+ orgs (re-routed) + 31
   community-partner rows. Mission-aligned, never contacted. Variant tracking from message
   one (no cold baseline exists — confirmed empirically).
3. **Phase 3 — cold retailers:** discovery/analyzer output. One-shot ammunition; only after
   engine + templates + pre-flight judge panels are proven on forgiving traffic.

Rationale anchored in b2b-historical-findings.md: zero cold-intro history exists (nothing to
calibrate cold sends against); warm threads (She Bop, THProjekt) both converted; org failure
mode is follow-through, not messaging — which the queue/cadence engine directly fixes.

### Design #9 — Wholesale → B2B rename + cleanup

Do this last. Details already in the earlier plan section. Wait until:
- All new code is written and tested
- Green tests guard the rename
- `pre_increase_pricing` flag rollout is complete (check status before starting)

---

## Files Worth Reading Before Implementing

Discovery pipeline:
- [b2b-discovery/discover.js](b2b-discovery/discover.js) — entry point
- [b2b-discovery/lib/analyzer.js](b2b-discovery/lib/analyzer.js) — AI analysis (uses Haiku direct, needs aiClient.js port)
- [b2b-discovery/lib/scorer.js](b2b-discovery/lib/scorer.js) — lead scoring logic
- [b2b-discovery/schema.sql](b2b-discovery/schema.sql) — retailer_prospects + discovery_progress tables

Existing CRM spine:
- [gmail-management/b2b-schema.sql](gmail-management/b2b-schema.sql) — b2b_companies, b2b_contacts
- [gmail-management/sync/syncB2bContacts.js](gmail-management/sync/syncB2bContacts.js) — ingest from sheet + Klaviyo + donation form

Operator console (canonical patterns to follow):
- [customer-service/lib/tools/donationPartners.js](customer-service/lib/tools/donationPartners.js) — template for new tool modules
- [customer-service/lib/operatorTools.js](customer-service/lib/operatorTools.js) — where to register new tools (3-line change)
- [customer-service/lib/operatorAgentStandalone.js](customer-service/lib/operatorAgentStandalone.js) — standalone console agent
- [customer-service/server.js](customer-service/server.js) — MCP server tool registration

CS advisor (patterns to inherit):
- [customer-service/lib/aiAdvisor.js](customer-service/lib/aiAdvisor.js) — draft+steer+send loop, structured output, shadow eval
- [customer-service/lib/operatorAgent.js](customer-service/lib/operatorAgent.js) — operator agent, two-phase confirm

Shared infrastructure (must use):
- [shared/aiClient.js](shared/aiClient.js) — all AI calls go through here with component tag
- [shared/supabaseClient.js](shared/supabaseClient.js) — singleton Supabase client

Rubies-utilities (source of existing logic to port, NOT to keep running):
- `rubies-utilities/scripts/update-sales-leads.js` — Gmail fetch, AI analysis, cadence formula
- `rubies-utilities/scripts/generate-next-10-followups.js` — priority queue logic (6 tiers, port this)

---

## What We Are NOT Doing

- No Gorgias for B2B outbound
- No dedicated dashboard panel in V1 (MCP tools in operator console only)
- No payout/attribution code for affiliates (Shopify app handles that)
- No backwards-compatibility shims during the rename
- No rebuilding the discovery scraper from scratch (fix routing + pre-filter, keep the working parts)
- No new memory files for this project until implementation is complete and ready to merge into domain files
