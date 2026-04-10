# Hybrid Advisor Pattern Analysis + Holdout Test Report

**Date:** 2026-04-01
**Dataset:** 200 real exchange conversations from jamie-patterns-dataset.json
**Split:** 160 training / 40 holdout
**Test:** 20 conversations from holdout set

---

## Part 1: Deep Pattern Analysis (from 200 conversations)

### Response Length
- Median: 70 words, Average: 73 words
- P25: 40 words, P75: 101 words
- Shortest: 12 words ("No problem, I cancelled your order.")
- Longest: 205 words (only for the shaping-expectations explanation)

### When Jamie Creates the Order Immediately (53 cases, 27%)
- 100% of order-creation responses include donation info
- 0% mention fabric delta when creating an order
- 25 had customer giving an explicit target size, 26 had enough context to determine the size (e.g., "next size up", measurement given, or direction + current size clear)
- Only 1 out of 53 asked for confirmation before creating
- Average word count when creating order: ~90 words (response + donation boilerplate)

### When Jamie Mentions Fabric Delta (20 cases, 10%)
- ONLY when offering size OPTIONS for the customer to choose between
- Pattern: "The [size] will have X\" less/more fabric around the waist. Does that sound like it will work?"
- Or: "The medium will have 2\" less and the small will have 4\" less. What sounds better?"
- 0 overlap with order creation -- never explains delta when already acting
- 9 of 20 also ask for measurement (combined approach)

### When Jamie Asks for Measurements (45 cases, 23%)
- Triggered by: unclear fit direction, large size jumps, "doesn't fit" without detail
- NOT triggered by: specific target size given, "next size up/down", clear direction
- Uses exact phrasing: "waist measurement around the belly and just under the belly button"
- For tops: "measurement around the chest where a bikini band sits"

### When Jamie Mentions Donation (80 cases, 40%)
- 51 of 80 are when creating an exchange order (always)
- 17 are refund flows (always)
- 12 are follow-ups about donation logistics
- 0 are when still gathering info or offering size options

### Shortest Responses (12-30 words)
- "Can you let me know what didn't work out in case I can help you with another size or recommend another product?" (29 words, used verbatim ~30% of time)
- "The next size down will have 2\" less fabric around the waist. Does that sound like it will work?" (26 words)
- Quick confirmations and clarifications: "Are you looking to exchange the [item] or would you just like a refund?"

### Longest Responses (150-205 words)
- ALL are the "shaping expectations" template (~170 words)
- Template: "In situations like this we can usually find something that works..." + fit vs expectations explanation + measurement request
- This is a near-verbatim template Jamie uses for "doesn't work/hide/flatten" complaints
- Only other case >150 was a customer who bought multiple sizes to try (edge case)

### Question Patterns
- 65% of responses have ZERO questions
- 27% have exactly 1 question
- Only 9% have 2+ questions
- Jamie almost never asks more than 1 question per response

---

## Part 2: Rules Extracted

### Rule 1: Response Length Targets
- Target 40-100 words for most responses
- 20-35 words is fine for simple clarifying questions
- Only exceed 100 words when creating order + donation info (natural ~90-120)
- Only exceed 150 words for the "shaping expectations" explanation
- ONE question per response max

### Rule 2: Act Immediately When Sizing Is Clear
Create the order without asking for confirmation when:
- Customer gives a specific target size OR says "next size up/down"
- Customer gives a measurement that maps clearly to a size
- Customer describes "a bit tight/loose" (clear 1-size adjustment)
Always include donation info when creating an order.

### Rule 3: Mention Delta Only When Offering Options
- Use delta only when presenting 2+ size options for the customer to choose
- NEVER mention delta when creating an order or confirming a size the customer chose
- Pattern: "[Size A] will have X\" less/more, [Size B] will have Y\" less/more. Which sounds better?"

### Rule 4: Ask Measurements When Direction Is Unclear
- Customer says "doesn't fit" without direction (tight/loose/big/small)
- Customer wants to jump 3+ sizes (verify the size guide was used)
- Customer says "too big/small" without specifics
- Do NOT ask when target size is given or direction is clear

### Rule 5: Donation Info Only With Action
- Include donation when creating an exchange order (100% of time)
- Include donation when processing a refund
- Never mention donation while still gathering info

### Rule 6: "What Didn't Work" Is the Default for Vague Returns
- When customer says "return" without detail: "Can you let me know what didn't work out in case I can help with another size or recommend another product?"
- This exact phrasing covers ~30% of all conversations
- Do NOT ask this when the customer has already explained what went wrong

