/**
 * Conversation Tester MCP Tool
 *
 * Simulates a multi-message exchange conversation. Shows clean output:
 * customer info, order context, each message/response pair, and the
 * exchange order that would be created.
 *
 * Consumes _structured data from the exchange advisor — NO regex parsing.
 * Does NOT create any real orders — simulation only.
 *
 * Tool: test_exchange_conversation
 */

const { searchCustomers, getCustomerOrders } = require('../shopify');
const { getProductNickname } = require('../decisionTree');

// Import the advisor handler
const advisorTools = require('./exchangeAdvisor');
const advisorHandler = advisorTools.find(t => t.name === 'exchange_advisor').handler;

// ---------------------------------------------------------------------------
// Response composer — builds agent response from structured data
// ---------------------------------------------------------------------------

function composeAgentResponse(s) {
  const greeting = s.customer.name ? `Thanks ${s.customer.name}! ` : 'Hi! ';
  const items = s.prescription.items;
  const resolvedItems = (s.intake.items || []).filter(i => i.resolved_size);

  // Safety override
  if (s.status === 'safety_override') {
    return 'We\'ll process a refund for you right away. No questions asked. We hope your situation improves.';
  }

  // Ready — order can be created
  if (s.status === 'ready' && resolvedItems.length > 0) {
    const systemPickedSize = resolvedItems.some(i => !i.desired_size && i.resolved_size);

    let response;
    if (systemPickedSize) {
      const desc = resolvedItems.map(i => `a ${getProductNickname(i.product)} in size ${i.resolved_size}`).join(' and ');
      response = greeting + `I've gone ahead and created a new order for ${desc}.`;
    } else {
      response = greeting + `I've gone ahead and created an exchange order for you.`;
    }

    // Crossover note (youth→adult or vice versa)
    if (s.prescription.crossover_note) {
      response += '\n\n' + s.prescription.crossover_note;
    }

    // Donation
    if (s.prescription.donation?.text) {
      response += '\n\n' + s.prescription.donation.text;
    }

    return response;
  }

  // Needs info — use the tree's per-item response text
  if (s.status === 'needs_info' && items.length > 0) {
    const actionTexts = items.filter(i => i.response_text).map(i => i.response_text);
    if (actionTexts.length > 0) {
      return greeting + actionTexts.join(' ');
    }
  }

  // Gathering — don't know what they want yet
  if (s.status === 'gathering' || !items.length) {
    return greeting + "Can you let me know what didn't work out?";
  }

  // Fallback
  return greeting + (s.prescription.still_needed.length > 0
    ? 'Could you provide: ' + s.prescription.still_needed.join(', ') + '?'
    : "I'd be happy to help — can you tell me more?");
}

// ---------------------------------------------------------------------------
// Tool handler
// ---------------------------------------------------------------------------

