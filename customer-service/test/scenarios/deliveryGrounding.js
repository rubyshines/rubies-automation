/**
 * Delivery-estimate grounding scenario (order-independent → no drift confound).
 *
 * Before: the advisor prompt told the AI to call `delivery_estimate`, but that
 * tool was NOT registered in the advisor's TOOLS array — a dead reference — so
 * the advisor answered transit-time questions from memory. Now delivery_estimate
 * is wired to the existing handler over our historical transit data
 * (order_delivery_times), per the "operational facts come from tools" rule.
 *
 * Asserts the advisor gives a concrete, data-backed delivery window for a
 * country question (rather than a vague guess or a deferral).
 *
 * Run: node customer-service/test/scenarios/deliveryGrounding.js
 */
require('dotenv').config();
const { aiAdvisor } = require('../../lib/aiAdvisor');

function pass(m) { console.log('  ✓ ' + m); }
function fail(m) { console.error('  ✗ ' + m); process.exitCode = 1; }

(async () => {
  const r = await aiAdvisor({ issue_description: 'Hi, I am in the UK and thinking of ordering. How long does delivery usually take to the United Kingdom?' });
  const d = ((r?._structured?._composedResponse) || r?.response || '').trim();
  console.log('draft: ' + d.replace(/\n+/g, ' ').slice(0, 240));

  const hasWindow = /\d+\s*[-–to]+\s*\d+\s*(business\s*)?(days|weeks)|\b\d+\s*(days|weeks)\b/i.test(d);
  if (hasWindow) pass('gives a concrete delivery window'); else fail('no concrete delivery window (guessing/deferring?)');

  if (/look into (that|it)|get back to you|i'?m not sure|not certain/i.test(d)) fail('defers instead of using delivery data');
  else pass('does not defer');

  console.log('\n' + (process.exitCode === 1 ? 'FAILED' : 'PASSED'));
})().catch(e => { console.error(e); process.exit(1); });