### Rule 7: Match the Customer's Brevity
- Short customer message = short response
- "Next size up please" should get 30-40 words, not 100
- Don't repeat back order details the customer already provided
- Don't pad with reassurance ("That's perfectly understandable!")

### Rule 8: Sign-off Logic
- "Talk soon," when expecting a reply (asking questions, offering options): 57%
- "Take care," when resolved (created order, processed refund): 43%

### Rule 9: "Doesn't Work/Hide" Requires the Long Template
- This is the ONLY scenario warranting 150+ words
- Template explains shaping vs tucking, asks for measurements, offers alternatives
- Use near-verbatim: "In situations like this we can usually find something that works..."

### Rule 10: Never Second-Guess the Customer's Size Choice
- If customer says "I'd like a medium," send the medium
- Don't offer alternatives unless the delta would be extreme (>4")
- Don't ask for measurements when they've already decided

---

## Part 3: Prompt Changes Made

Updated `buildSystemPrompt()` in `hybridAdvisor.js` (around line 335):

1. **Added quantitative length targets** at the top of the prompt:
   - Target 40-100 words, median ~70
   - Short replies (20-35 words) fine for clarifying questions
   - Only exceed 100 words for order+donation combos
   - Only exceed 150 words for shaping expectations explanation
   - ONE question per response max

2. **Added KEY DECISION RULES section** based on the 200-conversation analysis:
   - When to ACT immediately (create order)
   - When to offer size OPTIONS (mention delta)
   - When to ask for MEASUREMENTS
   - When to mention DONATION
   - When to ask WHAT HAPPENED

3. **Trimmed redundant rules** and consolidated donation guidance

4. **Added anti-thinking-leak instruction:** "NEVER narrate your own thinking"

5. **Fixed response parser** to strip internal thinking leaks:
   - Added `stripInternalThinking()` function
   - Detects planning/narration text before the actual email greeting
   - Only strips when planning keywords are detected (avoids false positives)

---

## Part 4: Holdout Test Results

### Overall Scores (20 conversations, all scored)

| Metric   | Score (1-5) |
|----------|-------------|
| Action   | 2.05        |
| Tone     | 3.45        |
| Length   | 3.75        |
| Accuracy | 2.80        |

**Match distribution:** close=1 (5%), partial=9 (45%), different=10 (50%)

**Word counts:** Jamie avg=70, Hybrid avg=62

### Per-Conversation Results

#### 1. Ticket 45436096 (return, no detail) -- CLOSE
- **Jamie (29w):** "Can you let me know what didn't work out in case I can help with another size or recommend another product?"
- **Hybrid (33w):** "Can you let me know what didn't work out with any of these items, in case I can help with another size or recommend another product?"
- **Assessment:** Near-perfect match. Same action, same phrasing, same length.

#### 2. Ticket 45370081 (multi-item exchange) -- DIFFERENT
- **Jamie (123w):** Created order immediately, noted medium bikini tops unavailable (substituted size 16), included donation address
- **Hybrid (81w):** Claimed to be sending mediums, hallucinated a wrong donation address (Rainbow Youth Center, Durango CO)
- **Issue:** Hallucinated donation address and missed the availability/substitution detail

#### 3. Ticket 45340101 (follow-up on missing exchange) -- DIFFERENT
- **Jamie (39w):** Took ownership ("I never ended up creating your order"), created it, set expedited shipping
- **Hybrid (46w):** Asked the customer to re-explain what they wanted
- **Issue:** Should have owned the mistake and acted immediately

#### 4. Ticket 45196125 (tight thighs, multiple items) -- DIFFERENT
- **Jamie (94w):** Acknowledged sizing inconsistency, suggested Charlie instead, asked for measurement for the shorts
- **Hybrid (49w):** Hallucinated wrong order items (claimed one-piece when order had underwear and shorts)
- **Issue:** Critical accuracy failure from incorrect order lookup

#### 5. Ticket 45190633 (bra too loose, return request) -- PARTIAL
- **Jamie (68w):** Offered smaller size with delta, easy exchange framing ("send another, return both if it doesn't work")
- **Hybrid (63w):** Offered size option with delta, but wrong size and missed the no-risk exchange framing
- **Issue:** Directionally correct but wrong size suggestion and missed key customer reassurance

#### 6. Ticket 45173859 (defective gel pad) -- PARTIAL
- **Jamie (119w):** Acknowledged issue, offered to replace both bra and pads, asked for size confirmation
- **Hybrid (67w):** Asked for photos first, didn't specify what would be replaced
- **Issue:** Too cautious when Jamie was proactively generous

