---
name: Collaboration
description: How Jamie and I work together — confirmation patterns, communication style, session management
type: feedback
originSessionId: f09c5f2c-793a-4c2b-9fa4-8c114307aed5
---
## Wait for explicit confirmation before acting

Don't infer go-ahead from tangential replies. Wait for explicit "looks good" or "yes" before bulk operations, destructive changes, or multi-step executions.

**Why:** Jamie gives context and thinks out loud. A response like "interesting" or "that makes sense" is acknowledgment, not approval.

**How to apply:** Before executing bulk ops or irreversible changes, get a clear "yes" / "go ahead" / "do it". If the response is ambiguous, ask directly.

## Save plans to memory before clearing

Plans (created via EnterPlanMode) are ephemeral and DO NOT survive `/clear` or session restarts.

**Why:** Lost the full scenario testing plan when suggesting /clear. Hours of work disappeared.

**How to apply:**
- Before suggesting `/clear` or restart, check for active plan content worth keeping.
- Save plan content (or thorough summary) as a memory file FIRST.
- When in doubt, save it — redundant memory is better than lost work.

## Stop and rethink when a fix isn't working

When a fix isn't working after the first attempt, stop and rethink the approach rather than adding more layers. The right solution is usually simpler than what you're trying.

**Why:** Tendency to keep pushing on the current approach — adding patches, workarounds, and edge-case handling — when the difficulty itself is a signal the approach is wrong.

**How to apply:** If a fix requires more than one iteration, pause and ask: "Am I solving the right problem?" Look for the direct path before adding complexity.

## Fix recurring friction at the source

When the same first-attempt failure happens across sessions on a common operation, fix it in code rather than learning to work around it.

**Why:** A code fix works forever; a memory rule only works while I remember it. Forgetting to prepend `require('dotenv').config()` before every ad-hoc Supabase query was a recurring waste — adding dotenv to the shared clients themselves made the problem disappear permanently.

**How to apply:** When you notice the same first-attempt failure recurring, look at the root cause — usually a missing init step in a shared module, a confusing default, or an undocumented prerequisite. Fix the module/default rather than asking memory to compensate. Tell Jamie what you fixed and why.

## Restart servers after code changes

After modifying server-side code, restart the relevant server automatically — don't wait for Jamie to notice it's stale.

**Why:** Jamie had to ask why dashboard changes weren't reflected in the UI — the server was still running old code.

**How to apply:** After editing dashboard server, intake scripts, or any code the server imports: kill the process on the relevant port (`lsof -ti:PORT | xargs kill -9`) and restart in the background. Do this proactively.

## Memory system design principles (2026-04-14 reorganization)

If Jamie says memory is drifting or you notice structural issues, re-read this section and CLAUDE.md's Memory Protocol, then audit against these principles:

**Single source of truth:** Every fact lives in exactly one place. Domain files own "what exists and how it works." Initiative files own "where we're going on a business goal." Project files own "what code to build." Don't duplicate across files.

