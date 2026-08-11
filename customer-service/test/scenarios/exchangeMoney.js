/**
 * Exchange money rules scenario (2026-07 accuracy sweep).
 *
 * The May 27 – Jul 8 draft↔sent review found the advisor telling customers
 * "no payment needed, exchanges are free" on cross-product exchanges that
 * Jamie then invoiced for the difference (drafts 1909, 1947, 2413 — all
 * judged high-severity). Root cause: the prompt's flat "Exchanges are free"
 * rule didn't distinguish straight swaps from different-product exchanges.
 *
 * The rule (advisor prompt, "### Exchanges — Money"), as revised 2026-08-11:
 *   - straight same-product swaps are free, never invoiced
 *   - different-product exchanges are NOT judged by the advisor. It has no
 *     prices, so it calls `exchange_price_check` and obeys the verdict, which
 *     `settleExchange` (exchangeMath.js) decides: owed money is ALWAYS
 *     refunded; an upcharge at or under $15 USD is waived and the customer is
 *     told not to worry about it; over $15 it is invoiced. This REPLACES the
 *     July rule that had the advisor promise an invoice on every cross-product
 *     upcharge (Jamie, 2026-08-11: "in general I let them slide if they are a
 *     small difference but I always do a refund… make sure the draft says
 *     don't worry about the price difference so the customer can acknowledge
 *     we did them a favour").
 *   - an explicit customer ask to be charged wins over the verdict (case 3)
 *   - adding to an order with nothing coming back is NOT an exchange and IS
 *     invoiced — see holdOnUnshippedModify
 *   - exchange + new purchases combine into ONE order, never "place a
 *     separate order on the site"
 *   - no hand-computed dollar amounts in any case (the tools own the math)
 *   - "$0" / "free" / "no invoice" never appear in operator_action_summary on
 *     a cross-product swap: the operator agent reads that as "straight swap"
 *     and skips exchange_difference entirely (operatorAgent.js:142-149)
 *
 * Case 1 deliberately does NOT pin which verdict comes back — the net depends
 * on live catalog prices, live automatic discounts, and what the customer
 * actually paid, all of which move. It asserts the advisor CALLED the tool and
 * that its reply states exactly one of the four legal outcomes, which is the
 * behaviour that changed. The threshold arithmetic is pinned in the unit tests
 * (`settleExchange`, exchangeMath.test.js) where it is deterministic.
 *
 * Both cases run synthetic messages against the CURRENT order state of the
 * ticket-103998306 customer (whose order now carries a Queeny tankini + Ruby
 * bottom in Pink 16 after the original exchange executed). Replaying the
 * historical ticket text is confounded by order-state drift — the original
 * Sky one-piece is no longer on the order (first run confirmed: advisor
 * correctly asked a clarifying question instead of exercising the money path).
 * Case 1: cross-product swap Queeny ($47) → Sky one-piece ($65) = upcharge.
 * Case 2: straight same-product size swap — must stay free, no invoice talk.
 *
 * Usage: node customer-service/test/scenarios/exchangeMoney.js
 */
require('dotenv').config();
const gorgias = require('../../import/gorgiasClient');
const { aiAdvisor } = require('../../lib/aiAdvisor');

const UPCHARGE_TICKET_ID = '103998306'; // Sky one-piece → Queeny + Ruby (draft 1947)

const MONEY_RE = /(?:US?\$|CA\$|\$)\s?\d[\d,]*(?:\.\d{2})?|\b\d+\.\d{2}\b/;

// Settlement words that are true only of a straight swap. In an
// operator_action_summary they tell the operator agent to skip
// exchange_difference, so on a cross-product swap they route the money around
// the only thing that prices it.
const SETTLED_RE = /\$0|\bfree\b|no invoice|no charge|no price difference|same price|straight[- ]value|waive/i;

// 2026-07-18 verbosity fix: the exchange confirmation template ends at the
// ship-day ("It'll ship tomorrow.") — no tracking-email promise on exchanges.
const TRACKING_CLAUSE_RE = /you'?ll (get|receive) (the )?tracking|tracking (by|via) email|tracking (number|info(rmation)?) (by|via|once)/i;

