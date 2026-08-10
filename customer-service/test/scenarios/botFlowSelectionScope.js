/**
 * Bot-flow selection scope scenario.
 *
 * Repro: ticket 3100 / draft 3180 (2026-08-10). The Gorgias return flow handed
 * the advisor an explicit five-line "Selected items:" list — two AJ bottoms,
 * two Ruby bottoms and a Sky one-piece. The advisor relabelled the list as
 * "the AJ and Ruby bottoms" and acted on the label: intake.items got four
 * entries, operator_action_summary named four, get_donation_partner was called
 * with item_count 4, and the operator's refund panel came up one item short of
 * what the customer asked to send back. The one dropped line was the only one
 * that wasn't a bottom.
 *
 * Measured over every advisor draft carrying a bot-flow selection list (90
 * action drafts): 3 genuine drops, all of them where the selection spanned more
 * than one product family. The failure is silent and, on a refund, expensive to
 * unwind.
 *
 * The rule (advisor prompt, "### The structured items array must cover every
 * item the action touches"): when the customer picked items in a bot flow, that
 * selection list IS the scope — every line gets its own entry in items and its
 * own mention in operator_action_summary, including lines outside the group the
 * prose names.
 *
 * Fixture: pennyheatley@gmail.com, order #32586 — a single-order customer whose
 * fulfilled, unrefunded order is a structural replica of the failing one (a Sky
 * one-piece plus two Ruby bottoms and two Mia tops, so the one-piece is again
 * the line that doesn't fit the group). If that order is ever refunded or the
 * customer orders again, swap in another single-order customer whose order
 * mixes a one-piece with bottoms and tops.
 *
 * Asserts (only when the refund path is actually reproduced this run):
 *   1. the refund path was exercised
 *   2. every selected line is represented in the structured items array
 *   3. operator_action_summary names all three product families, Sky included
 *   4. the reply does not narrow the scope in prose ("the bottoms" alone)
 *
 * Usage: node customer-service/test/scenarios/botFlowSelectionScope.js
 */
require('dotenv').config();
const { aiAdvisor } = require('../../lib/aiAdvisor');

const CUSTOMER_EMAIL = 'pennyheatley@gmail.com';

// The bot-flow transcript shape the Gorgias return flow actually produces.
const ISSUE_DESCRIPTION = `Help me with a return or exchange

[Bot]: What would you like to do?

Start a return or exchange

[Bot]: Select an order

#32586 - July 23, 2026

Order number: #32586

Selected items:
1x RUBY NO-TUCK SHAPING BIKINI BOTTOM - Pink / L
1x RUBY NO-TUCK SHAPING BIKINI BOTTOM - Pink / 16
1x MIA HALTER BIKINI TOP - Pink / L
1x MIA HALTER BIKINI TOP - Pink / M
1x SKY NO-TUCK SHAPING ONE-PIECE - Pink / L Tall

Order Created: 7/23/2026, 2:14:02 PM

Shipping address: Boulder

[Bot]: What are you looking to do?

Return

[Bot]: What didn't work out with the item(s) you are looking to return?

The shaping showed more of a bump than she was hoping for and it really upset her. She refuses to wear any of them now.

[Bot]: We're here to help!  In many cases, we can recommend a size that works better or suggest another product you might love.

If you are open to an excahnge share any details that might help us:

 For example:
Shaping not working
If too tight: Where is it tight?
If too loose: Where is it loose? ,
Other fit issues: Doesn't stay in place, comes up too high or too low
If you need assistance choosing the right size:
For bottoms, send us the waist measurement around the belly and just under the belly button.
For tops, send the measurement around the chest where a bikini band would sit.

Let us know how you'd like to proceed—whether it's a return, an exchange, or trying a different size or style.

I'd like to return them please. Can you please let me know how to do this?`;