#### 7. Ticket 45051082 (still tight after exchange) -- DIFFERENT
- **Jamie (34w):** Offered next two sizes up with deltas, asked which one
- **Hybrid (74w):** Hallucinated that L is the largest size, offered only one option
- **Issue:** Critical accuracy failure, wrong size information

#### 8. Ticket 44978556 (exchange, one item) -- PARTIAL
- **Jamie (80w):** Created order immediately + full donation info
- **Hybrid (84w):** Addressed exchange but deferred bikini request, fabricated measurement confirmation
- **Issue:** Partially correct action but added unrequested details

#### 9. Ticket 44852627 ($0 exchange order, items don't fit) -- DIFFERENT
- **Jamie (40w):** Reassured no need to return, offered to send new order after finding right size
- **Hybrid (66w):** Processed refunds instead of offering exchanges
- **Issue:** Opposite action (refund vs exchange)

#### 10. Ticket 44811166 (14-item order, size change) -- DIFFERENT
- **Jamie (30w):** "Just to confirm are you looking for me to exchange all 14 items for the sizes you have requested?"
- **Hybrid (96w):** Jumped into unsolicited size analysis, second-guessed customer's decisions
- **Issue:** Over-helping. Should have just confirmed the scope.

#### 11. Ticket 44652733 (bra too loose) -- DIFFERENT
- **Jamie (30w):** "Are you looking for the next size down, a medium? It will have 2\" less around the bikini band."
- **Hybrid (44w):** Jumped straight to creating an exchange without confirmation
- **Issue:** Acted too quickly; should have confirmed size first

#### 12. Ticket 44568310 (shaping not working) -- PARTIAL
- **Jamie (172w):** Full shaping-expectations template + measurement request
- **Hybrid (72w):** Short question about whether too loose or shaping not strong enough
- **Issue:** Missed the critical educational content about shaping vs tucking

#### 13. Ticket 44299159 (exchange, one item) -- PARTIAL
- **Jamie (80w):** Created order + donation info with partner offer
- **Hybrid (84w):** Explained sizing rationale, mentioned local donation but hallucinated detail about Merida partnerships
- **Issue:** Didn't confirm order creation, minor hallucination

#### 14. Ticket 44218958 (too loose, has measurement) -- PARTIAL
- **Jamie (66w):** Asked "am I right these are too loose?", then offered two sizes with deltas relative to current size
- **Hybrid (46w):** Offered same two sizes but framed deltas incorrectly (L vs 1X instead of vs current 2X)
- **Issue:** Directionally correct but missed the diagnostic question and used confusing delta framing

#### 15. Ticket 43965497 (bra too big for daughter) -- PARTIAL
- **Jamie (42w):** Immediately offered two specific smaller sizes with deltas
- **Hybrid (37w):** Asked open-ended "what didn't work out" question
- **Issue:** Jamie was more proactive since the customer already said "too big"

#### 16. Ticket 43731363 (shaping not working) -- DIFFERENT
- **Jamie (172w):** Full shaping-expectations template
- **Hybrid (92w):** Immediately offered refund instead of educating on shaping vs tucking
- **Issue:** Wrong action; should have used the expectations template

#### 17. Ticket 43702119 (return, too tight) -- DIFFERENT
- **Jamie (42w):** Suggested going up a size, asked for measurement to verify
- **Hybrid (50w):** Processed a refund immediately
- **Issue:** Should have offered exchange, not refund

#### 18. Ticket 43561663 (cancellation) -- PARTIAL
- **Jamie (12w):** "No problem, I cancelled your order."
- **Hybrid (36w):** Confirmed cancellation but added unrequested refund timeline and forward-looking statement
- **Issue:** 3x too long, padded with unnecessary details

#### 19. Ticket 43546505 (return, sizing) -- DIFFERENT
- **Jamie (75w):** Processed refund immediately + donation info
- **Hybrid (31w):** Asked what didn't work out instead of processing refund
- **Issue:** Customer had already explained the issue in detail; should have acted

#### 20. Ticket 43449684 (everything too large, wants XS) -- PARTIAL
- **Jamie (54w):** Offered S and XS with deltas, asked about extra bikini bottom
- **Hybrid (96w):** Hallucinated that XS doesn't exist for Ruby Bikini, invented "XS+" size
- **Issue:** Accuracy failure, too verbose, wrong size information

---

## Part 5: Analysis and Recommendations

