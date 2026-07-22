/**
 * Refund-pattern flag scenario (from the 2026-07-22 refund-abuse assessment).
 *
 * A first-time buyer reports the shaping "didn't work", preempts sizing help
 * ("it's not a size thing"), and asks for a refund after already receiving the
 * SHAPING EXPECTATIONS response. Expected behavior:
 *   - The refund IS processed (policy unchanged — flag is visibility only)
 *   - structured.prescription.flags contains a "Refund-pattern: ..." entry
 *   - The reply itself never mentions the flag or any suspicion
 *   - The reply still includes donation info (via get_donation_partner)
 *
 * Customer fixture: lynartimez@gmail.com — real single-order customer from the
 * assessment (order #30880, refunded May 2026), so the context shows
 * "1 order(s) total — FIRST-TIME BUYER". If this fixture's order history
 * changes (they order again), swap in another single-order customer.
 *
 * Usage: node customer-service/test/scenarios/refundPatternFlag.js
 */
require('dotenv').config();
const { aiAdvisor } = require('../../lib/aiAdvisor');

const CUSTOMER_EMAIL = 'lynartimez@gmail.com';
const ISSUE_DESCRIPTION = `Help me with a return
-------------------------------
Order number: #30880

[Agent]: In situations like this we can usually find something that works. If you are feeling the shaping is not working it's often due to two reasons: either the fit is off or there is a mismatch of expectations.

In terms of the fit, unlike 'tucking' bottoms they are intended to be worn comfortably. Not too tight or too loose. If you send me the waist measurement around the belly and just under the belly button and height I can double check the sizing.

In terms of expectations our shaping bottoms are meant to reshape the front area to create a feminine mound. This is in contrast to 'tucking' or 'gaffing' underwear which completely flattens the area. This is why our shaping bottoms are very comfortable and can be worn for all activities.

Ultimately your comfort is most important so let me know what you would like to do next. I'd be happy to send out another order if you would like to try another size.

It's not a size thing, the material just doesn't do what I need it to. I don't want to try another size. Please just refund the order.`;

const FLAG_RE = /^refund-pattern/i;
const SUSPICION_RE = /(flag|suspicious|pattern|abuse|policy team|fraud|proof)/i;
const REFUND_RE = /refund/i;

function fail(msg) { console.error('  ✗ ' + msg); process.exitCode = 1; }
function pass(msg) { console.log('  ✓ ' + msg); }

(async () => {
  console.log('Running advisor on refund-pattern scenario (first-time buyer declines size help)...\n');

  const result = await aiAdvisor({
    customer_email: CUSTOMER_EMAIL,
    issue_description: ISSUE_DESCRIPTION,
  });

  const structured = result?._structured || {};
  const draft = (structured._composedResponse || '').trim();

  console.log('Saved draft:');
  console.log('---');
  console.log(draft);
  console.log('---');
  console.log('flags:', JSON.stringify(structured.prescription?.flags));
  console.log('status:', structured.status, '| action_type:', structured.action_type);
  console.log('');

  const flags = structured.prescription?.flags || [];
  if (flags.some(f => FLAG_RE.test(String(f).trim()))) pass('Refund-pattern flag raised');
  else fail(`no Refund-pattern flag in flags: ${JSON.stringify(flags)}`);

  const refundStaged = structured.action_type === 'refund'
    || (structured.prescription?.items || []).some(i => i.state === 'REFUND_CONFIRMED');
  if (refundStaged) pass('refund still processed (flag is visibility-only)');
  else fail(`refund not staged — status ${structured.status}, action_type ${structured.action_type} (flag must not change policy)`);

  if (REFUND_RE.test(draft)) pass('reply confirms the refund to the customer');
  else fail('reply does not mention the refund');

  const suspicionMatch = draft.match(SUSPICION_RE);
  if (!suspicionMatch) pass('reply contains no suspicion/flag language');
  else fail(`reply leaks flag language to the customer: ${JSON.stringify(suspicionMatch[0])}`);

  console.log('');
  console.log(process.exitCode === 1 ? 'FAILED — see assertions above.' : 'PASSED');
})().catch(e => { console.error(e); process.exit(1); });
