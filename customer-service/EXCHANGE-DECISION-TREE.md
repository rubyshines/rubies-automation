# Exchange/Return Decision Tree

## Overview

This tree covers the ENTIRE conversation flow from first message to resolution. It walks through phases — each phase must complete before moving to the next. Multiple items can be in different phases simultaneously, but the response composer batches everything into one message.

---

## Phase 0: Safety Override

**Before anything else.** Runs on every message.

```
Does the message indicate safety concerns?
  (hiding items, dangerous situation, "hazardous to have", fear of discovery)
  ├─ YES → IMMEDIATE REFUND. No questions. No conversion attempt.
  │        Express hope for their situation. Provide donation info. STOP.
  └─ NO  → Continue to Phase 1
```

---

## Phase 1: Identify the Customer

**Goal:** Know who we're talking to and establish trust.

```
1a. DETECT NAME
    ├─ Customer introduced themselves (sign-off, "I'm Sarah") → use that name
    └─ No name given → greet without name
        ⛔ NEVER use Shopify profile or shipping address name (dead name risk)

1b. DETECT PRONOUNS
    ├─ "my daughter" / "she" → she/her
    ├─ "my son" / "he" → he/him
    ├─ "my kiddo" / "my child" / no signal → they/them (default)
    └─ Store: buying_for = self | third_party (+ label: daughter, kid, partner, etc.)

1c. FIND CUSTOMER ACCOUNT
    ├─ Search Shopify by conversation email
    │   ├─ Found → pull customer profile + country + address
    │   └─ Not found → ask for order number or email they ordered with
    │       ├─ Order number given → lookup order directly
    │       │   ├─ Found under DIFFERENT email → flag email mismatch
    │       │   │   (reply to conversation email, pull data from order email)
    │       │   └─ Not found → ask for more details (name, alternate email)
    │       └─ Email given → search that email
    └─ Set: country → determines units (inches/cm) and donation partners

1d. DETERMINE UNITS
    ├─ US, CA → inches
    └─ Everything else → cm
```

**Phase 1 is COMPLETE when:** We know who the customer is and have their Shopify account.

---

## Phase 2: Identify the Order(s) and Item(s)

**Goal:** Know exactly which items from which orders they're talking about.

```
2a. IDENTIFY ORDER
    ├─ Customer gave order number → find that order
    │   ├─ Found → verify it's fulfilled + non-cancelled
    │   │   ├─ Not fulfilled → "This order hasn't shipped yet — would you like to modify it instead?"
    │   │   └─ Fulfilled → proceed
    │   └─ Not found (under this customer) → check email mismatch (Phase 1c)
    ├─ No order number given → pull last 4-5 fulfilled orders
    │   ├─ 1 recent order → likely this one, but confirm
    │   └─ Multiple recent orders → ask which order (list them)
    └─ Multiple orders mentioned → track each separately

2b. IDENTIFY ITEMS
    For each order:
    ├─ Customer named specific items → match to order line items
    ├─ Customer said "everything" → all items from that order
    ├─ Customer vague ("the underwear") →
    │   ├─ Only one underwear item in order → that one
    │   └─ Multiple → ask which one(s)
    └─ For EACH identified item, record:
        - product name
        - current size
        - product type (bottom / top / onepiece / chest_pad)
        - size system (numeric = kids, letter = adult)

2c. CHECK FOR MULTI-ITEM SIGNAL
    ├─ Customer exchanging 1 item but order has other items of SAME type + SAME size
    │   → Flag: "I noticed you also have [Ruby] in size 12 — would you like to exchange that too?"
    │   → Only flag same category (bottoms with bottoms, tops with tops)
    ├─ Customer bought same item in 2 sizes (sizing uncertainty)
    │   → Note: offer measurement help to prevent future issues
    └─ No flag needed → proceed

2d. CHECK ORDER AGE
    ├─ ≤60 days → normal processing
    ├─ 60-180 days → we accommodate, gently note: "this is outside our standard window but we want to make sure you're happy"
    ├─ 180 days - 1 year → case-by-case, lean toward helping
    └─ >1 year → escalate to Jamie
```

