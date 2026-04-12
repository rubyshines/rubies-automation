---
name: Customer Service
description: AI advisor, ops dashboard, exchanges, shipping tracking, Gorgias/Gmail intake, knowledge base
type: project
---

## What's Built

**AI Advisor (Opus-based):** AI reads full conversation + calls tools as needed. Handles exchanges, sizing, shipping, product questions, positive feedback. Returns structured JSON for dashboard consumption. All business rules live in the system prompt.

**Tool Ecosystem (30+ MCP tools):** Lookup (customer, orders, products), actions (create/edit/refund orders, exchanges, wholesale orders, warehouse holds), analytics (LTV, margins, inventory, delivery estimates, reviews), knowledge (CS history search, FAQ, sizing guide).

**Dashboard (web-based):** Real-time Gorgias ticket queue with tabs (New, Follow-up, Parked, Snoozed, Closed). Operators review AI-drafted responses and approve/edit. Operator agent for complex order manipulations. Mobile-responsive PWA. Deployed on Railway at ops.rubyshines.com.

**Intake Pipeline:** Two pathways -- Gorgias ticket webhooks and Gmail CS parsing. Both feed through the AI advisor, store drafts in Supabase, and auto-assign handled tickets to "RUBIES AI" in Gorgias.

**Exchange System:** Two-phase flow. Phase 1: AI determines size, creates draft order in Shopify, shows preview with links. Phase 2: operator confirms, marks paid. Only uses FULFILLED non-cancelled orders for current size (ignores $0 exchange orders). Auto-finds correct order unless operator specifies one.

**Donation Routing:** After exchange, routes old items to LGBTQ+ partners. Geographic matching (Google Maps geocoding + haversine distance), load-balanced across 3 closest partners. Skips for defects. Full explanation of gender-affirming program in customer message.

**Knowledge Base:** 63 embedded articles (Voyage AI, 512 dims). Semantic search for product info, shipping, policies. NOT used for exchange decisions (advisor handles those directly).

**Auto Follow-ups:** Day 3 care@ via Gorgias, day 6 personal jamie@ via SendGrid, then close. Runs on 4h timer in webhook server.

## Advisor Prompt Candidates

(Track rules the advisor prompt might need. Only promote when evidence shows a gap.)

- Currently empty -- populate as gaps are identified during ticket review

## Current Status

- **Production:** AI advisor handling all ticket types. Dashboard fully operational. Intake running (Gorgias webhooks + Gmail). Auto follow-ups active. ~$0.08/conversation.
- **Validated:** 95% action accuracy on 198 held-out conversations. 60+ scenarios tested across 7 complexity tiers.
- **Partial:** Shipping tracking integration exists but delivery estimate accuracy needs ongoing validation.
- **393 unit tests passing.**

## Key Architecture

- `customer-service/lib/aiAdvisor.js` -- Main AI advisor (Opus). Exported as `aiAdvisor()`.
- `customer-service/lib/operatorAgent.js` -- Operator command agent. Exported as `operatorAgent()`.
- `customer-service/lib/sizingEngine.js` -- Product classification, size normalization, grading deltas, fabric calculations. Also contains legacy walkTree/prescribe functions (not in execution path, kept for test coverage).
- `customer-service/lib/tools/csAdvisorMcp.js` -- MCP wrappers for `cs_advisor`/`exchange_advisor` tools (thin wrappers around aiAdvisor).
- `customer-service/lib/tools/advisorTester.js` -- MCP tool for testing advisor conversations.
- `customer-service/lib/contextBuilder.js` -- Builds customer + order context from Supabase/Shopify.

## Key Decisions

- **Agentic loops, not decision trees:** Opus controls flow. Legacy tree kept as reference only in sizingEngine.js.
- **Structured output:** Advisor returns `_structured` JSON alongside customer-facing markdown. Dashboard/tester consume structured data directly (no regex parsing).
- **Exchange sizing from SKU, not variant title:** Last segment of SKU is the canonical size. Product nicknames in PRODUCT_NICKNAMES map.
- **Auto-confirm if fabric delta <=2" (one even size).** Confirm with delta explanation if >2".
- **"A bit tight/loose" = high confidence, auto-confirm.** "Too tight/loose" = unclear degree, offer options.
- **Multi-item exchanges:** Same product+size = assume all. Different product+same size+same category = ask. Never check past orders for multi-item.
- **Fabric delta wording:** Bottoms = "fabric around the waist", bras = "bra band will be X longer", other tops = "fabric around the torso".
- **"Doesn't fit" without direction:** Product-specific question (bottoms: waist tight/loose, tops: tight/loose up top, one-piece: waist + top height).
- **"Doesn't work" / "doesn't hide" on bottoms:** Expectation mismatch flow (shaping vs tucking explanation). NOT for tops.
- **Return = refund intent.** First ask what didn't work. If customer insists on second ask, process gracefully.
- **Style switch (tight legs):** Cheeky (swim), Flo Dance (kids), Sassy (adult underwear). Track through confirmation.
- **Don't ask what unit for measurements** -- just ask for the measurement.
- **CS response style:** Signature on every email. "Talk soon" (casual) vs "Take care" (more formal). Never use emdashes. Gentle approach for safety-sensitive messages.
- **Advisor prompt changes:** Always trace execution path, read audit trails, check existing rules before modifying prompts. Don't add rules that duplicate existing logic.
- **Always check stored ticket data** in Supabase before diagnosing advisor issues on a ticket.
- **Testing workflow:** Pull real conversations from Supabase, run tests directly via node (not MCP), show full order context + message/response pairs.

## What's Next

- Expand shipping scenario coverage (info/duties/address scenarios remaining after 9 tracking scenarios done)
- Validate delivery estimate accuracy against real outcomes
- Continue monitoring advisor quality on live tickets
- Follow-up cleanup: remove legacy walkTree/prescribe functions from sizingEngine.js (requires migrating their test assertions to test utility functions directly)
