# RUBIES Automations — Claude Memory

## Project Overview
- Node.js automation scripts for RUBIES gender-affirming underwear brand
- Root: `/Users/jamiealexander/Library/Mobile Documents/com~apple~CloudDocs/Documents/RUBIES creative content/code/rubies-repo/rubies-automations`

## Key Files
- `shared/supabaseClient.js` — `getSupabaseClient()` + `upsert()` (singleton, shared across all scripts)
- `shared/googleSheetsClient.js` — Google Sheets access
- `.env` — real secrets (never commit)
- `.env.example` — template (committed)
- `package.json` — npm scripts + dependencies

## Supabase
- URL and SERVICE_KEY already in `.env`
- All tables documented in `seo-tracking/supabase-schema.sql`

## npm Scripts
- `npm run backfill` — SEO backfill
- `npm run daily-seo-tracking`
- `npm run daily-sales-report`
- `npm run wholesale` — retailer lead gen CLI

## Wholesale / Retailer Lead Gen System
- Spec: `RETAILER-LEAD-GEN-SPEC.md` (in ~/Downloads)
- Directory: `wholesale/`
- Step 1 (COMPLETE): Foundation + scraper
  - `wholesale/schema.sql` — run once in Supabase SQL Editor
  - `wholesale/discover.js` — main CLI
  - `wholesale/lib/config.js` — env/config loader
  - `wholesale/lib/db.js` — Supabase wrapper (prospects + progress tables)
  - `wholesale/lib/dedup.js` — domain/placeId dedup logic
  - `wholesale/lib/scraper.js` — two-stage scraper (simple HTTP → Puppeteer fallback)
  - `wholesale/lib/contactFinder.js` — email/phone/form extractor

### Test Commands (Step 1, no API keys needed)
```bash
node wholesale/discover.js --scrape-test --url "https://sockdrawerheroes.com"
node wholesale/discover.js --contact-test --url "https://sockdrawerheroes.com"
```

### Step 1 Design Decisions
- Puppeteer browser instance recycled every 10 pages (memory management)
- Rate limiting: 1s between domains, 2s same-domain subpages
- Content truncated to 15,000 chars for AI analysis
- Contact form URLs resolved to absolute before storing
- `website_domain` and `google_place_id` are the two dedup keys

## Customer Service MCP Server
- Directory: `customer-service/`
- MCP server (stdio transport) registered as `rubies-cs` in `~/.claude/settings.json`
- Uses same Shopify auth as `shared/shopifyClient.js` (SHOPIFY_STORE_URL + SHOPIFY_PASSWORD)
- `customer-service/server.js` — entry point, registers 22 tools
- `customer-service/lib/shopify.js` — GraphQL client (queries + mutations, NOT ShopifyQL)
- `customer-service/lib/productCache.js` — loads catalog from Supabase at startup, fuzzy search
- `customer-service/sync/syncProducts.js` — syncs products + variants from Shopify → Supabase (`products` + `product_variants` tables)
- `customer-service/products-schema.sql` — products + product_variants tables + `get_product_catalog()` RPC
- Tools: lookup_customer, get_customer_orders, get_order_details, search_products, get_product_catalog, create_exchange_order, create_wholesale_order, parse_wholesale_input, create_invoice_order, send_draft_order_invoice, klaviyo_campaigns, klaviyo_campaign_content, klaviyo_flows, klaviyo_list_stats, cs_search_history, cs_search_faq, cs_get_knowledge, cs_get_sizing_guide, cs_log_conversation
- Exchange orders: two-phase (phase 1 creates draft + preview, phase 2 confirms + marks paid). Phase 1 auto-creates the draft order in Shopify and shows clickable admin links.
- Wholesale/invoice orders: also two-phase confirmation (`confirmed` boolean param)
- **CRITICAL for exchanges:** When determining sizes (e.g. "one size down"), ONLY look at FULFILLED, non-cancelled orders. Ignore unfulfilled $0 exchange orders — they are previous exchanges, NOT the customer's current size. NEVER pass `original_order_id` unless the user gives an explicit order number — let the tool auto-find the correct fulfilled order. The tool validates fulfillment status and rejects non-fulfilled orders.
- Exchange preview shows clickable links to both the original order and the draft order
- **Presentation preferences:** Always say "draft order" explicitly (not just "order") when creating exchanges. Include the shipping address in the exchange preview.
- Wholesale: US/AU 50% off, others 30% off, free shipping, AU auto-splits at $1k AUD
- Currency override: hello@sockdrawerheroes.com always USD
- **Size system:** Two sizing systems in catalog:
  - "Youth Size" (numeric): 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16 — AJ, Charlie, Brooke, Ruby (these also have letter sizes)
  - "Size" (letter-only): XXS, XXS+, XS, XS+, S, M, L, 1X, 2X, 3X, 4X — Ava, Cheeky, Sassy
  - Aliases: XL→1X, XXL→2X, 3XL→3X, 4XL→4X, 5XL→5X
  - Numeric-to-letter (for letter-only products): 10→XXS, 11→XXS+, 12→XS, 13→XS+, 14→S, 16→M
  - `productCache.js` handles all normalization automatically in `searchProducts()`

