---
name: AI Infrastructure
description: Building the plumbing for an AI-forward company — MCP tools, sync pipelines, webhooks, dashboard, memory system
type: initiative
domains: [cs, finance, b2b_sales, marketing, product_design, inventory, logistics, community, tech]
last_updated: 2026-09-09
originSessionId: 6dac20eb-938c-4580-b59e-5f35c46acc87
---

## Goal
Build the foundational systems for an AI-forward company so the business can scale without hiring.

## Phases
- Core MCP tooling (well over 100 tools across CS, finance, B2B, merchandising, marketing) — complete, growing
- Sync pipelines (daily-sync-all sub-pipelines) — complete
- Webhook infrastructure (Shopify, Gorgias, Gmail) — complete
- Ops dashboard — complete, continuously improving
- AI observability (every AI call tracked in `ai_calls`, per-component daily cost, spend-cap + pricing-drift alerting, monthly bill reconciliation) — complete
- Memory system & Claude co-operator — active

## Current Status
Active, ongoing. Core systems built and running. Continuously expanding capabilities across all business domains; the advisor model per domain (CS, Sales, Community, Marketing, Merchandising, Finance, Creative, Tech, Supervisor) is the long-term operating shape.

## Decisions Made
- Right model for the task: Opus for anything customer-facing, money-moving or multi-tool agentic; Sonnet for fail-closed classification and tone polish; Haiku for pre-filter culls (policy in CLAUDE.md)
- MCP tools as source of truth for all business logic; tools are agent-agnostic
- Supabase for state, Shopify as source of truth for products
- Railway for deployment