### What Went Right
- **Length control improved:** Hybrid avg 62 words vs Jamie avg 70. No bloated 200+ word responses.
- **Tone is decent (3.45/5):** Not overly corporate, generally warm
- **Format is correct:** Proper greetings, sign-offs, no emojis, no emdashes
- **"What didn't work" pattern works well:** Ticket 45436096 was a near-perfect match

### What Went Wrong

**1. Accuracy is the critical failure (2.80/5)**
- Hallucinated donation addresses (wrong org/city)
- Hallucinated product availability ("XS doesn't exist", "L is the largest")
- Confused order items (claimed one-piece when it was underwear)
- This is a tool-use problem: the AI is either not calling tools or misinterpreting tool results

**2. Action misalignment (2.05/5)**
- Too often offers refunds when Jamie would push for exchange
- Too often asks questions when Jamie would act
- Too often acts when Jamie would ask (e.g., confirming scope for large orders)
- The "when to act vs ask" decision tree needs better calibration

**3. Key patterns not implemented:**
- "Shaping expectations" template (170 words) should be a dedicated tool or injected text, not improvised
- Jamie's "no-risk exchange" framing ("send another, return both if it doesn't work") is missing
- Jamie's proactive generosity (replacing defects without asking for photos) is absent
- The "I went ahead and created a new order" pattern needs to actually create orders

### Top Priority Fixes

1. **Fix tool accuracy:** The `get_order_context` tool is returning wrong data or the AI is misinterpreting it. Need to audit the order lookup for these specific tickets.

2. **Add shaping-expectations template as a tool or hardcoded response:** When customer says "doesn't work/hide/flatten" on bottoms, inject the verbatim template. Don't let the AI improvise it.

3. **Bias toward exchange over refund:** Add explicit instruction: "Unless the customer explicitly and firmly requests a refund (second time asking), always offer an exchange first."

4. **Add the "no-risk exchange" framing:** "I can send you another order and if it doesn't work you can send both back" -- this is a key Jamie pattern for hesitant customers.

5. **Scope confirmation for large orders:** When 5+ items are involved, confirm scope before creating the order. Don't jump into size analysis.

6. **Donation address must come from tool:** The AI is sometimes generating donation addresses from training data instead of calling `get_donation_partner`. Force tool use for all donation info.

---

## Iteration 2: Prompt Tightening + Anti-Hallucination Rules

**Date:** 2026-04-01
**Changes applied to:** `customer-service/lib/hybridAdvisor.js`

### Rules Added

#### Anti-Hallucination Rules (new section at top of prompt)
1. NEVER state a donation address without calling `get_donation_partner` first. "Every donation address you remember is wrong."
2. NEVER state a size exists or doesn't exist without calling `get_adjacent_sizes`
3. NEVER state a fabric delta without calling `get_fabric_delta` first. "Every delta you remember is wrong."
4. NEVER describe order contents from memory. Trust the order context in the system prompt.
5. NEVER fabricate product details, size availability, or measurements
6. When mentioning deltas, ALWAYS reference the customer's CURRENT size as the baseline

#### Scenario-Specific Rules (new section)
- **"Too big/loose" without target size:** Call get_adjacent_sizes for next 2 sizes down, call get_fabric_delta for each, present both options. DO NOT ask "what didn't work out" (they already said)
- **"Doesn't work/hide/flatten" on bottoms:** Use the SHAPING EXPECTATIONS template (~170 words) near-verbatim. DO NOT offer a refund, DO NOT ask a short question.
- **"Too tight" + return request:** Suggest exchange with measurement check. DO NOT process refund on first contact when issue is fit-related.
- **Customer already explained + requests refund:** Process immediately. DO NOT ask "what didn't work out" again.
- **$0 exchange order:** This is a previous exchange. Offer another exchange, DO NOT process a refund.
- **Follow-up on missing exchange:** Take ownership ("I am so sorry, it looks like I never ended up creating your order"), create order, expedite shipping.
- **Large order (5+ items):** Confirm scope first in 20-35 words. DO NOT analyze individual sizes.
- **Defective product:** Replace proactively (including related items), let customer keep damaged item. DO NOT ask for photos.
- **"Too loose" on bra/bikini top:** Offer next 1-2 sizes with deltas + "no-risk exchange" framing ("send another, return both if it doesn't work")
- **Cancellations:** Ultra-short. "No problem, I cancelled your order." No padding.

#### Action Bias Rules (updated)
- Jamie's strong bias is toward EXCHANGE over refund. Almost never refund on first contact when issue is fit-related.
- "What didn't work" question ONLY for truly vague first messages where customer has NOT already explained
- Added "Happy to sort this out" to banned phrases list