async function handleTestConversation({ customer_email, messages }) {
  if (!customer_email || !messages || messages.length === 0) {
    return { content: [{ type: 'text', text: 'Error: provide customer_email and messages array' }] };
  }

  // Customer/order info populated from first advisor call's _structured result
  let customerInfo = customer_email;
  let orderInfo = '';

  // Walk through messages, accumulating intake via _structured
  let intake = null;
  const conversationLog = [];

  for (let i = 0; i < messages.length; i++) {
    const customerMsg = messages[i];
    let s = null;

    try {
      const result = await advisorHandler({
        customer_email,
        issue_description: customerMsg,
        intake,
      });

      s = result._structured;
      if (s) intake = s.intake;

      // Populate header from first advisor call (uses the actual order the advisor resolved)
      if (i === 0 && s) {
        const c = s.customer;
        customerInfo = `${c.email || customer_email} | ${c.country || '?'}`;
        if (s.order) {
          orderInfo = `Order ${s.order.name} (${s.order.date}):\n`;
          for (const li of s.order.items) {
            orderInfo += `  ${li.quantity}x ${li.title} — ${li.variant} (SKU: ${li.sku || 'n/a'})\n`;
          }
        }
      }
    } catch (e) {
      conversationLog.push({ messageNum: i + 1, customer: customerMsg, agent: `(Error: ${e.message})`, status: 'error' });
      continue;
    }

    if (!s) {
      conversationLog.push({ messageNum: i + 1, customer: customerMsg, agent: '(No structured response)', status: 'error' });
      continue;
    }

    const agentResponse = composeAgentResponse(s);

    conversationLog.push({
      messageNum: i + 1,
      customer: customerMsg,
      agent: agentResponse,
      status: s.status,
      items: (s.intake.items || []).map(it => ({
        product: it.product,
        size: it.size,
        issue: it.issue,
        resolved_size: it.resolved_size,
        desired_size: it.desired_size,
      })),
      name: s.customer.name,
      pronouns: s.customer.pronouns,
      flags: s.prescription.flags,
    });
  }

  // Build the simulated exchange order
  // Use the last structured status (from tree), not intake.status (pre-tree)
  const lastStructuredStatus = conversationLog.length > 0 ? conversationLog[conversationLog.length - 1].status : null;
  let orderSimulation = null;
  if (lastStructuredStatus === 'ready') {
    const resolvedItems = (intake.items || []).filter(i => i.resolved_size);
    if (resolvedItems.length > 0) {
      orderSimulation = {
        customer: customer_email,
        name: intake.name,
        tags: ['exchange', 'cs-mcp'],
        items: resolvedItems.map(i => ({
          product: i.product,
          from_size: i.size,
          to_size: i.resolved_size,
          color: i.color,
        })),
      };
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // FORMAT OUTPUT — always three sections, deterministic, no AI
  // ═══════════════════════════════════════════════════════════════════

  let md = '';

  // ── SECTION A: ORIGINAL ORDER ──
  md += '## A. Original Order\n\n';
  md += `Customer: ${customerInfo}\n`;
  if (orderInfo) {
    md += orderInfo;
  } else {
    md += 'No fulfilled order found.\n';
  }
  md += '\n';

  // ── SECTION B: CONVERSATION ──
  md += '## B. Conversation\n\n';
  for (const entry of conversationLog) {
    md += `[Customer message ${entry.messageNum}]: ${entry.customer}\n\n`;
    md += `[AI agent response ${entry.messageNum}]: ${entry.agent}\n\n`;
    if (entry.flags?.length > 0) {
      for (const f of entry.flags) md += `[Flag]: ${f}\n`;
      md += '\n';
    }
  }

  // ── SECTION C: RESOLUTION ──
  md += '## C. Resolution\n\n';
  if (orderSimulation) {
    md += `Status: EXCHANGE ORDER CREATED (simulation)\n`;
    md += `Customer: ${orderSimulation.customer}${orderSimulation.name ? ' (' + orderSimulation.name + ')' : ''}\n\n`;
    for (const item of orderSimulation.items) {
      md += `${item.product} — ${item.color || 'same color'}\n`;
      md += `  Was: ${item.from_size}\n`;
      md += `  Now: ${item.to_size}\n`;
      md += `  Price: $0.00 (exchange)\n\n`;
    }
    md += `Shipping: Free\n`;
    md += `Total: $0.00\n`;
  } else {
    md += `Status: NOT RESOLVED\n`;
    if (conversationLog.length > 0) {
      const lastEntry = conversationLog[conversationLog.length - 1];
      md += `Current state: ${lastEntry.status}\n`;
      const unresolvedItems = (lastEntry.items || []).filter(i => !i.resolved_size);
      if (unresolvedItems.length > 0) {
        md += `Still needed: ${unresolvedItems.map(i => 'size confirmation for ' + (i.product || 'item')).join(', ')}\n`;
      }
    }
  }

  return { content: [{ type: 'text', text: md }] };
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

const tools = [
  {
    name: 'test_exchange_conversation',
    description: [
      'Simulate a multi-message exchange conversation. Provide a customer email and an array of customer messages.',
      'Shows the full conversation: customer info, order context, each message/response pair, intake state,',
      'and the exchange order that WOULD be created (simulation only — no real orders created).',
      'Use this to test and validate the exchange decision tree.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        customer_email: { type: 'string', description: 'Real customer email from Shopify (used to pull order context)' },
        messages: {
          type: 'array',
          description: 'Array of customer messages in order, e.g. ["the AJ is too tight", "yes size 14 please — Sarah"]',
          items: { type: 'string' },
        },
      },
      required: ['customer_email', 'messages'],
    },
    handler: handleTestConversation,
  },
];

module.exports = tools;
