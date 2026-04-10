# RUBIES Automations — Development Principles

## AI-First Architecture

This project uses Opus (claude-opus-4-6) as the reasoning engine for customer service, action routing, and decision-making. The architecture is: **clear prompts + capable model + real tools**.

### When the AI makes a wrong decision, fix the prompt — not the code

Do NOT add deterministic pre-processing, regex, counters, or code-based validation to work around AI mistakes. If the AI is reasoning incorrectly, the prompt is unclear or contradictory. Fix the prompt.

This applies to everything:
- Counting customer asks (refund requests, exchange offers) — the AI reads the conversation
- Classifying intent — the AI decides, don't regex customer words
- Detecting conversation state (has a real offer been made?) — the AI can see the messages
- Routing to the right tool — give the AI the tools and let it choose

The ONE exception: mechanical format translations the AI cannot do (e.g., resolving email to Shopify customer ID requires an API call). That's a lookup, not a decision.

### Always use Opus

Use claude-opus-4-6 for all AI-powered features. Never use Sonnet or Haiku for tool-calling or decision-making tasks. Sonnet is unreliable for multi-tool agentic workflows.

### Use the real tools

When building an AI agent feature, give it the actual MCP tool schemas — including lookup and search tools, not just action tools. An agent that can only execute but can't gather info first is useless.

## Code Organization

- `customer-service/lib/sizeUtils.js` — Single source of truth for size constants, normalization, SKU parsing, variant option helpers
- `customer-service/lib/csConfig.js` — Product classification, nicknames, sizing helpers, legacy decision tree (not in active execution path)
- `customer-service/lib/donationRouting.js` — Geographic donation partner matching
- `customer-service/lib/hybridAdvisor.js` — Active CS advisor (Opus-based), handles all customer-facing logic
- `customer-service/lib/actionRouter.js` — Agentic tool executor for dashboard operator commands
- `customer-service/lib/productCache.js` — Product catalog with fuzzy search, loaded from Supabase

## Testing

Run tests with: `node --test customer-service/test/*.test.js`
