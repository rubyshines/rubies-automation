/**
 * Waist-loose / legs-tight → high-leg-cut alternative scenario.
 *
 * Rule (advisor prompt, "### Product Knowledge", "Waist and legs need different
 * sizes — switch leg cut, DON'T refund"): when the waist is too loose while the
 * legs do NOT have room to spare (legs fit fine OR are already too tight), no
 * single size in the same product works. The advisor must offer a higher-leg-cut
 * alternative (Cheeky/Sassy/Flo) and set needs_info / AWAITING_DECISION — NOT
 * size down and NOT jump to a refund. If the customer leans toward a refund but
 * hasn't been offered the leg-cut alternative yet, offer it once first.
 *
 * Anchored on the real failure (Gorgias 103799699, CS ticket 1910, order
 * #31447): customer reported Serena shorty shorts "too big in the waist but the
 * thighs and glute area was way too tight ... this fit just doesn't work for her
 * body type" and pre-thanked us "for processing our return". Pre-fix the advisor
 * skipped the high-leg alternative (Cheeky) entirely and went straight to a
 * refund confirmation. The strong directive only fired on "waist loose BUT legs
 * FIT" — this two-axis "waist loose AND legs tight" case fell between rules.
 *
 * Synthetic + order-independent (per domain_cs.md: validate prompt changes with
 * scenarios, not live regen). Two turns:
 *   Turn 1 — generic return request, no specifics.
 *   Turn 2 — the two-axis fit report + tentative refund acceptance.
 *
 * Asserts on turn 2:
 *   1. the draft offers a higher-leg-cut alternative (Cheeky/Sassy/Flo, or
 *      explicit "leg cut" / "leg opening" language)
 *   2. the advisor does NOT silently refund — action_type !== 'refund'
 *      (status needs_info or item AWAITING_DECISION is the expected shape)
 *
 * Run: node customer-service/test/scenarios/waistLooseLegsTight.js
 */
require('dotenv').config();
const { aiAdvisor } = require('../../lib/aiAdvisor');

function pass(m) { console.log('  ✓ ' + m); }
function fail(m) { console.error('  ✗ ' + m); process.exitCode = 1; }

// Terminal-state order containing the Serena swim shorts (the real anchor order).
const CUSTOMER_EMAIL = 'nutanmathew@gmail.com';

const TURN1_MSG = `Hello!

I'm sad to say that the two swim shorts I ordered for my daughter (order #31447) did not work out. I would like to return them, please.

With gratitude,
Nutan`;

// The two-axis fit report + tentative refund acceptance — the exact failure shape.
const TURN2_MSG = `Hi Jamie!

Unfortunately, they were too big in the waist (I did measure) but the thighs and glute area was way too tight. It was consistent on both, so I think this fit just doesn't work for her body type. She did like the swim top, so thank you for that!

Thank you for processing our return.

Nutan`;

// A higher-leg-cut alternative being named, or explicit leg-cut reasoning.
const LEGCUT_ALT = /cheeky|sassy|flo|leg cut|leg opening|higher.?leg|larger leg|different (leg )?cut|more room (in|for) the (leg|thigh)/i;

(async () => {
  console.log('=== Turn 1: generic return request ===\n');
  const r1 = await aiAdvisor({ customer_email: CUSTOMER_EMAIL, issue_description: TURN1_MSG });
  const intake1 = r1?._structured;
  const d1 = (intake1?._composedResponse || '').trim();
  console.log('turn 1 draft: ' + d1.replace(/\n+/g, ' ').slice(0, 300) + '\n');

  console.log('=== Turn 2: waist loose + legs/thighs tight, tentative refund accept ===\n');
  const r2 = await aiAdvisor({
    customer_email: CUSTOMER_EMAIL,
    issue_description: TURN2_MSG,
    intake: intake1,
  });
  const s2 = r2?._structured || {};
  const d2 = (s2._composedResponse || '').trim();

  console.log('turn 2 draft: ' + d2.replace(/\n+/g, ' ').slice(0, 600));
  console.log('status: ' + s2.status + ' | action_type: ' + (s2.action_type || '(none)') + '\n');

  if (LEGCUT_ALT.test(d2))
    pass('draft offers a higher-leg-cut alternative for the loose-waist/tight-leg fit');
  else
    fail('draft does not offer a higher-leg-cut alternative (expected Cheeky/Sassy/Flo or leg-cut language)');

  if (s2.action_type !== 'refund')
    pass(`advisor did not silently refund (action_type=${s2.action_type || 'none'}, status=${s2.status})`);
  else
    fail('advisor jumped to a refund instead of offering the leg-cut alternative first');

  console.log('\n' + (process.exitCode === 1 ? 'FAILED — see above' : 'PASSED'));
})().catch(e => { console.error(e); process.exit(1); });
