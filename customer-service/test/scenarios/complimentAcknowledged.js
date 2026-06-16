/**
 * Compliment-acknowledgment scenario.
 *
 * Regression for the 2026-06-16 tone overcorrection. Commit 75eadc0 strengthened
 * the personal-stories rule with a stack of negatives ("do not praise, reassure,
 * encourage ... a real person confirming an order wouldn't add it"). That rule is
 * about not EVALUATING the customer, but the model generalized it and began
 * stripping the (correct) act of reciprocating a compliment aimed at us.
 *
 * Observed on ticket 1850: customer wrote "You are more than helpful and beyond
 * generous!" and the advisor's draft opened straight with "Here's where you can
 * send the Brooke:" — no acknowledgment. Jamie had to hand-add "Thanks for your
 * kind words!". The day before (ticket 1717), the advisor did it on its own.
 *
 * Fix: a positive rule telling the advisor to open with one short acknowledgment
 * when a customer compliments RUBIES/our help/our generosity.
 *
 * Test: customer sends a warm compliment plus a simple question. Assert the draft
 * acknowledges the kind words near the top (and doesn't just dive into the task).
 *
 * Uses order #30757 (skarlovnika@gmail.com) — delivered, terminal state.
 *
 * Run: node customer-service/test/scenarios/complimentAcknowledged.js
 */
require('dotenv').config();
const { aiAdvisor } = require('../../lib/aiAdvisor');

function pass(m) { console.log('  ✓ ' + m); }
function fail(m) { console.error('  ✗ ' + m); process.exitCode = 1; }

const CUSTOMER_EMAIL = 'skarlovnika@gmail.com';

// Customer gushes, then asks a simple question. The compliment is aimed at us.
const COMPLIMENT_MSG = `Hi,

I just wanted to say you have been more than helpful and beyond generous with everything. Thank you so much!

One quick question, where should I send the items back to?`;

// An acknowledgment of the compliment, expected near the top of the body.
const ACK_PATTERNS = [
  /kind words/i,
  /that'?s (so|very) (kind|sweet|nice)/i,
  /so kind of you/i,
  /thank you so much/i,
  /you'?re too kind/i,
  /that means a lot/i,
  /happy (to help|i could help)/i,
  /glad (to help|i could help|to hear)/i,
  /appreciate (your|the) kind/i,
];

(async () => {
  console.log('=== Compliment acknowledgment: advisor reciprocates kind words ===\n');
  const r = await aiAdvisor({ customer_email: CUSTOMER_EMAIL, issue_description: COMPLIMENT_MSG });
  const draft = (r?._structured?._composedResponse || '').trim();
  const s = r?._structured || {};

  // Body = everything after the greeting line, before the signature.
  const bodyLines = draft.split('\n')
    .filter(l => l.trim() && !/^Hi[,!]?\s*$/i.test(l.trim()) && !/^(Take care|Talk soon)/i.test(l.trim()) && !/^Jamie Alexander/i.test(l.trim()));
  const firstBodyLine = bodyLines[0] || '';

  console.log('draft: ' + draft.replace(/\n+/g, ' ').slice(0, 400));
  console.log('status: ' + s.status);
  console.log('first body line: ' + firstBodyLine.slice(0, 150) + '\n');

  // The acknowledgment should appear, and it should be up front — in the first
  // one or two body lines, not buried at the end.
  const topOfBody = bodyLines.slice(0, 2).join(' ');
  const ackMatch = ACK_PATTERNS.find(re => re.test(topOfBody));
  if (ackMatch)
    pass(`draft opens by acknowledging the kind words (matched: ${ackMatch})`);
  else
    fail('draft does not acknowledge the compliment near the top — overcorrected back to all-business');

  // Sanity: it should still answer the actual question (where to send returns).
  if (/donat|send (it|them|the|your)|return|address|c\/o|RUBIES Returns/i.test(draft))
    pass('draft still addresses the return/donation question');
  else
    fail('draft acknowledged the compliment but dropped the actual CS task');

  console.log('\n' + (process.exitCode === 1 ? 'FAILED — see above' : 'PASSED'));
})().catch(e => { console.error(e); process.exit(1); });
