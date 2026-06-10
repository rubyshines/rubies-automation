---
name: Customer Service
description: AI advisor, ops dashboard, exchanges, shipping tracking, Gorgias/Gmail intake, knowledge base
type: project
originSessionId: 327e54a2-8e87-46eb-aca3-d44cd69bb1b2
---
## What's Built

**AI Advisor (Opus-based):** AI reads full conversation + calls tools as needed. Handles exchanges, sizing, shipping, product questions, positive feedback. Returns structured JSON for dashboard consumption (including `message_type`, `customer_sentiment`, `summary`, `history_summary`). All business rules live in the system prompt. Injects recent related exchange/refund/defect tickets via history_summary for second-round follow-up context.

**Tool Ecosystem (30+ MCP tools):** Lookup (customer, orders, products), actions (create/edit/refund orders, exchanges, wholesale orders, warehouse holds), analytics (LTV, margins, inventory, delivery estimates, reviews), knowledge (CS history search, FAQ, sizing guide).

**Dashboard (web-based):** Real-time Gorgias ticket queue with tabs (New, Follow-up, Parked, Snoozed, Closed) plus global ticket search across all statuses by customer name/email/order number/summary. Operators review AI-drafted responses and approve/edit. Operator agent for complex order manipulations. Ad Hoc Operator tab: context-free queries and actions against all CS tools (Opus, ephemeral history). Mobile-responsive PWA. Deployed on Railway at ops.rubyshines.com.

**Intake Pipeline:** Two pathways -- Gorgias ticket webhooks and Gmail CS parsing. Both feed through the AI advisor, store drafts in Supabase, and auto-assign handled tickets to "RUBIES AI" in Gorgias.

**Exchange System:** Two-phase flow. Phase 1: AI determines size, creates draft order in Shopify, shows preview with links. Phase 2: operator confirms, marks paid. Only uses FULFILLED non-cancelled orders for current size (ignores $0 exchange orders). Auto-finds correct order unless operator specifies one.

**Donation Routing:** After exchange, routes old items to LGBTQ+ partners. Geographic matching (Google Maps geocoding + haversine distance), load-balanced across 3 closest partners. Skips for defects. Full explanation of gender-affirming program in customer message.

**Knowledge Base:** 63 embedded articles (Voyage AI, 512 dims). Semantic search for product info, shipping, policies. NOT used for exchange decisions (advisor handles those directly).

**Auto Follow-ups:** Event-driven off Gorgias snooze expiry. Stage 1: care@ via Gorgias ("just following up"), re-snoozes 3d. Stage 2: personal jamie@ via SendGrid (quotes original response), closes ticket. Customer reply during snooze resets stage to 0; replies to Stage 2 stay in Gmail (intake skips them).

**Unnotified Pre-Order Outreach (auto-drafter):** Detects unfulfilled orders containing a paid item at inventory ≤ 0 whose line item lacks the `Pre-order` customAttribute. Classifies each order A/B/C, composes per-case outreach with restock ETA from variant metafields, seeds a pending CS Advisor draft via `seedOutboundDraft()`. Each candidate verified against live Warehance `ready_to_ship` before flagging. Runs inside the daily order alerts cron. See [reports/lib/unnotifiedPreOrder.js](../../reports/lib/unnotifiedPreOrder.js).

## Current Status

- **Production:** AI advisor handling all ticket types. Dashboard fully operational. Intake running (Gorgias webhooks + Gmail). Auto follow-ups re-enabled (event-driven off Gorgias snooze expiry). ~$0.39/draft, ~$0.60/ticket (~$107/month).
- **Validated:** 95% action accuracy on 198 held-out conversations. 60+ scenarios tested across 7 complexity tiers.
- **Partial:** Shipping tracking integration exists. Delivery estimate accuracy needs ongoing validation.

## Key Files

