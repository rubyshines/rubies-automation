/**
 * Change-then-cancel save-the-sale scenario.
 *
 * Rule (advisor prompt, cancel branches): a cancel request with NO stated
 * reason routes to save-the-sale (`action_type: warehouse_hold`), no matter
 * how firmly it's worded — and an earlier message asking to CHANGE the order
 * is a fixable-issue hint even when the latest message says cancel (the
 * customer likely hit a wall mid-change and defaulted to cancelling).
 *
 * Anchored on ticket 108603227 (CS ticket 2610, order #32472): customer opened
 * a chat flow with "Change my order before it ships", then sent "I would like
 * to cancel the order and get a refund on my card" — firm but reasonless.
 * Pre-fix the advisor read the firmness as clear intent and returned
 * action_type cancellation with no hold, leaving the unfulfilled order
 * shippable until the operator executed the cancel.
 *
 * Asserts: action_type === 'warehouse_hold'.
 *
 * NOTE ON DRIFT: this is a LIVE regen and the advisor reads live order state.
 * Once order #32472 is cancelled/fulfilled the scenario no longer reproduces,
 * so this script SKIPS (exit 0) on a null/absent order rather than
 * false-failing. To re-pin, pass a fresh ticket with the same two-message
 * shape (change request, then reasonless cancel) on an unfulfilled order.
 *
 * Usage: node customer-service/test/scenarios/changeThenCancelHold.js [ticketId]
 */
require('dotenv').config();
const gorgias = require('../../import/gorgiasClient');
const { aiAdvisor } = require('../../lib/aiAdvisor');
const { getOrderByNumber } = require('../../lib/shopify');

// Re-pinned 2026-08-11 alongside holdOnUnshippedModify: the previous anchor
// (#32472) was cancelled, and a dead anchor makes this SKIP rather than fail.
const TICKET_ID = process.argv[2] || '111183724';
// Anchor order for the default ticket. Pass a second arg when re-pinning.
const ORDER_NUMBER = process.argv[3] || '32615';

function fail(msg) { console.error('  ✗ ' + msg); process.exitCode = 1; }
function pass(msg) { console.log('  ✓ ' + msg); }
function skip(msg) { console.log('  ⊘ SKIP: ' + msg); }

(async () => {
  console.log(`Loading ticket ${TICKET_ID} from Gorgias...`);
  const msgs = await gorgias.getTicketMessages(TICKET_ID);

  const parts = [];
  let customerEmail = null;
  for (const m of msgs) {
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
  if (!customerEmail) { fail('could not extract customer email from ticket'); return; }

  // Drift gate up front: the save-the-sale routing only applies to a live
  // UNFULFILLED order. Once the anchor order is cancelled or shipped the
  // advisor legitimately answers differently — and its wrong-answer shape
  // (action_type 'cancellation') is exactly the regression this scenario pins,
  // so we can't infer drift from the answer itself.
  const order = await getOrderByNumber(ORDER_NUMBER);
  if (!order || order.cancelledAt || order.displayFulfillmentStatus !== 'UNFULFILLED') {
    skip(`anchor order #${ORDER_NUMBER} is ${!order ? 'not found' : order.cancelledAt ? 'cancelled' : order.displayFulfillmentStatus} — scenario needs a live unfulfilled order. Re-pin: node customer-service/test/scenarios/changeThenCancelHold.js <ticketId> <orderNumber>`);
    return;
  }

  console.log(`Customer: ${customerEmail}`);
  console.log('Running advisor...');
  const result = await aiAdvisor({ customer_email: customerEmail, issue_description: parts.join('\n\n') });
  const s = result?._structured || {};
  const actionType = s.action_type || null;

  console.log('');
  console.log(`action_type: ${actionType}`);
  console.log(`operator_action_summary: ${s.operator_action_summary || '(none)'}`);
  console.log('');

  if (actionType === 'warehouse_hold') {
    pass('reasonless cancel after a change request routed to warehouse_hold (save-the-sale, order frozen)');
    const replyText = result?.content?.[0]?.text || s._composedResponse || '';
    if (/swap|change/i.test(replyText)) {
      pass('reply asks whether there is something to swap or change before cancelling');
    } else {
      console.log('  (note) reply did not visibly ask the save-the-sale question — check the draft text');
    }
  } else {
    // The drift gate above already guaranteed a live unfulfilled order, so any
    // non-hold answer here is a real regression (cancellation = the pre-fix bug).
    fail(`expected warehouse_hold (save-the-sale) for a reasonless cancel preceded by a change request, got ${JSON.stringify(actionType)}`);
  }

  console.log('');
  console.log(process.exitCode === 1 ? 'FAILED — see assertions above.' : 'DONE');
})().catch((e) => { console.error(e); process.exit(1); });
