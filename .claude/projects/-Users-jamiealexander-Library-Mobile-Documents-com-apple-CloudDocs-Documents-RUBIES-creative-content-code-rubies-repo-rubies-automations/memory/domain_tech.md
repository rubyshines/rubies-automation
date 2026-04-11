---
name: Tech & Website
description: Supabase, webhooks, Railway, sync pipelines, shared clients, Shopify storefront, custom web
type: project
---

## What's Built

**Shared Client Libraries:** Singleton clients for Supabase (with upsert helper), Shopify (GraphQL + REST + ShopifyQL + HMAC verification), Google Search Console, GA4, SendGrid, Klaviyo, JudgeMe. All created once, reused across domains.

**Webhook Server (Express on Railway):**
- Shopify (8 topics): orders create/update, customers update, inventory levels-update, fulfillments create/update, products create/update. All verify HMAC via raw body.
- Gorgias (2): ticket-created, ticket-updated. Verify via Gorgias secret key.
- Gmail: Cloud Pub/Sub push delivery → triggers email intelligence sync.
- Design: immediate 200 response before processing (critical for 10s Gorgias timeout, Shopify retry). Dead-letter logging to Supabase. Health check at /health.

**Daily Sync Runner (daily-sync-all.js):** 16 sub-pipelines run sequentially: SEO, Email, Reviews, Products, Inventory, Orders, Customers, Conversations, Finance, Shipping Zones, Fulfillment Costs, Delivery Times, Gmail Intelligence, Gmail CS Intake, Gmail Watch Renewal, Ticket Reconciliation. Consolidated SendGrid email with results.

**Email Intelligence (Gmail):** 3-tier classifier: rule-based (skip patterns, internal domain, known B2B) → Claude Sonnet batch for unknowns. Labels: internal, skip, b2b_wholesale, lgbtq_org, press, other. Incremental fetch with 6-hour overlap for safety. Thread builder with AI summaries. Routes classified emails to CS intake.

**Railway Deployment:** Nixpacks builder. Webhook server as primary service. Health check /health, 30s timeout. ON_FAILURE restart, max 5 retries. Scheduled jobs via railway.toml definitions.

**Supabase Architecture:** All tables documented in schema SQL files per domain. Supabase is state store for everything. Dotenv guard pattern lets scripts work standalone or from runner.

## Advisor Prompt Candidates

- Currently empty

## Current Status

- **Production:** Webhook server running on Railway (real-time Shopify, Gorgias, Gmail). Daily sync pipeline runs scheduled. Gmail webhook via Cloud Pub/Sub. All shared clients stable.
- **Partial:** Webhook dead-letter queue stores failures but no automatic reprocessing. Gmail Watch renewal daily but token expiry handling manual. Shopify webhook registration requires manual re-run if domain changes.
- **Gaps:** No webhook circuit breaker (high-volume events could overload). No idempotency token tracking per webhook (Shopify retries could duplicate if handler not idempotent). No CloudFront/CDN layer.

## Key Decisions

- **Architecture principles:** MCP tools are source of truth for all business logic (same result from CLI, dashboard, or poller). Supabase for state, files for config. No duplicate stores. Idempotent pipelines. Singleton clients. Schema SQL files for every table.
- **Immediate 200 response on webhooks:** Handlers run async after response. Critical for Gorgias 10s timeout and Shopify retry deadlines.
- **Daily sync as idempotency layer:** Even if webhooks miss or duplicate, daily sync runs reconciliation (last write wins via upsert).
- **3-tier email classifier:** Rule-first (zero cost), then AI batch (~$1.50/mo Sonnet). Avoids expensive per-message classification.
- **Raw body for Shopify HMAC:** Custom route-level express.raw() to avoid JSON parsing breaking signature verification.
- **Gmail push vs polling:** Cloud Pub/Sub push delivery. More efficient than hourly polling.
- **Always paginate Supabase queries:** Default 1000 row limit causes wrong analysis. Always paginate large tables.
- **Webhook + real-time sync plan:** Replace remaining polling with Gorgias + Shopify webhooks on Railway. Phase 3: move CS reads to Supabase. All phases built together.

## What's Next

- Webhook circuit breaker / rate limiting
- Idempotency tokens for webhook dedup
- Website design and development (Shopify storefront + custom)
- Complete webhook migration (replace remaining polling)
