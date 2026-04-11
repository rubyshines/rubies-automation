---
name: Technical Rules
description: Cross-cutting technical patterns for building and maintaining systems — architecture, data, pipelines
type: feedback
---

## MCP tools are the source of truth for all business logic

All business logic lives in MCP tools (or the underlying functions they call). Everything else (pollers, dashboards, CLIs, cron jobs, UIs) is a thin interface.

**Why:** If logic lives outside the tools, it can't be tested, reused, or composed. The same operation must produce the same result regardless of which interface triggers it.

**How to apply:**
- Build the underlying function + MCP tool first, then wire into interfaces.
- Interfaces provide context as inputs to tools. They don't interpret, transform, or add logic on top of tool results.
- Calling the underlying function directly (e.g. `createRefund()`) is fine during development — same code path as the MCP tool.
- Test: "Can I get this same result by calling the function/tool directly?" If no, the logic is in the wrong place.

## Data and infrastructure patterns

- Supabase for state, files for config — no duplicate stores
- MCP tools read Supabase; sync scripts write to Supabase
- Idempotent pipelines — safe to re-run
- Singleton clients (Supabase, Shopify, etc.) — shared across scripts
- Gradual backfill over big-bang migrations
- Schema SQL files for every table — runnable in Supabase SQL Editor

## Always paginate Supabase queries

**Why:** Supabase default limit is 1000 rows. Queries without pagination silently truncate, causing wrong analysis and missed data.

**How to apply:** Always paginate when querying tables that could exceed 1000 rows. Don't assume a single query returns all results.

## Use agentic patterns

**Why:** Building dumb routers that just dispatch based on keywords wastes the AI's capabilities. Give the AI real tools + context and let it reason.

**How to apply:** When building an AI feature, give it the actual tool schemas (including lookup/search tools, not just action tools). Let the AI decide which tools to call and how to interpret results. Don't pre-filter or pre-route with regex.

## Temporary memory files need done_when conditions

**Why:** Memory accumulates without cleanup and becomes noise. Jamie shouldn't have to remember to tell me to clean up stale files.

**How to apply:**
- Temporary memory files must include a `done_when` field with a verifiable condition.
- At conversation start, check done_when conditions. If met, ask Jamie about cleanup.
- Prefer conditions verifiable by reading code/files over date-based expiry.
