---
name: Technical Rules
description: Cross-cutting technical patterns for building and maintaining systems — architecture, data, pipelines
type: feedback
originSessionId: ab0af39f-342c-41e0-af0a-92e9d280f04e
---
## MCP tools are the source of truth for all business logic

All business logic lives in MCP tools (or the underlying functions they call). Everything else (pollers, dashboards, CLIs, cron jobs, UIs) is a thin interface.

**Why:** If logic lives outside the tools, it can't be tested, reused, or composed. The same operation must produce the same result regardless of which interface triggers it.

**How to apply:**
- Build the underlying function + MCP tool first, then wire into interfaces.
- Interfaces provide context as inputs to tools. They don't interpret, transform, or add logic on top of tool results.
- Calling the underlying function directly (e.g. `createRefund()`) is fine during development — same code path as the MCP tool.
- Test: "Can I get this same result by calling the function/tool directly?" If no, the logic is in the wrong place.

## All AI calls route through shared/aiClient.js

Every production Anthropic or Voyage call MUST go through `callClaude`/`embedTexts` in [shared/aiClient.js](../../shared/aiClient.js) with a `component` tag — never the raw SDK (`new Anthropic()` / `client.messages.create()` / direct Voyage fetch).

**Why:** The wrapper writes one row per call to `ai_calls` (model_id, tokens, cost, latency, tool calls), which is the only thing that makes spend attributable per-component. A shadow-eval experiment silently ran for weeks twice because there was no per-component cost visibility — "where did the money go?" was unanswerable. The wrapper closes that blind spot, but only if every call uses it.

**How to apply:**
- Adding an AI feature? Import the wrapper, pass a `component` string (see existing values in `ai_calls` before inventing a new one), and pass `model` verbatim. If you reach for `new Anthropic()`, stop.
- Pricing lives in [shared/aiPricing.js](../../shared/aiPricing.js), keyed by exact model_id. When a new model ships, add its rate there.
- Writes are fail-soft (missing `ai_calls` table → no-op), so the wrapper never breaks a production path.
- Per-component cost surfaces in the daily ops digest (the "RUBIES Daily Sync" email) via `lib/rollupAiCosts.js` → `ai_costs_daily`.

## Data and infrastructure patterns

- Supabase for state, files for config — no duplicate stores
- MCP tools read Supabase; sync scripts write to Supabase
- Idempotent pipelines — safe to re-run
- Singleton clients (Supabase, Shopify, etc.) — shared across scripts
- Gradual backfill over big-bang migrations
- Schema SQL files for every table — runnable in Supabase SQL Editor

## All sync writes MUST be idempotent under concurrency

Every sync, webhook handler, intake job, and import script that writes to Supabase must be safe to run concurrently with another instance of itself. Two runs starting at the same time, or a webhook firing while a periodic sync is mid-operation, must NOT produce duplicate rows.

**Why:** Webhooks retry on failure, schedulers can fire while a previous run is still in flight, Pub/Sub delivers at-least-once. We've been bitten twice — Gmail Pub/Sub redelivery created duplicate Gorgias tickets (now fixed via atomic claim on `email_messages.processed_at`), and `order_line_items` had occasional duplicates from a delete+insert race between `syncAll.js` and the Shopify webhook. Both had the same root cause: non-atomic write sequences with no per-row stable identifier or unique constraint.

**How to apply:**
- **Default to `upsert` with explicit `onConflict`**, not `delete + insert`. The natural key must be a real unique constraint or unique index on the table.
- **Never delete-then-insert without a unique constraint protecting the natural key.** Two concurrent runs can both delete and both insert, producing 2× rows.
- **For per-row updates from external sources, store the source's stable ID** and upsert by it. We store `shopify_line_item_id`, `shopify_order_id`, `gmail_message_id`, `gorgias_ticket_id`, etc. — never rely on `(field1, field2, field3)` natural keys when the source provides a real ID.
- **Append-only audit logs need an idempotency key too.** Either a content hash, a deterministic timestamp (e.g., truncated to the minute), or a unique constraint on `(natural_columns, time_bucket)`. `shipping_zones_history` was bare `.insert()` until we added a `(country_code, change_type, observed_at)` unique constraint + minute-truncation.
- **When you need to remove rows that no longer exist upstream**, use a narrow orphan-cleanup pass: `DELETE WHERE parent_id = X AND child_id NOT IN (current_ids)`. Combined with the upsert above, this is concurrency-safe — at worst a brief window where a concurrent run re-creates a row another run just deleted, which both will agree on.
- **For at-least-once delivery (webhooks, Pub/Sub)**, add an atomic claim: `UPDATE table SET processed_at = NOW() WHERE id = X AND processed_at IS NULL` — only one concurrent caller wins, the rest no-op.
- **Test concurrency by reasoning about interleaves**, not by running. Ask "if I delete here, then another run inserts the same set, then I insert — what happens?" If the answer is "duplicates," redesign.