// One entry per line the customer selected: the product family and the size
// that must both be traceable in the staged action.
const SELECTED = [
  { family: 'RUBY', size: 'L', label: 'Ruby bottom / L' },
  { family: 'RUBY', size: '16', label: 'Ruby bottom / 16' },
  { family: 'MIA', size: 'L', label: 'Mia top / L' },
  { family: 'MIA', size: 'M', label: 'Mia top / M' },
  { family: 'SKY', size: 'L', label: 'Sky one-piece / L Tall' },
];

function fail(msg) { console.error('  ✗ ' + msg); process.exitCode = 1; }
function pass(msg) { console.log('  ✓ ' + msg); }

// An items entry covers a selected line when its product names the family and
// its size matches. Sizes are compared loosely ("L Tall" covers "L") because
// the advisor may carry the tall suffix or not.
function covers(entry, sel) {
  const product = String(entry.product || '').toUpperCase();
  const size = String(entry.current_size ?? entry.size ?? '').toUpperCase().trim();
  if (!product.includes(sel.family)) return false;
  return size === sel.size || size.startsWith(sel.size + ' ');
}

(async () => {
  console.log('Running advisor on a 5-line bot-flow return selection (3 product families)...\n');

  const result = await aiAdvisor({
    customer_email: CUSTOMER_EMAIL,
    issue_description: ISSUE_DESCRIPTION,
  });

  const s = result?._structured || {};
  const draft = (s._composedResponse || '').trim();
  const items = (s.intake && s.intake.items) || s.items || [];
  const summary = s.operator_action_summary || '';

  console.log('Saved draft:\n---\n' + draft + '\n---');
  console.log('action_type: ' + s.action_type);
  console.log('items: ' + JSON.stringify(items));
  console.log('operator_action_summary: ' + summary);
  console.log('');

  // Assertion 1: refund path reproduced
  const refundStaged = s.action_type === 'refund'
    || (s.prescription?.items || []).some(i => i.state === 'REFUND_CONFIRMED');
  if (refundStaged) {
    pass('refund path exercised');
  } else {
    fail(`refund path not reproduced this run (status ${s.status}, action_type ${s.action_type}) — cannot test selection scope. Re-run; if this persists the fixture order's state may have drifted.`);
    return;
  }

  // Assertion 2: every selected line has an entry in the structured items array
  const uncovered = SELECTED.filter(sel => !items.some(e => covers(e, sel)));
  if (uncovered.length === 0) {
    pass(`all ${SELECTED.length} selected lines present in the items array`);
  } else {
    fail(`items array drops ${uncovered.length} selected line(s): ${uncovered.map(u => u.label).join(', ')} — the bot-flow selection is the scope of the action`);
  }

  // Assertion 3: operator_action_summary names every family, Sky included.
  // This is what the operator's refund panel is built from.
  if (!summary) {
    fail('operator_action_summary is empty on a ready refund');
  } else {
    const up = summary.toUpperCase();
    const missing = [...new Set(SELECTED.map(sel => sel.family))].filter(f => !up.includes(f));
    if (missing.length === 0) pass('operator_action_summary names every selected product family');
    else fail(`operator_action_summary omits ${missing.join(', ')} — the operator's refund panel is built from this string`);
  }

  // Assertion 4: the prose must not narrow the scope to one group. It is allowed
  // to stay generic ("the items"); it is not allowed to name only the bottoms
  // when a one-piece and two tops are coming back too.
  const narrowed = /\b(the|your)\s+(bottoms|two bottoms|ruby bottoms)\b/i.test(draft)
    && !/one-?piece|\bsky\b/i.test(draft);
  if (!narrowed) pass('reply does not narrow the refund to a subset of the selection');
  else fail('reply describes the refund as covering only the bottoms while a one-piece and tops are also being returned');

  console.log('');
  console.log(process.exitCode === 1 ? 'FAILED — see assertions above.' : 'PASSED');
})().catch(e => { console.error(e); process.exit(1); });