**Separation of concerns:**
- Domain Current Status = system state (what's running). No gaps — gaps go to Backlog or What's Next.
- Initiative Current Status = progress toward a business goal.
- What's Next = directional items without an initiative yet. Move to initiative when one is created.
- Backlog = specific bugs/fixes/tasks for later. Promote to project when non-trivial.

**Anti-drift rules:**
- Never silently update memory — propose delta to Jamie first, write after approval.
- Never create new memory files without discussing with Jamie first. Always check if content belongs in an existing file.
- Don't record implementation details that live in code/prompts. Memory captures *what we decided and why*, not the rules themselves.
- Keep MEMORY.md one-liners as static topic descriptions, not current status.
- Validate links at session start (MEMORY.md → files, domain Key Files → code paths).
- After any memory file changes, verify MEMORY.md matches disk.
- Initiative updates are high-level progress bullets, not detailed analysis.

**Common drift patterns to watch for:**
- Creating granular files instead of adding to existing domain/initiative files
- Duplicating advisor behavior rules from the prompt into domain Key Decisions
- MEMORY.md index pointing at files that no longer exist
- What's Next accumulating items that should be on initiatives
- Gaps appearing in Current Status instead of Backlog

**Why:** Jamie spent significant time organizing memory in April 2026 because it had drifted badly — 30 ghost file references, no initiative tracking, vague instructions that led to inconsistent reading/writing. The system works when the rules are followed precisely.

## Session permission mode: Auto mode for cowork (2026-06-10 saga)

In the VS Code extension, the UI mode selector (shift+tab) OUTRANKS all permission allow
rules. "Ask before edits" and "Plan mode" prompt for every file edit by design — no settings
file, allowlist rule, or symlink change can override them. Jamie's setup already has wide
Edit/Write/Bash allow rules at user scope; they only take effect in Auto mode (or Edit
automatically).

**How to apply:** If Jamie reports repeated permission prompts, check the MODE first (one
glance at the selector) before touching any configuration. A night was spent on symlinks,
allowlist syntax, and directory moves when the answer was the mode selector. Diagnose with
ground truth (/permissions panel, ~/.claude/settings.json) before iterating.

## Follow the chain for CSS fixes

Trace the full CSS ancestor chain before writing any fix. Don't patch the symptom — find the broken link.

**Why:** CSS layout bugs are almost never local. Speculative patches waste Jamie's testing time.

**How to apply:** Read the ancestry from root to affected element (height, overflow, position, display, max-height). Check for scroll-within-scroll containers and fixed-height boxes that trap content. Identify which ancestor breaks the chain. Fix that, not the leaf element.

## Always use Eastern Time

When showing timestamps, log times, or any time-related data, convert to Eastern Time (ET).

**Why:** Jamie is in the Eastern time zone. UTC timestamps require mental math.

**How to apply:** When displaying times from databases, logs, or APIs (which are typically UTC), convert and present as ET. Use "ET" label (covers both EST and EDT automatically).

## Diagnose with data before iterating on AI behavior

When the AI seems to be misbehaving, capture data showing what it's actually doing across multiple runs *before* iterating on the prompt. UI symptoms can be downstream of caching, stale state, or completely unrelated bugs.

**Why:** A session-long chase of "the advisor lapses into apologetic openers" turned out to be a localStorage cache bug in the dashboard — the model was generating fresh drafts correctly, but the browser was rendering a stale version. Five prompt commits, two near-miss architectural proposals, all chasing a phantom. The cost of one diagnostic round (capture full per-round text + regen N times + inspect) is far less than five wrong-direction iterations on the prompt.

**How to apply:** Before tightening a prompt rule on the basis of one observed failure, instrument enough to confirm the failure is reproducible and is what you think it is. If the symptom is "the dashboard shows X" — check what the API returns, what the DB has, and what the browser caches independently. If the model is suspect — run N regens and look at the actual saved drafts, not just one report. Build the diagnostic before iterating on the fix.

## Don't overfit fixes to one observed failure

When tightening a rule (especially a prompt rule) in response to a single regression, mentally test it against sibling cases. Would it break a single-item order? A no-alternatives case? A different domain? If yes, find the right level of generality before shipping.

**Why:** This session, after seeing one apologetic draft, I tightened the pre-order prompt to "always offer exactly 3 options" and "no preamble of any kind" — both of which would have broken sibling cases (single-item orders have no split option; legitimate warm phrases like "I appreciate your patience" got banned). Both rules had to be rolled back, and the iteration was wasted.

**How to apply:** When adding a rule to fix one case, ask "would this rule misfire on the inverse?" If the answer is yes, generalize first. Locking in too-specific rules and rolling them back is wasted iteration that erodes prompt quality.

## Architectural refactors need diagnostic-grounded justification

Before proposing a refactor that unwinds existing convergence work — months of validation, holdout-tested accuracy, multi-week prompt tuning — prove with data that the current architecture genuinely cannot reach the goal. Hypothesis is not enough.

**Why:** This session I twice proposed major refactors (two-stage compose at ~850 LOC; classifier + prefill registry) on hunches about what was causing apology drift. Both were walked back when the actual cause turned out to be a localStorage cache bug. The bar for "rebuild" must be much higher than the bar for "iterate" — refactoring discards calibration work that isn't easy to recover.

**How to apply:** When you find yourself proposing architectural change to fix a behavior issue, stop and ask: "what's the diagnostic that proves the architecture can't solve this, vs the prompt or a downstream bug?" If you can't point to data, the answer isn't a refactor. The smaller the proposed change relative to the validated work it disturbs, the better.

## Lean into doing while we have the context

When something relevant to the current work comes up — a redundancy, a related cleanup, a logical extension — default to fixing it inline rather than parking it. Even if it's a bit bigger than what was originally asked. We've already paid for the context (files loaded, call paths understood, tests primed); capturing and reopening later wastes that.

**Why:** Context is the expensive thing, not the work itself. Parking a small-to-medium fix in the middle of related work means re-deriving the surrounding state when we come back to it. The cumulative overhead of context-rebuilding is far higher than just doing the thing now.

**How to apply:**
- In the same files / call path: just do it, mention what you're doing.
- Relevant but bigger: surface it ("this is wider than what you asked for, but X — want to take it now?"), default toward doing.
- Unrelated to the current thread: park it, even if small.
- If a tangent threatens to derail the current task before it's finished, surface the trade-off — don't silently context-switch.
- **Reserve `/park` for** items that genuinely need their own session: unrelated to current work, requiring an architectural decision first, or substantial enough to meaningfully derail the current task.

## Be aggressive about committing and pushing once work is validated

When a logical change is complete and its tests pass, proactively commit and push it (this repo deploys from `main`) rather than leaving it sitting in the working tree. Don't wait to be asked a second time.

**Why:** Local edits have no production effect until pushed. A refund-amount prompt fix was verified working locally, but the live dashboard kept emitting the old behavior because the change was never deployed — Railway was still running the pre-fix code. Uncommitted, validated work is invisible to production and easy to forget.

**How to apply:**
- **Treat a fix as unfinished until all three are done, in one motion, without being asked:** (1) restart the server that loads the changed code (local dashboard via `lsof -ti:3847 | xargs kill -9` + relaunch; Railway via push to `main`), (2) commit, (3) push to `main` if it touches anything that runs in production. Then *verify each*: server back up on the new code (`/health` commit or restart time), `git status` clean, `origin/main` updated and Railway redeployed. The recurring failure is stopping after "committed" — code on local `main` that's never pushed is invisible to production, and a server that wasn't restarted serves stale code. If you catch yourself reporting a fix as done, that report is the trigger to run this checklist. (2026-06-12: a 529/garbled-draft fix sat committed-but-unpushed for a day and the local dashboard ran stale code — Jamie had to chase both.)
- After completing + testing a coherent change, commit it with a clear message and push to `main` (the deploy branch) — proactively, in the same session. Group into logical commits when there's more than one concern.
- Only stage files I actually changed for this work. If unrelated modified files are in the tree (someone else's in-progress work), leave them out and flag them — never bundle them in.
- Still run the test suite before committing, and never commit secrets or local-only artifacts (lock files, scratch scripts).
- When a fix's whole point is to change production behavior, treat "pushed + deploying" as part of done — say so explicitly, and remember Railway redeploys from `main` (verify deploy before declaring it live).

## Write plan file updates inline — no permission gate

During active design sessions, update the plan file (`.claude/plans/*.md`) as decisions are locked — don't ask "should I save this?" or "want me to update the plan?" Just write it as part of the work.

**Why:** Plan files are the working artifact of design sessions. Gating each write behind a question breaks the flow and is redundant — Jamie is already in the conversation, confirming decisions.

**How to apply:** When a design decision is confirmed (Jamie says "yes", "go ahead", "lock it", or similar), write the locked entry to the plan file immediately and continue. The write is part of completing the decision, not a separate step to ask about.

## Sales hat on during B2B design — drive toward conversations

When designing B2B outreach features, keep the sales goal front and center: does this drive a reply, open a door, or move a relationship forward? If a feature does not serve that goal, do not suggest it and do not ask about it.

**Why:** During message type design, I surfaced a question about referencing specific SKUs in reorder nudges. When Jamie asked for my opinion I realized the answer was obviously no — the nudge is a conversation opener, not a catalog review. The question wasted a turn.

**How to apply:** Before raising a design option, ask "does this make the conversation more likely to happen?" If yes, propose it. If no or marginal, make the call and move on. Own the recommendation — do not outsource obvious judgment calls to Jamie.

## High bar for memory writes — default to NOT writing

Most completed work does not warrant a memory update. Before proposing one, apply the test: "Would a future session make a materially worse decision without this, AND can it not be re-derived from the code/tests?" If either half fails, don't write it. Implementation-level behavior — a reconciler's author gate, a specific edge-case branch, which column a tool writes — lives in code and tests, even when it was a deliberate choice made this session. Domain Key Decisions are for architecture and cross-cutting choices that shape how we build, not for documenting what a function does.

**Why:** Memory collected so much low-value detail it needed a full cleanup (April 2026). Proposing a one-line behavior detail (e.g. a "cancelled orders auto-resolve any note" exception) as a domain Key Decision is exactly the minutiae that re-bloats it. The fix already documents itself in the commit, the code comment, and the regression test.

**How to apply:** When I catch myself drafting a Key Decision that restates what a function/branch does, stop — that's a code concern. Only surface a memory update when the *architecture, ownership, or a genuinely surprising cross-cutting constraint* changed. When unsure, don't propose it.

## Memory updates go in the same commit as the code they document

Now that `.claude/memory/` is in the repo, don't commit code then update memory as a separate step. Bundle them together — one commit with both the code change and the memory update that documents it. For memory-only updates (design sessions, planning, no code changed), commit and push at the end of the session.
