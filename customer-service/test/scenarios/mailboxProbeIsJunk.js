/**
 * Mailbox-probe scenario (order-independent → no drift confound).
 *
 * Unknown senders have been sending one-line footer questions to the CS inbox —
 * "Hi Rubyshines, can your products be delivered internationally?" — from
 * free-mail handles that do not match the display name, greeting us by our
 * domain rather than our name. They exist to learn whether the inbox is live;
 * a reply confirms it. The advisor drafted these as `shipping` (ticket 3500,
 * 2026-09-03), so intake's junk disposition never fired.
 *
 * Two arms: the probe must come back message_type `junk` with no customer
 * reply, and a specific pre-purchase shipping question from an unknown sender
 * must NOT — that is the sibling case the probe rule could over-reach into.
 *
 * Run: node customer-service/test/scenarios/mailboxProbeIsJunk.js
 */
require('dotenv').config();
const { aiAdvisor } = require('../../lib/aiAdvisor');

function pass(m) { console.log('  ✓ ' + m); }
function fail(m) { console.error('  ✗ ' + m); process.exitCode = 1; }

(async () => {
  // Arm 1 — the probe, verbatim from the live ticket.
  const probe = await aiAdvisor({
    customer_email: 'lucyjames01v@gmail.com',
    issue_description: "Hi Rubyshines \n\nI'd like to know if your products can be delivered internationally? \nLooking forward to hearing from you.",
  });
  const pType = probe?._structured?.message_type;
  const pDraft = ((probe?._structured?._composedResponse) || probe?.response || '').trim();
  console.log(`probe: message_type=${pType} draft="${pDraft.replace(/\n+/g, ' ').slice(0, 160)}"`);
  if (pType === 'junk') pass('probe classified junk');
  else fail(`probe classified ${pType}, expected junk`);
  if (!/^hi[,!]?\s/i.test(pDraft) && !/jamie alexander/i.test(pDraft)) pass('probe gets an internal note, not a customer email');
  else fail('probe drafted a customer-facing reply');

  // Arm 2 — a genuine pre-purchase shipping question, unknown sender, with specifics.
  const real = await aiAdvisor({
    customer_email: 'sarah.mcallister@gmail.com',
    issue_description: 'Hi RUBIES, my daughter is 11 and we are in Germany. If I order the AJ in youth 12, do you cover the customs duties or will we get a bill on delivery?',
  });
  const rType = real?._structured?.message_type;
  const rDraft = ((real?._structured?._composedResponse) || real?.response || '').trim();
  console.log(`real: message_type=${rType} draft="${rDraft.replace(/\n+/g, ' ').slice(0, 160)}"`);
  if (rType !== 'junk') pass(`specific shipping question is not junk (${rType})`);
  else fail('specific shipping question was classified junk');
  if (/dut/i.test(rDraft)) pass('specific shipping question gets a real answer about duties');
  else fail('specific shipping question got no duties answer');

  console.log('\n' + (process.exitCode === 1 ? 'FAILED' : 'PASSED'));
})().catch(e => { console.error(e); process.exit(1); });
