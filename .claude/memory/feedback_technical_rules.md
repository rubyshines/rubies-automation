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

## Right model for the task — balance accuracy and cost

Full policy lives in CLAUDE.md (Building Principles → "Right model for the task"). The test: does the quality of *this* decision materially affect a customer, a relationship, or a dollar — and is there no downstream check that would catch a mistake? Opus for customer-facing text, money-moving loops, and unreviewed high-stakes judgment; Sonnet for fail-closed classification and tone-polish of deterministic text; Haiku for pre-filter culls. Deliberate cheap-model picks get a code comment saying why. Model IDs come from `MODELS.*` in [shared/aiPricing.js](../../shared/aiPricing.js) — never hardcoded.

**Why:** The old rule was an absolute "Always use Opus," which the 2026-07 review mechanically applied, flagging deliberate cost decisions (thank-you closer, junk-ticket triage, batch email classification) as violations. The balanced test keeps Opus where model quality is the product and stops mislabeling correct Sonnet/Haiku picks.

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

### The claim must come before the expensive work, not just before the write

The rules above make concurrent writes *correct*. They do not make them *cheap*. When the work guarded by a claim costs money or time — an LLM call, a paid API, a long job — the claim has to be taken **before** that work starts, not at the moment of writing the result.

**Why:** intake dedupe was correct for years and still burned ~49% of advisor spend on real tickets. Gorgias emits `ticket-message-created` once per message, and the offline chat widget lands a whole flow transcript at once (measured: 8–10 customer messages inside one second). Each delivery ran a full Opus draft, all resolved to the *same* latest customer message, and all but one were discarded at INSERT on `UNIQUE(gorgias_ticket_id, gorgias_message_id)`. The data was never wrong — one draft, every time — so nothing surfaced it. Only the bill did, and only when someone decomposed it. Concurrency also makes it worse than N×: simultaneous callers cannot share a prompt cache, so every one pays the full cold cache-write.

**How to apply:**
- Ask of any claim: *what does the loser avoid?* If the answer is "a duplicate row" but not "the cost", the claim is in the wrong place.
- Insert the claim row first, do the work, then **fill the claim in by UPDATE** — an INSERT at the end would collide with your own claim.
- A mid-flight claim needs release on **every** exit including thrown errors. A `try/finally` wrapper around the existing body does this without restructuring it; a leaked claim silently suppresses the work forever, which for CS means an unanswered customer.
- Pair the release with a **staleness takeover** for the process-died case (a redeploy mid-work). Scope it so it can only ever match an unfilled claim of your own kind — never a completed record, never another subsystem's claim.
- **A stubbed-client unit test cannot catch a schema violation in the claim row.** The first version of this claim omitted a `NOT NULL` column, which would have made every claim fail and *nothing* ever draft. Round-trip the claim against the real table before shipping, and assert N concurrent claims yield exactly one winner.
- Watch for the symptom rather than the cause: **more API calls than there are outputs to show for them.** A calls-per-output ratio is the cheap tripwire for this whole class.

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

## Restart the dashboard by command match, never by port

Use `scripts/restart-dashboard.sh`. `lsof -ti:3847 | xargs kill -9` only kills whatever currently holds the socket — a server that failed to bind, or one started from a worktree, keeps running invisibly. Several competing processes produce "failed to fetch" in the browser with nothing useful in any single log, and the symptom looks exactly like a code bug in whatever you just shipped.

**Why:** 2026-08-07, three orphaned dashboard processes accumulated across a session of repeated restarts. One had crashed; the browser hit it and reported a fetch failure, which cost a real debugging detour into freshly-shipped endpoints that turned out to be fine.

**How to apply:** `pkill -f "customer-service/dashboard/server.js"`, wait for it to actually exit, start one, then verify BOTH that `/health` responds and that exactly one process matches. The script does all of that and warns when the count is not 1.

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

## A prompt fix isn't validated until you re-measure the assertions you were NOT targeting

When changing the advisor prompt to fix one failure, run the scenario enough times to get a rate (5–6 runs — variance is wide) and compare **every** assertion before and after, not just the one you set out to fix. A prompt change shifts behaviour globally, so it can repair the target metric while quietly breaking a neighbour.

**Why:** 2026-07-28, fixing the dropped `warehouse_hold` on unshipped-order edits. The first attempt added a clause naming the steered order to cover that case. It fixed the target completely (0/10 hold-drops against a 20–60% baseline) — and drove a *different* assertion, "reply invents order composition," from 0/5 to 4/6: naming the other order invited the model to reason about contents it had not loaded. Watching only the target metric would have traded a hold bug for a hallucination in customer-facing text. The minimal version (scoping statement only, no mention of the other order) fixed the hold-drop with the neighbour at 1/6, indistinguishable from baseline.