**Audit hook:** any time you add a new sync/webhook/intake handler that writes more than one row per upstream entity, double-check it satisfies the rules above before shipping.

## Always paginate Supabase queries

**Why:** Supabase default limit is 1000 rows. Queries without pagination silently truncate, causing wrong analysis and missed data.

**How to apply:** Always paginate when querying tables that could exceed 1000 rows. Don't assume a single query returns all results.

## Don't ask permission to fetch data you can fetch yourself

**Why:** If the data is retrievable (Supabase query, file read, API call), asking "want me to pull it?" wastes a turn. Jamie expects me to just do the analysis.

**How to apply:** When asked to analyze something and the data source is known/accessible, pull it and analyze without confirming first. Only ask if the fetch itself is destructive, expensive, or ambiguous about which record.

## Use agentic patterns

**Why:** Building dumb routers that just dispatch based on keywords wastes the AI's capabilities. Give the AI real tools + context and let it reason.

**How to apply:** When building an AI feature, give it the actual tool schemas (including lookup/search tools, not just action tools). Let the AI decide which tools to call and how to interpret results. Don't pre-filter or pre-route with regex.

## Verify deployment before debugging

After making code changes, confirm the updated code is actually running before investigating further issues. Dashboard changes need a server restart (kill port + restart). Webhook/poller changes need a Railway deploy (commit + push to main). Don't chase bugs that are just stale code.

**Why:** Wasted time debugging "broken" behavior that was actually the old code still running — the fix was correct but hadn't been deployed.

**How to apply:** When a fix doesn't seem to work: (1) Dashboard: check if the server was restarted (`lsof -ti:3847`). (2) Webhooks/pollers: ask Jamie if Railway has redeployed — don't assume the push triggered a deploy. (3) Don't layer more fixes on top until you've confirmed the first fix is actually live.

## Read schema before querying — don't guess columns

**Why:** Wasted turns guessing `cs_drafts` vs `cs_ai_drafts` and inventing non-existent columns on `cs_tickets`. Every guess burns a round-trip and can produce wrong answers silently if the guess happens to be a real-but-unrelated column.

**How to apply:** Before querying a Supabase table, read the domain's schema SQL file (listed in the domain file's Key Files) or introspect via `select('*').limit(1)` and inspect `Object.keys`. If PostgREST returns an error with a `hint` (e.g. "Perhaps you meant the table X"), trust the hint — don't chain new guesses. Schemas are the source of truth; memory holds pointers to the SQL files, not column lists.

**Trigger:** If a Supabase response surfaces `error.message: ''` or HTTP 400, the column name is almost certainly wrong (PostgREST swallows the body when `head: true` is set). Re-check schema before retrying — don't guess again.

## Tests accompany deterministic code changes

Every code change that touches deterministic logic must land with tests — new tests for new behavior, updated tests when existing behavior changes. Don't commit uncovered logic changes.

**Why:** Deterministic tools and pure helpers are the load-bearing foundation under the AI layer. When they break silently, the advisor gives wrong answers with full confidence. Holdout/scenario harnesses catch AI reasoning regressions but can't catch a helper returning the wrong variant or a refund filter missing a gateway kind.

**How to apply:**
- **Required** for: MCP tool implementations (`lib/tools/*`), pure helpers (`sizeUtils`, `resolveLineItems`, `businessDays`, `autoLinker`, `shippingInfo`, sizing/grading math), data transformations, anything whose output is a deterministic function of its input.
- **Not required** for: advisor/prompt changes (covered by `runHoldout.js` + scenario harness), UI/dashboard wiring, intake glue that's mostly API orchestration, Supabase schema migrations, config changes. For prompt changes, add or update a scenario in the holdout set instead of a unit test.
- **Stubbing pattern:** For tool handlers that import `shopify`/`productCache`, stub via `require.cache[require.resolve('../lib/shopify')] = { ..., exports: { ... } }` before requiring the module under test. See [resolveLineItems.test.js](../../customer-service/test/resolveLineItems.test.js) as the reference.
- **Run before committing:** `node --test customer-service/test/*.test.js` — all must pass.

## Dry-run flags use CLI args, not env vars

**Why:** When a script defaults to print-only and needs an opt-in to execute, env vars (`LIVE=1`, `DRY_RUN=false`) leak between sessions, aren't visible in the command you ran, and make it easy to misfire by forgetting to unset.

**How to apply:** Use a positional CLI flag like `--send`, `--live`, `--execute`. Self-documenting in shell history, explicit per-invocation, no hidden state. Default to print-only when no flag is passed. Reserve env vars for credentials and configuration that's stable across runs.

## Use scripts/sb.js for ad-hoc Supabase queries

For one-off Supabase queries, run `node scripts/sb.js "<expression>"` from the project root instead of writing fresh `node -e` boilerplate.

