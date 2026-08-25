/**
 * Donation address is given once per ticket.
 *
 * Anchored on ticket 114053249 (order #33118, four size-16 items exchanged down
 * to 14). Turn 1 confirmed the exchange and gave the Trans Closet of the Hudson
 * Valley address in full. Turn 2 the customer wrote "we also have some older
 * Rubies in good condition, should I send those to that same address as well?"
 * and the advisor re-sent the entire block — address, org description, wash
 * reminder, appreciation line — to answer a yes/no question. Jamie rewrote it
 * to one line before sending.
 *
 * The cause was not a missing rule. "Donation/returns boilerplate appears ONCE
 * per conversation" was already in the prompt; it lost to the tool result's own
 * "paste word-for-word, every line, do not shorten" instruction, which is a
 * positive template arriving at the moment of writing. So the fix moved the
 * decision into the tool: get_donation_partner now knows this ticket already
 * has the address and returns one confirming line instead of the block, with
 * the matching instruction. The model's contract is unchanged — relay
 * response_text verbatim.
 *
 * Why this scenario is stable where order-anchored ones drift: the trigger is a
 * permanent row (a sent draft carrying the address), not a transient state of
 * the world like an unshipped order.
 *
 * Asserts (only when the trigger is confirmed present this run):
 *   0. the prior-address lookup actually fired — without this every assertion
 *      below passes vacuously on a ticket that simply has no donation history
 *   1. the reply carries no partner address block
 *   2. the reply does not repeat the wash reminder
 *   3. the reply does not repeat the appreciation line
 *   4. the reply actually answers the question (points at the same address)
 *
 * Usage: node customer-service/test/scenarios/donationAddressNotRepeated.js
 */
require('dotenv').config();
const { getSupabaseClient } = require('../../../shared/supabaseClient');
const { aiAdvisor } = require('../../lib/aiAdvisor');
const { buildContext } = require('../../lib/contextBuilder');
const { findPriorPartnerDonation } = require('../../lib/donationRouting');

const TICKET_ID = 114053249;
const CUSTOMER = 'ljrbarkan@gmail.com';
const ORDER = '#33118';
const LATEST = 'Amazing - thank you! We also have some older Rubies in good condition. Should I send those to that same address as well?';

function fail(msg) { console.error('  ✗ ' + msg); process.exitCode = 1; }
function pass(msg) { console.log('  ✓ ' + msg); }

(async () => {
  const sb = getSupabaseClient();
  const { data: priorDrafts } = await sb
    .from('cs_ai_drafts')
    .select('sent_response, sent_at, created_at, structured_output')
    .eq('gorgias_ticket_id', TICKET_ID)
    .not('sent_response', 'is', null);

  // Assertion 0. A scenario whose trigger is absent measures nothing and still
  // exits 0 — the failure mode that left two warehouse_hold scenarios dead for
  // months. Stop loudly instead.
  const prior = findPriorPartnerDonation(priorDrafts || []);
  if (!prior) {
    console.error(`  ✗ trigger missing: no sent draft on ticket ${TICKET_ID} carries a partner address, so this scenario cannot test anything`);
    console.error('FAILED — re-anchor on another ticket whose first reply gave a donation address.');
    process.exit(1);
  }
  pass(`prior-address lookup fired (${prior.partner_name || 'partner unknown'})`);

  // The regen shape the dashboard sends: history + latest message, intake fed
  // back. A first-pass shape would not reproduce what production does here.
  const issue = [
    '[CONVERSATION HISTORY]',
    'Customer: exchange all four size 16 items down to size 14 on order #33118.',
    'Us: (exchange confirmed; donation partner address given in full)',
    '',
    '[LATEST CUSTOMER MESSAGE]',
    LATEST,
  ].join('\n');

  const preContext = await buildContext({
    customer_email: CUSTOMER,
    order_number: ORDER,
    issue_description: LATEST,
    current_gorgias_ticket_id: TICKET_ID,
  });

  const result = await aiAdvisor({
    customer_email: CUSTOMER,
    customer_name: 'Lauren',
    issue_description: issue,
    preContext,
    ticket_id: TICKET_ID,
  });
  const draft = result?.response || result?._structured?._composedResponse || '';
  if (!draft) {
    fail('advisor returned no draft');
    console.log('FAILED');
    return;
  }
  console.log('\n--- draft ---\n' + draft.trim() + '\n-------------\n');

  if (!/^RUBIES Returns\r?$/m.test(draft)) {
    pass('no partner address block in the reply');
  } else {
    fail('the partner address block was sent again — the customer already has it');
  }

  if (!/wash/i.test(draft)) {
    pass('wash reminder not repeated');
  } else {
    fail('the wash reminder was repeated');
  }

  if (!/greatly appreciated by someone in our community/i.test(draft)) {
    pass('appreciation line not repeated');
  } else {
    fail('the appreciation line was repeated');
  }

  if (/same (address|place)/i.test(draft)) {
    pass('answers the question by pointing at the same address');
  } else {
    fail('the reply never tells the customer the same address applies — it answered nothing');
  }

  console.log('');
  console.log(process.exitCode === 1 ? 'FAILED — see assertions above.' : 'PASSED');
})().catch(e => { console.error(e); process.exit(1); });