- `customer-service/lib/aiAdvisor.js` — AI advisor entry point (Opus). All CS business rules live in its system prompt.
- `customer-service/dashboard/public/app.js:16-87` — Operator touch-time timer (`_focusAccumulated`, 60s idle, localStorage persistence). Fires on every terminal action (send, release, close, snooze, park, delete, spam); server writes to `cs_ai_drafts.focus_time_seconds`. Stats page + daily email surface total time on CS per day/week.
- `customer-service/lib/operatorAgent.js` — Operator command agent for dashboard.
- `customer-service/lib/followUp.js` — Two-stage auto follow-up engine (Stage 1 care@ via Gorgias, Stage 2 jamie@ via SendGrid + close).
- `webhooks/handlers/gorgiasTicketUpdated.js` — Snooze-expiry trigger for follow-ups; routes to Stage 1 or Stage 2 by `follow_up_stage`.
- `customer-service/lib/contextBuilder.js` — Builds customer + order context from Supabase/Shopify.
- `customer-service/lib/tools/` — MCP tool implementations (30+ tools).
- `customer-service/dashboard/` — Ops dashboard (web UI).
- `customer-service/intake/` — Gorgias webhook + Gmail intake processing.
- `customer-service/drafter/tickets-schema.sql` — Schema source of truth for CS tables. Read before querying — don't guess columns. Draft content lives on `cs_ai_drafts`, not `cs_tickets`.

## Key Decisions

