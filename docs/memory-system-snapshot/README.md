# Memory System Snapshot — 2026-04-14

This directory is a snapshot of the Claude Code memory system for this project, captured after a comprehensive reorganization session on 2026-04-14. Commit this to git so you have a known-good reference point if memory drifts again.

## Why this exists

Claude Code's memory system lives in `~/.claude/projects/<project>/memory/` — outside the project directory, so it's not version controlled. If memory drifts badly, you lose the intentional structure without a way to restore it. This snapshot is the restore point.

## What's in this directory

### Memory files (24)
- `MEMORY.md` — pure index with domain keyword map and file list
- `feedback_collaboration.md` — how Jamie and Claude work together
- `feedback_technical_rules.md` — architecture patterns and technical rules
- 9 `domain_*.md` files — what exists in each business domain
- 11 `initiative_*.md` files — ongoing business efforts
- 1 `project_*.md` file — active code work (follow-up bugs)

### Also included
- `CLAUDE.md.copy` — the project's CLAUDE.md with full Memory Protocol (lives at repo root, copied here for snapshot)
- `orient.md.copy` — the `/orient` slash command (lives at `.claude/commands/orient.md`, copied here)

## The design principles (what "good" looks like)

### File type taxonomy

| Type | Purpose | Lifecycle |
|---|---|---|
| `feedback_*.md` | How we work (only 2 files, never create more) | Permanent |
| `domain_*.md` | What exists and how it works per business domain | Permanent |
| `project_*.md` | Discrete code work with clear deliverable | Merge into domain when done, delete |
| `initiative_*.md` | Ongoing business outcomes | Permanent, updated as progress happens |
| `MEMORY.md` | Pure index, no content | Updated when files added/removed |

### Domain file sections (fixed structure)

1. **What's Built** — current system capabilities
2. **Key Decisions** — architectural choices and why (not implementation rules)
3. **Key Files** — 3-5 entry-point files for code navigation
4. **Current Status** — system state only (running/partial, no gaps)
5. **What's Next** — directional items without an initiative yet
6. **Backlog** — specific bugs/fixes/tasks for later

### Initiative file sections

- Frontmatter requires `domains` (array) and `last_updated` (YYYY-MM-DD)
- Goal, Phases, Current Status, Decisions Made

### Anti-drift rules (the hard-won lessons)

1. **Single source of truth** — every fact lives in exactly one place
2. **Don't duplicate implementation details** — if it's in code/prompts, it doesn't belong in memory
3. **Propose before writing** — never silently update memory files
4. **Discuss before creating** — no new memory files without Jamie's approval
5. **Validate links on read** — at session start, verify MEMORY.md links and Key Files paths exist
6. **Update index after changes** — after any memory file add/rename/delete, verify MEMORY.md matches disk
7. **Static one-liners** — MEMORY.md descriptions are topic descriptions, not current status
8. **Rename key files in same change** — if you rename/move/delete a key file, update the domain file immediately

## How to use `/orient`

Type `/orient` at the start of a fresh Claude Code session, optionally followed by your request:

```
/orient I want to fix a bug in the CS advisor
```

This forces Claude to:
1. Read both feedback files
2. Read MEMORY.md fresh from disk
3. Match the request to the correct domain
4. Read the matched domain file(s)
5. Check for related projects/initiatives
6. Validate all links
7. Report a summary before starting work

Without `/orient`, Claude often skips the memory protocol and jumps to code search.

## Known limitations

- **Protocol is probabilistic.** Even with CLAUDE.md instructions and `/orient`, the model may occasionally skip steps. The system is 95% reliable, not 100%.
- **Cached MEMORY.md ghost files.** Fresh sessions sometimes reference old file names that no longer exist. Cause is unclear — possibly Claude Code's auto-memory cache or training on old patterns. `/orient` validates links and catches this.
- **No programmatic enforcement.** Claude Code hooks run shell commands, but can't force the model to read specific files. The only way to enforce the protocol is procedurally (via `/orient`).

## The conversation that produced this (context)

On 2026-04-14, Jamie and Claude spent a multi-hour session fixing the memory system. Starting problem: MEMORY.md pointed at ~30 files that no longer existed (the system had been consolidated but the index was never updated). No initiative tracking existed. Instructions in CLAUDE.md were too vague to enforce consistent reading/writing.

Outcome:
- Rewrote CLAUDE.md Memory Protocol with concrete reading checklist, writing rules, validation steps, and file type taxonomy
- Rebuilt MEMORY.md with domain keyword map, accurate file index
- Audited all 9 domain files: added Key Files sections, trimmed Key Decisions to architectural only, separated What's Next from Backlog, removed Gaps and Advisor Prompt Candidates sections
- Created 11 initiative files covering all active business efforts (AI infrastructure, CS automation, pricing, Naomi launch, IRAP, B2B, SEO, email campaigns, website theme, LGBTQ+ partnerships, production pipeline)
- Added `last_updated` and `domains` frontmatter to all initiatives
- Created `/orient` slash command to force protocol compliance
- Added "Memory system design principles" section to `feedback_collaboration.md` so future Claude instances can course-correct if drift is detected

Tested with 6 fresh sessions across different domains. Without `/orient`: 0% protocol compliance. With `/orient`: ~95% compliance (reads feedback files, domain files, validates links, but sometimes still tries to read ghost files from cached memory).

## How to restore from this snapshot

If memory drifts badly and you need to reset:

```bash
# From repo root
MEMORY_DIR="$HOME/.claude/projects/-Users-jamiealexander-Library-Mobile-Documents-com-apple-CloudDocs-Documents-RUBIES-creative-content-code-rubies-repo-rubies-automations/memory"

# Backup current state
cp -r "$MEMORY_DIR" "$MEMORY_DIR.backup.$(date +%Y%m%d)"

# Restore memory files (strip .snapshot suffix, skip CLAUDE and orient which go elsewhere)
for f in docs/memory-system-snapshot/*.md.snapshot; do
  name=$(basename "$f" .snapshot)
  if [[ "$name" != "CLAUDE.md" && "$name" != "orient.md" ]]; then
    cp "$f" "$MEMORY_DIR/$name"
  fi
done

# Restore CLAUDE.md
cp docs/memory-system-snapshot/CLAUDE.md.snapshot CLAUDE.md

# Restore orient command
cp docs/memory-system-snapshot/orient.md.snapshot .claude/commands/orient.md
```

After restoring, start a fresh Claude session and run `/orient` to verify everything reads correctly.

## Commit message suggestion

```
Add memory system snapshot reference

Captures the full Claude Code memory structure after the 2026-04-14
reorganization. Commit this as a restore point if memory drifts —
see README.md for the design principles and restore instructions.
```
