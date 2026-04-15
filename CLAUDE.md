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
- **Always use Opus** (claude-opus-4-6) for AI features — never Sonnet or Haiku for tool-calling.
- **Run tests** before and after changes: `node --test customer-service/test/*.test.js`
- **Memory directory location:** The authoritative memory directory is `~/.claude/projects/-Users-jamiealexander-Library-Mobile-Documents-com-apple-CloudDocs-Documents-RUBIES-creative-content-code-rubies-repo-rubies-automations/memory/`. Always use this path for any direct file operations (audit, restore, manual edit). Do NOT edit memory files at any other path — duplicates at other locations (e.g., inside the project directory) are stale artifacts and should be ignored or deleted.
- **Memory Protocol — reading (every session start):**
  1. Read `feedback_collaboration.md` and `feedback_technical_rules.md`
  2. Scan MEMORY.md domain map — match user's request to domain keyword(s). If no domain matches, scan initiative list for keyword match.
  3. Read matched `domain_*.md` file(s) BEFORE exploring code
  4. Check for active `project_*.md` and `initiative_*.md` in that domain (use `domains` field in initiative frontmatter). If any initiative has `last_updated` >30 days old and is contextually relevant, flag to Jamie.
  5. Validate: verify all MEMORY.md linked files exist and domain Key Files paths exist. Flag any broken links to Jamie immediately.
  6. Only go to code for specifics memory doesn't cover. Never launch exploration agents for things already documented in memory.
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
  - `domain_*.md` — what exists and how it works per business domain. Sections: What's Built, Key Decisions, Key Files, Current Status, What's Next, Backlog. Current Status = system state only (what's running, what's partial) — no gaps (gaps go to Backlog or What's Next). What's Next = directional items that don't have an initiative yet (move to initiative when one is created). Backlog = specific bugs/fixes/tasks for later. Key Files = entry-point files (3-5 per domain) — if you rename, move, or delete a key file, update the domain file in the same change. Update when: a new tool/system is added or removed, or architecture fundamentally changes. Don't update for: config changes, prompt tweaks, bug fixes.
  - `project_*.md` — discrete code work with a clear deliverable. Must have `done_when` and `domain` in frontmatter. Promoted from domain backlog when non-trivial. **Project files are build specs, not knowledge records — they should be detailed and prescriptive, capturing the full plan including alternatives considered, reasoning, edge cases, and decisions made. The terseness rules that apply to domain and initiative files do NOT apply here. A project file should be self-sufficient enough that execution doesn't require re-deriving decisions from the original conversation. Open questions should be resolved in conversation before writing — the project file captures closed decisions only.** When done, merge learnings into domain file, delete project file. Single source of truth: if it's a backlog bullet, it's NOT also a project file, and vice versa.
  - `initiative_*.md` — ongoing business outcomes that may span weeks to months (or longer). Must have `last_updated` and `domains` in frontmatter. Update `last_updated` whenever the file is touched. Has phases/milestones. Current Status = progress toward a business goal (distinct from domain Current Status which is system state). May spawn multiple projects over its lifetime.
  - `MEMORY.md` — pure index with keyword→domain map at top. One-line entries describe the topic, not current status (static descriptions only). Under 200 lines. No inline content.
