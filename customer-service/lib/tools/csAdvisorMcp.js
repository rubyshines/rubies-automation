/**
 * CS Advisor MCP Tools
 *
 * Thin MCP wrappers around the AI advisor (hybridAdvisor → aiAdvisor).
 * Provides cs_advisor and exchange_advisor tool names for MCP client compatibility.
 * Also includes log_donation_routing (standalone, not advisor-dependent).
 */

const { logDonationRouting } = require('../donationRouting');

// Lazy-load to avoid circular deps
let _hybridAdvisor = null;
function getAdvisor() {
  if (!_hybridAdvisor) {
    _hybridAdvisor = require('../aiAdvisor').aiAdvisor;
  }
  return _hybridAdvisor;
}

async function handleCsAdvisor({ customer_email, issue_description, order_number, intake, reference_date }) {
  const advisor = getAdvisor();
  const result = await advisor({
    customer_email,
    issue_description,
    order_number: order_number || undefined,
    intake: intake || undefined,
    reference_date: reference_date || undefined,
  });

  const s = result?._structured;
  const draft = result?._composedResponse || result?.draft || '';

  // MCP format
  let md = `## CS Advisor\n\n`;
  md += `**Status:** ${s?.status || 'unknown'}\n`;
  if (s?.message_type) md += `**Type:** ${s.message_type}\n`;
  if (s?.confidence) md += `**Confidence:** ${s.confidence}\n`;
  md += `\n**Draft Response:**\n${draft}\n`;
  if (s?.audit?.length) {
    md += `\n**Audit:**\n`;
    for (const a of s.audit) md += `- ${a}\n`;
  }

  return { content: [{ type: 'text', text: md }], _structured: s };
}

async function handleLogDonationRouting({ customer_email, order_number, partner_id, items_count, routing_type }) {
  await logDonationRouting({
    customer_email,
    order_number,
    partner_id,
    items_count,
    routing_type: routing_type || 'partner',
  });
  return {
    content: [{ type: 'text', text: `## Donation Routing Logged\n\n**Customer:** ${customer_email}\n**Order:** ${order_number || 'N/A'}\n**Items:** ${items_count || 1}\n**Type:** ${routing_type}\n${partner_id ? '**Partner ID:** ' + partner_id + '\n' : ''}` }],
  };
}

const csAdvisorDescription = [
  'Customer service advisor — call this on EVERY customer message.',
  'Handles: exchanges, refunds, defects, pre-purchase sizing, shipping, order modifications, and general inquiries.',
  'Returns structured guidance + a draft response.',
].join(' ');

const csAdvisorSchema = {
  type: 'object',
  properties: {
    customer_email: { type: 'string', description: 'Customer email address (used to find customer and orders)' },
    issue_description: { type: 'string', description: "The customer's LATEST message (not the full conversation — just the new message)" },
    order_number: { type: 'string', description: 'Optional order number. If omitted, auto-detects from message or uses most recent fulfilled order.' },
    intake: { type: 'object', description: 'The intake JSON from the previous call. Pass this back to accumulate state across messages. Omit on first call.' },
    reference_date: { type: 'string', description: 'ISO date string for time-sensitive logic (order age windows). Defaults to now.' },
  },
  required: ['customer_email'],
};

const tools = [
  {
    name: 'cs_advisor',
    description: csAdvisorDescription,
    inputSchema: csAdvisorSchema,
    handler: handleCsAdvisor,
  },
  {
    name: 'exchange_advisor',
    description: csAdvisorDescription + ' (Alias for cs_advisor)',
    inputSchema: csAdvisorSchema,
    handler: handleCsAdvisor,
  },
  {
    name: 'log_donation_routing',
    description: 'Log a donation routing after an exchange is processed. Tracks which partner was recommended and increments their counter for load-balancing.',
    inputSchema: {
      type: 'object',
      properties: {
        customer_email: { type: 'string', description: 'Customer email address' },
        order_number: { type: 'string', description: 'Order number associated with this exchange' },
        partner_id: { type: 'number', description: 'Donation partner ID (from donation_partners table). Omit for local donations.' },
        items_count: { type: 'number', description: 'Number of items being donated (default: 1)' },
        routing_type: { type: 'string', description: 'Routing type: "partner" (sent to partner org), "local_single" (1 item, donate locally), "local_no_partner" (no partner in country)' },
      },
      required: ['customer_email', 'routing_type'],
    },
    handler: handleLogDonationRouting,
  },
];

module.exports = tools;
