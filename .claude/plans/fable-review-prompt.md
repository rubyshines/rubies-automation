# RUBIES Automations — Deep Review Prompt for Fable

*Copy everything below the line into Fable as your opening message.*

---

## Who you're reviewing for

I'm Jamie Alexander, solo founder of RUBIES (rubyshines.com) — a company making gender-affirming underwear and swimwear for trans girls and women. I run the business without employees, working with Claude as my primary co-operator and engineer. I'm a lifelong coder and serial entrepreneur. I built this system myself over roughly 18 months with Claude Code.

The codebase lives at `/Users/jamiealexander/Code/rubies-repo/rubies-automations`. You should read files directly — start broad (structure, key files) then go deep wherever the review pulls you.

---

## What I want from you

Do a deep, honest review of everything I've built and everything I'm trying to achieve. Not a summary of what exists — I know what exists. I want:

1. **Challenge my assumptions.** Where am I solving the wrong problem? Where does the stated architecture contradict what I've actually built?
2. **Find token and cost waste I haven't found.** I've already identified some (see below). What's left?
3. **Tell me what you can do that previous models couldn't.** You're a new model. What specific capabilities do you have that would change this architecture if I used them properly? Where am I leaving capability on the table?
4. **Prioritise the next 30 days.** What's the highest-leverage work? I have limited time — rank it.
5. **Suggest refactoring if needed.** I'm not attached to what's been built. If the architecture needs rethinking, say so with specifics and a migration path.

Ask me questions before forming conclusions. Challenge me when you find a contradiction. I want friction.

---

## The business

**RUBIES:** Patented no-tuck shaping technology for trans women and girls. Looks, wears, and feels like regular underwear and swimwear.

**Strategic goal:** Build AI tooling so the business can scale without hiring. Claude becomes a true co-operator — knowing everything, making decisions, filling roles.

**Business priorities (April 2026 review):**
1. Build AI tooling — reduce operating time, increase capability
2. Automate customer service — reduce ~1hr/day Jamie CS time
3. Drive new revenue — SEO, pricing, content
4. Expand B2B and LGBTQ+ partnerships
5. Meta-goal: Claude as true business co-operator

---

## Architecture philosophy

These are the principles I've been building to. Challenge them if you disagree.

**AI-first, not code-first:** When the AI makes a wrong decision, fix the prompt — not the code. No deterministic pre-processing, regex, or counters to work around AI mistakes. Two exceptions only: (1) mechanical lookups the AI can't do (resolving email to Shopify customer ID requires an API call), (2) deterministic calculations (size charts, pricing math).

**Clear prompts + capable model + real tools** — this is the whole stack. No middleware reasoning layers.

**Agentic loops, not decision trees:** Opus controls flow. All business rules live in the advisor system prompt.

**MCP tools as source of truth:** All business logic lives in tools. Interfaces (dashboard, dashboards, crons, UIs) are thin wrappers — they provide context as input, they don't interpret results.

**Model selection:** Opus (claude-opus-4-6) for all AI-powered decision-making features. I ran a shadow evaluation for 6+ days and found Sonnet 4.6 had a 30% B_worse rate. Sonnet+thinking had mean 2.67 on a 1-5 scale (3 = tied with Opus). Both not viable. Infrastructure to re-test a new model is preserved and ready.

**All AI calls route through `shared/aiClient.js`** — one wrapper, one row per call to `ai_calls` table (model, tokens, cost, latency). This is how spend is attributable per-component.

---

## What's built

### CS Advisor (the centrepiece — start here)

An Opus-based AI that reads full customer conversations, calls tools, and returns structured JSON drafts for operator review via a web dashboard.

**File:** `customer-service/lib/aiAdvisor.js` (2,053 lines)

**System prompt stats:**
- 16,473 tokens total
- 9,600 — rules
- 3,900 — 51 tone samples (verbatim example emails)
- 1,500 — tool descriptions
- 500 — product links