**How to apply:** prefer the smallest rule that removes the ambiguity — adding detail to "cover" a case often hands the model new material to act on. Capture the full pass/fail line-up per run, not just the headline. If a fix seems to need more specificity than one scoping sentence, that's a signal the prompt structure is wrong, not that the rule needs more words.

## Any AI context that reasons about elapsed time must state today's date

If a prompt asks a model to judge recency (a re-approach after a gap, whether something has gone stale, whether a figure still holds), the assembled context has to carry the current date explicitly. Timestamps on the records are not enough.

**Why:** the B2B community advisor was handed a thread with absolute dates on every message and asked to write a re-approach. It read the newest message as current and wrote "632 items distributed this year" from a figure an org gave us in September 2025, in a draft composed in August 2026. Nothing in the context said what today was, so "newest in the thread" was the only anchor available and the model took it. The failure is silent and lands in customer-facing text as a confidently wrong fact.

**How to apply:** render a date line into the context, paired with what to do with it ("work out how long ago something was before describing it as recent; never repeat a figure or status from an old message as if it still holds"). Inject the date as a parameter rather than calling `new Date()` inline, so the render stays pure and testable. Audit any other advisor whose prompt talks about gaps, staleness, or "recently" — the CS advisor and any future supervisor have the same exposure.

## When a draft sounds wrong, grep the prompt for the exact phrase before theorising

A tone complaint about AI-written text is usually not the model drifting. It is the model following a verbatim template it was handed. Search the prompt for the offending words first.

**Why:** Jamie flagged "and that's on me" as something no human writes. It came, word for word, from a prompt line that said: *own it plainly and warmly with zero defensiveness: "I am so sorry, that one is on me."* The same draft's bloated scheduling paragraph came from a rule requiring explicit timezone math, a statement that Jamie sends the invite, and naming Google Meet "whenever the email names a platform at all." Both complaints were the prompt working exactly as written. No amount of reasoning about model behaviour would have found that; one grep did.