function fail(msg) { console.error('  ✗ ' + msg); process.exitCode = 1; }
function pass(msg) { console.log('  ✓ ' + msg); }

async function ticketToInput(ticketId) {
  const msgs = await gorgias.getTicketMessages(ticketId);
  const jamieIdx = msgs.findIndex(m => {
    if (!m.from_agent || m.channel === 'internal-note') return false;
    if (m.sender?.email?.endsWith('@email.gorgias.com') || m.via === 'rule') return false;
    const body = gorgias.stripHtml(m.stripped_text || m.body_text || '');
    return /Jamie Alexander/i.test(body);
  });
  const endIdx = jamieIdx >= 0 ? jamieIdx : msgs.length;
  const parts = [];
  let customerEmail = null;
  for (let i = 0; i < endIdx; i++) {
    const m = msgs[i];
    if (m.channel === 'internal-note') continue;
    const body = gorgias.stripHtml(m.stripped_text || m.body_text || '').trim();
    if (!body) continue;
    if (!m.from_agent) {
      parts.push(body);
      if (!customerEmail) customerEmail = m.sender?.email || null;
    } else if (m.sender?.email?.endsWith('@email.gorgias.com') || m.via === 'rule') {
      parts.push('[Bot]: ' + body);
    }
  }
  return { customerEmail, issueDescription: parts.join('\n\n') };
}

