List active projects by globbing `.claude/memory/project_*.md`.

## Source of truth

**Read from disk, not from MEMORY.md.** MEMORY.md is a hand-maintained index and can drift. The set of `project_*.md` files in the memory directory is the source of truth — if a file exists, the project is active.

## What to do

1. Glob `.claude/memory/project_*.md`
2. For each file, read its frontmatter (name, description, domain, done_when, last_updated if present)
3. Render a compact list:

```
Active projects (<N>):

  <name>
    domain: <domain>
    done_when: <done_when>
    <description>

  <name>
    ...
```

4. If a project's `last_updated` (if present) is older than 30 days, mark it with `(stale)` after the name.

5. If MEMORY.md's "Active Projects" section disagrees with what's on disk, flag the mismatch to Jamie at the bottom of the output so he can fix the index.

## Optional filter

If Jamie passes a domain after `/projects` (e.g. `/projects cs`), filter to projects whose frontmatter `domain` field matches.