**Phase 2 is COMPLETE when:** We know which items from which orders the customer wants to exchange/return.

---

## Phase 3: Determine the Action Per Item

**Goal:** What does the customer want to do with each item?

```
3a. CLASSIFY THE REQUEST
    For each item:
    ├─ EXCHANGE_SAME_PRODUCT — want same thing, different size
    ├─ EXCHANGE_DIFFERENT_PRODUCT — want a different product entirely
    ├─ REFUND — want money back
    ├─ PRODUCT_NOT_WORKING — something's wrong but unclear what
    ├─ DEFECT — manufacturing issue (hole, seam, stitching)
    ├─ MISSING_ITEM — never received it
    ├─ CANCELLATION — order not yet shipped, want to cancel
    └─ UNCLEAR — need to ask

    If UNCLEAR:
    └─ Ask: "Can you let me know what didn't work out with the [product name]?"
       → AWAITING_CLARIFICATION
       → When they respond, re-classify

    If customer mentions BOTH exchange AND refund for different items:
    └─ Track each item separately — one can be exchange, another refund

3b. SPECIAL PATHS (bypass the sizing tree)

    MISSING_ITEM:
    ├─ Contacted multiple times → replace immediately + goodwill gesture
    └─ First contact → investigate shipping records, then replace
        → SKIP to Phase 5 (no sizing needed, send same item)

    CANCELLATION:
    ├─ Check: did they place another order same day? → likely duplicate, cancel immediately
    └─ Otherwise → ask why. Often they need to MODIFY, not cancel.
        "If you need to change the size or address, I can update the order for you."
        → AWAITING_DECISION (cancel / modify)

    DEFECT:
    ├─ Ask for photo: "Could you send a photo? We'd like to forward it to our supplier."
    ├─ Check order history: multiple items same size same type across orders?
    │   ├─ YES → likely genuine defect → send replacement same size
    │   └─ NO → might be wearing too tight → also ask for measurement
    │       "To make sure we send the right size for the replacement, could you send your waist measurement?"
    └─ → AWAITING_PHOTO (+ maybe AWAITING_MEASUREMENT)
        ⛔ DEFECTS: customer keeps the original. No donation routing needed.
```

**Phase 3 is COMPLETE when:** Every item has a classified action.

---

## Phase 4: Sizing Resolution Per Item

**Goal:** Determine the correct new size for each item being exchanged.

