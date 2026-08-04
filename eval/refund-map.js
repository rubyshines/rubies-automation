/**
 * The refund decision map — every path, and where its rule currently lives.
 *
 * Refund logic is spread across 24 sections of the advisor prompt. Nobody has
 * ever seen it in one place, which is how contradictions survive: two rules in
 * two sections can disagree for months and each reads fine on its own.
 *
 * This is a REVIEW artifact, not a runtime one. It never executes. The point
 * is to let Jamie rule on the decision space; encoding it back as a branching
 * tree in the prompt is what produced the sprawl in the first place.
 *
 * `conflict` is populated where I believe two rules actually disagree, or
 * where a rule and Jamie's observed behaviour disagree. Those are the rows
 * worth his time; the rest are there so the map is complete.
 */

// kind: 'gate' = deterministic policy (candidate for a tool)
//       'judgment' = reasoning that cannot be enumerated (stays in the prompt)
//       'output' = what the reply must contain once the decision is made
const PATHS = [
  {
    step: '1. Is this actually a refund request?',
    kind: 'judgment',
    trigger: 'Any message mentioning refund, return, money back',
    decision: 'Only treat as a refund request if the customer explicitly asked for that outcome. Confirming a fact, expressing mild doubt, or describing a problem is NOT a request.',
    lives: 'ANTI-HALLUCINATION rule 9',
    conflict: '',
  },
  {
    step: '2. Is it a $0 exchange order?',
    kind: 'gate',
    trigger: 'Order total is $0 (a previous exchange)',
    decision: 'NEVER refund. Offer another exchange instead.',
    lives: 'Scenario: $0 exchange order + Refunds (additional rules)',
    conflict: '',
  },
  {
    step: '3. How old is the order?',
    kind: 'gate',
    trigger: 'days_since_order from context',
    decision: '0-60 process normally · 61-180 process but note it as generous · over 180 route to human',
    lives: 'Refund Eligibility by Order Age',
    conflict: 'Exchanges use different boundaries for the same customer: 0-60 / 61-180 / 181-365 case-by-case / over 365 escalate. So a 200-day-old order can be exchanged on judgment but a refund on it must route to you. Intended?',
  },
  {
    step: '4. How many prior refunds?',
    kind: 'gate',
    trigger: 'Customer order history line',
    decision: '2 or more previously refunded orders: do NOT stage the refund, route to human. One prior refund is normal, process it.',
    lives: 'Refund-pattern flag section',
    conflict: '',
  },
  {
    step: '5. Have they had REAL sizing help yet?',
    kind: 'judgment',
    trigger: 'Read the conversation. A real offer = you suggested a specific size, gave a fabric delta, or asked for a measurement. The Gorgias bot asking "would you like to exchange?" does NOT count.',
    decision: 'NO: nudge first, treat it as a sizing conversation. YES: process the refund immediately, do not make them ask twice.',
    lives: 'Refunds — when to process vs when to nudge + Scenario: return or refund',
    conflict: 'Refunds (additional rules) opens with "Process refunds and exchanges IMMEDIATELY" with no mention of the nudge. Read alone that line skips step 5 entirely, and it sits 200 lines away from the rule it contradicts.',
  },
  {
    step: '5a. Exceptions that skip the nudge',
    kind: 'judgment',
    trigger: 'Safety situation · customer explicitly says "just a refund"/"no exchange" after real help · product fundamentally does not work (not a sizing issue)',
    decision: 'Process immediately even if no sizing help was offered.',
    lives: 'Refunds — when to process vs when to nudge',
    conflict: '',
  },
  {
    step: '6. Are the items unambiguous?',
    kind: 'judgment',
    trigger: 'What they are returning contradicts the order contents or their own earlier message',
    decision: 'Ask the ONE question that resolves it before processing. A wrong refund is harder to unwind than a one-message delay.',
    lives: 'Refunds (additional rules)',
    conflict: 'Sits directly against "Do NOT ask them to confirm which items if they already selected them" in the nudge section. Reconcilable — one is about contradiction, one about re-confirmation — but they are in different sections and a model reading either alone gets it wrong.',
  },
  {
    step: '7. Process it',
    kind: 'output',
    trigger: 'All gates passed',
    decision: 'Process immediately. Never contingent on the customer donating, shipping, or confirming anything first.',
    lives: 'Refunds (additional rules)',
    conflict: '',
  },
  {
    step: '8. Donation info in the same message',
    kind: 'output',
    trigger: 'Every processed refund',
    decision: 'Call get_donation_partner and paste its response_text verbatim. Never compose donation wording yourself.',
    lives: 'When to mention DONATION + ANTI-HALLUCINATION rule 1',
    conflict: '',
  },
  {
    step: '9. Never state a dollar amount',
    kind: 'output',
    trigger: 'Every refund and cancellation',
    decision: 'Write "I\'ve processed your refund to your original payment method. You\'ll get a confirmation email with the details." The tool computes the real figure.',
    lives: 'Refunds (additional rules)',
    conflict: 'You cut "confirmation email" mentions on tolerance items #15 and #17, and it appears in 0 of your 78 approved exemplars — but this rule mandates that exact sentence. Which wins on refunds?',
  },
  {
    step: '10. Set the refund-pattern flag',
    kind: 'gate',
    trigger: 'Precondition: EVERY item in the order is coming back. Any item kept means an ordinary partial return, flags: [] and stop.',
    decision: 'First-time buyer who declined or preempted sizing help, OR no reason given at all, gets a flag. Anyone else gets none. Operator-visible only, never changes the reply.',
    lives: 'Refund-pattern flag section',
    conflict: '',
  },
  {
    step: '11. Flagged refund gets the donation proof ask',
    kind: 'output',
    trigger: 'A Refund-pattern flag was raised in step 10',
    decision: 'Call get_donation_partner with include_proof_ask: true. Never write the ask yourself, never make the refund sound conditional on it.',
    lives: 'Refund-pattern flag section',
    conflict: '',
  },
  {
    step: '12. First-order full refund gets a retention line',
    kind: 'output',
    trigger: 'Refunding a customer\'s FIRST order IN FULL',
    decision: 'Close with "I hope you will give RUBIES a try again in the future." Nothing more.',
    lives: 'Refunds (additional rules)',
    conflict: 'This fires on the SAME customer as step 11 in the common case — first-time buyer, whole order back, no reason given. So one email asks them to photograph the donation as proof AND invites them to come back. Have you ever seen that combination go out, and does it read right?',
  },
  {
    step: '13. Ask what went wrong',
    kind: 'judgment',
    trigger: 'Customer has not said why',
    decision: 'CURRENTLY IN FLUX — see conflict.',
    lives: 'When to ask WHAT HAPPENED + Refunds (additional rules)',
    conflict: 'Three positions on one question. (a) "When to ask WHAT HAPPENED" says ask when they gave no explanation at all. (b) Your 08-04 ruling says ask before the refund, and if you have reached the refund without knowing, ask nothing. (c) Your actual sends: the advisor asked it on 36 refunds since May and you kept it 35 times. Proposed fix is the "first opportunity" wording.',
  },
];

module.exports = { PATHS };