- **Agentic loops, not decision trees:** Opus controls flow. All exchange/sizing/response rules live in the advisor prompt, not in code.
- **Structured output:** Advisor returns `_structured` JSON alongside customer-facing markdown. Dashboard consumes structured data directly.
- **Exchange sizing from SKU, not variant title:** Last segment of SKU is the canonical size.
- **Advisor prompt changes:** Always trace execution path, read audit trails, check existing rules before modifying. Don't add rules that duplicate existing logic.
- **Always check stored ticket data** in Supabase before diagnosing advisor issues on a ticket.
- **Testing workflow:** Pull real conversations from Supabase, run tests directly via node (not MCP).
- **Gorgias writes before Supabase writes:** Call Gorgias first and let errors propagate; only update `cs_tickets` after Gorgias confirms. Never wrap the Gorgias call in try/catch — that causes silent split-brain between the two systems.
- **Drift sync is a diagnostic, not a fixer:** `gorgiasAdvisorResync.js` spots sync issues so you can fix the underlying bug. Never schedule it or use it to backfill.
- **message_type taxonomies are separate:** `cs_tickets.message_type` is the canonical inquiry category (10-value list in [lib/messageTypes.js](../../customer-service/lib/messageTypes.js)). `intake_state.message_type` (inside structured_output JSONB) is a separate sub-taxonomy for sizingEngine item-level decisions. Don't conflate — non-canonical values coerce to `uncategorized`.
- **Related ticket injection:** contextBuilder pulls the most-recent closed exchange/refund/defect ticket (60d window) with a populated `history_summary`; advisor injects it as `[PRIOR TICKET]`. Legacy tickets without a summary are excluded. No lazy summary generation.
- **Auto follow-ups are event-driven, dedup by `follow_up_stage`.** Trigger is the Gorgias `ticket-updated` webhook on snooze-expired→open. Stage advances on `cs_tickets.follow_up_stage`; customer replies reset to 0. Stage 1 sent as AI bot so intake skips it; Stage 2 closes the ticket. Never re-introduce a polling timer.
- **Tool calls precede customer-facing prose.** The advisor saves only the last round's text blocks, so prose written before a tool call is dropped. Rule: planning narration before tool calls is fine, but the customer-facing email must be written entirely in the final round after all tool results. Same rule applies to the operator agent.
- **Outbound-initiated tickets are modeled as snoozed-after-reply.** `status='snoozed'`, `initiated_by='operator'`, `has_agent_reply=true`; seeded draft with `source='operator_outreach'`, `status='sent'`, empty `draft_response`, `sent_response=body`. Normal snooze-expiry follow-up plumbing applies with no extra state. See [customerOutreach.js](../../customer-service/lib/customerOutreach.js).
- **Single-draft outreach stages with NULL `gorgias_ticket_id`; Gorgias created lazily on send.** `create_outreach_ticket` composes one Opus draft and seeds `cs_tickets`/`cs_ai_drafts` rows with null Gorgias id. On send, `apiSendDraft` creates the Gorgias ticket and back-fills both rows. Use for single bespoke drafts needing review before any external write; use `sendIncidentOutreach` for batch sends.
- **Per-incident outreach pattern: durable substrate + one-off driver.** Build a per-incident driver in `scripts/_<incident>-outreach.js` and hand the order list to `sendIncidentOutreach()` ([customerOutreach.js](../../customer-service/lib/customerOutreach.js)). Handles Gorgias creation, pipeline registration, snooze, and `order_alert_notes`. Modes (flags, not env vars): default print-only, `--test-send`, `--send`. The driver + template is one-off; the outreach infrastructure is permanent.
- **Operator note overrides pre-order auto-classification in the daily report.** An unresolved operator note pulls an order out of the silent Pre-Orders bucket into actionable/waiting flows. Implemented in [reports/dailyOrderAlerts.js:236](../../reports/dailyOrderAlerts.js#L236).
- **`order_alert_notes.alert_type` records intake pipeline, not state-kind.** Values: `'unfulfilled'`, `'shipping'`. Don't introduce values for operator states — use note text and Gorgias tags instead.
- **Completed operator actions are filed inline in the ticket timeline.** Each completed action appends to `cs_ai_drafts.actions[]` (append-only JSONB) with `executed_at`, `action_type`, `summary`, `links`. Dashboard weaves these chronologically as non-interactive yellow blocks. `action_result` is the in-flight scratchpad, cleared on completion.
- **Pre-order detection reads Shopify line item customAttributes, not just product tags.** The Pre-Order Now app stamps each line item with a `Pre-order` customAttribute containing the target date. Tag alone misses historical orders where the tag was removed after the window closed — the line item attribute persists.
- **Help-center FLOW transcripts are parsed directly.** Gorgias flow messages pack the whole interaction into one help-center message with `meta.origin==='flow'`. `extractCleanBody` detects the flow marker and parses via `cleanHelpCenterBody` (drops bot copy, keeps customer input). Direct help-center messages that use `>` quoting keep the normal reply-parser path.
- **Gmail intake claims its row atomically.** Pub/Sub is at-least-once; `processMessage` does a conditional `UPDATE email_messages SET processed_at = NOW() WHERE processed_at IS NULL` as its first action — only one concurrent caller wins. Secondary defense: checks Gorgias for existing open tickets by email.
- **Default shipping speed is `standard` across all order-creation tools.** `create_order`, `create_invoice_order`, `create_exchange_order`, `create_wholesale_order` all default to `standard`. Operator must explicitly pass `shipping_speed: "expedited"` to upgrade.
- **`update_shipping_speed` works on Shopify drafts and placed Warehance orders.** Pass a draft name like `"D6720"` (string with leading D) for draft updates; numeric input hits Warehance. Refuses when the draft is `COMPLETED`.
- **All order-creation tools accept an explicit `shipping_address` override.** Beats the customer default address and (for exchanges) the original-order address. Shared helper in [orderUtils.js](../../customer-service/lib/orderUtils.js).
- **Ad Hoc Operator PDF handling: extract text server-side, native fallback for image-only PDFs.** `POST /api/console/extract-pdf` runs `pdf-parse` v2; text-extracted PDFs inline as text; PDFs with <200 chars extracted fall back to a native Anthropic `document` block (cap 20 pages, 5 MB upload cap).
- **Operator agent hard-stops on infrastructure errors.** Distinguish infrastructure errors (GraphQL errors, 5xx, stack traces, fetch failures) from business-outcome errors (order not found, OOS). Infrastructure errors → reply once with error excerpt and stop; no workaround attempts.
- **`consolidate_orders` merges two unfulfilled orders without cancel/refund.** Adds dropped order's items to keeper at 100% discount, placeholder-fulfills dropped order, refunds shipping if combined subtotal meets threshold. Two-phase preview/confirm. Refuses on partial-fulfillment, Warehance `in_progress`, or different customers. See [consolidateOrders.js](../../customer-service/lib/tools/consolidateOrders.js).
- **Unnotified pre-order outreach is detection + outreach, not channel blocking.** Unpublishing from Shop channel hides all variants including in-stock ones, so we detect and stage outreach instead. Detection runs on the daily cron to avoid racing Warehance allocation. Idempotent via an `author='auto'` unresolved `order_alert_notes` row with a 14-day staleness guard.
- **`action_type` taxonomy is operator-write verbs, mostly 1:1 with tools.** Values: `exchange` / `refund` / `exchange+refund` / `free_order` / `order_modification` / `warehouse_hold` / `cancellation` / `customer_profile_update` / `discount_code` / `split_shipment` / `order_consolidation` / `invoice_kept_items`. Adding a new action_type requires: matching MCP tool in `operatorTools.js`, whitelist in `aiAdvisor.js parseStructured`, and dashboard prefill in `app.js`.
- **Operator agent confirmation handling: tool call mandatory, never re-preview.** On any confirm signal, the agent's next action MUST be the same tool from the phase-1 preview with `confirmed: true`. Never re-show the preview or narrate.
- **Advisor-proposed warehouse holds execute at intake, not on operator command.** `autoExecuteAdvisorHold` in processGorgiasTickets.js calls `handleWarehouseHold` synchronously when `action_type === 'warehouse_hold'` and files the result in `draft.actions[]`. `holdAlreadyPlaced` in operatorAgent.js reads `draft.actions` only — `draft.action_type` is a proposal, not an execution.
- **Refund/cancellation confirmations never state an exact dollar amount.** Both customer-facing draft and `operator_action_summary` omit the figure; the tool computes the real amount. Exception: `invoice_kept_items` and custom refunds (DDP duties) still pass an explicit amount.
- **One-click "Execute & Send" runs operator action and sends draft in background, gated on AUTO_CONFIRM verdict.** Auto-confirms phase 2 only when verdict is SAFE AND exactly one clean awaiting-confirmation write was previewed. HOLD on divergence, question, error, or multi-write. Action before send; phase-2 failure sends no email; send failure after successful action is a half-state (action filed, draft still pending). See [dashboard/server.js](../../customer-service/dashboard/server.js).
- **Accuracy-eval ground truth: Jamie's sent reply.** Compare `draft_response` to `sent_response`. For ACTIONS, ground truth is what the sent prose says was done — not `cs_ai_drafts.actions[]` (incomplete). Verify factual claims against DB/catalog, not the draft.
- **Validate advisor prompt/tool changes with order-independent scenario tests, not live regen.** Re-running on historical tickets is confounded by order-state drift. Use synthetic scenarios in [test/scenarios/](../../customer-service/test/scenarios/); add a pinned scenario for every validated fix.
- **DB hard facts override KB/memory; advisor looks them up.** Authoritative facts live in DB tables (shipping_zones, product_variants, order_delivery_times). Advisor must use tools (`shipping_info`, `delivery_estimate`, `compare_products`) and state only what they return. The KB (`cs_knowledge_base`) is NOT read by the advisor — feeds `cs_get_knowledge` on other surfaces only.
- **Delivered-but-not-received handled directly.** Advisor states tracking facts, confirms full ship-to address (now in order context), suggests checking around, offers reship, sets `needs_info`. Never tells customer to file a carrier claim on first contact.
- **`pending_operator` / On Me tab: ticket state where Jamie owes the response.** "On Me" moves ticket to `pending_operator` + snoozes Gorgias without sending; auto-follow-up is suppressed. Customer reply returns ticket to `open`. Implemented in `gorgiasTicketUpdated.js` and `dashboard/server.js`.
- **Donation routing copy — use tool's `response_text` as-is, no state-conditional framing.**
- **Fulfilled-order notes surface in Waiting on Response.** Unresolved `author != 'auto'` notes for already-shipped orders are included via `fetchFulfilledOrphanNotes`. Resolve with `resolve_order`.
- **Unnotified pre-order detection — timing gate + per-order Warehance check.** Orders are candidates only after 5pm Pacific on the next business day from placement. Verification uses each order's `ready_to_ship` field from the Warehance order API. See `reports/lib/unnotifiedPreOrder.js`.
- **Accuracy-sweep cadence is change-driven, surfaced at orient.** Last sweep: **2026-05-27** (China-window May 8–25, 200 drafts; branch `cs-accuracy`). Recommend a new sweep when ≥~8 commits have touched the advisor OR ≥~150 new sent drafts have accumulated under a stable prompt OR substantive-edit rate rises above baseline (~28.5% prose edited, ~6% factual).
- **Operator touch time is accumulated keyboard/mouse time, not elapsed time.** 60s idle pauses it; tab hide pauses it; localStorage persists across reloads. Captured on every terminal action; summed across drafts for per-ticket totals. Headline metric is total time on CS per day/week (stats page + daily email).

## What's Next

- Expand shipping scenario coverage (info/duties/address scenarios remaining)
- Validate delivery estimate accuracy against real outcomes
