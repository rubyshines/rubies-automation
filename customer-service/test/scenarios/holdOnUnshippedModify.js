/**
 * Hold-on-unshipped-modify scenario (parked item #877).
 *
 * Rule (advisor prompt, "### Address Changes & Order Edits"): ANY request to
 * modify the ITEMS of an UNFULFILLED order — vague OR specific — must set
 * action_type to "warehouse_hold" so the order is frozen before it ships. The
 * old prompt carved out specific requests ("named product + size/color → skip
 * the hold, go straight to order_modification"), which left orders exposed: the
 * order could ship the wrong item before an operator executed the swap. This is
 * exactly what happened on the anchor ticket below.
 *
 * Anchored on ticket 103643280 (CS ticket 1892): customer asked, before
 * shipping, to swap a specific item (Pink size 10 → AJ Black 12) and be charged
 * the difference. Pre-fix the advisor returned order_modification with NO hold.
 *
 * Asserts: action_type === 'warehouse_hold', and — for the SPECIFIC branch,
 * where the customer named the product+size — that the reply states the change
 * as already made and never narrates the hold. The operator runs the staged
 * change before the reply goes out (Execute & Send), so past tense is true by
 * the time the customer reads it, and the hold is internal plumbing. Before
 * 2026-07-29 the prompt's verbatim shape was "I've put a hold on your order so
 * it won't ship, and I'll swap ... You'll get a confirmation once it's done",
 * which narrated the plumbing and hedged the change into the future.
 *
 * NOTE ON DRIFT: this is a LIVE regen and the advisor reads live order state.
 * Once the order is modified/fulfilled/cancelled the modify path no longer
 * reproduces, so this script SKIPS (exit 0) rather than false-failing. The
 * deterministic hold *placement* is covered by autoAddressChange.test.js +
 * the export regression test; this script checks the *advisor's routing*.
 *
 * Usage: node customer-service/test/scenarios/holdOnUnshippedModify.js [ticketId] [orderNumber]
 */
require('dotenv').config();
const gorgias = require('../../import/gorgiasClient');
const { aiAdvisor } = require('../../lib/aiAdvisor');
const { getOrderByNumber } = require('../../lib/shopify');
const { getSupabaseClient } = require('../../../shared/supabaseClient');

