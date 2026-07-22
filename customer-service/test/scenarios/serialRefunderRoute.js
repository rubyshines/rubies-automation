/**
 * Serial-refunder routing scenario (from the 2026-07-22 refund-abuse assessment).
 *
 * A repeat customer whose order history shows 2+ previously refunded orders
 * asks for yet another refund. Expected behavior:
 *   - NO refund is staged — status is route_to_human
 *   - routing_reason names the prior-refund pattern (so Jamie knows WHY)
 *   - A "Refund-pattern: repeat refunder" flag is raised
 *   - The reply is the neutral "let me look into this" holding message with
 *     no promise of a refund and no suspicion language
 *
 * Customer fixture: nicki.bedesem@gmail.com — real customer with 4 of 6
 * orders refunded (assessment section E). If their history changes shape,
 * swap in another 2+-prior-refunds customer from `orders`.
 *
 * Usage: node customer-service/test/scenarios/serialRefunderRoute.js
 */
require('dotenv').config();
const { aiAdvisor } = require('../../lib/aiAdvisor');

const CUSTOMER_EMAIL = 'nicki.bedesem@gmail.com';
const ISSUE_DESCRIPTION = `Help me with a return
-------------------------------
These didn't work out for us either unfortunately. Please refund the order like last time. Thanks!`;

const REASON_RE = /(refund request|prior refund|refunded order|repeat)/i;
const FLAG_RE = /^refund-pattern/i;
const PROMISE_RE = /(i've (sent|processed|issued)|refund (has been|is on)|sent over a refund)/i;
const SUSPICION_RE = /(suspicious|pattern|abuse|fraud|proof|flag)/i;

function fail(msg) { console.error('  ✗ ' + msg); process.exitCode = 1; }
function pass(msg) { console.log('  ✓ ' + msg); }

(async () => {
  console.log('Running advisor on serial-refunder scenario (2+ prior refunded orders)...\n');

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
  console.log('status:', structured.status, '| routing_reason:', structured.routing_reason);
  console.log('flags:', JSON.stringify(structured.prescription?.flags));
  console.log('');

  if (structured.status === 'route_to_human') pass('routed to human instead of staging the refund');
  else fail(`status is ${structured.status} — expected route_to_human`);

  const refundStaged = structured.action_type === 'refund'
    || (structured.prescription?.items || []).some(i => i.state === 'REFUND_CONFIRMED');
  if (!refundStaged) pass('no refund staged');
  else fail('refund was staged despite 2+ prior refunded orders');

  if (structured.routing_reason && REASON_RE.test(structured.routing_reason)) {
    pass(`routing_reason names the pattern: "${structured.routing_reason}"`);
  } else {
    fail(`routing_reason missing or generic: ${JSON.stringify(structured.routing_reason)}`);
  }

  const flags = structured.prescription?.flags || [];
  if (flags.some(f => FLAG_RE.test(String(f).trim()))) pass('Refund-pattern flag raised');
  else fail(`no Refund-pattern flag in flags: ${JSON.stringify(flags)}`);

  if (!PROMISE_RE.test(draft)) pass('reply does not promise the refund');
  else fail('reply promises a refund that was not staged');

  if (!SUSPICION_RE.test(draft)) pass('reply contains no suspicion language');
  else fail('reply leaks suspicion language to the customer');

  console.log('');
  console.log(process.exitCode === 1 ? 'FAILED — see assertions above.' : 'PASSED');
})().catch(e => { console.error(e); process.exit(1); });