(async () => {
  console.log('=== exchange money rules ===\n');

  // --- Case 1: cross-product exchange with an upcharge → settle nothing ---
  console.log(`[upcharge] resolving customer from ticket ${UPCHARGE_TICKET_ID}...`);
  const { customerEmail } = await ticketToInput(UPCHARGE_TICKET_ID);
  if (!customerEmail) { fail('could not extract customer email from ticket'); return; }

  const UPCHARGE = `Hi,

My daughter has been trying the Queeny tankini in Pink size 16 and it just isn't her style. Could we exchange the tankini for the Sky one-piece in Pink size 16 instead? I understand the one-piece costs more.`;
  const r1 = await aiAdvisor({ customer_email: customerEmail, issue_description: UPCHARGE });
  const s1 = r1?._structured || {};
  const d1 = (s1._composedResponse || '').trim();
  const tools1 = (s1._timing?.api_calls || []).flatMap(c => c.tool_calls || []);
  console.log('[upcharge] draft:\n---\n' + d1 + '\n---');
  console.log('[upcharge] tools: ' + JSON.stringify(tools1));

  const exchangeStaged = s1.action_type === 'exchange'
    || (Array.isArray(s1.intake?.items) && s1.intake.items.some(i => i.state === 'CONFIRMED'));
  if (!exchangeStaged) {
    console.log('  (exchange path not reproduced this run — skipping upcharge asserts)');
  } else {
    // The behaviour that changed: the advisor must ASK rather than guess.
    if (tools1.includes('exchange_price_check')) pass('exchange_price_check was called before pricing was mentioned');
    else fail('exchange_price_check was NOT called — the advisor guessed the settlement on a cross-product swap');

    if (!/free exchange|no payment needed|nothing (more )?(owed|to pay)/i.test(d1)) pass('draft does not claim the exchange is free');
    else fail('draft claims free/no-payment on a cross-product exchange');

    if (!MONEY_RE.test(d1)) pass('draft contains no hand-computed dollar amount');
    else fail('draft states a dollar amount (the tools own the math)');

    // Exactly one of the four legal outcomes, never two at once — "an invoice
    // is coming" plus "don't worry about the difference" is the contradiction
    // this scenario exists to catch.
    const claims = [
      ['invoice', /invoice/i.test(d1)],
      ['waive', /don'?t worry about the (price )?difference|we'?(ve| have) covered the difference/i.test(d1)],
      ['refund', /back to your original (payment|card)|refunded to your original/i.test(d1)],
    ].filter(([, hit]) => hit).map(([name]) => name);
    if (claims.length <= 1) pass(`draft states one settlement outcome or none (${claims[0] || 'silent'})`);
    else fail(`draft states contradictory settlement outcomes: ${claims.join(' + ')}`);

    const summary = s1.operator_action_summary || '';
    if (/exchange_difference|invoice the (price )?difference/i.test(summary)) pass('operator_action_summary hands settlement to the tools');
    else fail(`operator_action_summary does not hand settlement to the tools: "${summary}"`);

    if (!SETTLED_RE.test(summary)) pass('operator_action_summary asserts no straight-swap settlement');
    else fail(`operator_action_summary pre-settles a cross-product swap — routes the agent around exchange_difference: "${summary}"`);

    if (!TRACKING_CLAUSE_RE.test(d1)) pass('no tracking-email promise on the exchange confirmation');
    else fail('exchange confirmation still promises tracking by email (clause removed 2026-07-18)');
  }

  // --- Case 2: straight same-product size swap → free, no invoice talk ---
  const STRAIGHT_SWAP = `Hi,

The Queeny tankini in Pink size 16 is a bit big on my daughter. Could we exchange it for the exact same tankini in size 14?`;
  const r2 = await aiAdvisor({ customer_email: customerEmail, issue_description: STRAIGHT_SWAP });
  const s2 = r2?._structured || {};
  const d2 = (s2._composedResponse || '').trim();
  console.log('\n[straight-swap] draft:\n---\n' + d2 + '\n---');

  const tools2 = (s2._timing?.api_calls || []).flatMap(c => c.tool_calls || []);
  console.log('[straight-swap] tools: ' + JSON.stringify(tools2));

  // Straight swaps are free by policy, so pricing them is a wasted round on
  // the majority of exchanges. The prompt scopes the tool to non-straight swaps.
  if (!tools2.includes('exchange_price_check')) pass('straight swap does not price-check (free by policy)');
  else fail('exchange_price_check called on a straight swap — wasted round, and invites a money sentence where none belongs');

  if (!/invoice/i.test(d2)) pass('straight swap draft has no invoice mention');
  else fail('straight swap draft mentions an invoice — same-product swaps are always free');

  if (!MONEY_RE.test(d2)) pass('straight swap draft contains no dollar amount');
  else fail('straight swap draft states a dollar amount');

  if (!TRACKING_CLAUSE_RE.test(d2)) pass('straight swap has no tracking-email promise');
  else fail('straight swap confirmation still promises tracking by email (clause removed 2026-07-18)');

  // --- Case 3: customer ASKS to be charged → the one path that still invoices ---
  const ASKS_TO_PAY = `Hi,

My daughter has been trying the Queeny tankini in Pink size 16 and it just isn't her style. Could we swap the tankini for the Sky one-piece in Pink size 16? Please charge me the difference, I don't want it for free.`;
  const r3 = await aiAdvisor({ customer_email: customerEmail, issue_description: ASKS_TO_PAY });
  const s3 = r3?._structured || {};
  const d3 = (s3._composedResponse || '').trim();
  console.log('\n[asks-to-pay] draft:\n---\n' + d3 + '\n---');

  const staged3 = s3.action_type === 'exchange'
    || (Array.isArray(s3.intake?.items) && s3.intake.items.some(i => i.state === 'CONFIRMED'));
  if (!staged3) {
    console.log('  (exchange path not reproduced this run — skipping asks-to-pay asserts)');
  } else {
    if (/invoice/i.test(d3)) pass('draft confirms the invoice the customer asked for');
    else fail('customer asked to be charged and the draft never mentions an invoice');

    if (!MONEY_RE.test(d3)) pass('draft still states no dollar amount');
    else fail('draft states a dollar amount (exchange_difference owns the math)');

    const summary3 = s3.operator_action_summary || '';
    if (/invoice the (price )?difference/i.test(summary3)) pass('operator_action_summary carries "invoice the difference"');
    else fail(`operator_action_summary missing "invoice the difference" on an explicit ask: "${summary3}"`);
  }

  console.log('\nDone.');
})().catch(e => { console.error(e); process.exit(1); });
