# RUBIES Automations

## RUBIES & Mission

RUBIES makes gender-affirming underwear and swimwear for trans girls and women. Our patented no-tuck shaping technology creates a feminine silhouette without compression, tucking, or gaffing — clothing that looks, wears, and feels like regular underwear and swimwear.

**"Every girl deserves to shine."**

Community programs: free swimwear for families in need, clothing donations to LGBTQ+ organizations, retail partnerships to increase access.

**Brand personality:** Playful but respectful. Confident but approachable. Positive and supportive. Celebrating all girls and women. Quality but not high-end. RUBIES is NOT political, righteous, or judgmental.

**Three pillars:**
1. Be comfortable doing what you love — be active, express yourself, freedom to be who you want to be
2. High quality without being exclusive — engineered with care, tested with our community, money-back guarantee
3. Celebrating all girls, women, and their families — we understand the journey, we listen to actual needs, we're here to help

Website: rubyshines.com

## Jamie & How We Work

Jamie is a solo founder, lifelong coder, and serial entrepreneur. RUBIES is the most successful and rewarding company he's built. He runs the business without employees — working with talented freelancers he inspires rather than babysits.

Jamie is deeply excited about AI as a force multiplier. The long-term vision is for Claude to become a true co-operator across the entire business: knowing everything, prioritizing work, making decisions, and filling roles — so the business can scale without hiring.

Claude is used for coding, customer service operations, financial analysis, content, wholesale, and eventually sales and project management.

## Business Priorities (review quarterly — last updated April 2026)

These are strategic direction. Initiatives in MEMORY.md track execution against these priorities.

1. **Build AI tooling** — reduce operating time and increase capability
2. **Automate customer service** — reduce Jamie's daily CS time
3. **Drive new revenue** — SEO, pricing, content
4. **Expand B2B and LGBTQ+ partnerships** — retailers and community orgs
5. **Meta-goal:** Claude becomes a true business co-operator

## Building Principles

### AI-First Architecture

This project uses Opus (claude-opus-4-6) as the reasoning engine for customer service, action routing, and decision-making. The architecture is: **clear prompts + capable model + real tools**.

**When the AI makes a wrong decision, fix the prompt — not the code.** Do NOT add deterministic pre-processing, regex, counters, or code-based validation to work around AI mistakes. If the AI is reasoning incorrectly, the prompt is unclear or contradictory. Fix the prompt.

This applies to everything:
- Counting customer asks (refund requests, exchange offers) — the AI reads the conversation
- Classifying intent — the AI decides, don't regex customer words
- Detecting conversation state (has a real offer been made?) — the AI can see the messages
- Routing to the right tool — give the AI the tools and let it choose

**Two exceptions** where deterministic code is correct:
1. Mechanical lookups the AI cannot do (e.g., resolving email to Shopify customer ID requires an API call)
2. Deterministic calculations (size chart lookups, pricing math, fabric delta calculations)

### Always use Opus

Use claude-opus-4-6 for all AI-powered features. Never use Sonnet or Haiku for tool-calling or decision-making tasks. Sonnet is unreliable for multi-tool agentic workflows.

### Use the real tools

When building an AI agent feature, give it the actual MCP tool schemas — including lookup and search tools, not just action tools. An agent that can only execute but can't gather info first is useless.

## Systems

See domain files in MEMORY.md for systems detail. Deployment: Railway (scheduled jobs, webhook server), local development.

## Guardrails

- **Pronoun sensitivity:** Never use Shopify profile names (dead name risk). Default they/them for customers. Detect whether the buyer is purchasing for themselves or someone else.
- **Brand voice:** All customer-facing content must be playful/supportive, never political, righteous, or judgmental.
- **No em dashes in customer-facing copy.** Use commas, parentheses, or short sentences instead. Applies to advisor drafts, marketing emails, blog content, and any AI-generated customer text.
- **Always use Opus** (claude-opus-4-6) for AI features — never Sonnet or Haiku for tool-calling.
- **Run tests** before and after changes: `node --test customer-service/test/*.test.js`
- **Memory directory location:** Memory lives at `~/.claude/projects/-Users-jamiealexander-Library-Mobile-Documents-com-apple-CloudDocs-Documents-RUBIES-creative-content-code-rubies-repo-rubies-automations/memory/` and is symlinked into the project at `.claude/memory/` (gitignored). Reference memory files in chat using the workspace-relative path `.claude/memory/<file>.md` so Jamie can click them open in VSCode — both paths resolve to the same files. Do NOT edit memory files at any other location — duplicates elsewhere are stale artifacts.
- **Plans directory location:** Plans live at `~/.claude/plans/` and are symlinked into the project at `.claude/plans/` (gitignored, shared across all projects). Reference plan files as `.claude/plans/<name>.md` so they're clickable in VSCode.
- **Memory Protocol — reading (every session start):**
  1. Read `feedback_collaboration.md` and `feedback_technical_rules.md`
  2. Scan MEMORY.md domain map — match user's request to domain keyword(s). If no domain matches, scan initiative list for keyword match.
  3. Read matched `domain_*.md` file(s) BEFORE exploring code
  4. Check for active `project_*.md` and `initiative_*.md` in that domain (use `domains` field in initiative frontmatter). If any initiative has `last_updated` >30 days old and is contextually relevant, flag to Jamie.
  5. Scan `parked.md` for items whose `Domains` tag matches the matched domain(s), or whose title/notes keyword-match the request. Flag total count if >50 and stale count (items with `Last touched` >90 days).
  6. Validate: verify all MEMORY.md linked files exist and domain Key Files paths exist. Flag any broken links to Jamie immediately.
  7. Only go to code for specifics memory doesn't cover. Never launch exploration agents for things already documented in memory.
