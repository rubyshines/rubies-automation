---
name: Save plans to memory before clearing session
description: Never tell user to /clear without first persisting any plan content to memory files — plans are ephemeral and get deleted
type: feedback
---

Plans (created via EnterPlanMode) are ephemeral and DO NOT survive `/clear` or session restarts. They are stored in temporary `.claude/` space, not in the persistent memory directory.

**Why:** Lost the full scenario testing plan (`structured-twirling-lecun.md`) when advising the user to `/clear`. Hours of collaborative work disappeared. Major trust failure.

**How to apply:**
- Before EVER suggesting `/clear` or a session restart, check if there is an active plan with content the user would want to keep.
- If so, save the plan content (or a thorough summary) as a **project memory file** in the memory directory FIRST.
- Plans are for within-conversation tracking only. Anything that needs to survive across sessions MUST go to memory.
- When in doubt, save it — a redundant memory file is far better than lost work.
