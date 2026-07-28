/**
 * No-apology-for-third-party scenario (voice rule 2, adopted 2026-07-17).
 *
 * Jamie's rule: customs/duties, carriers, payment processors, and policy
 * limits are outside RUBIES' control — explain the boundary politely
 * ("unfortunately it's out of our control"), then still offer the remedy or
 * workaround. Polite softeners fine; apology words are not.
 *
 * First cut of this scenario used a domestic "carrier handling fee", which the
 * advisor correctly treated as an anomaly to investigate (no boundary exists
 * for a fee we never authorize) — scenario premise was wrong, not the prompt.
 * This version uses the clean rule-2 case: payment-processor declines, which
 * RUBIES genuinely cannot control and which have a standard workaround.
 *
 * Test: customer's card keeps declining. Assert no apology words, the
 * boundary is named, and a workaround/next step is offered.
 *
 * Uses skarlovnika@gmail.com (order #30757 — delivered, terminal state).
 *
 * Run: node customer-service/test/scenarios/noApologyForThirdParty.js
 */
require('dotenv').config();
const { aiAdvisor } = require('../../lib/aiAdvisor');

function pass(m) { console.log('  ✓ ' + m); }
function fail(m) { console.error('  ✗ ' + m); process.exitCode = 1; }

const CUSTOMER_EMAIL = 'skarlovnika@gmail.com';

const MSG = `Hi,

I'm trying to place a new order and my card keeps getting declined at checkout, three times now. Nothing is wrong with my card, I used it this morning. This is really frustrating. Can you fix whatever is wrong with your checkout?`;

const APOLOGY_PATTERNS = [/\bsorry\b/i, /\bapolog/i, /\bmy bad\b/i];
// The draft must attribute the decline to an external party rather than owning
// it. Match on WHO is named, not on one exact phrasing — these patterns were
// previously too narrow and rejected valid drafts: "Card approvals are handled
// by the payment network and your issuing bank rather than our checkout" states
// the boundary perfectly but matched nothing, because the list only accepted
// "payment processor/provider/gateway" (2026-07-28, project_opus5_migration).
const BOUNDARY_PATTERNS = [
  /out of (our|rubies'?s?) control/i,
  /(don'?t|do not|no) control over (whether )?(the )?payment/i,
  // The external party, however it is named.
  /payment (processor|provider|gateway|network|system)/i,
  /(issuing|your|the) bank/i,
  /card (issuer|network|company)/i,
  /(declined?|decision|approvals?) (comes? from|is made by|are (made|handled) by|by|handled by) /i,
];
const WORKAROUND_PATTERNS = [
  /paypal/i,
  /different (card|browser|payment)/i,
  /invoice/i,
  /(another|other) (way|method) to pay/i,
  /try (again|checkout)/i,
];

(async () => {
  console.log('=== No apology for third-party (payment declines): boundary + workaround, no sorry ===\n');
  const r = await aiAdvisor({ customer_email: CUSTOMER_EMAIL, issue_description: MSG });
  const draft = (r?._structured?._composedResponse || '').trim();
  console.log('draft: ' + draft.replace(/\n+/g, ' ').slice(0, 400) + '\n');

  if (!draft) { fail('no draft produced'); return; }

  const apologyHit = APOLOGY_PATTERNS.find(re => re.test(draft));
  if (apologyHit)
    fail(`draft apologizes for a payment-processor issue (matched: ${apologyHit})`);
  else
    pass('draft contains no apology');

  const boundaryHit = BOUNDARY_PATTERNS.find(re => re.test(draft));
  if (boundaryHit) pass(`draft names the boundary (matched: ${boundaryHit})`);
  else fail('draft should state plainly that payment acceptance is outside our control');

  const workHit = WORKAROUND_PATTERNS.find(re => re.test(draft));
  if (workHit) pass(`draft offers a workaround (matched: ${workHit})`);
  else fail('a refusal/boundary must carry an alternative — no workaround offered');

  console.log('\n' + (process.exitCode === 1 ? 'FAILED — see above' : 'PASSED'));
})().catch(e => { console.error(e); process.exit(1); });