## Customer Service AI Knowledge Base
- `customer-service/lib/embeddings.js` — Voyage AI embedding wrapper (voyage-3-lite, 512 dims)
- `customer-service/lib/tools/csHistory.js` — cs_search_history, cs_search_faq (semantic search of past conversations)
- `customer-service/lib/tools/csKnowledge.js` — cs_get_knowledge, cs_get_sizing_guide (knowledge base + sizing)
- `customer-service/lib/tools/csAdmin.js` — cs_log_conversation (feedback loop)
- `customer-service/supabase-schema.sql` — pgvector-enabled tables (cs_conversations, cs_messages, cs_knowledge_base, cs_faq_patterns, cs_import_progress)
- `customer-service/knowledge/*.md` — Curated knowledge articles (sizing, policies, shipping, care, wholesale)
- `customer-service/import/` — Import pipeline (Gorgias, Tidio, categorizer, seeder)
- Embeddings: Voyage AI (voyageai.com), env var `VOYAGE_API_KEY`
- Gorgias: env vars `GORGIAS_DOMAIN`, `GORGIAS_API_KEY`, `GORGIAS_EMAIL`
- npm scripts: cs-seed-knowledge, cs-import-gorgias, cs-import-tidio, cs-categorize, cs-embed, cs-import-macros
- Supabase RPC functions: cs_search_conversations, cs_search_knowledge, cs_search_faqs (cosine similarity)

## Klaviyo Integration
- `shared/klaviyoClient.js` — singleton API wrapper, uses built-in `fetch`, no new deps
- `customer-service/lib/tools/klaviyo.js` — 4 MCP tools for email marketing stats + content (hit API directly, not Supabase)
- API: `https://a.klaviyo.com`, revision `2024-10-15`, auth via `KLAVIYO_API_KEY` env var
- **Removed (2026-03-12):** Per-customer Klaviyo enrichment (syncKlaviyo) and klaviyo_flows table — were write-only, never consumed. Klaviyo columns dropped from customers table.
- Daily email tracking pipeline (`email-tracking/daily-email-tracking.js`) still syncs `klaviyo_daily_metrics` + `klaviyo_campaigns` tables

## Unified Customer + Order Sync
- `customers` table (email PK) — unified profile across Shopify, Gorgias, Tidio
- `orders` + `order_line_items` tables — synced from Shopify, dual-currency (shop + presentment)
- Schema: `customer-service/orders-schema.sql` (includes migration from cs_conversations)
- Sync script: `customer-service/sync/syncAll.js` (--orders, --customers, --all)
- `shopify.js` has `fetchOrdersForSync()` (comprehensive dual-currency query) and `getCustomerProfile()`
- npm: cs-sync-orders, cs-sync-customers, cs-sync-all, cs-sync-full
- Helper RPCs: `get_customer_profile(email)`, `get_conversation_orders(order_numbers)`, `find_orders_by_item(title, variant)`, `refresh_customer_aggregates()`

