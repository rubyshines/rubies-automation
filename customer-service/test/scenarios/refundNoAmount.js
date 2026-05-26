/**
 * Refund-amount-suppression scenario.
 *
 * Anchored on a real single-item refund ticket (the customer wanted a refund
 * after sizing help, advisor processes it immediately). Before the Phase 0
 * prompt change the advisor wrote the exact dollar figure into BOTH the
 * customer-facing draft ("You should see $32.00 back...") and the
 * operator_action_summary ("refund order #30345 for 1x Sassy XS Black,
 * $32.00"). That hand-written figure diverges from what refund_order actually
 * computes (shipping/tax inclusion), which forces the Execute & Send gate to
 * HOLD.
 *
 * The rule (advisor prompt, "### Refunds (additional rules)"): never state an
 * exact dollar amount in customer-facing refund/cancellation prose, and
 * operator_action_summary names the order + items, never a precomputed amount.
 *
 * Asserts (only when the refund path is actually reproduced this run):
 *   1. the refund path was exercised (action_type === 'refund')
 *   2. the customer-facing draft contains NO dollar amount
 *   3. operator_action_summary is populated, names the item, and has NO amount
 *
 * Usage: node customer-service/test/scenarios/refundNoAmount.js
 */
require('dotenv').config();
const gorgias = require('../../import/gorgiasClient');
const { aiAdvisor } = require('../../lib/aiAdvisor');

const TICKET_ID = '96686844'; // single Sassy XS refund, order #30345

// Matches "$32.00", "$32", "US$32", "32.00" — but not order numbers (#30345) or sizes.
const MONEY_RE = /(?:US?\$|CA\$|\$)\s?\d[\d,]*(?:\.\d{2})?|\b\d+\.\d{2}\b/;

function fail(msg) { console.error('  ✗ ' + msg); process.exitCode = 1; }
function pass(msg) { console.log('  ✓ ' + msg); }

(async () => {
  console.log(`Loading ticket ${TICKET_ID} from Gorgias...`);
  const msgs = await gorgias.getTicketMessages(TICKET_ID);

  const jamieIdx = msgs.findIndex(m => {
    if (!m.from_agent || m.channel === 'internal-note') return false;
    if (m.sender?.email?.endsWith('@email.gorgias.com') || m.via === 'rule') return false;
    const body = gorgias.stripHtml(m.stripped_text || m.body_text || '');
    if (/I'll escalat|team will|get back to you|created with AI|to the (right|appropriate) team/i.test(body)) return false;
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
  const issueDescription = parts.join('\n\n');
  if (!customerEmail) { fail('could not extract customer email from ticket'); return; }

  console.log(`Customer: ${customerEmail}`);
  console.log('Running advisor...');

  const result = await aiAdvisor({
    customer_email: customerEmail,
    issue_description: issueDescription,
  });

  const s = result?._structured || {};
  const draft = (s._composedResponse || '').trim();
  const actionType = s.action_type || null;
  const summary = s.operator_action_summary || null;

  console.log('');
  console.log('Saved draft:\n---\n' + draft + '\n---');
  console.log(`action_type: ${actionType}`);
  console.log(`operator_action_summary: ${summary}`);
  console.log('');

  // Assertion 1: refund path reproduced
  if (actionType === 'refund') {
    pass('refund path exercised (action_type === "refund")');
  } else {
    fail(`refund path not reproduced this run (action_type === ${JSON.stringify(actionType)}) — cannot test the no-amount rule. Re-run; if this persists the anchor ticket's context may have drifted.`);
    return;
  }

  // Assertion 2: no dollar amount in customer-facing draft
  const draftAmt = draft.match(MONEY_RE);
  if (!draftAmt) pass('customer-facing draft contains no dollar amount');
  else fail(`draft states a dollar amount (${draftAmt[0]}) — should say "you'll get a confirmation email with the details" instead`);

  // Assertion 3: operator_action_summary populated, names item, no amount
  if (!summary) {
    fail('operator_action_summary is empty on a ready refund');
  } else {
    const sumAmt = summary.match(MONEY_RE);
    if (sumAmt) fail(`operator_action_summary states a dollar amount (${sumAmt[0]}) — should name the order + items only`);
    else pass('operator_action_summary has no dollar amount');
    if (/sassy/i.test(summary)) pass('operator_action_summary names the item');
    else fail(`operator_action_summary does not name the item being refunded: ${JSON.stringify(summary)}`);
  }

  console.log('');
  console.log(process.exitCode === 1 ? 'FAILED — see assertions above.' : 'PASSED');
})().catch(e => { console.error(e); process.exit(1); });
