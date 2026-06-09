/**
 * Anti-mirroring scenario.
 *
 * Two patterns seen after the Opus 4.8 upgrade (2026-05-29):
 *
 *   1. The advisor opens by paraphrasing the customer's situation back at them
 *      ("You paid for expedited shipping expecting delivery by Thursday...").
 *      The customer already knows what they wrote.
 *
 *   2. On multi-turn exchanges, the advisor repeats sizing information that was
 *      already given in turn 1 (e.g. "the next size up adds about 2 inches of
 *      fabric") when confirming the action in turn 2.
 *
 * Test 1 — single-turn complaint: customer describes their delayed expedited
 * order in explicit detail. Assert the draft does NOT open with a restatement
 * of those details (no "you paid for expedited", "you mentioned", etc.).
 *
 * Test 2 — two-stage exchange: turn 1 produces a sizing recommendation with
 * a fabric delta. Turn 2 is the customer confirming ("yes please"). Assert
 * the turn-2 draft does NOT repeat the 2-inch delta from turn 1.
 *
 * Uses order #30757 (skarlovnika@gmail.com) — delivered, terminal state.
 *
 * Run: node customer-service/test/scenarios/noMirroring.js
 */
require('dotenv').config();
const { aiAdvisor } = require('../../lib/aiAdvisor');

function pass(m) { console.log('  ✓ ' + m); }
function fail(m) { console.error('  ✗ ' + m); process.exitCode = 1; }

const CUSTOMER_EMAIL = 'skarlovnika@gmail.com';

// -----------------------------------------------------------------------
// Test 1: single-turn complaint with rich customer-provided details
// The advisor must NOT open by restating what the customer wrote.
// -----------------------------------------------------------------------
const COMPLAINT_MSG = `Hi,

I ordered the Brooke bra and Charlie underwear (order #30757) and I paid the extra money for expedited shipping because I specifically needed it before my trip that starts Thursday morning. It was supposed to arrive in 2-3 business days but it is still showing in transit and now I am leaving in less than 48 hours. I am very disappointed that I paid extra for nothing.

Thank you`;

// Phrases that constitute "mirroring" — restating the CONTENT of what the customer wrote.
// "you wrote in" / "when you wrote" (time reference) is fine; restating their complaint is not.
const MIRRORING_PATTERNS = [
  /you paid (the extra|extra|for expedited)/i,
  /you (specifically )?needed it (before|by|for)/i,
  /you mentioned/i,
  /i understand (that )?you (paid|needed|wanted|ordered|expected|said)/i,
  /you said (you|that)/i,
  /i see (that )?you (paid|needed|wanted|ordered|expected)/i,
  /you wrote (that|about)/i,
  /you're (very )?disappointed/i,
];

// -----------------------------------------------------------------------
// Test 2: two-stage exchange — check that turn 2 doesn't repeat turn 1 info
// -----------------------------------------------------------------------
// Turn 1: customer says "too small, can I exchange?"
const TURN1_MSG = 'Hi, my Brooke bra from order #30757 is too small. Can I exchange for the next size up?';
// Turn 2: customer confirms
const TURN2_MSG = 'Great, yes please go ahead with that!';

(async () => {
  // -----------------------------------------------------------------------
  // Test 1
  // -----------------------------------------------------------------------
  console.log('=== Test 1: No mirroring of customer complaint details ===\n');
  const r1 = await aiAdvisor({ customer_email: CUSTOMER_EMAIL, issue_description: COMPLAINT_MSG });
  const d1 = (r1?._structured?._composedResponse || '').trim();
  const s1 = r1?._structured || {};

  // Strip the greeting line(s) to get the body
  const body1Lines = d1.split('\n').filter(l => l.trim() && !/^Hi[,!]?\s*$/i.test(l.trim()) && !/^Jamie Alexander/i.test(l.trim()));
  const firstBodyLine1 = body1Lines[0] || '';

  console.log('draft: ' + d1.replace(/\n+/g, ' ').slice(0, 400));
  console.log('status: ' + s1.status);
  console.log('first body line: ' + firstBodyLine1.slice(0, 150) + '\n');

  const mirroringFound = MIRRORING_PATTERNS.find(re => re.test(d1));
  if (!mirroringFound)
    pass('draft does not restate the customer\'s complaint back at them');
  else
    fail(`draft mirrors customer content (matched: ${mirroringFound})`);

  // First body sentence must not OPEN with a direct paraphrase of the customer's complaint.
  // Check that it doesn't start with "You paid...", "You mentioned...", "I understand you..."
  const OPENER_RESTATEMENT = /^(You (paid|mentioned|said|needed|wanted|wrote that)|I understand (that )?you|I see (that )?you)/i;
  if (!OPENER_RESTATEMENT.test(firstBodyLine1))
    pass('first body sentence does not open with a restatement');
  else
    fail(`first body sentence opens with a restatement: "${firstBodyLine1.slice(0, 100)}"`);

  // -----------------------------------------------------------------------
  // Test 2
  // -----------------------------------------------------------------------
  console.log('\n=== Test 2: Turn-2 confirmation does not repeat turn-1 sizing delta ===\n');

  // Stage 1: get the exchange recommendation (turn 1)
  console.log('Running turn 1 (sizing exchange request)...');
  const r2a = await aiAdvisor({ customer_email: CUSTOMER_EMAIL, issue_description: TURN1_MSG });
  const intake1 = r2a?._structured;
  const d2a = (intake1?._composedResponse || '').trim();

  console.log('turn 1 draft: ' + d2a.replace(/\n+/g, ' ').slice(0, 300));

  // Check if turn 1 mentioned a sizing delta (the "adds X inches" language)
  const hasDelta = /adds.*inch|inch.*add|2.inch|two inch/i.test(d2a);
  if (hasDelta)
    console.log('  (turn 1 mentioned a sizing delta — good anchor for turn 2 test)');
  else
    console.log('  (turn 1 did not mention a sizing delta — turn 2 repeat test is moot)');

  // Stage 2: customer confirms — run turn 2 with the turn 1 intake
  console.log('\nRunning turn 2 (customer confirms)...');
  const r2b = await aiAdvisor({
    customer_email: CUSTOMER_EMAIL,
    issue_description: TURN2_MSG,
    intake: intake1,
  });
  const d2b = (r2b?._structured?._composedResponse || '').trim();
  const s2b = r2b?._structured || {};

  console.log('turn 2 draft: ' + d2b.replace(/\n+/g, ' ').slice(0, 400));
  console.log('status: ' + s2b.status + '\n');

  if (hasDelta) {
    if (!/adds.*inch|inch.*add|2.inch|two inch/i.test(d2b))
      pass('turn-2 confirmation does not repeat the sizing delta from turn 1');
    else
      fail('turn-2 confirmation repeats the sizing delta that was already told in turn 1');
  } else {
    pass('(sizing delta not in turn 1 — repetition test skipped)');
  }

  if (s2b.action_type === 'exchange' || /created|set up|exchange|on its way|i.ve/i.test(d2b))
    pass('turn-2 draft confirms the action');
  else
    fail(`turn-2 draft does not confirm the exchange — status: ${s2b.status}, action: ${s2b.action_type}`);

  console.log('\n' + (process.exitCode === 1 ? 'FAILED — see above' : 'PASSED'));
})().catch(e => { console.error(e); process.exit(1); });
