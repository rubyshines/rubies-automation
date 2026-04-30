/**
 * Pre-order future-target shipping inquiry scenario.
 *
 * Reproduces ticket #96041425 (Wrenn / order #29702): customer asks why
 * their month-old order hasn't shipped. The order has:
 *   - Magical Chest Pads M (in stock)
 *   - 2x Sassy Black/M with line item attribute
 *     `Pre-order: Target availability end of June, 2026.` and 0 inventory
 *     → FUTURE TARGET branch
 *   - Naomi M Black with line item attribute
 *     `Pre-order: Target availability beginning of April, 2026.` but now
 *     41 in stock → PAST-TARGET-RESOLVED branch
 *
 * Before the prompt rule was extended, the advisor produced an OOS reply
 * ("currently out of stock... website was out of sync with our warehouse
 * inventory") because the system only detected pre-orders via product
 * tags, not line item customAttributes.
 *
 * The extended pre-order rule should produce a draft that:
 *   - Recognizes Sassy as a pre-order (not OOS)
 *   - Mentions the Sassy target date (June or "end of June")
 *   - Uses the "you would have seen at checkout" framing (future-target only)
 *   - Offers a split shipment OR a refund of the Sassy
 *   - Does NOT use the "out of sync with inventory" OOS apology for Sassy
 *   - Does NOT reference Naomi as a delay reason (its pre-order resolved)
 *
 * Usage: node customer-service/test/scenarios/preorderFutureTarget.js
 */
require('dotenv').config();
const gorgias = require('../../import/gorgiasClient');
const { aiAdvisor } = require('../../lib/aiAdvisor');

const TICKET_ID = '96041425';

const PREORDER_RE = /(pre[\s-]?order)/i;
const TARGET_DATE_RE = /(end of June|June[ ,]+2026|June 2026|target availability)/i;
const CHECKOUT_FRAMING_RE = /(you (would|might) have seen|when you placed|at checkout|on the (product|item) page)/i;
const SPLIT_OR_REFUND_RE = /(ship.{0,40}(separate|now|in the meantime)|send.{0,40}(separate|right away|now)|refund.{0,40}(sassy|pre.?order|item)|partial refund)/i;

const FORBIDDEN_OOS_FRAMING_RE = /(out of sync|website (was )?out of sync|out of stock.{0,40}(sassy|sass)|sassy.{0,40}out of stock)/i;
const FORBIDDEN_NAOMI_BLAME_RE = /(naomi.{0,40}(out of stock|pre.?order|delay|holding|blocking|wait))/i;

function fail(msg) { console.error('  ✗ ' + msg); process.exitCode = 1; }
function pass(msg) { console.log('  ✓ ' + msg); }

(async () => {
  console.log(`Loading ticket ${TICKET_ID} from Gorgias...`);
  const msgs = await gorgias.getTicketMessages(TICKET_ID);

  // Build customer context up to the latest customer message (no agent reply
  // exists yet on this ticket — it's a fresh inbound).
  const customerMsgs = msgs.filter(m => !m.from_agent && m.channel !== 'internal-note');
  if (!customerMsgs.length) { fail('no customer messages on ticket'); return; }
  const customerEmail = customerMsgs[0].sender?.email;
  if (!customerEmail) { fail('could not extract customer email'); return; }

  const issueDescription = customerMsgs
    .map(m => gorgias.stripHtml(m.stripped_text || m.body_text || '').trim())
    .filter(Boolean)
    .join('\n\n');

  console.log(`Customer: ${customerEmail}`);
  console.log('');
  console.log('Running advisor...');

  const result = await aiAdvisor({
    customer_email: customerEmail,
    issue_description: issueDescription,
  });

  const draft = (result?._structured?._composedResponse || '').trim();

  console.log('');
  console.log('Draft:');
  console.log('---');
  console.log(draft);
  console.log('---');
  console.log('');

  // Assertion 1: pre-order mentioned
  if (PREORDER_RE.test(draft)) pass('draft mentions pre-order');
  else fail('draft does not mention pre-order — Sassy should be framed as pre-order, not OOS');

  // Assertion 2: target date surfaced
  if (TARGET_DATE_RE.test(draft)) pass('draft mentions Sassy target date (June)');
  else fail('draft does not surface the Sassy target date — customer needs the timeline');

  // Assertion 3: future-target checkout framing
  if (CHECKOUT_FRAMING_RE.test(draft)) pass('draft uses checkout-disclosure framing');
  else fail('draft missing "you would have seen at checkout" framing for the future-target pre-order');

  // Assertion 4: offers split shipment or refund
  if (SPLIT_OR_REFUND_RE.test(draft)) pass('draft offers a split shipment or refund of the pre-order item');
  else fail('draft does not offer to split the shipment or refund the pre-order — both options should be on the table');

  // Assertion 5: no OOS apology for Sassy
  if (!FORBIDDEN_OOS_FRAMING_RE.test(draft)) pass('draft avoids OOS / "out of sync" framing for Sassy');
  else fail('draft uses the OOS apology for Sassy — should be pre-order language, not "out of sync with inventory"');

  // Assertion 6: Naomi not blamed
  if (!FORBIDDEN_NAOMI_BLAME_RE.test(draft)) pass('draft does not blame Naomi for the delay');
  else fail('draft references Naomi as a delay reason — its pre-order resolved (41 units in stock)');

  if (process.exitCode === 1) {
    console.log('');
    console.log('FAILED — see assertions above.');
  } else {
    console.log('');
    console.log('PASSED');
  }
})().catch(e => { console.error(e); process.exit(1); });