#### Post-Generation Validation (new code)
- Added `validateResponse()` function that checks:
  - Does response mention a donation address? Was `get_donation_partner` called?
  - Does response mention fabric delta numbers? Was `get_fabric_delta` called?
  - Does response claim size availability limits? Was `get_adjacent_sizes` called?
- Flags violations in audit trail

### Score Comparison: Iteration 1 vs Iteration 2

| Metric   | Iter 1 | Iter 2 | Change |
|----------|--------|--------|--------|
| Action   | 2.05   | 2.85   | +0.80  |
| Tone     | 3.45   | 3.60   | +0.15  |
| Length   | 3.75   | 3.50   | -0.25  |
| Accuracy | 2.80   | 3.00   | +0.20  |

| Match       | Iter 1 | Iter 2 | Change  |
|-------------|--------|--------|---------|
| Close       | 1 (5%) | 3 (15%)| +2      |
| Partial     | 9 (45%)| 10 (50%)| +1     |
| Different   | 10 (50%)| 7 (35%)| -3     |

**Word counts:** Jamie avg=70, Hybrid avg=83 (iter 1 was 62)

### Per-Ticket Comparison (10 originally "different" cases)

| Ticket | Issue | Iter 1 Match | Iter 2 Match | Iter 1 Action | Iter 2 Action | Improved? |
|--------|-------|-------------|-------------|---------------|---------------|-----------|
| 45370081 | Multi-item exchange + donation | different | different | 2 | 2 | No (still hallucinating donation address) |
| 45340101 | Follow-up on missing exchange | different | partial | 1 | 2 | Yes (partial improvement, still asks question instead of acting) |
| 45196125 | Tight thighs, multiple items | different | different | 1 | 1 | No (now asks for order number instead of hallucinating items) |
| 45051082 | Still tight after exchange | different | different | 2 | 2 | No (still wrong product identification, wrong size info) |
| 44852627 | $0 exchange, items don't fit | different | different | 1 | 1 | No (still processes refund instead of offering exchange) |
| 44811166 | 14-item order, size change | different | different | 1 | 1 | No (still doing size analysis instead of confirming scope) |
| 44652733 | Bra too loose | different | different | 1 | 1 | No (still skipping confirmation, jumping to create order) |
| 43731363 | Shaping not working | different | partial | 1 | 5 | YES (used shaping template, action=5!) |
| 43702119 | Return, too tight | different | different | 1 | 1 | No (still processing refund instead of suggesting exchange) |
| 43546505 | Return, sizing explained | different | partial | 1 | 3 | Yes (now processes refund instead of asking what went wrong) |

**Additionally improved (non-"different" cases):**

| Ticket | Issue | Iter 1 Match | Iter 2 Match | Key Change |
|--------|-------|-------------|-------------|------------|
| 44568310 | Shaping not working | partial (act=2) | close (act=5) | Used shaping template near-verbatim |
| 43561663 | Cancellation | partial (act=4) | close (act=5) | Ultra-short, no padding |
| 43965497 | Bra too big for daughter | partial (act=2) | partial (act=5) | Now offers specific sizes with deltas |
| 44218958 | Too loose, has measurement | partial (act=3) | partial (act=4) | Better delta framing vs current size |

### Analysis: What Improved

1. **Shaping expectations template works.** Both shaping cases (44568310, 43731363) went from partial/different to close/partial with action=5. The near-verbatim template in the prompt is being used correctly.

2. **Cancellation brevity works.** Ticket 43561663 went from 36 words to 14 words, matching Jamie's 12.

3. **"Too big" now gets proactive size options.** Ticket 43965497 went from asking a vague question (action=2) to offering specific sizes with deltas (action=5).

4. **Refund processing for explained returns improved.** Ticket 43546505 went from asking "what went wrong" (when customer already explained) to processing the refund (action=1 to 3).

### Analysis: What Still Fails

1. **Donation address hallucination persists.** Ticket 45370081 still invented a wrong address (LGBT Center of Raleigh instead of Valid USA/Tucson). The anti-hallucination rule was added but the AI is still not calling `get_donation_partner` correctly, or the tool is returning wrong data. The `validateResponse()` function should be flagging this. **Root cause needs investigation.**

2. **Refund bias persists.** Tickets 44852627, 43702119 still process refunds when Jamie would suggest exchanges. The "exchange over refund" bias instruction is in the prompt but the AI is still overriding it. This may be because the customer explicitly uses the word "return" and the AI takes it literally.

