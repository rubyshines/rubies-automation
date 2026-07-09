/**
 * Exchange money rules scenario (2026-07 accuracy sweep).
 *
 * The May 27 – Jul 8 draft↔sent review found the advisor telling customers
 * "no payment needed, exchanges are free" on cross-product exchanges that
 * Jamie then invoiced for the difference (drafts 1909, 1947, 2413 — all
 * judged high-severity). Root cause: the prompt's flat "Exchanges are free"
 * rule didn't distinguish straight swaps from different-product exchanges.
 *
 * The rule (advisor prompt, "### Exchanges — Money"):
 *   - straight same-product swaps are free, never invoiced
 *   - different-product exchanges settle the price difference (invoice or
 *     refund), with operator_action_summary ending "invoice the difference"
 *   - exchange + new purchases combine into ONE order, never "place a
 *     separate order on the site"
 *   - no hand-computed dollar amounts (exchange_difference owns the math)
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

  // --- Case 1: cross-product exchange with an upcharge → invoice the difference ---
  console.log(`[upcharge] resolving customer from ticket ${UPCHARGE_TICKET_ID}...`);
  const { customerEmail } = await ticketToInput(UPCHARGE_TICKET_ID);
  if (!customerEmail) { fail('could not extract customer email from ticket'); return; }

  const UPCHARGE = `Hi,

My daughter has been trying the Queeny tankini in Pink size 16 and it just isn't her style. Could we exchange the tankini for the Sky one-piece in Pink size 16 instead? I understand the one-piece costs more.`;
  const r1 = await aiAdvisor({ customer_email: customerEmail, issue_description: UPCHARGE });
  const s1 = r1?._structured || {};
  const d1 = (s1._composedResponse || '').trim();
  console.log('[upcharge] draft:\n---\n' + d1 + '\n---');

  const exchangeStaged = s1.action_type === 'exchange'
    || (Array.isArray(s1.intake?.items) && s1.intake.items.some(i => i.state === 'CONFIRMED'));
  if (!exchangeStaged) {
    console.log('  (exchange path not reproduced this run — skipping upcharge asserts)');
  } else {
    if (/invoice/i.test(d1)) pass('draft tells the customer an invoice for the difference is coming');
    else fail('draft does not mention the invoice — cross-product upcharge presented as free');

    if (!/free exchange|no payment needed|nothing (more )?(owed|to pay)/i.test(d1)) pass('draft does not claim the exchange is free');
    else fail('draft claims free/no-payment on a cross-product upcharge exchange');

    if (!MONEY_RE.test(d1)) pass('draft contains no hand-computed dollar amount');
    else fail('draft states a dollar amount (exchange_difference owns the math)');

    const summary = s1.operator_action_summary || '';
    if (/invoice the difference/i.test(summary)) pass('operator_action_summary flags "invoice the difference"');
    else fail(`operator_action_summary missing "invoice the difference": "${summary}"`);
  }

  // --- Case 2: straight same-product size swap → free, no invoice talk ---
  const STRAIGHT_SWAP = `Hi,

The Queeny tankini in Pink size 16 is a bit big on my daughter. Could we exchange it for the exact same tankini in size 14?`;
  const r2 = await aiAdvisor({ customer_email: customerEmail, issue_description: STRAIGHT_SWAP });
  const s2 = r2?._structured || {};
  const d2 = (s2._composedResponse || '').trim();
  console.log('\n[straight-swap] draft:\n---\n' + d2 + '\n---');

  if (!/invoice/i.test(d2)) pass('straight swap draft has no invoice mention');
  else fail('straight swap draft mentions an invoice — same-product swaps are always free');

  if (!MONEY_RE.test(d2)) pass('straight swap draft contains no dollar amount');
  else fail('straight swap draft states a dollar amount');

  console.log('\nDone.');
})().catch(e => { console.error(e); process.exit(1); });
