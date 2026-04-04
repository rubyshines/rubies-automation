/**
 * Run a single conversation through the hybrid advisor and show results.
 * Usage: node customer-service/test/runOneConvo.js <ticketId> [orderNumber]
 */
require('dotenv').config();
const gorgias = require('../import/gorgiasClient');
const { hybridAdvisor } = require('../lib/hybridAdvisor');

const ticketId = process.argv[2];
const orderOverride = process.argv[3];
if (!ticketId) { console.log('Usage: node runOneConvo.js <ticketId> [orderNumber]'); process.exit(1); }

(async () => {
  const msgs = await gorgias.getTicketMessages(ticketId);

  // Find first real Jamie reply
  const jamieIdx = msgs.findIndex(m => {
    if (!m.from_agent || m.channel === 'internal-note') return false;
    if (m.sender?.email?.endsWith('@email.gorgias.com') || m.via === 'rule') return false;
    const body = gorgias.stripHtml(m.stripped_text || m.body_text || '');
    if (/I'll escalat|team will|get back to you|created with AI|to the (right|appropriate) team/i.test(body)) return false;
    return /Jamie Alexander/i.test(body);
  });

  // Build customer context (everything before Jamie's reply)
  const endIdx = jamieIdx >= 0 ? jamieIdx : msgs.length;
  const parts = [];
  for (let i = 0; i < endIdx; i++) {
    const m = msgs[i];
    if (m.channel === 'internal-note') continue;
    const body = gorgias.stripHtml(m.stripped_text || m.body_text || '').trim();
    if (!body) continue;
    if (!m.from_agent) parts.push(body);
    else if (m.sender?.email?.endsWith('@email.gorgias.com') || m.via === 'rule') parts.push('[Bot]: ' + body);
  }
  const fullContext = parts.join('\n\n');

  // Extract order number from context
  const orderMatch = fullContext.match(/#(\d{4,6})/);
  const orderNumber = orderOverride || (orderMatch ? orderMatch[1] : null);

  // Get customer email
  const custMsg = msgs.find(m => !m.from_agent);
  const email = custMsg?.sender?.email || msgs[0]?.customer?.email || 'unknown';

  console.log('CUSTOMER:');
  console.log(fullContext.substring(0, 500));
  if (fullContext.length > 500) console.log('...(truncated)');
  console.log('');

  // Run hybrid
  const result = await hybridAdvisor({
    customer_email: email,
    issue_description: fullContext,
    order_number: orderNumber,
  });

  console.log('OPUS:');
  console.log(result._structured?._composedResponse || '(none)');
  console.log('');

  if (jamieIdx >= 0) {
    const jamieText = gorgias.stripHtml(msgs[jamieIdx].stripped_text || msgs[jamieIdx].body_text || '');
    console.log('JAMIE:');
    console.log(jamieText.substring(0, 500));
  }
})();