## Unified Daily Sync Runner
- `daily-sync-all.js` — runs all 8 pipelines sequentially, sends one consolidated SendGrid email
- Pipelines: SEO, Email, Reviews, Products, Inventory, Orders, Customers, Conversations
- Each pipeline exports `async run()` returning `{ sources: { [name]: { success, rowsWritten, error } }, status }`
- Dotenv guard pattern: `if (!process.env.SUPABASE_URL) require('dotenv')...` lets scripts work standalone or from runner
- npm: `daily-sync-all`
- `customer-service/sync/syncConversations.js` — daily Gorgias import + embedding, skips gracefully if no Gorgias creds

## AI CS Agent — Exchange System Built, Needs Refactor
- [Exchange decision rules from Jamie](project_exchange_decision_rules.md) — Measurement triage, multi-item checks, donation routing, refund policy (captured 2026-03-20)
- **Architecture:** AI parser (Sonnet) → deterministic decision tree → response composition with tone samples
  - `customer-service/lib/decisionTree.js` — 7-phase deterministic tree (safety, customer ID, orders, actions, sizing, order creation, donation) + pre-purchase sizing
  - `customer-service/lib/tools/exchangeAdvisor.js` — MCP orchestrator: AI intake parser + routing by message_type + tree + tone samples. Tools: **cs_advisor** (primary), exchange_advisor (alias), log_donation_routing
  - `customer-service/lib/tools/conversationTester.js` — MCP tool: **test_cs_conversation** (primary), test_exchange_conversation (alias)
- **Message type routing (cs_advisor):**
  - exchange/refund/defect/wrong_item → exchange decision tree
  - sizing_inquiry → pre-purchase sizing (prescribePrePurchaseSizing)
  - shipping → tracking lookup (PLANNED — see shipping subsystem)
  - order_modification/product_question/wholesale → stub, routes to human
  - positive_feedback → warm acknowledgment
- **Pre-purchase sizing (BUILT 2026-03-27):**
  - Measurement → size recommendation via find_size_by_measurement RPC
  - Cross-product reference sizing ("I wear 8 in the AJ, what size Ruby?") with odd-size awareness
  - Kid/adult detection from measurement + height + third_party context
  - One-piece: analyzeOnepieceFit() — exact/wiggle/separates recommendations
  - Shared helpers: getChartCategory, lookupHeightVariant, analyzeOnepieceFit, getSeparatesText, formatMeasurementDisplay, getMeasureLocation, KID_LABELS
