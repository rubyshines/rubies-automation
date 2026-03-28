---
name: Temporary memory files need done_when conditions
description: All temporary/WIP memory files must have a done_when field so they can be proactively cleaned up when the work is complete
type: feedback
---

Temporary memory files (project plans, WIP tracking, rules-in-progress) must include a `done_when` field in their frontmatter that describes a verifiable condition for cleanup.

**Why:** Jamie works on many things and shouldn't have to remember to tell me to clean up stale memory files. Memory that accumulates without cleanup becomes noise and makes future conversations harder.

**How to apply:**
- When creating a temporary memory file, add `done_when:` with a concrete, verifiable condition (e.g. "grep for X in file Y" or "check if table Z exists")
- At the start of conversations, if I see `done_when` fields, check if the condition is met. If yes, ask Jamie if the file should be cleaned up.
- Prefer conditions I can verify by reading code/files over date-based expiry.
- When the work described in a temporary file is complete and coded, delete the file and remove it from MEMORY.md.