**How to apply:** take the phrase the human objected to, grep the prompt file for it and for its close variants. Then fix the template rather than adding a "do not say X" rule on top, since the positive template will keep winning. Replace it with what the person actually writes — pull real examples from their sent mail rather than inventing a register (Jamie's real apologies are "So sorry" and "Oh darn I am so sorry for missing this", never a construction that performs accountability). When a rule exists for a real reason but produces bloat, keep the outcome and cut the narration: "write the time in both zones" preserves the anti-timezone-confusion goal that "explain that you will confirm both zones" was bloating. Re-run the same draft 3+ times after, since one clean generation is not evidence.

## Positive prompt rules stick; negative ones drift

When you need an LLM behavior to be reliable, frame it as a positive instruction with a verbatim template ("Open with: ..."). Negative instructions ("DO NOT open with sorry") are followed unreliably.

**Why:** Diagnostic data this session showed the advisor's positive rules — "open with this disclosure paragraph", "offer these N options" — sticking at ~100% across 6 regenerations of the same ticket. The matched negative rule on the same branch — "DO NOT open with apology preamble" — drifted on ~50% of generations, with the model finding a different apologetic phrasing each time ("Sorry for the wait", "I'm sorry your order has been sitting", "I hear you, sorry"). The pattern wasn't phrase imitation; it was the model's general "shipping inquiry → apologize" prior overriding a buried negative rule.

**How to apply:**
- Default to positive instructions with verbatim templates. "Open the email with: 'Hi [name], When you placed your order...'" is reliable. "Do not apologize for the wait" is not.
- If a behavior needs both inclusion and exclusion, lead with the positive ("DO this") and let the negative emerge implicitly. Don't pile on negative rules to cover edge cases — each one is fragile.
- If you find yourself adding more "DO NOT" rules to fix a recurring lapse, that's a sign the prompt structure is wrong, not that the rules need to be louder. Restructure into positive form, or accept the variance and add a downstream guard (operator review, validateResponse-style strip).

## Code work happens in worktrees; the main checkout is a read-only mirror

Every session that touches code works in a worktree. **The local `main` checkout is a read-only
mirror of `origin/main` — never commit, merge, rebase, or cherry-pick into it.** Integration
happens on the remote, not in the shared local tree. Each workstream gets a worktree at
`~/Code/rubies-repo/worktrees/<name>` on a `wt/<name>` (or `sprint/<name>` for sprints) branch.

**Why — the coupling we removed (2026-06-16):** the old protocol landed work by fast-forward
merging your branch *into the local `main` checkout*, then pushing. That made the shared local
`main` the integration point. If a session merged but didn't push immediately, local `main` sat
ahead of `origin/main`; the next session then (a) created its worktree off that ahead-of-remote
`main`, silently inheriting the unpushed commit, and (b) stacked its own commit on top — so one
`git push` deployed another session's in-flight work. Taking local `main` out of integration
entirely removes the coupling: sessions only ever read from local `main` and only ever write to
`origin/main` through their own worktree branch. (Earlier failure modes this also fixes: Railway
deploys from `main`, and concurrent sessions sharing the main tree's commits/edits blocked each
other — 2026-06-10.)

**How to apply — create a worktree off `origin/main`:**
```
git fetch origin
git worktree add ~/Code/rubies-repo/worktrees/<name> -b wt/<name> origin/main
ln -sf "$(git rev-parse --show-toplevel)/.env" ~/Code/rubies-repo/worktrees/<name>/.env
ln -sfn "$(git rev-parse --show-toplevel)/node_modules" ~/Code/rubies-repo/worktrees/<name>/node_modules
```
Branching off `origin/main` (not local HEAD) is what guarantees a worktree never inherits another
session's unpushed commit. Symlinks are required because worktrees don't carry gitignored files
(verified 2026-06-10: full suite passes inside a worktree with symlinks).

**How to apply — land work by pushing the worktree branch straight to `origin/main`:**
```
# inside the worktree, after committing + tests green:
git fetch origin
git rebase origin/main          # replay your commits on the latest remote main
node --test customer-service/test/*.test.js   # re-run after the rebase
git push origin HEAD:main        # push only your commits to remote main
git worktree remove <path>       # from the main checkout, once landed
```
Never `git merge` your branch into the local `main` checkout. To refresh the read-only mirror,
`git pull --ff-only` (or just `git fetch`). Rollback stays `git reset` to a tag + push.

**Other shared state:**
- Default ports are shared too: a server started from a worktree must use a non-default port
  (`PORT=3848 node customer-service/dashboard/server.js`), or sessions silently replace each
  other's server and serve the wrong code (hit 2026-06-10).
- Sprints keep the rollback-tag convention: `pre-sprint-<date>` pushed to origin before starting.

**Enforced by two `PreToolUse` hooks (wired in `.claude/settings.json`):**
- `block-main-edits.js` (matcher `Edit|Write|NotebookEdit`): blocks code edits to a file whose
  working tree is on `main`/`master`. `.claude/*`, plans, and `CLAUDE.md` are exempt.
- `block-main-checkout-git.js` (matcher `Bash`): blocks `git commit|merge|rebase|cherry-pick`
  when the command's working tree is the **main checkout** (detected via `--git-dir` ==
  `--git-common-dir`, so linked worktrees pass) and it's on `main`/`master`. `git fetch`,
  `pull --ff-only`, `reset`, and `push` stay allowed (mirror refresh + rollback).
Both are project-scoped, so every checkout carries them. The hooks stop the *current* session;
they can't stop a concurrent session that lacks them. Hook/settings changes need a Claude Code
restart to arm.

## Memory commits never leave the main checkout — two tracks, branch-from-latest

Memory (`.claude/memory/`) is committed to the repo, but `.claude/*` is *exempt* from the
edit-blocking hook while `block-main-checkout-git` *blocks committing* from the main checkout.
So memory edited on the main checkout can never be committed there — it silently piles up as
uncommitted state. Memory is also *shared mutable state*: a worktree is a point-in-time snapshot,
so a stale worktree that edits a memory file and merges later **reverts any memory change that
landed in between**. (Observed: `origin/main` advanced 10 commits mid-session.)

**Two tracks for getting memory committed:**
- **Memory that documents a code change** → edit it *in that change's worktree*, ship it in the
  same PR. (Same rule as "memory updates go in the same commit as the code they document.")
- **Standalone memory** (audits, cleanup, design notes, rescuing orphaned updates) → a worktree
  branched from **current `origin/main` immediately before editing**, its own small PR. Memory PRs
  need no code review. If the file you're touching is already modified on an open memory branch,
  *stack onto that branch* instead of branching fresh — that's how you avoid clobbering it.

**The invariant that makes it safe is "branch from the latest `origin/main` right before
editing"** — not "any worktree." Before applying memory edits into a worktree, confirm the target
files didn't change upstream since the branch point (`git diff <base> origin/main -- .claude/memory/`).

**Forcing function:** never end a session with uncommitted memory. It goes into a code PR (track 1)
or a memory PR (track 2) before close — otherwise it's invisible incomplete state.

