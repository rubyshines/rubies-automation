---
name: Collaboration
description: How Jamie and I work together — confirmation patterns, communication style, session management
type: feedback
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

## Restart servers after code changes

After modifying server-side code, restart the relevant server automatically — don't wait for Jamie to notice it's stale.

**Why:** Jamie had to ask why dashboard changes weren't reflected in the UI — the server was still running old code.

**How to apply:** After editing dashboard server, intake scripts, or any code the server imports: kill the process on the relevant port (`lsof -ti:PORT | xargs kill -9`) and restart in the background. Do this proactively.