**Performance:**
- ~$0.39/draft, ~$0.60/ticket, ~$107/month total
- 95% action accuracy on 198 held-out conversations, tested across 60+ scenarios in 7 complexity tiers
- SSE streaming deployed — perceived latency ~1-2s to first visible text
- Prompt caching deployed but effectively a no-op: 44% of drafts arrive with >5min gap from the next request, so the Anthropic cache (5min TTL) has expired. At current volume (~6 unique tickets/day) requests rarely cluster within a cache window.

**Tool catalog:** ~40 tools in `customer-service/lib/tools/`:
- Lookup: `customerLookup.js`, `productSearch.js`, `inventory.js`, `csHistory.js`, `csKnowledge.js`
- Actions: `createOrder.js`, `editOrder.js`, `refundOrder.js`, `exchangeOrder.js`, `cancelOrder.js`, `discountCode.js`, `consolidateOrders.js`, `splitShipment.js`, `updateCustomer.js`
- Analytics: `ltv.js`, `margins.js`, `deliveryEstimate.js`, `reviews.js`
- Knowledge: `shippingInfo.js`, `shippingLookup.js`, `donationPartners.js`
- Plus sizing tools built directly into aiAdvisor.js (fabric delta, size charts, adjacent sizes)

**Structured output format:** The advisor returns `_structured` JSON alongside the customer-facing draft. The dashboard reads `message_type`, `customer_sentiment`, `action_type`, `status`, `confidence`, `summary`, etc. directly. Accuracy is judged partly by whether these structured fields are correct.

**Other CS systems:**
- `customer-service/dashboard/` — web dashboard at ops.rubyshines.com. Ticket queue tabs: New, Follow-up, Parked, Snoozed, Closed, On Me (pending_operator). Touch-time tracking per ticket.
- `customer-service/intake/` — Gorgias webhooks + Gmail CS parsing, both feed the advisor
- `customer-service/lib/followUp.js` — event-driven follow-ups (Stage 1: care@ via Gorgias; Stage 2: personal jamie@ via SendGrid + close)
- `customer-service/lib/operatorAgent.js` — separate Opus agent for complex order actions

### Broader infrastructure

**Webhook server** (`webhooks/server.js`): Express on Railway. Shopify (8 topics), Gorgias (2), Gmail (Cloud Pub/Sub). Immediate 200 response before async processing — critical for Gorgias's 10s timeout.

**Daily sync pipeline** (`daily-sync-all.js`): 19 sub-pipelines run sequentially. SEO, Email, Reviews, Products, Inventory, Orders, Customers, Finance, Shipping Zones, Fulfillment Costs, Delivery Times, Gmail Intelligence, Gmail CS Intake, Gmail Watch Renewal, Ticket Reconciliation, AI Cost Rollup, Advisor Edit Rate, AI Pricing Check. Sends a consolidated daily ops digest email.

**Shared clients** (`shared/`): Singleton clients for Supabase, Shopify (GraphQL + REST + ShopifyQL), SendGrid, Klaviyo, JudgeMe, Google. All `aiClient.js` routes through the AI wrapper.

**Data domains with sync pipelines:** `b2b-discovery/`, `competitor-pricing/`, `finance/`, `gmail-management/`, `inventory-tracking/`, `klaviyo-tracking/`, `reports/`, `review-tracking/`, `seo-tracking/`

**AI observability:** `ai_calls` table captures every production AI call (model, tokens, cost, latency). Daily rollup to `ai_costs_daily`. Per-component cost line in daily ops digest. Spend cap warning.

---

## Eight advisors — the long-term architecture

The goal is one advisor per business domain, all sharing infrastructure, orchestrated eventually by a supervisor agent:

