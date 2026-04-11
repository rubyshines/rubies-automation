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

1. **Build AI tooling** — reduce operating time and increase capability across all business functions
2. **Automate customer service** — reduce the ~1hr/day Jamie spends on CS queries
3. **Drive new revenue** — SEO optimization, pricing strategy, discounting and bundles revamp
4. **Expand wholesale reach** — grow retailer partnerships
5. **Expand LGBTQ+ org partnerships** — more community and donation partners
6. **Meta-goal:** Claude becomes a true business co-operator — project management, decision-making, filling operational roles

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

## Systems Landscape

- **CS MCP server** (30+ tools) — customer lookup, orders, exchanges, wholesale orders, knowledge base, sizing, shipping, inventory, reviews, margins, LTV
- **Finance MCP server** — QBO integration, cash flow analysis, margins, tax estimation, budget tracking
- **Ops dashboard** — Gorgias ticket management UI, action router for operator commands
- **Daily sync pipelines** — SEO, email, reviews, products, inventory, orders, customers, conversations, finance (9 pipelines via `daily-sync-all.js`)
- **Wholesale discovery tools** — web scraping, contact finding, lead scoring
- **Webhook infrastructure** — real-time events from Shopify, Gorgias, Gmail
- **Email intelligence** — Gmail classification, B2B contact discovery, inbox digest
- **Competitor pricing** — monthly price monitoring and tracking
- **Deployment:** Railway (scheduled jobs, webhook server), local development

## Guardrails

- **Pronoun sensitivity:** Never use Shopify profile names (dead name risk). Default they/them for customers. Detect whether the buyer is purchasing for themselves or someone else.
- **Brand voice:** All customer-facing content must be playful/supportive, never political, righteous, or judgmental.
- **Always use Opus** (claude-opus-4-6) for AI features — never Sonnet or Haiku for tool-calling.
- **Run tests** before and after changes: `node --test customer-service/test/*.test.js`
