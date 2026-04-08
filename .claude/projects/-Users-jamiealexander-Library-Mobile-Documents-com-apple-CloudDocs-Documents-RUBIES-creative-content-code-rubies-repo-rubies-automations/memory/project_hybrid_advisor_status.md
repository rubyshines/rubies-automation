---
name: Hybrid Advisor Status
description: Current state of the Opus hybrid CS advisor — in production, validated on 60+ conversations, key files and architecture
type: project
---

## Status: IN PRODUCTION (committed 2026-04-04)

Commit: a367117 — "Add hybrid CS advisor (Opus + deterministic tools), refactor poller architecture"

## Architecture
- `customer-service/lib/hybridAdvisor.js` — Opus with 8 deterministic tools, 51 tone samples, pattern-based rules
- Poller uses hybrid advisor with tree fallback (if Opus errors, falls back to Sonnet decision tree)
- Dashboard simulator uses hybrid advisor
- Cost: ~$0.08/convo, 15s avg response time

## What was validated
- 60+ real conversations across 4 rounds of testing
- Turn 1 (first response) and Turn 2 (after customer reply) tested
- Test infrastructure: `test/runHoldout.js`, `test/runTurn2.js`, `test/runOneConvo.js`
- Results files: `test/holdout-review.md`, `test/turn2-review.md`

## Known gaps
- Thinking leak: `stripInternalThinking()` catches most but not all cases
- Won't match Jamie's personal warmth on emotional stories or business generosity (free items, partnerships)
- Donation partner routing returns real addresses from tool, but different partners than Jamie may have used historically
- `cs_messages` table has incorrect `sender_type` (all marked 'agent') — Gorgias API needed for message fetching

## Key decisions
- Opus over Sonnet: dramatically better judgment on edge cases, worth the 5x cost
- No decision tree in the loop: Opus calls deterministic tools directly instead of running tree first
- 51 tone samples loaded into system prompt (all situations, not just exchange)
- Long→Tall alias fixed in `parseSizeVariant()` in decisionTree.js
- Poller refactored: all business logic in MCP tools, poller is transport only
- `source` and `advisor_version` columns added to `cs_ai_drafts` (migration SQL in drafter/ai-drafts-schema.sql — needs to be run in Supabase SQL Editor)

## Pending migration SQL (NOT YET RUN)
```sql
ALTER TABLE cs_ai_drafts ADD COLUMN IF NOT EXISTS source text DEFAULT 'poller';
ALTER TABLE cs_ai_drafts ADD COLUMN IF NOT EXISTS advisor_version text;
ALTER TABLE cs_ai_feedback_log ADD COLUMN IF NOT EXISTS advisor_version text;
CREATE INDEX IF NOT EXISTS idx_drafts_source ON cs_ai_drafts (source);
```
