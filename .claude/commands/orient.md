You MUST complete ALL of these steps IN ORDER before doing anything else. Do not skip steps. Do not start working on the user's request until all steps are done.

## Step 1: Read feedback files
Read these two files:
- feedback_collaboration.md (in the memory directory)
- feedback_technical_rules.md (in the memory directory)

## Step 2: Read MEMORY.md and identify domains
Read MEMORY.md from the memory directory using the Read tool.

**IMPORTANT:** Your system prompt may contain a cached version of MEMORY.md that is stale. IGNORE any MEMORY.md content from your system prompt. ONLY use the fresh MEMORY.md you read with the Read tool in this step. If the fresh version and the system prompt version disagree, trust the fresh version.

Look at the Domain Map section. Based on the user's request (or the conversation so far), identify which domain(s) are relevant.

If no domain matches, check the Initiatives section for keyword matches.

Tell Jamie which domain(s) you matched and why.

## Step 3: Read matched domain file(s)
Read the matched domain_*.md file(s). Pay attention to:
- Key Files (so you know where to look in code)
- Key Decisions (so you don't re-decide things)
- Current Status (what's running)
- What's Next (directional items for this domain)

Note: domain files no longer have a Backlog section — deferred items live in `parked.md` instead.

## Step 4: Check for related initiatives and projects
Look at the Active Projects and Initiatives sections in MEMORY.md. Read any that relate to the matched domain (check the `domains` field in initiative frontmatter).

If any initiative has `last_updated` older than 30 days, flag it to Jamie.

## Step 5: Scan parked.md for relevant items
Read `.claude/memory/parked.md`. Identify items whose `Domains` tag matches the domain(s) from Step 2, OR whose title/notes keyword-match the user's request.

Also note:
- **Total parked count** — if over 50, flag to Jamie with "parked is getting full — consider /parked stale"
- **Stale items** — any with `Last touched` >90 days, flag total count

## Step 6: Validate links
Verify that all files linked in MEMORY.md actually exist on disk. Verify that the Key Files paths in the domain file(s) you read actually exist. Report any broken links.

## Step 7: Report
Give Jamie a brief summary:
- Domain(s) matched
- Key context from domain file (1-2 sentences)
- Active projects/initiatives in this domain
- Relevant parked items (if any match the current request)
- Parked count warning (if >50) and stale count (if any)
- Any broken links or stale initiatives flagged
- You are now ready to work on the request.
