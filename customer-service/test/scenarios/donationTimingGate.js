/**
 * Donation-timing gate scenario (2026-07-30).
 *
 * The donation/return block belongs in the message that reports something
 * already done — a created exchange, a processed refund, or a direct answer to
 * "where do I send this back?". It does NOT belong in a message whose job is to
 * ask the customer for something. Observed 2026-07-30 (draft 2978, ticket
 * 110269653): the advisor sized three items, hit an out-of-stock colour on one,
 * asked "would Pink work for the top?" — and pasted the full partner address
 * block underneath, telling the customer to mail their things back before they
 * knew what they were getting in return. Rare in production (4 of ~1,800 drafts
 * since April) but the rule was negative-framed, so it drifts; this pins it.
 *
 * Two arms against the same FULFILLED 3-item order (dallen3214@gmail.com,
 * #32591 — Ruby M, Mia L, AJ M), both inventory-independent:
 *   (a) "all three are too tight", no target size → the advisor must ask
 *       (measurement or size options). NO donation routing, NO return address.
 *   (b) reason given + wants everything refunded → the refund trigger fires
 *       normally: donation routing runs and the partner address block appears.
 *
 * Arm (b) is the control — the gate must not over-suppress. (It deliberately
 * states a reason and declines a size swap: a bare "I'd like to return this,
 * where do I ship it?" hits the nudge-first rule and correctly gets a question
 * back with no address, so it can't tell over-suppression from correct
 * behaviour. Verified on the incumbent prompt 2026-07-30.) Side-effect-free:
 * the advisor's tools are all read-only, so nothing is executed either way.
 *
 * Run: node customer-service/test/scenarios/donationTimingGate.js
 */
require('dotenv').config();
const { aiAdvisor } = require('../../lib/aiAdvisor');

function pass(m) { console.log('  ✓ ' + m); }
function fail(m) { console.error('  ✗ ' + m); process.exitCode = 1; }

const CUSTOMER_EMAIL = 'dallen3214@gmail.com';

// (a) Fit complaint with no target size — the advisor has to ask before it can act.
const ASKING_MSG = `Hi,

I got my order last week and all three pieces are too tight on the bum. It's the leg and glute area, not the waist. What are my options?`;

// (b) Reason given, size help declined — the refund goes through and the
// donation section rides along with it.
const RETURN_QUESTION_MSG = `Hi,

I tried all three pieces and the fabric just isn't right for me. It's not a size thing, I don't want to try another size. Please refund the whole order. Where should I ship everything to?`;

// Anything that tells the customer to mail their things somewhere.
const RETURN_BLOCK_PATTERNS = [
  /RUBIES Returns/i,
  /items? you are returning/i,
  /send the items? (back )?to/i,
  /please wash (any items|the item)/i,
  /donate (it |them )?locally/i,
  /all RUBIES returns will be donated/i,
];

function returnHits(draft) {
  return RETURN_BLOCK_PATTERNS.filter(re => re.test(draft));
}

(async () => {
  console.log('=== (a) unresolved exchange (advisor must ask) → NO donation block ===\n');
  const ra = await aiAdvisor({ customer_email: CUSTOMER_EMAIL, issue_description: ASKING_MSG });
  const sa = ra?._structured || {};
  const da = (sa._composedResponse || '').trim();
  console.log('draft: ' + da.replace(/\n+/g, ' ').slice(0, 500));
  console.log('status: ' + sa.status + ' | action_type: ' + (sa.action_type || '(none)') + '\n');

  if (!da) { fail('(a) no draft produced'); return; }

  // Structural precondition, not a prose one: the reply sometimes proposes a
  // style swap as a statement rather than a question, and that is still the
  // unsettled state this arm is about.
  const unsettled = (sa.status === 'needs_info' || sa.status === 'gathering') && !sa.action_type;
  if (unsettled) pass(`(a) nothing staged yet (status ${sa.status}, no action_type)`);
  else fail(`(a) precondition not reproduced — advisor settled the exchange (status ${sa.status}, action_type ${sa.action_type || 'null'}); re-check the fixture`);

  const hitsA = returnHits(da);
  if (hitsA.length === 0) pass('(a) no return/donation block while still asking');
  else fail(`(a) return/donation block emitted before the exchange was settled (matched: ${hitsA.join(', ')})`);

  if (!sa.prescription?.donation) pass('(a) donation routing did not fire');
  else fail(`(a) donation routing fired on an unresolved exchange: ${JSON.stringify(sa.prescription.donation)}`);

  console.log('\n=== (b) control: refund with a reason → donation block expected ===\n');
  const rb = await aiAdvisor({ customer_email: CUSTOMER_EMAIL, issue_description: RETURN_QUESTION_MSG });
  const sb = rb?._structured || {};
  const db = (sb._composedResponse || '').trim();
  console.log('draft: ' + db.replace(/\n+/g, ' ').slice(0, 500));
  console.log('status: ' + sb.status + ' | action_type: ' + (sb.action_type || '(none)') + '\n');

  if (!db) { fail('(b) no draft produced'); return; }

  const hitsB = returnHits(db);
  if (hitsB.length >= 2) pass(`(b) donation/return info still given alongside the refund (matched: ${hitsB.join(', ')})`);
  else fail(`(b) gate over-suppressed — a settled refund got no donation info (matched: ${hitsB.join(', ') || 'none'})`);

  if (sb.prescription?.donation) pass('(b) donation routing fired');
  else fail('(b) donation routing did not fire on a settled refund');

  console.log('\n' + (process.exitCode === 1 ? 'FAILED — see above' : 'PASSED'));
})().catch(e => { console.error(e); process.exit(1); });
