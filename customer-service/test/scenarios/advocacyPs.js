/**
 * Advocacy P.S. scenario.
 *
 * Validates the one-time "spread the word" P.S. What the customer actually
 * receives is the source of truth (the send hook records the ask by matching the
 * P.S. text in the sent body), so we assert on the P.S. prose:
 *  - Genuine enthusiasm / delight when buying for a child → the verbatim parent
 *    P.S. appears after the signature.
 *  - A defect / negative message → NO P.S.
 *  - A mild, transactional thank-you closing a logistics request → NO P.S.
 *    (2026-07-15 calibration: the bar is genuine warmth, not routine politeness.
 *    A real "Thank you so much!" closing an address fix had wrongly fired.)
 *
 * The signature standardization is asserted on the positive draft too.
 *
 * Sentiment and buying_for are inferred from the message text, so this does not
 * depend on the order state of the resolving email. Uses a real customer email
 * so context resolves; #30757 (skarlovnika@gmail.com) is delivered/terminal.
 *
 * Note: the once-ever guard (already-asked → no P.S.) is enforced by a DB lookup
 * (advocacy_asks_sent) and is not exercised here — it fail-softs to not-asked.
 *
 * Run: node customer-service/test/scenarios/advocacyPs.js
 */
require('dotenv').config();
const { aiAdvisor } = require('../../lib/aiAdvisor');
const { ADVOCACY_PS } = require('../../lib/signatures');

function pass(m) { console.log('  ✓ ' + m); }
function fail(m) { console.error('  ✗ ' + m); process.exitCode = 1; }

const CUSTOMER_EMAIL = 'skarlovnika@gmail.com';

// Pure gratitude, buying for a child, nothing left to do → positive resolution.
const PARENT_HAPPY = `Hi,

I just wanted to say thank you so much. My daughter absolutely loves her new swimsuit and it fits her perfectly. You have all been wonderful!`;

// A defect report → negative, never the moment for an advocacy ask.
const DEFECT = `Hi,

The swimsuit arrived with a hole in the seam near the leg. I'm pretty disappointed, this is the first time wearing it.`;

// A mild, transactional thank-you closing a logistics request (address confirm).
// Polite but not enthusiasm about the product → NO P.S. under the tightened bar.
// Mirrors the 2026-07-15 ticket that wrongly fired.
const MILD_THANKS = `Hi,

Yes, please ship to Care of Teresa Soldner, 809 Central Ave, St. Paul, MN 55104. Thank you so much!`;

(async () => {
  console.log('=== closing_ask: advocacy P.S. gating ===\n');

  // --- Case 1: happy parent → parent P.S. + standardized signature ---
  const r1 = await aiAdvisor({ customer_email: CUSTOMER_EMAIL, issue_description: PARENT_HAPPY });
  const d1 = (r1?._structured?._composedResponse || '').trim();
  const s1 = r1?._structured || {};
  console.log('[parent-happy] sentiment=' + s1.customer_sentiment + ' buying_for=' + (s1.customer?.buying_for));

  if (d1.includes(ADVOCACY_PS.peer_parent)) pass('draft contains the verbatim parent P.S.');
  else fail('draft is missing the parent advocacy P.S.');

  if (!d1.includes(ADVOCACY_PS.peer_self)) pass('draft did not use the self framing for a parent');
  else fail('draft used the self P.S. for a parent (wrong framing)');

  if (/Jamie Alexander, RUBIES Founder/.test(d1) && /rubyshines\.com/.test(d1)) pass('draft carries the standardized signature (name/title line + site)');
  else fail('draft is missing the standardized signature');

  if (!/rubyshines\.com\/help|https?:\/\//.test(ADVOCACY_PS.peer_parent)) pass('Phase A P.S. has no link');

  // --- Case 2: defect → no P.S. ---
  const r2 = await aiAdvisor({ customer_email: CUSTOMER_EMAIL, issue_description: DEFECT });
  const d2 = (r2?._structured?._composedResponse || '').trim();
  const s2 = r2?._structured || {};
  console.log('\n[defect] sentiment=' + s2.customer_sentiment);

  if (!/P\.S\./.test(d2)) pass('defect draft has no P.S.');
  else fail('defect draft wrongly included a P.S.');

  // --- Case 3: mild transactional thanks → no P.S. ---
  const r3 = await aiAdvisor({ customer_email: CUSTOMER_EMAIL, issue_description: MILD_THANKS });
  const d3 = (r3?._structured?._composedResponse || '').trim();
  const s3 = r3?._structured || {};
  console.log('\n[mild-thanks] sentiment=' + s3.customer_sentiment);

  if (!/P\.S\./.test(d3)) pass('mild transactional thanks → no P.S.');
  else fail('mild transactional thanks wrongly included a P.S. (bar too low)');

  console.log('\n' + (process.exitCode === 1 ? 'FAILED — see above' : 'PASSED'));
})().catch(e => { console.error(e); process.exit(1); });
