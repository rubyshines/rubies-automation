/**
 * Donation-tool-required scenario.
 *
 * Anchored on a real two-item refund ticket (customer bought a Ruby bottom +
 * Mia top for their girlfriend, sensory issues, asked for a refund). The
 * advisor correctly counted two items but SKIPPED calling get_donation_partner
 * — its audit said the "single-vs-multi guidance covers it" — then recited the
 * routing from memory backwards, giving the single-item "feel free to donate
 * locally, I can send you partner info if you'd like" framing on a multi-item
 * return. Policy: more than one item always gets a partner address (defects
 * are the only exception); only the tool knows which partner.
 *
 * The rule (advisor prompt, anti-hallucination rule 1 + "When to mention
 * DONATION"): every donation sentence comes from a get_donation_partner call
 * made in this conversation; the reply's donation section is the tool's
 * response_text verbatim.
 *
 * Asserts (only when the refund path is actually reproduced this run):
 *   1. the refund path was exercised (action_type === 'refund')
 *   2. get_donation_partner was actually called during the tool loop
 *   3. the draft contains a partner mailing block (RUBIES Returns / c/o ...)
 *   4. the draft does NOT frame donation as optional ("if you'd like",
 *      "I can send you the info", "feel free to donate locally", "you're
 *      welcome to send", "no need to send anything back")
 *   5. the tool's ask line survives verbatim ("can you please send the items
 *      you are returning to") — 2026-07-24: production data showed 40/40
 *      partner-address drafts rewrote the tool copy, half into optional
 *      framing, the rest dropping the ask so the address floated with no ask
 *
 * Usage: node customer-service/test/scenarios/donationToolCall.js
 */
require('dotenv').config();
const gorgias = require('../../import/gorgiasClient');
const { aiAdvisor } = require('../../lib/aiAdvisor');

const TICKET_ID = '108597162'; // 1x Ruby L + 1x Mia M refund, order #32418

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
  const toolCalls = (s._timing?.api_calls || []).flatMap(c => c.tool_calls || []);

  console.log('');
  console.log('Saved draft:\n---\n' + draft + '\n---');
  console.log(`action_type: ${actionType}`);
  console.log(`tool calls: ${JSON.stringify(toolCalls)}`);
  console.log('');

  // Assertion 1: refund path reproduced
  if (actionType === 'refund') {
    pass('refund path exercised (action_type === "refund")');
  } else {
    fail(`refund path not reproduced this run (action_type === ${JSON.stringify(actionType)}) — cannot test the donation rule. Re-run; if this persists the anchor ticket's context may have drifted.`);
    return;
  }

  // Assertion 2: the routing tool was actually called
  if (toolCalls.includes('get_donation_partner')) {
    pass('get_donation_partner was called');
  } else {
    fail('get_donation_partner was NOT called — advisor wrote the donation section from memory');
  }

  // Assertion 3: multi-item return relays a partner mailing block
  if (/RUBIES Returns/i.test(draft) && /c\/o /i.test(draft)) {
    pass('draft contains a partner mailing block (RUBIES Returns / c/o ...)');
  } else {
    fail('draft has no partner mailing block — two-item returns must get a partner address, never local-donation framing');
  }

  // Assertion 4: donation is not framed as optional
  const optional = draft.match(/if you'?d like|I can send you (?:the )?info|feel free to donate|welcome to send|no need to send anything back|if you(?:'re| are) able|should you (?:wish|like)|totally optional/i);
  if (!optional) {
    pass('donation is not framed as optional');
  } else {
    fail(`draft frames donation as optional (${JSON.stringify(optional[0])}) — the tool's response_text should be relayed as-is`);
  }

  // Assertion 5: the tool's ask line survives verbatim
  if (/can you please send the items you are returning to/i.test(draft)) {
    pass('the ask line is relayed verbatim');
  } else {
    fail('the ask line ("can you please send the items you are returning to") is missing — the advisor rewrote or dropped the tool\'s ask');
  }

  console.log('');
  console.log(process.exitCode === 1 ? 'FAILED — see assertions above.' : 'PASSED');
})().catch(e => { console.error(e); process.exit(1); });
