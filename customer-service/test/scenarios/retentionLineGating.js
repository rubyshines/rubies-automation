/**
 * Retention-line gating scenario (voice rule 11 as narrowed by Jamie, 2026-07-17).
 *
 * The "I hope you will give RUBIES a try again in the future" door-open line
 * fires ONLY on a customer's FIRST order refunded IN FULL. Jamie's narrowing
 * makes the negative case the regression risk: a partial refund (or repeat
 * customer) must NOT get the line, or it reads as pushing away a customer
 * who is staying.
 *
 * Test (negative case, order-independent): a customer refunding ONE item of a
 * multi-item order (explicitly keeping the rest). Assert no retention line;
 * assert the grant-first diagnostic question IS allowed but the door-open
 * line is absent.
 *
 * Uses skarlovnika@gmail.com (order #30757 — delivered, terminal state,
 * multi-item).
 *
 * Run: node customer-service/test/scenarios/retentionLineGating.js
 */
require('dotenv').config();
const { aiAdvisor } = require('../../lib/aiAdvisor');

function pass(m) { console.log('  ✓ ' + m); }
function fail(m) { console.error('  ✗ ' + m); process.exitCode = 1; }

const CUSTOMER_EMAIL = 'skarlovnika@gmail.com';

const MSG = `Hi,

I'd like a refund for just the bikini top from my order. It didn't work for me, but I'm keeping everything else, the bottoms are great.`;

const RETENTION_PATTERNS = [
  /give rubies a (try|chance) again/i,
  /try (us|rubies) again in the future/i,
  /hope (you'?ll|you will) (be back|come back|return)/i,
];

(async () => {
  console.log('=== Retention line gating: partial refund gets NO door-open line ===\n');
  const r = await aiAdvisor({ customer_email: CUSTOMER_EMAIL, issue_description: MSG });
  const draft = (r?._structured?._composedResponse || '').trim();
  console.log('draft: ' + draft.replace(/\n+/g, ' ').slice(0, 400) + '\n');

  if (!draft) { fail('no draft produced'); return; }

  const hit = RETENTION_PATTERNS.find(re => re.test(draft));
  if (hit)
    fail(`draft added the retention line on a PARTIAL refund (matched: ${hit}) — it is reserved for first-order FULL refunds`);
  else
    pass('no retention line on a partial refund (customer is staying)');

  // Sanity: the draft still processes/acknowledges the refund.
  if (/refund/i.test(draft)) pass('draft addresses the refund');
  else fail('draft does not address the refund at all');

  console.log('\n' + (process.exitCode === 1 ? 'FAILED — see above' : 'PASSED'));
})().catch(e => { console.error(e); process.exit(1); });
