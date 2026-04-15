Park the current item or idea into `.claude/memory/parked.md`.

## What to park

Use conversation context to figure out what Jamie wants to park. If the user gave explicit context after `/park` (e.g. `/park look at the auth middleware later`), use that. Otherwise, pull the topic from the most recent discussion.

## What to infer — don't ask unless the conversation is genuinely ambiguous

- **Title** — write it yourself. Short, specific, action-oriented. Example: "Fix dedup race in follow-up poller" not "Follow-up bug."
- **Domains** — pick from the domain map in MEMORY.md based on what the item touches. Multiple tags are fine for cross-cutting items.
- **Type** — `bug`, `idea`, `refactor`, `question`, or `decision-needed`. Omit if unclear.
- **Priority** — omit (defaults to normal). Only set `high` or `low` if Jamie said so explicitly.
- **Parked** and **Last touched** — today's date.
- **Plan** — only include if a plan file in `.claude/plans/` already exists for this item.
- **Notes** — only include if there's genuinely non-obvious context (a decision already made, a constraint, a specific thing you were about to try). If the title is self-explanatory, skip Notes.
- **Resume when** — only include if Jamie mentioned a trigger ("after the pricing launch," "when Sadie is back").

## Before writing

1. Read `.claude/memory/parked.md`.
2. Check for possible duplicates — any existing entry whose title overlaps substantially with what you're about to add. If you find one, show it to Jamie and ask whether to update the existing entry or create a new one. Do NOT write a duplicate silently.
3. Update `Last touched` on the existing entry if Jamie chooses update.

## After writing

Append the new entry to the bottom of parked.md (below existing entries, before any closing content). Then reply with this confirmation shape:

```
Parked as: "<title>" (<type>, <domains>)
Notes: <notes if any, else skip this line>
Total parked: <count> (<count by relevant domain>, <N> stale)
```

Stale = `Last touched` older than 90 days.

## Edge cases

- If Jamie says "park this as high priority" or similar, set `Priority: high`.
- If Jamie is actively in plan mode and says "park this," include the plan file path in `Plan:`.
- If the total parked count crosses 50 after this addition, add a warning line: `Parked is getting full — consider reviewing with /parked stale`.
- If total crosses 100, warn more firmly.