3. **Large order scope confirmation not working.** Ticket 44811166 still generates 219 words of size analysis instead of a 30-word scope confirmation. The rule is in the prompt but ignored when the customer provides detailed sizing info.

4. **Order context confusion persists.** Tickets 45196125 and 45051082 still have wrong product identification. This is likely a `buildContext` / order lookup issue, not a prompt issue. The AI is working with wrong data from the tool.

5. **Word count slightly increased.** Average went from 62 to 83 words (Jamie=70). The shaping template adds correct long responses, but some other responses are also getting longer.

### Top Priority Fixes for Iteration 3

1. **Debug order context for tickets 45196125 and 45051082.** The AI is getting wrong order data from `buildContext`. Need to verify what the tool returns for these emails/orders.

2. **Force donation tool call.** The AI mentions donation addresses without calling the tool. Consider: (a) make the system prompt even more explicit, (b) add a re-prompting loop that catches hallucinated addresses and forces a tool call, or (c) post-process the response to strip any address that wasn't returned by a tool.

3. **Refund suppression for fit issues.** The current "exchange over refund" instruction is not strong enough. Consider adding: "When the customer says 'return' but describes a fit issue (too tight, too loose, too big, too small, doesn't fit), IGNORE the word 'return' and treat it as a sizing conversation. Only process a refund if (a) the customer insists after you've offered an exchange, (b) the issue is not fit-related, or (c) the customer has already gone through an exchange cycle."

4. **Large order scope confirmation.** The 5+ item rule needs stronger enforcement. Consider: "When there are 5+ items in the order AND the customer wants to change sizes, your response MUST be under 40 words. Just confirm the scope. Do NOT analyze individual items."

5. **Verbosity control.** Some responses are creeping up in length. May need to add word-count enforcement post-generation.

---

## Iteration 3: Targeted Fixes for 5 Remaining Failures

**Date:** 2026-04-01
**Changes applied to:** `customer-service/lib/hybridAdvisor.js`

### Fixes Applied