**Why:** Recurring friction — guessing the client path (`shared/supabaseClient`, not `customer-service/lib/`) and the export name (`getSupabaseClient()`, not a `supabase` const) wastes turns. The helper hardcodes both.

**How to apply:**
- The helper exposes `sb` (the singleton client) and prints `data` as JSON, or surfaces the error.
- Example: `node scripts/sb.js "sb.from('cs_diagnostic_runs').select('id, judge_result, created_at').gte('created_at', '2026-04-28T02:13:27Z').order('created_at')"`
- **Never write ad-hoc scripts to `/tmp`.** Always `scripts/_<name>.js` from the project root, even for one-off analysis. Relative requires (`./shared/supabaseClient`) don't resolve from `/tmp` — `node /tmp/foo.js` will crash in the loader every time.
- The CLI is for single chained expressions. Anything beyond that (joins, aggregation, multiple chained queries, post-processing) goes in `scripts/_<name>.js` and imports `getSupabaseClient` directly.
- If a query needs to run regularly, promote it to a permanent script (no underscore) or an MCP tool.

## Temporary memory files need done_when conditions

**Why:** Memory accumulates without cleanup and becomes noise. Jamie shouldn't have to remember to tell me to clean up stale files.

**How to apply:**
- Temporary memory files must include a `done_when` field with a verifiable condition.
- At conversation start, check done_when conditions. If met, ask Jamie about cleanup.
- Prefer conditions verifiable by reading code/files over date-based expiry.

## Positive prompt rules stick; negative ones drift

When you need an LLM behavior to be reliable, frame it as a positive instruction with a verbatim template ("Open with: ..."). Negative instructions ("DO NOT open with sorry") are followed unreliably.

**Why:** Diagnostic data this session showed the advisor's positive rules — "open with this disclosure paragraph", "offer these N options" — sticking at ~100% across 6 regenerations of the same ticket. The matched negative rule on the same branch — "DO NOT open with apology preamble" — drifted on ~50% of generations, with the model finding a different apologetic phrasing each time ("Sorry for the wait", "I'm sorry your order has been sitting", "I hear you, sorry"). The pattern wasn't phrase imitation; it was the model's general "shipping inquiry → apologize" prior overriding a buried negative rule.

**How to apply:**
- Default to positive instructions with verbatim templates. "Open the email with: 'Hi [name], When you placed your order...'" is reliable. "Do not apologize for the wait" is not.
- If a behavior needs both inclusion and exclusion, lead with the positive ("DO this") and let the negative emerge implicitly. Don't pile on negative rules to cover edge cases — each one is fragile.
- If you find yourself adding more "DO NOT" rules to fix a recurring lapse, that's a sign the prompt structure is wrong, not that the rules need to be louder. Restructure into positive form, or accept the variance and add a downstream guard (operator review, validateResponse-style strip).

## Long-running/autonomous work uses git worktrees

Sprint and autonomous build sessions never work on `main` directly. Each workstream gets a
worktree at `~/Code/rubies-repo/worktrees/<name>` on a `sprint/<name>` (or `wt/<name>`) branch.

**Why:** Railway deploys from `main`; a long-running session pushing intermediate states to main
deploys them to production. Worktrees isolate the work; merges happen at checkpoints (tests
green; live-CS-path changes only with Jamie present). Rollback tag convention: `pre-sprint-<date>`
pushed to origin before a sprint starts — revert main to tag + push = production rollback.

**How to apply:**
- `git worktree add ~/Code/rubies-repo/worktrees/<name> -b sprint/<name>`
- Worktrees don't carry gitignored files: symlink `.env` and `node_modules` from the main
  checkout (`ln -sf .../rubies-automations/.env <wt>/.env`, `ln -sfn .../node_modules <wt>/node_modules`).
  Verified working 2026-06-10 (780/780 tests pass inside a worktree with symlinks).
- Remove with `git worktree remove <path>` after merge; `git worktree list` to audit.

## MCP tools must be agent-agnostic

Don't wire a tool to a specific advisor or agent. Any advisor should be able to call any tool. Tools own operations; agents own the judgment about when to call them.

**Why:** When a supervisor agent or critic layer is added later, it needs to call the same tools the current advisor calls. Tight coupling between a tool and a single agent is cheap to create and expensive to undo.

**How to apply:** When building a tool, ask "could a different advisor call this?" If no, the tool has absorbed reasoning that belongs in the agent's prompt, not in the tool itself.

## Operator edits to AI drafts are training signal — capture them

Store the AI-generated content and the final sent content separately. A boolean (`operator_edited`) is not enough.

**Why:** Edit patterns are the most reliable signal for where AI judgment is weak. "Jamie rewrites org intros but rarely touches retailer nudges" tells you where to invest in prompt improvement and eventually where a supervisor should escalate vs. handle autonomously. Without the before/after, there is no data to calibrate on.

**How to apply:** Every draft table should store both `ai_body` (what the advisor generated) and `sent_body` (what actually went out). Log at send time — no separate edit-tracking step needed.
