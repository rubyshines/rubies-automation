---
name: Architecture Principles
description: Core rules for system architecture — MCP tools as source of truth, data storage patterns, pipeline design
type: feedback
---

## MCP tools are the source of truth for all business logic

All business logic lives in MCP tools (or the underlying functions they call). Everything else (pollers, dashboards, CLIs, cron jobs, UIs) is a thin interface.

**Why:** If logic lives outside the tools, it can't be tested, reused, or composed. The same operation must produce the same result regardless of which interface triggers it — CLI, dashboard, poller, API, or chat. Logic that leaks into the interface layer only works in that one context.

**How to apply:**
- When building a new feature, build the underlying function + MCP tool first. Then wire it into whatever interface needs it.
- When an interface needs to do something smart (extract data, make decisions, compose output), check if an MCP tool or its underlying function already does it. If not, add it there — don't put it in the interface.
- Interfaces provide context (conversation history, user input, previous state) as inputs to tools. They don't interpret, transform, or add logic on top of tool results.
- Pollers, sync scripts, and dashboards are transport/display layers only: fetch data, call tools, save/show results.
- During development, calling the underlying function directly (e.g. `createRefund()` instead of the `refund_order` MCP tool) is fine — it's the same code path. The MCP layer is just registration (name, schema, handler). What matters is that the logic lives in the function, not in the caller.

**Test:** For any piece of logic, ask: "Can I get this same result by calling the underlying function or MCP tool directly?" If no, the logic is in the wrong place.

## Data and infrastructure patterns

- Supabase for state, files for config — no duplicate stores
- MCP tools read Supabase; sync scripts write to Supabase
- Idempotent pipelines — safe to re-run
- Singleton clients (Supabase, Shopify, etc.) — shared across scripts
- Gradual backfill over big-bang migrations
- Schema SQL files for every table — runnable in Supabase SQL Editor
