---
name: Scenario testing workflow for CS advisor
description: Full process for exchange advisor scenario testing — how to start a session, pull context, run tests, and when to write unit tests.
type: feedback
done_when: Exchange advisor scenario testing is complete and the system is in production. Check if project_scenario_testing_plan.md still exists.
---

When starting any scenario testing session for the exchange advisor:

### Session startup — always do this first
1. **Understand the goal** — What scenarios/tier are we testing? Ask if unclear.
2. **Pull relevant real conversations from Supabase** — Query `cs_conversations` + `cs_messages` filtered by the scenario type (product, issue, sizing pattern). Read full message threads to see how customers actually describe these issues and how Jamie responded. Use `analyze-scenarios.js` for broad analysis or direct queries for targeted pulls.
3. **Find real test customers** — Identify emails + order numbers from those conversations. These become inputs for `test_exchange_conversation`.

### During testing
4. **Always show full results in chat INCLUDING order details** — Every scenario output must include the original order info (all line items with product, variant, SKU, quantity) followed by the full conversation and resolution. Jamie cannot validate the response without seeing the order context. NEVER skip or abbreviate the order section.
5. **Run tests directly via node, not MCP** — Run `test_exchange_conversation` directly (e.g. via a node script or the conversation tester module) instead of through the MCP tool. Direct execution is faster and picks up code changes immediately without needing an MCP server restart.
6. **Always rerun after changes** — whenever a fix is made to the tree/composer/parser, rerun the scenario and show the updated output.
7. **Run scenarios interactively** — Use real customer data. Review with Jamie before assuming correctness.

### After validation
7. **Fix issues first, tests last** — Only write unit tests AFTER Jamie validates the behavior. Tests lock in validated behavior, not assumptions.
8. **Always write tests before ending a scenario session** — After each scenario is validated and the code is working, write unit tests to lock in the behavior BEFORE moving on. Don't accumulate untested changes across a session — test as you go. Every new decision tree path, new action type, or behavioral change needs a corresponding unit test.

**Why:** Writing tests before interactive validation led to tests encoding wrong assumptions. The conversations in Supabase are a good guide for understanding patterns, but Jamie is human — any single conversation may not be perfectly consistent with how things should be handled. Use conversations to understand the landscape and common patterns, not as exact templates. Jamie validates the correct behavior in real time during testing.

Jamie needs to see results immediately to give feedback. The relevant conversations change depending on what we're testing.

**How to apply:** Every time the user says "let's test scenarios" or "let's work on tier X", start with steps 1-3 before touching any code or tests.