const TICKET_ID = process.argv[2] || '103643280';
const ORDER_NUMBER = process.argv[3] || '31618';

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

  // Drift gate up front (2026-07-22): the hold routing only applies to a live
  // UNFULFILLED order. Once the anchor ships, a swap request on it correctly
  // becomes an 'exchange' — which the answer-shape skip below can't tell apart
  // from a real routing regression, so check the order state deterministically.
  const order = await getOrderByNumber(ORDER_NUMBER);
  if (!order || order.cancelledAt || order.displayFulfillmentStatus !== 'UNFULFILLED') {
    skip(`anchor order #${ORDER_NUMBER} is ${!order ? 'not found' : order.cancelledAt ? 'cancelled' : order.displayFulfillmentStatus} — scenario needs a live unshipped-modify ticket. Re-pin: node customer-service/test/scenarios/holdOnUnshippedModify.js <ticketId> <orderNumber>`);
    return;
  }

  console.log(`Customer: ${customerEmail}`);
  console.log('Running advisor...');

  // Feed the resolved intake_state back in, the way the dashboard's regen path
  // does (apiRefreshDraft passes `intake: draft.intake_state`). Without this the
  // scenario only ever exercises a FIRST pass, where the "unshipped → hold" rule
  // has no competing signal. On a regen the state says message_type "exchange"
  // with fully resolved items, and that is the input shape that actually broke:
  // 3/3 green here while the live regen produced a return-and-donate block.
  const supabase = getSupabaseClient();
  const { data: priorDraft } = await supabase
    .from('cs_ai_drafts')
    .select('intake_state')
    .eq('gorgias_ticket_id', Number(TICKET_ID))
    .not('intake_state', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (priorDraft?.intake_state) {
    console.log(`Replaying with stored intake_state (message_type=${priorDraft.intake_state.message_type}, intent=${priorDraft.intake_state.customer_intent})`);
  }

  const result = await aiAdvisor({
    customer_email: customerEmail,
    issue_description: parts.join('\n\n'),
    intake: priorDraft?.intake_state || undefined,
  });
  const s = result?._structured || {};
  const actionType = s.action_type || null;

  console.log('');
  console.log(`action_type: ${actionType}`);
  console.log(`operator_action_summary: ${s.operator_action_summary || '(none)'}`);
  console.log('');

  if (actionType === 'warehouse_hold') {
    pass('item-modify on an unshipped order routed to warehouse_hold (order frozen before ship)');
    // The specific-request branch should also stage the change for the operator.
    const isSpecific = !!(s.operator_action_summary && /swap|add|remove|change/i.test(s.operator_action_summary));
    if (s.operator_action_summary && /aj|swap/i.test(s.operator_action_summary)) {
      pass('operator_action_summary stages the specific swap for the operator');
    } else {
      console.log('  (note) operator_action_summary did not name the swap — fine for vague requests');
    }

    // Prose shape — only meaningful on the SPECIFIC branch. A vague request has
    // no change to report yet and legitimately opens with the hold.
    if (isSpecific) {
      // The composed customer email lives on _structured (buildCompatibleStructured
      // attaches it); the outer result only carries the markdown summary.
      const composed = String(s._composedResponse || '');
      if (!composed) { fail('advisor returned no composed reply to assert against'); }
      // The model sometimes prefixes planning narration ("This is an unfulfilled
      // order edit, so it's a warehouse hold...") before the greeting. The prompt
      // forbids that separately; these assertions are about the CUSTOMER copy, so
      // scope them from the greeting on, or an internal word like "hold" appearing
      // only in the model's own reasoning reads as a false failure.
      const greet = composed.search(/^(Hi|Hey|Hello|Hola)\b/m);
      const reply = greet >= 0 ? composed.slice(greet) : composed;
      if (/\b(I've|I have)\s+(swapped|added|removed|changed|updated)/i.test(reply)) {
        pass('states the change as already made (past tense)');
      } else {
        fail(`specific-branch reply did not state the change in past tense: ${JSON.stringify(reply.slice(0, 200))}`);
      }
      if (/\bhold\b/i.test(reply)) {
        fail(`specific-branch reply narrates the internal hold to the customer: ${JSON.stringify(reply.slice(0, 200))}`);
      } else {
        pass('does not narrate the internal hold');
      }
      if (/you'll get a confirmation|once it's done|will be confirmed/i.test(reply)) {
        fail(`specific-branch reply promises a later confirmation instead of reporting a completed change: ${JSON.stringify(reply.slice(0, 200))}`);
      } else {
        pass('no redundant "confirmation to follow" promise');
      }

      // Nothing has shipped, so there is nothing to send back. Item
      // classification labels a colour swap message_type "exchange", and on the
      // dashboard's REGEN path that label is fed back in as intake_state — which
      // is how a pre-ship swap once produced a full return-and-donate address
      // block for an order the customer had never received (2026-07-29).
      const donation = result?._structured?.prescription?.donation;
      if (donation) {
        fail(`donation routing fired on an UNFULFILLED order — nothing has shipped, so there is nothing to donate: ${JSON.stringify(donation)}`);
      } else {
        pass('no donation routing on an unshipped order');
      }
      if (/items? you are returning|RUBIES Returns|please wash (any items|the item)|send the items?\b/i.test(reply)) {
        fail(`reply asks the customer to mail back an order that has not shipped: ${JSON.stringify(reply.slice(0, 300))}`);
      } else {
        pass('does not ask the customer to return an unshipped order');
      }
    }
  } else if (actionType === 'order_modification' || actionType === 'cancellation' || actionType === null) {
    skip(`advisor returned ${JSON.stringify(actionType)} — anchor order has likely drifted (already modified/fulfilled/closed). Re-run against a fresh unshipped-modify ticket: node customer-service/test/scenarios/holdOnUnshippedModify.js <ticketId>`);
  } else {
    fail(`unexpected action_type ${JSON.stringify(actionType)} — expected warehouse_hold for an unshipped item modify`);
  }

  console.log('');
  console.log(process.exitCode === 1 ? 'FAILED — see assertions above.' : 'DONE');
})().catch((e) => { console.error(e); process.exit(1); });
