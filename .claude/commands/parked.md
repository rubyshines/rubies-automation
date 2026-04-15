List parked items from `.claude/memory/parked.md`.

## Filters

If Jamie passes an argument after `/parked`, interpret it as a filter:

- `/parked` — all items, sorted by priority (high → normal → low) then by `Last touched` descending
- `/parked <domain>` — filter by domain tag (e.g. `/parked cs`, `/parked tech`)
- `/parked <type>` — filter by type (e.g. `/parked bugs`, `/parked ideas`, `/parked refactors`)
- `/parked stale` — only items with `Last touched` >90 days, sorted oldest first
- `/parked high` / `/parked low` — filter by priority
- `/parked <keyword>` — substring search against title and Notes if nothing else matches

Arguments can combine loosely: `/parked cs bugs` = CS domain AND bug type.

## Output format

Show a compact list Jamie can scan fast. One line per item, grouped by domain if no domain filter was applied:

```
CS (3)
  [bug]      Advisor classification overridden by closing-message tone    14d
  [refactor] Remove legacy walkTree/prescribe functions from sizingEngine  14d
  [bug]      Fix quick-reply button race                                   32d

TECH (3)
  [idea]     Add webhook circuit breaker / rate limiting                  14d
  ...
```

Age column = days since `Last touched`. Mark stale items (>90 days) with `*` suffix on the age.

If a filter returns nothing, say so plainly: "No parked items match <filter>."

## Footer

After the list, print a one-line summary:

```
Total: <N> items (<M> stale, <K> high priority)
```

## How to read parked.md

Entries start with `## <title>` and end at the next `##` heading or EOF. Frontmatter fields are `- <Field>: <value>` lines. Parse them, filter, sort, render.
