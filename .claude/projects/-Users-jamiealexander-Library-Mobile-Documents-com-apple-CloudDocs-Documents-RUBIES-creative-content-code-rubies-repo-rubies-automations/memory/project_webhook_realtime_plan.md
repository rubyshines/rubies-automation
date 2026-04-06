---
name: Webhook & Real-Time Sync Plan
description: Plan to replace polling with webhooks (Gorgias + Shopify) and move CS routing reads to Supabase. Deploy on Railway. All phases built together.
type: project
---

## Goal
Replace polling-based syncs with webhooks and move the CS routing/intake layer to read from Supabase instead of Shopify. Deploy a webhook receiver on Railway. All phases built as one project.

## Current Architecture
- **Gorgias**: Poller fetches open tickets → runs advisor → writes drafts to Supabase → dashboard review → send via Gorgias API
- **Shopify**: CS tools read customer/orders directly from Shopify GraphQL (2-3 API calls per ticket). Analytics tools read from Supabase (daily sync).
- **Inventory**: Daily sync to Supabase. Exchange advisor checks stock from Supabase — can be up to 24hrs stale.
- **Conversations archive**: Daily Gorgias → Supabase sync for `cs_conversations`. Used by simulator, semantic search, dashboard stats. Not in live processing path.

## Part 1: Gorgias Webhook (replaces poller)

**What changes:**
- Gorgias fires webhook on `ticket-message-created` → Railway endpoint
- Webhook handler replaces polling loop entry point
- Still calls Gorgias API once per ticket for full message thread (same as poller does now)
- Same filter logic (skip spam, assigned to other agents, already drafted)
- Same advisor processing, draft writing, Gorgias assignment — all unchanged
- Dashboard unchanged

**Benefits:**
- Instant: drafts appear seconds after customer sends, not on next poll
- No wasted API calls scanning tickets that don't need processing
- Eliminates polling infrastructure

**Webhook payload includes:** ticket ID, customer email, message body — enough to decide whether to process without any API call.

**Security:** Gorgias webhook secret validation on all incoming requests.

## Part 2: Shopify Webhooks (inventory, orders, customers, fulfillments)

**Webhooks to register:**
- `inventory_levels/update` → upsert to `product_variants` table
- `orders/create` → insert to `orders` + `order_line_items` tables
- `orders/updated` → upsert to `orders` + `order_line_items` tables
- `customers/update` → upsert to `customers` table
- `fulfillments/create` → update order fulfillment status + tracking info in `orders` table
- `fulfillments/update` → update tracking status (delivered, exception, etc.) in `orders` table
- `products/create` → insert to `products` + `product_variants` tables
- `products/update` → upsert to `products` + `product_variants` tables

**Fulfillment data available from webhooks:**
- `fulfillment_status` (FULFILLED, PARTIALLY_FULFILLED, etc.)
- `fulfillments` array: tracking number, tracking URL, carrier, created_at
- Top-level tracking status from Shopify (shipped/in_transit/delivered)
- NOT detailed Passport events — those still require the tracking scraper

**Security:** Shopify HMAC signature validation on all incoming requests.

## Part 3: Move CS intake/routing reads to Supabase

**Scope:** The **read/routing layer** only — `buildContext()` fetches customer profile and order history to figure out what the customer is talking about and route the ticket. Does NOT change the mutation layer.

**What changes:**
- Rewrite `buildContext()` to query Supabase instead of Shopify GraphQL
- Single Supabase query returns customer + orders + fulfillment status + LTV + profitability
- Staleness safety: if customer's last sync >1 hour ago, fall back to Shopify direct

**What stays on Shopify direct (mutations + single-order reads before mutation):**
- **Exchange execution:** `createDraftOrder`, `completeDraftOrder` — needs latest state, already mutating Shopify
- **Refund execution:** `calculateRefund`, `createRefund` — must read real-time financial status before refunding
- **Order edits:** `orderEditBegin`, `orderEditAddVariant`, `orderEditCommit` — real-time order state required
- **Shipping lookup:** `getOrderByNumber()` for fulfillment details — needs live tracking info not in Supabase

These tools operate on a single specific order, need absolute latest state (was it just fulfilled? just refunded?), and are about to mutate it anyway. No benefit to reading from Supabase when you're making Shopify write calls regardless.

**Benefits (for the routing layer):**
- Faster ticket processing: one Supabase query (~50ms) replaces 2-3 Shopify calls (~500ms each) in `buildContext()`
- Richer context: single query can pull customer + orders + LTV + past conversations + profitability — data the advisor currently has no access to
- Fulfillment awareness: `buildContext()` knows if an order was shipped, when, and with which carrier — enough to route shipping inquiries correctly without a Shopify call
- No Shopify rate limit risk
- Resilience: ticket routing works even if Shopify API is slow
- Simpler mental model: reads from Supabase for context, writes to Shopify for actions

**Future enhancement:** Advisor could consult conversation history during processing ("this customer emailed 3 times about the same issue", "we already offered an exchange last week").

## What Stays the Same
- Daily sync runs as reconciliation (catches missed webhooks, fills gaps from downtime). Upserts so safe to run alongside webhooks.
- Tracking scraper still scrapes carrier pages live (detailed Passport events not available from webhooks)
- Conversation archive (`cs_conversations`) stays on daily sync — not in live processing path
- All Shopify mutations stay direct (exchanges, refunds, order edits)
- Single-order lookups for mutation tools stay on Shopify direct
- Dashboard, simulator, semantic search — unchanged
- Products sync stays daily as reconciliation (webhooks handle real-time)

## Railway Deployment
- Single service: Express/Fastify HTTP server receiving webhooks
- Endpoints:
  - `POST /webhooks/gorgias` — ticket message handler
  - `POST /webhooks/shopify/inventory` — inventory level changes
  - `POST /webhooks/shopify/orders` — order create/update
  - `POST /webhooks/shopify/customers` — customer update
  - `POST /webhooks/shopify/fulfillments` — fulfillment create/update
  - `GET /health` — monitoring
- Shared Supabase client, same env vars as existing scripts
- Logging to Railway's built-in log viewer
- Dead letter: if processing fails, write payload to Supabase queue table for retry

## Not Needed
- Burst handling — 20-40 orders/day, webhook volume is low
- Real-time conversation archive — simulator/search don't need it
