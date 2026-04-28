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
 * Usage: node customer-service/test/scenarios/chartBiggerThanExpected.js
 */
require('dotenv').config();
const gorgias = require('../../import/gorgiasClient');
const { aiAdvisor } = require('../../lib/aiAdvisor');

const TICKET_ID = '95615342';

const SIZE_RECOMMEND_RE = /\b2X(L|XL)?\b/i;
const EXCEPTION_RE = /(exception|works for most|most people|for most)/i;
const EXCHANGE_RE = /(exchange|swap|send (it )?back)/i;
const FREE_RE = /(free|no (cost|charge)|won't cost|on us)/i;
const FORBIDDEN_CALIBRATED_RE = /(calibrat|specially siz|engineered (for|to) (your |the )?(fit|body)|true (to )?body|sized to your body|tailored to your body)/i;
const FORBIDDEN_GENDERED_RE = /\b(men'?s|boys'?|male sizing|guys'? siz)/i;

function fail(msg) { console.error('  ✗ ' + msg); process.exitCode = 1; }
function pass(msg) { console.log('  ✓ ' + msg); }

(async () => {
  console.log(`Loading ticket ${TICKET_ID} from Gorgias...`);
  const msgs = await gorgias.getTicketMessages(TICKET_ID);

  // Build customer context: include all customer + bot messages, and any agent
  // messages that came before the latest customer message. The advisor needs
  // to see the full back-and-forth (including the prior agent reply that
  // explained women's/girls' sizing) so the test reflects production state.
  const lastCustomerIdx = (() => {
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (!msgs[i].from_agent) return i;
    }
    return -1;
  })();
  if (lastCustomerIdx < 0) { fail('could not find a customer message in ticket'); return; }

  const parts = [];
  let customerEmail = null;
  for (let i = 0; i <= lastCustomerIdx; i++) {
    const m = msgs[i];
    if (m.channel === 'internal-note') continue;
    const body = gorgias.stripHtml(m.stripped_text || m.body_text || '').trim();
    if (!body) continue;
    if (!m.from_agent) {
      parts.push(body);
      if (!customerEmail) customerEmail = m.sender?.email || null;
    } else if (m.sender?.email?.endsWith('@email.gorgias.com') || m.via === 'rule') {
      parts.push('[Bot]: ' + body);
    } else {
      parts.push('[Agent]: ' + body);
    }
  }
  const issueDescription = parts.join('\n\n');
  if (!customerEmail) { fail('could not extract customer email from ticket'); return; }

  console.log(`Customer: ${customerEmail}`);
  console.log(`Context length: ${issueDescription.length} chars`);
  console.log('');
  console.log('Running advisor...');

  const result = await aiAdvisor({
    customer_email: customerEmail,
    issue_description: issueDescription,
  });

  const draft = (result?._structured?._composedResponse || '').trim();

  console.log('');
  console.log('Saved draft:');
  console.log('---');
  console.log(draft);
  console.log('---');
  console.log('');

  // Assertion 1: recommends going with the chart's 2X for 38" waist
  if (SIZE_RECOMMEND_RE.test(draft)) pass('draft recommends 2X (chart\'s size for 38" waist)');
  else fail('draft does not mention 2X — should recommend the chart\'s size');

  // Assertion 2: acknowledges the chart works for most / has exceptions
  if (EXCEPTION_RE.test(draft)) pass('draft acknowledges chart works for most / has exceptions');
  else fail('draft is missing "works for most" / "exceptions" framing');

  // Assertion 3: reassures free exchange
  if (EXCHANGE_RE.test(draft) && FREE_RE.test(draft)) pass('draft reassures free exchange if it does not feel right');
  else fail('draft does not reassure free exchange');

  // Assertion 4: does NOT claim sizing is calibrated to body / specially sized
  const calibratedMatch = draft.match(FORBIDDEN_CALIBRATED_RE);
  if (!calibratedMatch) pass('draft does not falsely claim RUBIES sizing is calibrated/specially sized');
  else fail(`draft contains forbidden calibration framing: ${JSON.stringify(calibratedMatch[0])}`);

  // Assertion 5: does NOT mention men's / boys' sizing
  const genderedMatch = draft.match(FORBIDDEN_GENDERED_RE);
  if (!genderedMatch) pass('draft does not reference mens/boys sizing');
  else fail(`draft contains forbidden mens/boys reference: ${JSON.stringify(genderedMatch[0])}`);

  if (process.exitCode === 1) {
    console.log('');
    console.log('FAILED — see assertions above.');
  } else {
    console.log('');
    console.log('PASSED');
  }
})().catch(e => { console.error(e); process.exit(1); });