1. **CS Advisor** — inbound customer support → *built, running*
2. **Sales Advisor** — retailers + affiliates → *in design*
3. **Community Advisor** — LGBTQ+ org partnerships → *in design*
4. **Marketing Advisor** — campaigns, content, Klaviyo → *data syncs exist, no advisor yet*
5. **Merchandising Advisor** — product design, production, inventory, logistics → *tools exist, no advisor yet*
6. **Finance Advisor** — pricing, margins, financial decisions → *data syncs exist*
7. **Creative Advisor** — brand, visual design, UX
8. **Tech Advisor** — engineering, systems, website
9. **Supervisor** — Jamie for now; eventually an orchestrating agent

---

## Known inefficiencies (already on my radar)

Don't just repeat these back — find what I haven't found:

1. **System prompt is 16K tokens.** 51 tone samples = ~3,900 tokens. Plan to curate to ~25 (saves ~2K/call). Never executed.
2. **Prompt caching is a no-op at current volume.** Already analysed — not worth optimising until volume grows.
3. **MCP tool catalog is organically grown.** ~75 tools total across all domains. No coherent naming convention, mixed I/O shapes, vendor-mapped not domain-mapped.
4. **Shadow eval infrastructure is idle.** `cs_diagnostic_runs` table, `scripts/analyze-shadow-runs.js`, and the shadow eval code in `aiAdvisor.js:runShadowEvaluation()` are all preserved and ready to re-run. Currently disabled via `CS_DIAGNOSTICS_ENABLED=true` opt-in gate.
5. **Sonnet advisor_20260301 beta tool untested.** Anthropic released a beta pattern where Sonnet runs the agentic loop and calls Opus as a tool when stuck. Potentially $70-80/month savings. Untested. Reference: Anthropic's "The Advisor Strategy" blog post.
6. **Closeness-to-final judge not built.** The shadow eval uses an Opus judge to compare A vs B, which has self-preference bias. A better method: score each candidate against Jamie's final sent message (ground truth). The infrastructure for this was designed but the judge function was never built.
7. **`cs_conversations.category` is null on all recent records.** Classification not running. Limits conversation analysis.
8. **Knowledge base has stale/wrong articles.** `cs_knowledge_base` has wrong shipping facts. The advisor doesn't read it directly, but it's accessible via the `cs_get_knowledge` MCP tool.

---

## What I'm most uncertain about

1. **Is 95% accuracy good enough to justify reducing human review?** Currently Jamie reviews every draft. At what quality threshold does it make sense to auto-send certain ticket types? What would that detection system look like?
2. **Is the single-advisor architecture the right shape?** Each of the 8 domains is currently either one advisor or nothing. Should some domains be multi-agent internally?
3. **What does the supervisor agent actually look like?** Currently "Jamie is the supervisor." What's the first concrete version of an orchestrating agent? What does it own, what does it escalate?
4. **Are there inference patterns I'm not using?** Extended thinking, multi-turn structured reasoning, context-efficient retrieval — I've been building with basic tool-use + agentic loops. What am I missing?
5. **Is the "fix prompts not code" rule being applied too broadly?** There may be cases where deterministic pre-processing would be cleaner and more reliable than relying on the model to do something trivial.

---

## Your review deliverable

Structure your output however makes sense, but I want:

- **Findings that surprised you** — things I haven't raised that deserve attention
- **Direct challenges** — where you think my approach is wrong, with your alternative
- **Specific token/cost improvements** — with rough estimates
- **The 30-day priority list** — what to build or change first, and why
- **Questions for me** — anything you need to know before forming a recommendation

Don't pad this with summaries of what I told you. Get to the substance.

Codebase path: `/Users/jamiealexander/Code/rubies-repo/rubies-automations`

Start by reading:
1. `CLAUDE.md` — full architecture philosophy and guardrails
2. `customer-service/lib/aiAdvisor.js` — the system prompt is the heart of the CS advisor (search for `const SYSTEM_PROMPT` or similar)
3. `customer-service/lib/tools/` — the tool catalog
4. `shared/aiClient.js` — the AI wrapper
5. `daily-sync-all.js` — the sync pipeline structure

Then ask me anything before writing conclusions.