- **Data seeded in Supabase:**
  - 94 size chart entries + 65 grading rules (from 8 rubyshines.com size guide pages)
  - 13 donation partners (US:9, CA:3, CH:1) with load-balanced routing + geocodes for geographic proximity
  - 26 active exchange decision rules (reviewed by Jamie)
  - 51 tone samples (Jamie's actual phrasing by situation)
  - cs_tone_samples table + get_tone_samples() RPC
- **Validated:** 95% action accuracy on 198 held-out conversations, 63% size match on first message
- **Refactor COMPLETE:** Advisor returns `_structured` JSON. Tester consumes it directly (no regex). Dead code removed. EXCHANGE-DECISION-TREE.md deleted (code is the tree).
- **Scenario testing in progress** — see plan file `structured-twirling-lecun.md` for full list + priority order
- **Key design decisions (from Jamie):**
  - Auto-confirm if fabric delta ≤2" (one even size). Confirm with delta if >2".
  - "A bit tight/loose" or "next size up" = high confidence, auto-confirm
  - "Too tight/loose" = unclear degree, offer options
  - Multi-item: same product+size = assume all. Different product+same size+same category = ask. Never check past orders.
  - Fabric delta wording: bottoms="fabric around the waist", any bra="bra band will be X longer", bikini top band, other tops="fabric around the torso"
  - Donation: always full explanation about LGBTQ+ program. Skip for defects. Wash instructions only for named partner (not local donation).
  - "Doesn't fit" without direction → product-specific question (bottoms: waist tight/loose, tops: tight/loose up top, one-piece: waist + top height)
  - "Doesn't work" / "doesn't hide" on bottoms → expectation mismatch flow (shaping vs tucking explanation). NOT for tops.
  - Return = refund intent. First ask what didn't work. Second ask (insists) → process gracefully.
  - Style switch: tight legs → Cheeky (swim), Flo Dance (kids), Sassy (adult underwear). Track through confirmation.
  - Sizes from SKU (last segment), not variant title. Product nicknames in PRODUCT_NICKNAMES map.
  - Don't ask what unit for measurements — just ask for the measurement.
  - Geographic donation routing via Google Maps Geocoding API.
  - Unit tests at `customer-service/test/`. Run before/after changes.
- npm: cs-seed-donation-partners, cs-extract-exchange-rules, cs-review-exchange-rules, cs-extract-tone, cs-seed-size-charts
- KB: 63 articles embedded. Embeddings useful for non-exchange CS (product info, shipping) but NOT needed for exchange decisions (tree handles those)
- Embeddings confirmed 512 dims (voyage-3-lite), consistent everywhere

## Shipping Tracking Subsystem (PLANNED 2026-03-27)
- [Shipping subsystem plan](project_shipping_subsystem_plan.md) — Full plan approved, not yet built
- Carriers: USPS (~80% US), OnTrac (~20% US), Passport (all international incl. Canada)
- Zones: DDP (AU/NZ/UK/EU, duties pre-paid), DDU (rest of world), Canada, US
- Passport since Aug 2025 — all international. Pre-May 2025 customs complaints are legacy.
- Approach: scrape tracking pages + Sonnet summarize + unfulfilled order investigation
- Sync shipping zones/rates from Shopify DeliveryProfile API → shipping_zones table

## AI Sanity Check Layer
- [Sanity check rules](project_sanity_check_rules.md) — Inconsistencies caught during testing, will become the AI review stage prompt
- [Scenario testing plan](project_scenario_testing_plan.md) — Ordered tier list from simple→complex, testing progress

## Brand & Content
- [RUBIES Brand Values & Voice](user_brand_values.md) — Value prop, personality (playful/respectful, confident/approachable, NOT political/righteous/judgmental), three messaging pillars. Source: Brand House PDF
- [Blog Writing Guidelines](feedback_blog_writing.md) — Goals: community-first + SEO traffic. Use data to pick topics, brand voice for tone, real reviews for social proof. Register published posts in Supabase to avoid duplication.

## Feedback
- [Architecture Principles](feedback_architecture_principles.md) — MCP tools are source of truth for all business logic (same result from CLI, dashboard, or poller); Supabase for state, files for config; no duplicate stores; idempotent pipelines; singleton clients; schema SQL files for every table
- [Never manually parse CSV data](feedback_no_manual_csv_parsing.md) — always pass raw CSV to `parse_wholesale_input`
- [Name & Pronoun Sensitivity](feedback_name_pronoun_sensitivity.md) — Never use Shopify profile names (dead name risk). Default they/them. Detect self-vs-third-party buyer.
- [Save plans to memory before clearing](feedback_save_plans_to_memory.md) — Plans are ephemeral; persist to memory before /clear
- [Temp memory files need done_when](feedback_temp_memory_cleanup.md) — All WIP memory files must have verifiable cleanup conditions; proactively check and clean up

## IRAP 2026 Project
- [IRAP 2026 Proposal](project_irap_2026.md) — AI ops automation project, Lisa Borneaz (ITA), May-Dec 2026, ~$135K/$70K IRAP. Prep docs at `~/Downloads/IRAP-Meeting-Prep.html`

## Webhook & Real-Time Sync Plan
- [Webhook & Real-Time Sync Plan](project_webhook_realtime_plan.md) — Replace polling with Gorgias + Shopify inventory webhooks on Railway. Phase 3: move CS reads to Supabase.

## Hybrid CS Advisor
- [Hybrid Advisor Status](project_hybrid_advisor_status.md) — Opus + deterministic tools, in production. ~$0.08/convo. Replaces decision tree. Poller uses with tree fallback.

## Dependencies
- `@supabase/supabase-js`, `dotenv`, `googleapis`, `@google-analytics/data`
- `@sendgrid/mail`, `pg`, `puppeteer` (v22, bundles Chromium)
- `@modelcontextprotocol/sdk` (MCP server for CS tools)