- **Memory Protocol — writing (after completing work):**
  - If a change affects what exists, how it works, or a key decision → tell Jamie the proposed update and where it goes in one sentence, write only after approval
  - If work advances a business initiative → tell Jamie the proposed update, write only after approval
  - Initiative updates are high-level progress bullets, not detailed analysis. Capture what happened and what's next, not the full reasoning. If you don't have enough context to summarize, don't add — wait until Jamie discusses progress.
  - Don't duplicate implementation details that live in code or prompts. Domain Key Decisions capture *what we decided and why*, not the rules themselves. If it can be read in the code, it doesn't belong in memory.
  - Don't anchor memory entries to specific examples (ticket IDs, customer names, incidents) unless genuinely illustrative. State rules and decisions abstractly — specific references need context that won't exist in future sessions and go stale fast.
  - Don't record bug fixes, refactors, or config changes — git history covers those
  - Never silently update memory files
  - Before creating any new memory file, check if the content belongs in an existing file. Only create new files after discussing with Jamie and getting approval.
  - After creating, renaming, or deleting any memory file, verify MEMORY.md matches what's on disk before moving on.
- **Memory Protocol — file types:**
  - `feedback_*.md` — only the two existing files. How we collaborate + how we build. Never create new ones.
  - `domain_*.md` — what exists and how it works per business domain. Sections: What's Built, Key Decisions, Key Files, Current Status, What's Next. Current Status = system state only (what's running, what's partial). What's Next = directional items that don't have an initiative yet (move to initiative when one is created). Deferred items (bugs, fixes, ideas) live in `parked.md`, NOT here. Key Files = entry-point files (3-5 per domain) — if you rename, move, or delete a key file, update the domain file in the same change. Update when: a new tool/system is added or removed, or architecture fundamentally changes. Don't update for: config changes, prompt tweaks, bug fixes.
  - `parked.md` — single journal of everything deferred. Bugs, ideas, half-formed plans, refactors, questions, decisions-needed — all in one file, tagged with `Domains` for filtering. Minimum entry: title + `Parked` date + `Domains`. Everything else (Type, Priority, Plan, Notes, Resume when, Last touched) is optional. Never split parked items across multiple files or into domain backlogs. Stale = `Last touched` >90 days. Flag >50 total entries at session start.
  - `project_*.md` — discrete code work with a clear deliverable. Must have `done_when` and `domain` in frontmatter. Promoted from parked when Jamie decides to execute. **Project files are build specs, not knowledge records — they should be detailed and prescriptive, capturing the full plan including alternatives considered, reasoning, edge cases, and decisions made. The terseness rules that apply to domain and initiative files do NOT apply here. A project file should be self-sufficient enough that execution doesn't require re-deriving decisions from the original conversation. Open questions should be resolved in conversation before writing — the project file captures closed decisions only.** When done, merge learnings into domain file, delete project file. If work is paused mid-execution, move remaining scope back to `parked.md` and delete the project file — project files only exist for active work. Single source of truth: if it's a parked entry, it's NOT also a project file, and vice versa.
  - `initiative_*.md` — ongoing business outcomes that may span weeks to months (or longer). Must have `last_updated` and `domains` in frontmatter. Update `last_updated` whenever the file is touched. Has phases/milestones. Current Status = progress toward a business goal (distinct from domain Current Status which is system state). May spawn multiple projects over its lifetime. When complete, MOVE to `.claude/memory/archive/` rather than deleting — initiatives carry business narrative worth preserving.
  - `reference_*.md` — operational references for cross-cutting concerns (e.g. deployment). Not domain-specific. Update `reference_deployment.md` whenever a Railway service is added/removed, a cron schedule changes, or the env var flow changes.
  - `MEMORY.md` — pure index with keyword→domain map at top. One-line entries describe the topic, not current status (static descriptions only). Under 200 lines. No inline content.
- **Memory Protocol — lifecycle & commands:**
  - Workflow: **captured → discussed → planned → executing → validated**. Stages 1–3 all live in `parked.md` (with optional `Plan:` link to `.claude/plans/<name>.md` at stage 3). Stage 4 is a `project_*.md` file. Stage 5 merges learnings into `domain_*.md` Key Decisions and deletes the project.
  - Slash commands: `/park` adds a parked entry from conversation context (auto-generates title, infers domain/type, never requires required fields). `/parked [filter]` lists parked items with optional domain/type/priority/stale filter. `/projects` lists active projects by globbing `project_*.md` on disk (never trusts MEMORY.md). `/initiatives` does the same for initiatives. `/orient` is the session-start routine.
  - Phrase triggers (no slash needed): "park this", "show me parked items", "promote X to a project", "mark project X done", "start a new initiative for X", "archive the X initiative". Recognize these naturally.
  - `Last touched` update rule: only update when the parked entry's file content is edited. Passing mentions in conversation do NOT reset the clock — otherwise staleness becomes meaningless.
  - Park mid-plan: if Jamie is in plan mode and says "park this," include the plan file path in the parked entry's `Plan:` field and exit plan mode.
  - Park mid-execution: if Jamie wants to stop an active project, move remaining scope into a parked entry (with notes about what was done) and delete the `project_*.md` file.
