/**
 * Refund-pattern flag scenario (from the 2026-07-22 refund-abuse assessment).
 *
 * Arm (a) — WHOLE order back. A first-time buyer reports the shaping "didn't
 * work", preempts sizing help ("it's not a size thing"), and asks for a refund
 * after already receiving the SHAPING EXPECTATIONS response. Expected:
 *   - The refund IS processed (policy unchanged — flag is visibility only)
 *   - structured.prescription.flags contains a "Refund-pattern: ..." entry
 *   - The reply itself never mentions the flag or any suspicion
 *   - The reply still includes donation info (via get_donation_partner)
 *
 * Arm (b) — PARTIAL refund, same shape otherwise. Jamie's ruling 2026-07-30: a
 * customer keeping part of what they bought liked something enough to keep it,
 * which is the opposite of the behaviour these flags exist to surface. So the
 * flag (and with it the donation proof ask) requires the refund to cover every
 * item in the order. Repro: ticket 109937979 — first-time buyer refunded one of
 * two items, kept the other, and still drew the flag plus the proof ask.
 *
 * Customer fixtures: (a) lynartimez@gmail.com — real single-order customer from
 * the assessment (order #30880, refunded May 2026), so the context shows
 * "1 order(s) total — FIRST-TIME BUYER". (b) ellajinjuko03@gmail.com — order
 * #31505, a Cheeky bottom plus a Mia top, one order on the account. If either
 * fixture's order history changes (they order again), swap in another
 * single-order customer with a matching item count.
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
const DAYS_RE = /days after ordering/i;
const PROOF_RE = /send over a photo with the receipt so I can let the org know/i;
const SUSPICION_RE = /(flag|suspicious|pattern|abuse|policy team|fraud)/i;
const REFUND_RE = /refund/i;

function fail(msg) { console.error('  ✗ ' + msg); process.exitCode = 1; }
function pass(msg) { console.log('  ✓ ' + msg); }

// (b) Same pattern, but one of the two items stays with the customer.
const PARTIAL_CUSTOMER_EMAIL = 'ellajinjuko03@gmail.com';
const PARTIAL_ISSUE = `Help me with a return
-------------------------------
Order number: #31505

[Agent]: If you are feeling the fit is off I'd be happy to help you find the right size. Send me the measurement around the chest where a bikini band would sit and I can double check the top for you. I can also send out another size if you'd like to try one.

The top is too loose on me. It's not a size thing, I don't want to try another size. Please just refund the Mia top. I'm keeping the bottoms, those are fine.`;

(async () => {
  console.log('=== (a) whole order refunded → flag expected ===\n');
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

  if (flags.some(f => DAYS_RE.test(String(f)))) pass('flag includes days-after-ordering');
  else fail(`flag missing days-after-ordering marker: ${JSON.stringify(flags)}`);

  if (PROOF_RE.test(draft)) pass('donation proof ask included (flagged refund, partner routing)');
  else fail('donation proof ask missing from draft');

  const refundStaged = structured.action_type === 'refund'
    || (structured.prescription?.items || []).some(i => i.state === 'REFUND_CONFIRMED');
  if (refundStaged) pass('refund still processed (flag is visibility-only)');
  else fail(`refund not staged — status ${structured.status}, action_type ${structured.action_type} (flag must not change policy)`);

  if (REFUND_RE.test(draft)) pass('reply confirms the refund to the customer');
  else fail('reply does not mention the refund');

  const suspicionMatch = draft.match(SUSPICION_RE);
  if (!suspicionMatch) pass('reply contains no suspicion/flag language');
  else fail(`reply leaks flag language to the customer: ${JSON.stringify(suspicionMatch[0])}`);

  console.log('\n=== (b) partial refund (customer keeps an item) → NO flag ===\n');

  const partial = await aiAdvisor({
    customer_email: PARTIAL_CUSTOMER_EMAIL,
    issue_description: PARTIAL_ISSUE,
  });
  const ps = partial?._structured || {};
  const pDraft = (ps._composedResponse || '').trim();

  console.log('draft: ' + pDraft.replace(/\n+/g, ' ').slice(0, 400));
  console.log('flags:', JSON.stringify(ps.prescription?.flags));
  console.log('status:', ps.status, '| action_type:', ps.action_type, '\n');

  const pRefundStaged = ps.action_type === 'refund'
    || (ps.prescription?.items || []).some(i => i.state === 'REFUND_CONFIRMED');
  if (pRefundStaged) pass('(b) refund still processed');
  else fail(`(b) precondition not reproduced — refund not staged (status ${ps.status}, action_type ${ps.action_type})`);

  const pFlags = (ps.prescription?.flags || []).filter(f => FLAG_RE.test(String(f).trim()));
  if (pFlags.length === 0) pass('(b) no refund-pattern flag on a partial refund');
  else fail(`(b) partial refund flagged — the customer kept an item: ${JSON.stringify(pFlags)}`);

  // The proof ask rides on the flag, so it must not appear either.
  if (!PROOF_RE.test(pDraft)) pass('(b) no donation proof ask on a partial refund');
  else fail('(b) donation proof ask appeared on an unflagged partial refund');

  console.log('');
  console.log(process.exitCode === 1 ? 'FAILED — see assertions above.' : 'PASSED');
})().catch(e => { console.error(e); process.exit(1); });
