List active initiatives by globbing `.claude/memory/initiative_*.md`.

## Source of truth

**Read from disk, not from MEMORY.md.** The set of `initiative_*.md` files in the memory directory is the source of truth. Archived initiatives live in `.claude/memory/archive/` and should NOT be included in the default listing.

## What to do

1. Glob `.claude/memory/initiative_*.md` (not the archive subdir)
2. For each file, read its frontmatter (name, description, domains, last_updated)
3. Render a compact list, sorted by `last_updated` descending (most recently touched first):

```
Active initiatives (<N>):

  <name>  (updated <X days ago>)
    domains: <domains>
    <description>
```

4. If an initiative's `last_updated` is older than 30 days, mark it with `(stale)` after the date and flag at the end of the output. This matches the Memory Protocol rule that stale initiatives get flagged.

5. If MEMORY.md's "Initiatives" section disagrees with what's on disk, flag the mismatch so Jamie can fix the index.

## Optional filters

- `/initiatives <domain>` — filter to initiatives whose `domains` field includes the domain
- `/initiatives archived` — list files in `.claude/memory/archive/` instead of active ones