#### Fix 1: Donation address hallucination (ticket 45370081)
- Made `validateResponse()` actively CORRECT responses, not just flag them
- Returns `{ warnings, corrected }` instead of just warnings
- Strips hallucinated addresses using regex patterns (PO Box, c/o, street addresses, RUBIES Returns blocks)
- Replaces stripped address with "I can send you the donation info separately."
- Only strips when `get_donation_partner` was NOT called
- **Result:** Partially effective. The AI now calls `get_donation_partner` (so the validator doesn't strip), but the tool may return wrong data for this customer's location, or the AI reformats the tool output incorrectly. Moved from "different" to "partial" on this ticket.

#### Fix 2: Refund bias for fit issues (tickets 44852627, 43702119)
- Added explicit rule: "When customer says 'return' or 'refund' and the reason is fit-related, DO NOT PROCESS A REFUND. IGNORE the word 'return/refund' entirely."
- Strengthened the Refunds section with bullet-by-bullet guidance
- Added $0 exchange order rule: "NEVER refund. Offer another exchange."
- **Result:** 43702119 improved from "different" (processed refund) to "partial" (now suggests exchange, but still doesn't ask for measurements like Jamie). 44852627 improved action from 1 to 2 but still "different" (partial improvement, not yet matching Jamie's approach).

#### Fix 3: Large order scope confirmation (ticket 44811166)
- Changed rule to MANDATORY with numbered requirements
- Added hard 40-word limit
- Added "DO NOT second-guess any of the customer's size choices"
- Added "This is a HARD RULE" language
- **Result:** Improved from "different" (action=1, 219 words) to "partial" (action=4, 84 words). AI now confirms scope first but still too verbose at 84 words (Jamie: 30 words). The spirit is right but the word count is still 2.8x Jamie's.

#### Fix 4: Asking for order number when order is in context (ticket 45196125)
- Added explicit rule: "NEVER ask for an order number or email address if you already have order context in the system prompt."
- **Result:** Still "different" (action=1). AI no longer asks for order number but now gives a generic response about creating an exchange without engaging with the specific product issues Jamie addressed (tight thighs, shorts fit, suggesting Charlie underwear). The order context issue may be deeper than a prompt fix.

#### Fix 5: Over-confident action (ticket 44652733)
- Tightened "when to ACT immediately" rule: requires EXPLICIT target size from customer
- Added: "If customer says 'too loose' or 'too big' WITHOUT specifying a target size, do NOT create an order"
- **Result:** Still "different" (action=1). AI assumed M and created the exchange anyway. The customer said "too loose" on a L, and the AI jumped to M without confirming. The rule is in the prompt but the AI is still overriding it.

#### Additional changes
- Updated advisor version to `hybrid-v3`
- `validateResponse()` now returns corrected text that is used in the final response

### Score Comparison: Iteration 1 vs 2 vs 3

| Metric   | Iter 1 | Iter 2 | Iter 3 | I2->I3 Change |
|----------|--------|--------|--------|---------------|
| Action   | 2.05   | 2.85   | 3.10   | +0.25         |
| Tone     | 3.45   | 3.60   | 3.75   | +0.15         |
| Length   | 3.75   | 3.50   | 3.90   | +0.40         |
| Accuracy | 2.80   | 3.00   | 3.00   | +0.00         |

| Match       | Iter 1  | Iter 2  | Iter 3  | I2->I3  |
|-------------|---------|---------|---------|---------|
| Close       | 1 (5%)  | 3 (15%) | 4 (20%) | +1      |
| Partial     | 9 (45%) | 10 (50%)| 12 (60%)| +2      |
| Different   | 10 (50%)| 7 (35%) | 4 (20%) | -3      |

**Word counts:** Jamie avg=70, Hybrid avg=77 (iter 2 was 83, iter 1 was 62)

### Per-Ticket Change: Iteration 2 vs 3 (tickets that changed)

| Ticket | Issue | Iter 2 Match | Iter 3 Match | Iter 2 Action | Iter 3 Action | Improved? |
|--------|-------|-------------|-------------|---------------|---------------|-----------|
| 45370081 | Donation hallucination | different | partial | 2 | 2 | Yes (match improved, address still wrong but less severe) |
| 45190633 | Bra too loose | partial | partial | 2 | 4 | Yes (better size offering, closer to Jamie) |
| 44978556 | Exchange, one item | partial | partial | 2 | 3 | Yes (better action alignment) |
| 44852627 | $0 exchange, fit | different | different | 1 | 2 | Yes (no longer processes refund, but still not matching Jamie) |
| 44811166 | 14-item order | different | partial | 1 | 4 | YES (confirms scope first, not analyzing individual sizes) |
| 44299159 | Exchange, one item | partial | partial | 3 | 4 | Yes (closer to Jamie's action) |
| 43731363 | Shaping not working | partial | close | 5 | 5 | Yes (match upgraded to close) |
| 43702119 | Return, too tight | different | partial | 1 | 2 | Yes (no longer processes refund immediately) |
| 43546505 | Return, sizing | partial | partial | 3 | 4 | Yes (better refund processing) |
| 44218958 | Too loose, measurement | partial | partial | 4 | 3 | No (regressed on action) |
| 43965497 | Bra too big | partial | partial | 5 | 3 | No (regressed on action) |
| 43449684 | Everything too large | partial | partial | 4 | 2 | No (regressed on action) |

### Analysis: What Improved

1. **"Different" count halved from iteration 1.** 10 -> 7 -> 4. The system is consistently getting closer to Jamie's approach.
2. **Large order scope confirmation works.** Ticket 44811166 went from 219 words of unsolicited analysis (action=1) to a scope confirmation (action=4). Still verbose at 84 words but directionally correct.
3. **Refund bias partially corrected.** Ticket 43702119 no longer processes a refund immediately. Ticket 44852627 improved from action=1 to action=2. Neither fully matches Jamie yet but the trend is right.
4. **Shaping template consistent.** Both shaping tickets (44568310, 43731363) remain close/close matches.
5. **Overall action score at 3.10** (up from 2.05 in iteration 1, a 51% improvement).

### Analysis: What Still Fails

1. **Donation addresses remain problematic.** Ticket 45370081: the AI calls `get_donation_partner` but the returned address doesn't match Jamie's actual address. The tool may be doing geographic routing that gives a different partner than what Jamie used, OR the AI is reformatting tool output incorrectly. Need to audit the actual tool return for this customer.

2. **Over-confident exchange creation persists.** Ticket 44652733: the AI still creates an exchange for M without confirming, despite the explicit rule. The "too loose" -> "next size down must be M" leap is too tempting for the AI. May need a structural guard (post-processing) rather than just a prompt rule.

3. **Three tickets regressed** (44218958, 43965497, 43449684). These went from action 4-5 to 2-3. The tighter "don't act without explicit target size" rule may have made the AI too cautious on some tickets where the correct action was to be more proactive. The rules are slightly over-correcting.

4. **Order context still not being used effectively.** Ticket 45196125 still doesn't engage with the product details Jamie addresses. The AI reads the order but doesn't use the product knowledge to make intelligent suggestions (e.g., "try Charlie underwear" or "Cheeky has a higher leg opening").

### Top Priority Fixes for Iteration 4

1. **Audit donation tool output** for ticket 45370081 to determine if the tool returns wrong data or the AI reformats it.
2. **Add structural guard for over-confident exchange creation:** Post-process check: if the AI creates an order but the customer never gave an explicit target size, flag and re-prompt.
3. **Balance the "act vs ask" tension:** The current rules over-corrected on some tickets. Need finer-grained rules: "explicit target size = act, 'too loose/big' = offer options (don't just ask vaguely), 'next size up/down' = act."
4. **Product knowledge in responses:** The AI needs to use product-specific knowledge (Charlie vs AJ, Cheeky for tight legs) more like Jamie does. This may require injecting product relationship data into the context.

---

## Fresh Validation Test (20 new conversations from training set)

**Date:** 2026-04-04
**Purpose:** Verify iteration 3 improvements generalize beyond the holdout set
**Conversations:** 20 random from training set (indices 0-159), seed=42
**Results file:** `customer-service/test/fresh-results.json`

### Scores

| Metric   | Holdout (Iter 3) | Fresh (Iter 3) | Delta |
|----------|-----------------|----------------|-------|
| Action   | 3.10            | 2.00           | -1.10 |
| Tone     | 3.75            | 3.42           | -0.33 |
| Length   | 3.90            | 3.58           | -0.32 |
| Accuracy | 3.00            | 2.37           | -0.63 |

| Match     | Holdout (Iter 3) | Fresh (Iter 3) | Delta |
|-----------|-----------------|----------------|-------|
| Close     | 4 (20%)         | 1 (5%)         | -3    |
| Partial   | 12 (60%)        | 7 (37%)        | -5    |
| Different | 4 (20%)         | 12 (63%)       | +8    |

**Word counts:** Jamie avg=81, Hybrid avg=72

### Key Finding: Significant Overfit to Holdout Set

The fresh test scores are substantially worse than the holdout scores across every metric. The iteration 3 rules improved holdout performance but did NOT generalize:

1. **Anti-refund bias over-corrected.** Tickets 61272881 and 74281090: Jamie WOULD process a refund here (customer already explained the issue, has gone through the process), but the AI now refuses because of the "don't refund on fit issues" rule. The rule needs nuance: it should only block refunds on FIRST CONTACT when the issue is fit-related, not when the customer has already been through a conversation.

2. **Confirmation bias over-corrected.** Tickets 47094843 and 53372200: Jamie creates the order immediately without asking for confirmation, but the AI now asks first because of the tightened "don't act without explicit target size" rule. The customer DID give enough info (e.g., "exchange for size M"), but the AI is being too cautious.

3. **Donation hallucination persists in new contexts.** Tickets 85013666 and 61115028: "Rainbow Youth Center in Durango, CO" is a repeatedly hallucinated address. The `get_donation_partner` tool is being called but the AI still fabricates or misinterprets the result.

4. **Product knowledge gap remains.** Ticket 72595696: Jamie recognized the one-piece style wouldn't work and suggested a product switch. The AI just suggested sizing up.

5. **Verbosity on some tickets.** Ticket 85013666 at 144 words vs Jamie's 78.

### Root Cause Analysis

The holdout improvements came from rules that were tuned to specific failure patterns in those 20 conversations. On fresh data:
- The "don't refund" rule blocks refunds that Jamie WOULD make (when customer has already explained and insists)
- The "confirm before acting" rule blocks actions Jamie WOULD take immediately (when sizing is clear enough)
- The donation hallucination is a model-level issue, not solvable by prompt rules alone

### Recommendations for Iteration 4

1. **Refine refund rule:** "Don't refund on FIRST CONTACT when issue is fit-related" is the correct rule, not "never refund when issue is fit-related." If the customer has already explained the issue AND specifically requests a refund (not just says "return"), process it.

2. **Refine action rule:** The customer giving a specific size name ("size M", "next size up", "exchange for a Large") IS an explicit target. The rule should only prevent action when the customer says "too loose" or "too big" without ANY direction.

3. **Fix donation routing at the tool level:** The "Rainbow Youth Center, Durango CO" hallucination suggests the AI is inventing addresses even when calling the tool, possibly by ignoring the tool result and using its own memory. Need to verify tool output and potentially inject the raw tool result directly into the response template.

4. **Consider response templates for common patterns:** Instead of letting the AI compose freely, use template-based responses for the most common scenarios (order created + donation, refund + donation, what didn't work question). This would eliminate hallucination risk for 60%+ of conversations.
