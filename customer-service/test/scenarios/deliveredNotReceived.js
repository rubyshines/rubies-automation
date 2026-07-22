/**
 * "Marked delivered but the customer didn't get it" scenario (stolen / porch pirate).
 *
 * The advisor had no prompt branch for a FULFILLED order whose tracking shows
 * delivered while the customer says it never arrived. It improvised — telling
 * the customer to file a USPS claim and routing to human — instead of the
 * intended flow: confirm the ship-to address back to them, ask them to check
 * the usual spots, and offer a reship if it doesn't surface.
 *
 * It also couldn't quote the address: the order-context block only rendered
 * city/state/country, never the street. The full ship-to address now renders
 * so the advisor can confirm it.
 *
 * Uses delivered order #30757 (terminal state — won't drift).
 *
 * Asserts the draft:
 *   1. quotes the full street ship-to address (not just the city)
 *   2. asks the customer to verify that address
 *   3. offers to reship if it doesn't turn up
 *   4. does NOT tell the customer to file a carrier claim
 *   5. lands on status "needs_info" (handled directly, not route_to_human)
 *
 * Run: node customer-service/test/scenarios/deliveredNotReceived.js
 */
require('dotenv').config();
const { aiAdvisor } = require('../../lib/aiAdvisor');

function pass(m) { console.log('  ✓ ' + m); }
function fail(m) { console.error('  ✗ ' + m); process.exitCode = 1; }

const MSG = `Greetings.

I've recently ordered a bundle of Brooke bra and Charlie underwear, however, the order (#30757) appears to have been yoinked by a porch pirate. We don't have any pictures or video footage but it's not where the tracking says it should be. What can we do in such a case?

Thank you,
-A.S.`;

(async () => {
  const r = await aiAdvisor({ customer_email: 'skarlovnika@gmail.com', issue_description: MSG });
  const s = r?._structured || {};
  const d = (s._composedResponse || '').trim();
  console.log('draft: ' + d.replace(/\n+/g, ' '));
  console.log('status: ' + s.status + ' | action_type: ' + s.action_type + '\n');

  if (/salem cir/i.test(d)) pass('quotes the full street ship-to address');
  else fail('does not quote the street ship-to address (only city/state would mean the address render regressed)');

  if (/confirm|verify|right address|correct address|shipped to/i.test(d)) pass('asks the customer to verify the address');
  else fail('does not ask the customer to verify the ship-to address');

  if (/another (order|package)|new (order|package)|reship|send (over |out )?another|replacement/i.test(d)) pass('offers to reship if it does not turn up');
  else fail('does not offer a reship');

  if (!/file a (usps|carrier|claim)|usps\.com|file a claim/i.test(d)) pass('does not push a carrier-claim');
  else fail('tells the customer to file a carrier claim (should handle directly)');

  if (s.status === 'needs_info') pass('status is needs_info (handled directly, not escalated on first contact)');
  else fail(`status is "${s.status}", expected "needs_info"`);

  console.log('\n' + (process.exitCode === 1 ? 'FAILED' : 'PASSED'));
})().catch(e => { console.error(e); process.exit(1); });
