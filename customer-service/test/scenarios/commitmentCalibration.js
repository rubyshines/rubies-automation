/**
 * Commitment-calibration scenarios (2026-07 accuracy sweep).
 *
 * The May 27 – Jul 8 draft↔sent review's second-biggest divergence bucket
 * (~19%) was wrong ask-vs-act calibration: the advisor refunding when Jamie
 * clarified a contradiction first (draft 1849), refunding when nobody asked
 * for a refund (draft 2167), and promising rush shipping / "I've refunded
 * the expedited fee" before asking the needed-by date (drafts 1639, 1643).
 *
 * Rules exercised (advisor prompt):
 *   - ANTI-HALLUCINATION #9: money-moving actions require an explicit
 *     customer request in the conversation
 *   - "Refunds (additional rules)": ambiguous/contradictory items → ask the
 *     ONE resolving question before processing
 *   - "Customer needs the order by a specific date": ask the date before
 *     promising a shipping speed
 *   - "Shipped but stalled in transit": concrete check-back + pre-committed
 *     remedy, never a bare "I'm looking into it"
 *
 * Case anchors are real tickets, truncated before Jamie's first reply, same
 * technique as refundNoAmount.js.
 *
 * Usage: node customer-service/test/scenarios/commitmentCalibration.js
 */
require('dotenv').config();
const gorgias = require('../../import/gorgiasClient');
const { aiAdvisor } = require('../../lib/aiAdvisor');

const AMBIGUOUS_REFUND_TICKET = '102926421'; // draft 1849: "both suits" vs one size indicated
const NEEDED_BY_TICKET = '102518436';        // draft 1639: expedited order now showing late
const STALLED_TICKET = '101191288';          // draft 1387: UK parcel, Passport no movement ~12 days

function fail(msg) { console.error('  ✗ ' + msg); process.exitCode = 1; }
function pass(msg) { console.log('  ✓ ' + msg); }

const MONEY_ACTIONS = new Set(['refund', 'exchange+refund', 'cancellation']);

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

async function run(label, ticketId) {
  console.log(`\n[${label}] loading ticket ${ticketId} from Gorgias...`);
  const { customerEmail, issueDescription } = await ticketToInput(ticketId);
  if (!customerEmail) { fail(`${label}: could not extract customer email`); return null; }
  const r = await aiAdvisor({ customer_email: customerEmail, issue_description: issueDescription });
  const s = r?._structured || {};
  const draft = (s._composedResponse || '').trim();
  console.log(`[${label}] action_type=${s.action_type || 'null'} status=${s.advisor_status || s.status || '?'}\ndraft:\n---\n${draft}\n---`);
  return { s, draft };
}

(async () => {
  console.log('=== commitment calibration ===');

  // --- Case 1: contradictory return scope → clarify, don't refund ---
  const c1 = await run('ambiguous-refund', AMBIGUOUS_REFUND_TICKET);
  if (c1) {
    if (!MONEY_ACTIONS.has(c1.s.action_type)) pass('no refund staged while the return scope is contradictory');
    else fail(`staged ${c1.s.action_type} despite ambiguous return scope`);
    if (/\?/.test(c1.draft)) pass('draft asks the resolving question');
    else fail('draft asks no clarifying question');
  }

  // --- Case 2: paid-expedited order running late → ask needed-by date first ---
  const c2 = await run('needed-by-date', NEEDED_BY_TICKET);
  if (c2) {
    if (!MONEY_ACTIONS.has(c2.s.action_type)) pass('no immediate refund of the expedited fee before asking the date');
    else fail('refunded the expedited fee before asking the needed-by date');
    if (/\b(when do you need|what('s| is) the (last |latest )?date|need (it|this) by)\b/i.test(c2.draft)) pass('draft asks for the needed-by date');
    else fail('draft does not ask for the needed-by date');
  }

  // --- Case 3: stalled in transit → concrete check-back + pre-committed remedy ---
  const c3 = await run('stalled-transit', STALLED_TICKET);
  if (c3) {
    const bareInvestigate = /\b(look(ing)? into (it|this)|get back to you)\b/i.test(c3.draft)
      && !/\b(if it (hasn'?t|doesn'?t)|by (the )?(end of|early|next)|let me know (if|by))\b/i.test(c3.draft);
    if (!bareInvestigate) pass('draft is not a bare "looking into it" reply');
    else fail('draft only promises to investigate with no check-back plan');
    if (/\b(send (out )?(another|a new|a replacement)|ship (out )?(another|a replacement)|refund)\b/i.test(c3.draft)) pass('draft pre-commits to a remedy');
    else fail('draft never pre-commits to a remedy (reship/refund)');
  }

  console.log('\nDone.');
})().catch(e => { console.error(e); process.exit(1); });
