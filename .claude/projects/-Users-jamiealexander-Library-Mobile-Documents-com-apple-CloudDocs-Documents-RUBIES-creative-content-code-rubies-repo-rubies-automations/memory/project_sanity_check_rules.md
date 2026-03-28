---
name: AI sanity check rules for exchange advisor
description: TEMPORARY — Inconsistencies caught during testing, will become the AI review stage prompt. Delete once rules are coded into exchangeAdvisor.js.
type: project
done_when: A sanity check function exists in customer-service/lib/tools/exchangeAdvisor.js that encodes these rules. Verify by grepping for 'sanityCheck' or 'reviewPass'. Once confirmed, delete this file and remove from MEMORY.md.
---

## Purpose

These rules will power a final AI review pass in the exchange advisor pipeline:
`AI parser → decision tree → response composer → AI review → output (or escalate to Jamie)`

Each rule was discovered during interactive scenario testing. When we build the review stage, these become the check prompt.

## Rules

### Sizing inconsistencies
1. **Waist-fit contradiction:** If customer says "waist fits fine" but the response mentions "fabric around the waist" — flag. The delta wording should match what actually doesn't fit, not default to waist. *(Caught 2026-03-25, Eline/Nico scenario)*

2. **Invalid size for product:** If recommended size doesn't exist for the product category (e.g. odd size for underwear, even size for swim-only product) — flag. *(Caught 2026-03-25, AJ size 9 doesn't exist)*

3. **Size direction mismatch:** If customer describes looseness/bunching but tree recommends sizing up (or vice versa) — flag. *(Caught 2026-03-25, initial run went up instead of down for bunching)*

### Multi-item inconsistencies
4. **Item count mismatch:** If order has N items of the same product/size but response only mentions 1, or donation text says "one item" when there are multiple — flag. *(Caught 2026-03-25, 3 AJs but donation said "one item")*

### Third-party / pronoun inconsistencies
5. **Third-party not reflected:** If customer is buying for someone else (daughter, partner, etc.) but response uses "you" instead of adapting for the third party — flag. *(Caught 2026-03-25, no "her"/"your daughter" in initial response)*

6. **Positive feedback ignored:** If customer says something genuinely warm about the brand and response doesn't acknowledge it — flag. Not every compliment needs a response, but long-time loyalty ("wearing RUBIES since she was 4") should be acknowledged. *(Caught 2026-03-25)*

### Measurement acknowledgment
8. **Measurement provided but not acknowledged:** If customer gives a specific measurement (e.g. "I'm 32 inches") and the response doesn't reference it or validate it against the size chart — flag. Customers who provide measurements want confirmation that their measurement supports the size recommendation. *(Caught 2026-03-25, Jessica scenario — 32" on upper side of M, moving to L)*

### Response tone
7. **Too abrupt on auto-confirm:** If tree auto-confirms a size and response jumps straight to "I've created an order" without any explanation of why that size should work — flag. Customer needs to understand the reasoning. *(Caught 2026-03-25)*

10. **Multiple concerns must be connected:** If customer mentions two related issues (e.g. "shaping not working" + "too loose"), the response must connect them rather than only addressing one. The AI tone pass should recognize when one issue causes the other and frame the response accordingly. *(Caught 2026-03-25)*

9. **Grammar correction:** The AI tone pass should fix all grammar issues in the composed response (e.g. "a AJ" → "an AJ"). This is inherent to having an AI review the text, not a separate check. *(Caught 2026-03-25)*

### Confidence-based routing
11. **Route to human when confidence is low.** If the system isn't confident it can fully address the customer's message, route the ENTIRE conversation to a human. Don't partially answer and ignore the rest. Any analysis already done (exchange sizing, order lookup, etc.) is still useful as context, but the customer gets a human response. This applies across all scopes. As new scopes are added, each should route to human when confidence is insufficient.

## Adding new rules

When testing scenarios, add new rules here with:
- The rule (what to check)
- Date caught
- Brief scenario reference
- Why it matters

**Why:** These accumulate across sessions so nothing is lost. When we build the AI review stage, this file IS the spec.
**How to apply:** After each scenario test, check if any new inconsistency was found and add it here.
