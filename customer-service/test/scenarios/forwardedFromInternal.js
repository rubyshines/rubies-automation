/**
 * Forwarded-from-internal scenario.
 *
 * Anchored on a real ticket where a customer emailed support@rubyshines.com, Jamie
 * forwarded it into care@ (Gorgias native intake), and Gorgias made the FORWARDER
 * (support@rubyshines.com) the ticket requester. Before the prompt rule, the advisor
 * addressed its reply to the internal forwarder, so the reply went back to Jamie
 * instead of the real customer (christian.treubert@posteo.de, shown in the forwarded
 * "From:" header inside the body).
 *
 * The rule (advisor prompt, "## EMAIL & CUSTOMER SCENARIOS" → "Forwarded to us by
 * RUBIES staff"): when the conversation sender is an internal @rubyshines.com address
 * and the body is a forwarded customer email, the real customer is the original
 * external sender. The advisor sets forwarded_sender_email to that address, and the
 * returned customer.email is overridden to it (which the intake uses to re-point the
 * Gorgias ticket requester).
 *
 * Asserts:
 *   1. forwarded_sender_email is the original external sender (christian...@posteo.de)
 *   2. customer.email is overridden to that sender, not the internal forwarder
 *   3. the customer-facing draft does not greet the internal staff address
 *
 * Usage: node customer-service/test/scenarios/forwardedFromInternal.js
 */
require('dotenv').config();
const gorgias = require('../../import/gorgiasClient');
const { aiAdvisor } = require('../../lib/aiAdvisor');

const TICKET_ID = '105868549'; // "Packaging" — forwarded by support@ into care@
const EXPECTED_SENDER = 'christian.treubert@posteo.de';

function fail(msg) { console.error('  ✗ ' + msg); process.exitCode = 1; }
function pass(msg) { console.log('  ✓ ' + msg); }

(async () => {
  console.log(`Loading ticket ${TICKET_ID} from Gorgias...`);
  const msgs = await gorgias.getTicketMessages(TICKET_ID);

  // Reconstruct the customer (forwarded) message + the requester email Gorgias assigned.
  const parts = [];
  let customerEmail = null;
  for (const m of msgs) {
    if (m.channel === 'internal-note') continue;
    if (m.from_agent) continue; // only the inbound/forwarded customer message
    const body = gorgias.stripHtml(m.stripped_text || m.body_text || '').trim();
    if (!body) continue;
    parts.push(body);
    if (!customerEmail) customerEmail = m.sender?.email || null;
  }
  const issueDescription = parts.join('\n\n');
  if (!customerEmail) { fail('could not extract requester email from ticket'); return; }

  console.log(`Requester (forwarder) email: ${customerEmail}`);
  if (!/@rubyshines\.com$/i.test(customerEmail)) {
    fail(`anchor ticket requester is not internal (${customerEmail}) — context may have drifted; cannot test the forward rule`);
    return;
  }

  console.log('Running advisor...');
  const result = await aiAdvisor({
    customer_email: customerEmail,
    issue_description: issueDescription,
  });

  const s = result?._structured || {};
  const draft = (s._composedResponse || '').trim();
  const fwd = s.forwarded_sender_email || null;
  const resolvedEmail = s.customer?.email || null;

  console.log('');
  console.log(`forwarded_sender_email: ${fwd}`);
  console.log(`customer.email: ${resolvedEmail}`);
  console.log('Saved draft:\n---\n' + draft + '\n---');
  console.log('');

  // Assertion 1: forwarded_sender_email is the original external sender
  if (fwd && fwd.toLowerCase() === EXPECTED_SENDER) pass(`forwarded_sender_email is the original sender (${fwd})`);
  else fail(`forwarded_sender_email is ${JSON.stringify(fwd)} — expected ${EXPECTED_SENDER}`);

  // Assertion 2: customer.email overridden to the original sender (drives the redirect)
  if (resolvedEmail && resolvedEmail.toLowerCase() === EXPECTED_SENDER) pass('customer.email overridden to the original sender');
  else fail(`customer.email is ${JSON.stringify(resolvedEmail)} — expected ${EXPECTED_SENDER}, not the internal forwarder`);

  // Assertion 3: draft does not address the internal staff forwarder
  if (/\b(hi|hello|hey|dear)\s+(jamie|support|care|team)\b/i.test(draft)) {
    fail('draft greets the internal forwarder (e.g. "Hi Jamie") instead of the customer');
  } else {
    pass('draft does not greet the internal forwarder');
  }

  console.log('');
  console.log(process.exitCode === 1 ? 'FAILED — see assertions above.' : 'PASSED');
})().catch(e => { console.error(e); process.exit(1); });