## MCP tools must be agent-agnostic

Don't wire a tool to a specific advisor or agent. Any advisor should be able to call any tool. Tools own operations; agents own the judgment about when to call them.

**Why:** When a supervisor agent or critic layer is added later, it needs to call the same tools the current advisor calls. Tight coupling between a tool and a single agent is cheap to create and expensive to undo.

**How to apply:** When building a tool, ask "could a different advisor call this?" If no, the tool has absorbed reasoning that belongs in the agent's prompt, not in the tool itself.

## User-facing systems with an explainer page keep it in sync

When a system ships a human-facing methodology/explainer page (e.g. the email report's `reports/methodology.js` → `how-it-works.html`, written for non-technical readers like Sadie), updating that page is part of the same change as adding or altering a feature. A new report section, chart, or AI tool is not "done" until the explainer describes it and (where relevant) the report links to it via the per-section `Methodology` anchor.

**Why:** The explainer is the only thing that lets a non-technical operator trust and use the system. A feature the page doesn't describe is invisible to them, and stale docs erode trust faster than missing docs.

**How to apply:** After adding/changing a report section or studio tool, update the matching `<section>` (and anchor) in `reports/methodology.js`, plus the data-flow diagram if the plumbing changed. Treat it like a test: the change isn't complete without it.

## Operator edits to AI drafts are training signal — capture them

Store the AI-generated content and the final sent content separately. A boolean (`operator_edited`) is not enough.

**Why:** Edit patterns are the most reliable signal for where AI judgment is weak. "Jamie rewrites org intros but rarely touches retailer nudges" tells you where to invest in prompt improvement and eventually where a supervisor should escalate vs. handle autonomously. Without the before/after, there is no data to calibrate on.

**How to apply:** Every draft table should store both `ai_body` (what the advisor generated) and `sent_body` (what actually went out). Log at send time — no separate edit-tracking step needed.

## Spreadsheet totals are always live formulas, never hardcoded

When writing any sheet (Google Sheets, exported xlsx) that has subtotals or grand totals, emit them as formulas (`=SUM(...)`, `=ROUND(SUM(...),1)`) over the data rows, written with `valueInputOption: 'USER_ENTERED'` so they evaluate. Never write a precomputed number into a total cell.

**Why:** The founder edits quantities directly in these sheets (e.g. the inventory-projections review tab, the production-order draft tab). A hardcoded total goes stale the instant a cell is edited and silently misleads. A formula recalculates and stays trustworthy. Read-back is unaffected — `values.get` returns the computed value by default, so parsers still see numbers.

**How to apply:** Track each group's data-row range as you build the rows, write `=SUM(<col><first>:<col><last>)` in the total cell, and sum subtotal cells (not a range that would double-count them) for the grand total. Use `USER_ENTERED`, not `RAW`. Applies to every sheet a human will edit.

## Validate advisor changes on the input shape production actually sends

A pinned scenario that calls `aiAdvisor` with raw concatenated customer text and no intake is exercising a FIRST pass. The dashboard's regen (`apiRefreshDraft`) sends a different shape: `intake: draft.intake_state` fed back, plus an `issue_description` built as `[CONVERSATION HISTORY]` (which includes our own prior agent replies) + `[LATEST CUSTOMER MESSAGE]`, plus `preContext`. A scenario can be green on the first shape while the live path is broken.

**Why:** 2026-07-29. A prompt change went out on 3/3 green from `holdOnUnshippedModify`. The next live regen of a pre-ship colour swap produced a full return-and-donate block — partner address, wash instructions — for an order the customer had never received, and flipped `action_type` from `warehouse_hold` to `exchange`, which also drops the hold that keeps the order from shipping before the swap. On a first pass "unshipped → hold" has no competing signal; on a regen the fed-back `intake_state` says `message_type: exchange` with fully resolved items, and that is the input that actually broke. The scenario never sent it.

**How to apply:**
- Before calling a prompt change validated, ask which caller produces the drafts you care about and reproduce that caller's arguments. Most operator-visible CS drafts are regens, so a second-pass assertion is worth more than a first-pass one.
- Always run a control arm on the prior prompt, not just the new one. That is what showed the donation misfire predated the change rather than being caused by it — without a control the fix gets credited or blamed for behaviour it never touched.
- Beware measuring your own harness. Replaying one ticket repeatedly can produce a "failure rate" that is an artifact of that ticket's state: a 3/4 donation-miss turned out to be the model correctly declining to repeat donation info its own conversation history already contained, while production ran 99/100. Check the rate over real rows before treating a probe number as a defect.
