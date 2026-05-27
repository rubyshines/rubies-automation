/**
 * Shipping-policy grounding scenario (order-independent → no drift confound).
 *
 * The advisor previously had NO tool for ship-to countries / rates / free-ship
 * thresholds (shipping_zones), so it answered shipping-policy questions from
 * memory or stale KB. The new `shipping_info` tool surfaces the authoritative
 * shipping_zones facts; the advisor states only what it returns.
 *
 * Asserts the US free-shipping threshold ($99) and below-threshold rate ($10.50)
 * come through correctly.
 *
 * Run: node customer-service/test/scenarios/shippingPolicy.js
 */
require('dotenv').config();
const { aiAdvisor } = require('../../lib/aiAdvisor');

function pass(m) { console.log('  ✓ ' + m); }
function fail(m) { console.error('  ✗ ' + m); process.exitCode = 1; }

(async () => {
  const r = await aiAdvisor({ issue_description: 'Hi! I am ordering from the US. Is there free shipping, and how much is shipping if not?' });
  const d = ((r?._structured?._composedResponse) || r?.response || '').trim();
  console.log('draft: ' + d.replace(/\n+/g, ' ').slice(0, 260));

  if (/\$?\s?99/.test(d)) pass('cites the real $99 US free-shipping threshold');
  else fail('does not cite the $99 free-shipping threshold');
  if (/10\.50|10\.5|\$10/.test(d)) pass('cites the real below-threshold standard rate');
  else fail('does not cite the standard rate from shipping_zones');

  console.log('\n' + (process.exitCode === 1 ? 'FAILED' : 'PASSED'));
})().catch(e => { console.error(e); process.exit(1); });
