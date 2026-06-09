/**
 * Pre-purchase chart concern scenario.
 *
 * Reproduces ticket #95615342: customer asked whether the chart was male or
 * female, then provided a 38" waist measurement, then said "I'm usually a
 * large and im worried about the recommended by the chart might be to loose."
 *
 * Before the prompt rule was added, the advisor produced a wishy-washy reply
 * ("the sizing chart works for most but there can be exceptions") with no
 * framing of what the chart actually compares to and no anchor on
 * "worn comfortably". It also risked claiming our sizing is "specially
 * calibrated to body measurements", which is wrong: RUBIES uses standard
 * US girls/womens sizing.
 *
 * The "Pre-purchase chart concern" scenario rule should produce a draft that:
 *   - Recommends going with the chart's size (2X for 38" waist)
 *   - Mentions the chart can have exceptions
 *   - Reassures free exchange
 *   - Avoids claiming RUBIES sizing is calibrated to body measurements
 *   - Avoids any mens/boys sizing reference
 *
 * NOTE: Originally pulled live from Gorgias ticket #95615342. That ticket
 * drifted — the customer replied "Awesome, thank you so much!" after Jamie
 * answered, so loading the live thread caused the advisor to see a resolved
 * conversation and output a one-line closing reply. The conversation is now
 * hardcoded at the point BEFORE Jamie's answer so the test never drifts.
 * The customer email is kept real so contextBuilder can look up her order.
 *
 * Usage: node customer-service/test/scenarios/chartBiggerThanExpected.js
 */
require('dotenv').config();
const { aiAdvisor } = require('../../lib/aiAdvisor');

// Hardcoded snapshot of ticket #95615342 up to (but not including) Jamie's
// first reply. Messages 0–4: customer opener, Jamie's measurement request,
// customer's measurement, customer's concern about chart size being too big.
const CUSTOMER_EMAIL = 'chloeannfairchild@gmail.com';
const ISSUE_DESCRIPTION = `Product Question
-------------------------------
Is the size cart male or female?

[Agent]: Hi,

Our size chart uses women's/girls' US sizing. If you can share your If you send me the waist measurement around the belly and just under the belly button I can help recommend a size for whichever product you're looking at.

38

Im usually a large and im worried about the recommended by the chart might be to loose.`;

const SIZE_RECOMMEND_RE = /\b2X(L|XL)?\b/i;
const EXCEPTION_RE = /(exception|works for most|most people|for most)/i;
const EXCHANGE_RE = /(exchange|swap|send (it )?back)/i;
const FREE_RE = /(free|no (cost|charge)|won't cost|on us)/i;
const FORBIDDEN_CALIBRATED_RE = /(calibrat|specially siz|engineered (for|to) (your |the )?(fit|body)|true (to )?body|sized to your body|tailored to your body)/i;
const FORBIDDEN_GENDERED_RE = /\b(men'?s|boys'?|male sizing|guys'? siz)/i;

function fail(msg) { console.error('  ✗ ' + msg); process.exitCode = 1; }
function pass(msg) { console.log('  ✓ ' + msg); }

(async () => {
  console.log('Running advisor on hardcoded pre-answer snapshot of ticket #95615342...\n');

  const result = await aiAdvisor({
    customer_email: CUSTOMER_EMAIL,
    issue_description: ISSUE_DESCRIPTION,
  });

  const draft = (result?._structured?._composedResponse || '').trim();

  console.log('Saved draft:');
  console.log('---');
  console.log(draft);
  console.log('---\n');

  if (SIZE_RECOMMEND_RE.test(draft)) pass('draft recommends 2X (chart\'s size for 38" waist)');
  else fail('draft does not mention 2X — should recommend the chart\'s size');

  if (EXCEPTION_RE.test(draft)) pass('draft acknowledges chart works for most / has exceptions');
  else fail('draft is missing "works for most" / "exceptions" framing');

  if (EXCHANGE_RE.test(draft) && FREE_RE.test(draft)) pass('draft reassures free exchange if it does not feel right');
  else fail('draft does not reassure free exchange');

  const calibratedMatch = draft.match(FORBIDDEN_CALIBRATED_RE);
  if (!calibratedMatch) pass('draft does not falsely claim RUBIES sizing is calibrated/specially sized');
  else fail(`draft contains forbidden calibration framing: ${JSON.stringify(calibratedMatch[0])}`);

  const genderedMatch = draft.match(FORBIDDEN_GENDERED_RE);
  if (!genderedMatch) pass('draft does not reference mens/boys sizing');
  else fail(`draft contains forbidden mens/boys reference: ${JSON.stringify(genderedMatch[0])}`);

  console.log('');
  console.log(process.exitCode === 1 ? 'FAILED — see assertions above.' : 'PASSED');
})().catch(e => { console.error(e); process.exit(1); });
