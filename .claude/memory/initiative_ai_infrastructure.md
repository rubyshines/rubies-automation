---
name: ai-infrastructure
description: "Building the plumbing for an AI-forward company — MCP tools, sync pipelines, webhooks, dashboard, memory system"
metadata: 
  node_type: memory
  type: project
  domains: 
    - cs
    - finance
    - b2b_sales
    - marketing
    - product_design
    - inventory
    - logistics
    - community
    - tech
  last_updated: 2026-05-27
  originSessionId: 6dac20eb-938c-4580-b59e-5f35c46acc87
---

## Goal
Build the foundational systems for an AI-forward company so the business can scale without hiring.

## Phases
- Core MCP tooling (30+ tools) — complete
- Sync pipelines (18 sub-pipelines) — complete
- Webhook infrastructure (Shopify, Gorgias, Gmail) — complete
- Ops dashboard — complete, continuously improving
- AI observability (every AI call tracked in `ai_calls`, per-component daily cost, spend-cap + pricing-drift alerting) — complete (May 2026)
- Memory system & Claude co-operator — active

## Current Status
Active, ongoing. Core systems built and running. Continuously expanding capabilities across all business domains.

## Decisions Made
- Opus-only for all AI features
- MCP tools as source of truth for all business logic
- Supabase for state, Shopify as source of truth for products
- Railway for deployment
