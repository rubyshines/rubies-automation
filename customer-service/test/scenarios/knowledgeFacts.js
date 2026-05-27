/**
 * Knowledge-grounding scenarios (order-independent → no drift confound).
 *
 * Covers three real, order-state-INDEPENDENT advisor weaknesses found in the
 * China-window accuracy eval, fixed via the RUBIES FACTS block + the extended
 * anti-hallucination rule in aiAdvisor.js:
 *   A. Packaging discretion (#1175): advisor fabricated "return address says
 *      Shipment / no RUBIES reference". Truth: name IS on the return address in
 *      small font.
 *   B. Free-swimwear program link (#1188): advisor deferred instead of giving the
 *      known URL.
 *   C. Product colors (#1100/#1226): advisor recalled colors/variants from memory
 *      ("black only") instead of looking them up.
 *
 * Each is a synthetic general question with NO order context, so it does not
 * depend on any order's live fulfillment state. Run:
 *   node customer-service/test/scenarios/knowledgeFacts.js
 */
require('dotenv').config();
const { aiAdvisor } = require('../../lib/aiAdvisor');

function pass(m) { console.log('  ✓ ' + m); }
function fail(m) { console.error('  ✗ ' + m); process.exitCode = 1; }

async function draftFor(issue) {
  const r = await aiAdvisor({ issue_description: issue });
  return ((r?._structured?._composedResponse) || r?.response || '').trim();
}

(async () => {
  // A. Packaging discretion
  console.log('\nA. Packaging discretion (#1175)');
  const a = await draftFor('Hi, before I order I want to check — is the packaging discreet? Does the outside of the package show what is inside or the brand name?');
  console.log('  draft: ' + a.replace(/\n+/g, ' ').slice(0, 200));
  if (/poly mailer|plain|unbranded|discreet/i.test(a)) pass('mentions discreet/plain/unbranded packaging');
  else fail('does not describe the discreet packaging');
  if (/\bshipment\b/i.test(a)) fail('fabricates the false "Shipment" return-address detail');
  else pass('does not fabricate the "Shipment" return-address claim');
  if (/no (reference|mention|indication) (to|of) (rubies|the brand)[^.]*\breturn address|return address[^.]*\b(blank|no (rubies|brand|name))/i.test(a))
    fail('falsely claims the return address has no RUBIES name');
  else pass('does not falsely claim a brand-free return address');

  // B. Free-swimwear program link
  console.log('\nB. Free-swimwear program link (#1188)');
  const b = await draftFor('The link to your free swimwear for families program seems broken. Can you send me the correct link?');
  console.log('  draft: ' + b.replace(/\n+/g, ' ').slice(0, 200));
  if (/free-swimwear-for-families-in-need/i.test(b)) pass('gives the correct program URL directly');
  else fail('does not provide the program URL');
  if (/look into (that|it)|get back to you|i'?ll find/i.test(b)) fail('defers instead of giving the link');
  else pass('does not defer');

  // C. Product colors (look up, not memory)
  console.log('\nC. Product colors lookup (#1100)');
  const c = await draftFor('What colors does the Sky one-piece come in for adults?');
  console.log('  draft: ' + c.replace(/\n+/g, ' ').slice(0, 200));
  if (/black/i.test(c) && /pink/i.test(c)) pass('names the real adult colors (Black and Pink)');
  else fail('does not name both real adult colors (Black, Pink)');
  if (/\b(red|blue|green|white|purple)\b/i.test(c)) fail('mentions a color the Sky does not come in');
  else pass('invents no nonexistent color');

  console.log('\n' + (process.exitCode === 1 ? 'FAILED — see assertions.' : 'PASSED'));
})().catch(e => { console.error(e); process.exit(1); });