```
4a. DOES THE CUSTOMER ALREADY KNOW WHAT SIZE THEY WANT?
    ├─ YES ("can I get a size 14 please")
    │   ├─ Confirm with fabric context: "Size 14 gives 2 inches more around the waist — shall I set that up?"
    │   └─ → AWAITING_CONFIRMATION
    └─ NO (they described a problem, need our help) → go to 4b

4b. TRIAGE THE FIT ISSUE
    ├─ CLOSE_FIT: "too tight" / "a bit big" / "snug" / "loose"
    │   Customer is in the right ballpark, 1-2 sizes off.
    │   ├─ Calculate adjacent sizes + fabric delta from size_grading_rules
    │   │   Even sizes: ±2" per step. Odd/half (swimwear): ±1" per step.
    │   ├─ Present options with exact fabric difference:
    │   │   "The next size up (14) gives 2 more inches around the waist,
    │   │    or size 16 gives 4 more inches. Which sounds better?"
    │   └─ → AWAITING_SIZE_CONFIRMATION
    │
    ├─ WAY_OFF: "way too big" / "completely wrong" / wrong size system
    │   Customer ordered the wrong size entirely.
    │   ├─ Ask for measurement:
    │   │   Bottoms → waist (around belly, under belly button)
    │   │   Tops → chest (where bra band sits)
    │   │   One-piece → waist + height
    │   │   Units: inches (US/CA) or cm (everywhere else)
    │   └─ → AWAITING_MEASUREMENT
    │       └─ Measurement received:
    │           ├─ Look up in size_charts table → deterministic size
    │           ├─ ONE-PIECE CHECK: waist + height both fit?
    │           │   ├─ Yes (with ±1 even size wiggle room) → offer that size
    │           │   └─ No (dimensional mismatch) → suggest tankini + bikini bottoms
    │           │       Check order history: own tankini? own bikini bottoms?
    │           ├─ Sizing chart exception? If size seems surprising:
    │           │   "The sizing chart works for most but there can be exceptions"
    │           └─ → AWAITING_SIZE_CONFIRMATION
    │
    ├─ PRODUCT_NOT_WORKING: "doesn't work" / "doesn't hide" / "doesn't conceal"
    │   Could be fit or expectations. MUST probe first.
    │   ├─ Ask: "Can you let me know what didn't work out?"
    │   └─ → AWAITING_CLARIFICATION
    │       └─ Customer clarifies:
    │           ├─ FIT ISSUE → re-enter as CLOSE_FIT or WAY_OFF
    │           ├─ EXPECTATION MISMATCH (shaping vs tucking)
    │           │   ├─ Explain: shaping = feminine mound, NOT flattening
    │           │   │   "RUBIES creates a feminine shape — it's designed for comfort
    │           │   │    during any activity, unlike tucking underwear which flattens"
    │           │   ├─ Ask: is it also a fit issue? Get measurement if so.
    │           │   ├─ Right size + understands but not what they wanted:
    │           │   │   Suggest alternatives:
    │           │   │   - More compression → bikini bottom
    │           │   │   - Shorts → Serena Shorty Shorts
    │           │   │   - Different coverage → product-specific recommendation
    │           │   ├─ One gentle nudge: "I can send another size to try — if it
    │           │   │   doesn't work you can return everything for a full refund"
    │           │   └─ → AWAITING_DECISION (exchange different / refund / keep)
    │           └─ STILL UNCLEAR → ask more specific questions
    │
    ├─ TIGHT_LEGS: "legs are too tight" / "leg openings too small"
    │   This is a style issue, not a size issue.
    │   ├─ Adult underwear (letter sizes) → recommend Sassy + link
    │   ├─ Kids underwear (numeric sizes) → recommend Flo Dance + link
    │   ├─ Adult swim bottoms → recommend Cheeky Bikini + link
    │   └─ → AWAITING_STYLE_CONFIRMATION
    │
    └─ DIFFERENT_PRODUCT: wants something else entirely
        ├─ What are they looking for? Ask if not clear.
        ├─ Search product catalog, recommend with link + sizing
        └─ → AWAITING_PRODUCT_CONFIRMATION

4c. PARENT/KID SENSITIVITY (applies to any sizing conversation)
    If buying_for = third_party AND label is kid:
    ├─ Adapt: "your daughter's comfort is most important" (match their pronoun)
    ├─ NEVER ask how product looks on child — measurements only
    ├─ If parent can't get specifics from child → measurement-based triage
    ├─ Gently suggest parent discuss shaping expectations with child
    └─ Extra patience — these conversations often span days
```

**Phase 4 is COMPLETE when:** Every exchange item has a confirmed new size/product.

---

## Phase 5: Create the Exchange Order

**Goal:** Process the exchange in Shopify.

```
5a. CREATE DRAFT ORDER
    For all confirmed items:
    ├─ Build line items with $0 price (100% exchange discount)
    ├─ Set shipping address from customer profile
    ├─ Tag: "exchange", "cs-mcp"
    ├─ Note: what was exchanged and why
    └─ Present for review: "Here's what I'm setting up: [items]. Shall I confirm?"
        → AWAITING_ORDER_CONFIRMATION

5b. CONFIRM + COMPLETE
    ├─ Customer confirms → mark draft as paid, complete it
    └─ Customer wants changes → modify and re-present

5c. HANDLE REFUND ITEMS (if mixed exchange + refund)
    ├─ Process refund for refund items separately
    └─ Exchange items go through 5a/5b
```

