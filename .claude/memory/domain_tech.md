---
name: Tech & Website
description: Supabase, webhooks, Railway, sync pipelines, shared clients, Shopify storefront, custom web
type: project
originSessionId: 76845f16-8454-4953-8882-a8bc486354fb
---
## What's Built

**Shared Client Libraries:** Singleton clients for Supabase (with upsert helper), Shopify (GraphQL + REST + ShopifyQL + HMAC verification), Google Search Console, GA4, SendGrid, Klaviyo, JudgeMe. All created once, reused across domains.

**Webhook Server (Express on Railway):**
- Shopify (8 topics): orders create/update, customers update, inventory levels-update, fulfillments create/update, products create/update. All verify HMAC via raw body.
- Gorgias (2): ticket-created, ticket-updated. Verify via Gorgias secret key.
- Gmail: Cloud Pub/Sub push delivery → triggers email intelligence sync.
- Design: immediate 200 response before processing (critical for 10s Gorgias timeout, Shopify retry). Dead-letter logging to Supabase. Health check at /health.

**Daily Sync Runner (daily-sync-all.js):** 19 sub-pipelines run sequentially: SEO, Email, Reviews, Products, Inventory, Orders, Customers, Conversations, Finance, Shipping Zones, Fulfillment Costs, Delivery Times, Gmail Intelligence, Gmail CS Intake, Gmail Watch Renewal, Ticket Reconciliation, AI Cost Rollup, Advisor Edit Rate, AI Pricing Check (monthly, 1st only). Sends the consolidated **daily ops digest** email (subject "RUBIES Daily Sync") with results.

**Email Intelligence (Gmail):** 3-tier classifier: rule-based (skip patterns, internal domain, known B2B) → Claude Sonnet batch for unknowns. Labels: internal, skip, b2b_wholesale, lgbtq_org, press, other. Incremental fetch with 6-hour overlap for safety. Thread builder with AI summaries. Routes classified emails to CS intake.

**Railway Deployment:** Nixpacks builder. Webhook server as primary service. Health check /health, 30s timeout. ON_FAILURE restart, max 5 retries. Scheduled jobs via railway.toml definitions.

**Supabase Architecture:** All tables documented in schema SQL files per domain. Supabase is state store for everything. Dotenv guard pattern lets scripts work standalone or from runner. **Schema changes:** write a `migrations-YYYY-MM-DD-foo.sql` file under the relevant domain (e.g. `customer-service/`). To apply: if `SUPABASE_DATABASE_URL` is set in `.env`, connect via the `pg` client and run the SQL (see [seo-tracking/backfill.js:88](../../seo-tracking/backfill.js#L88) for the pattern — `new Client({ connectionString: dbUrl })` + `client.query(sql)`); otherwise paste into the Supabase SQL Editor. All migration files should be idempotent (`IF NOT EXISTS`, constraint guards) so re-runs are safe.

**AI Observability:** Every production AI call (Anthropic + Voyage, ~20 sites across CS, Gmail, B2B, marketing, embeddings) routes through the `shared/aiClient.js` wrapper, writing one row to `ai_calls` with model_id, tokens, cost, latency, and tool calls. `lib/rollupAiCosts.js` aggregates daily into `ai_costs_daily`; the daily ops digest shows a per-component cost line, a month-to-date spend total, a spend-cap early-warning banner (`lib/aiSpendCap.js`, gated on `AI_MONTHLY_CAP_USD`), and a CS advisor edit-rate line (`lib/advisorEditRate.js` — trailing-30d % of sent drafts edited, an accuracy-drift tripwire; see domain_cs.md cadence). A monthly check on the 1st (`scripts/check-ai-pricing.js`) flags new models missing from `aiPricing.js` and pricing-rate drift. Pricing is keyed by exact model_id in `shared/aiPricing.js`.

## Current Status

- **Production:** Webhook server running on Railway (real-time Shopify, Gorgias, Gmail). Daily sync pipeline runs scheduled (18 sub-pipelines). Gmail webhook via Cloud Pub/Sub. All shared clients stable.
- **Partial:** Webhook dead-letter queue stores failures but no automatic reprocessing. Gmail Watch renewal daily but token expiry handling manual.

## Key Files

- `webhooks/server.js` — Express webhook server (Shopify, Gorgias, Gmail).
- `daily-sync-all.js` — Daily sync runner (18 sub-pipelines).
- `shared/supabaseClient.js` — Singleton Supabase client. Import: `const { getSupabaseClient } = require('../../shared/supabaseClient')`.
- `shared/aiClient.js` — universal AI-call wrapper (`callClaude`/`embedTexts`); every AI call routes through it into `ai_calls`. Pricing in `shared/aiPricing.js`.
- `shared/shopifyClient.js` — Singleton Shopify client (GraphQL + REST + ShopifyQL).
- `scripts/sb.js` — Ad-hoc Supabase query CLI: `node scripts/sb.js "sb.from('table').select(...)"`. Use instead of writing `node -e` boilerplate.
- `gmail-management/sync/` — Gmail classification and CS routing.

## Key Decisions

- **Immediate 200 response on webhooks:** Handlers run async after response. Critical for Gorgias 10s timeout.
- **Daily sync as idempotency layer:** Even if webhooks miss or duplicate, daily sync reconciles.
- **3-tier email classifier:** Rule-first (zero cost), then AI batch (~$1.50/mo Sonnet).
- **Gmail push via Cloud Pub/Sub:** More efficient than polling.
- **All AI calls route through `shared/aiClient.js`:** one wrapper, one `ai_calls` row per call, cost computed at write time from `aiPricing.js` (keyed by exact model_id so historical rows keep their charged rate). This is what makes spend attributable per-component — see also the matching rule in feedback_technical_rules.md. The trigger was a shadow-eval experiment that silently ran for weeks twice because there was no per-component cost visibility.
- **Cross-runtime toggles live in Supabase, not env vars:** runtime flags that must be consistent across the webhook server, crons, and dashboard go in `system_flags` (read via `shared/systemFlags.js`, ~60s cache), NOT env vars. The CS shadow-eval `CS_DIAGNOSTICS_DISABLED` env toggle leaked ~$9.60/day twice because it had to be set on three Railway runtimes and manually propagated (`copy-railway-vars.js`) and never reached all three. A DB flag flips everywhere at once and is queryable.

## What's Next

- Complete webhook migration (replace remaining polling)