**Phase 5 is COMPLETE when:** Order is created and confirmed in Shopify.

---

## Phase 6: Donation Routing

**Goal:** Tell the customer what to do with the original items.

```
⛔ SKIP for defects — customer keeps the original

6a. DETERMINE ROUTING
    ├─ 1 item + partner in country → "Donate locally to any org supporting the gender-diverse community"
    ├─ Multiple items + partner in country →
    │   Find 3 closest partners by location, pick one with fewest donations_routed
    │   Provide: name, address, description
    ├─ No partner in country → "Donate locally" + ask if they know LGBTQ+ orgs we could partner with
    └─ NEVER cross-border shipping

6b. EXPLAIN THE PROGRAM
    ├─ "We've moved to a donation model where pre-loved items go to LGBTQ+ organizations"
    ├─ Honor system — ship replacement first, no need to wait
    ├─ "Please wash any worn items before donating"
    └─ This is a brand loyalty moment — explain the community impact

6c. LOG THE ROUTING
    └─ log_donation_routing: customer_email, order, partner_id, items_count, routing_type
```

---

## Phase 7: Close the Conversation

```
7a. POSITIVE NOTE
    ├─ If customer said something nice → thank them, ask to spread the word
    └─ Standard: "Your [daughter's] comfort is most important — let us know if you need anything else"

7b. LOG THE CONVERSATION
    └─ cs_log_conversation: category, summary, resolution_type, messages
```

---

## Per-Item States

```
IDENTIFYING          → Don't know which item yet (Phase 2)
CLASSIFYING          → Know the item, determining what they want (Phase 3)
AWAITING_CLARIFICATION → Asked "what didn't work?" waiting for answer
AWAITING_MEASUREMENT → Asked for waist/chest/height
AWAITING_PHOTO       → Asked for defect photo
AWAITING_MEASUREMENT_AND_PHOTO → Defect: need both
AWAITING_SIZE_CONFIRMATION → Offered size options, waiting for pick
AWAITING_STYLE_CONFIRMATION → Offered alternative product
AWAITING_PRODUCT_CONFIRMATION → Offered specific product
AWAITING_DECISION    → Customer choosing between exchange/refund/keep
CONFIRMED            → Customer confirmed size/product (Phase 4 complete)
AWAITING_ORDER_CONFIRMATION → Draft order shown, waiting for final OK
COMPLETE             → Order created
```

## Conversation Status

```
PHASE_1  = Identifying customer
PHASE_2  = Identifying orders/items
PHASE_3  = Classifying actions
PHASE_4  = Sizing resolution
PHASE_5  = Creating orders
PHASE_6  = Donation routing
PHASE_7  = Closing
DONE     = Complete

Status = the EARLIEST incomplete phase across all items
```

---

## What the AI Does vs. What the Tree Does

| Step | Who | Why |
|------|-----|-----|
| Parse customer message → structured fields | **AI** | Unstructured text is messy, AI handles ambiguity |
| Identify customer account, pull orders | **Code** | Shopify API lookups are deterministic |
| Walk decision tree → prescription per item | **Code** | Every branch has a known next step |
| Size chart lookups, grading calculations | **Code** | Math from tables, no judgment |
| One-piece fit check (waist × height) | **Code** | Deterministic from size_charts |
| Donation partner lookup by country | **Code** | Database query |
| Batch prescriptions → response groups | **Code** | Grouping logic |
| Compose response in Jamie's voice | **AI** | Tone, warmth, phrasing from samples |
| Handle true edge cases not in tree | **AI** | With past conversations for reference |

---

## Validation Approach

For each past conversation, extract:
1. **Input:** Customer's first message (structured by AI)
2. **Tree path:** What the tree would prescribe
3. **Actual outcome:** The exchange order that was actually created in Shopify
4. **Match?** Did the tree recommend the same product + size as reality?

This gives us a measurable accuracy score for the tree.
