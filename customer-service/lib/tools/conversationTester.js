/**
 * Conversation Tester MCP Tool
 *
 * Simulates a multi-message exchange conversation and shows clean output:
 * customer info, order context, each message/response pair, and the
 * exchange order that would be created.
 *
 * Does NOT create any real orders — simulation only.
 *
 * Tools: test_exchange_conversation
 */

const { getSupabaseClient } = require('../../../shared/supabaseClient');
const { searchCustomers, getCustomerOrders } = require('../shopify');
const { searchProducts } = require('../productCache');

// Import the advisor handler
const advisorTools = require('./exchangeAdvisor');
const advisorHandler = advisorTools.find(t => t.name === 'exchange_advisor').handler;

// ---------------------------------------------------------------------------
// Tool: test_exchange_conversation
// ---------------------------------------------------------------------------

async function handleTestConversation({ customer_email, messages }) {
  if (!customer_email || !messages || messages.length === 0) {
    return { content: [{ type: 'text', text: 'Error: provide customer_email and messages array (e.g., ["the AJ is too tight", "yes size 14 please"])' }] };
  }

  // 1. Get customer + order context for display
  let customerInfo = '';
  let orderInfo = '';
  try {
    const customers = await searchCustomers(customer_email);
    if (customers.length > 0) {
      const c = customers[0];
      const country = c.defaultAddress?.countryCodeV2 || c.defaultAddress?.country || '?';
      customerInfo = `${customer_email} | ${country}`;

      const { orders } = await getCustomerOrders(c.id, 10);
      const fulfilled = orders.filter(o =>
        o.displayFulfillmentStatus === 'FULFILLED' && !o.cancelledAt && o.displayFinancialStatus !== 'REFUNDED'
      );

      if (fulfilled.length > 0) {
        const order = fulfilled[0];
        orderInfo = `**Order ${order.name}** (${order.createdAt?.split('T')[0]}):\n`;
        for (const li of (order.lineItems || [])) {
          orderInfo += `  ${li.quantity}x ${li.title} — ${li.variantTitle}\n`;
        }
      } else {
        orderInfo = 'No fulfilled orders found.';
      }
    } else {
      customerInfo = `${customer_email} (not found in Shopify)`;
    }
  } catch (e) {
    customerInfo = `${customer_email} (error: ${e.message})`;
  }

  // 2. Walk through messages, accumulating intake
  let intake = null;
  const conversationLog = [];

  for (let i = 0; i < messages.length; i++) {
    const customerMsg = messages[i];

    let advisorResult;
    try {
      advisorResult = await advisorHandler({
        customer_email,
        issue_description: customerMsg,
        intake,
      });
    } catch (e) {
      conversationLog.push({
        messageNum: i + 1,
        customer: customerMsg,
        agent: `(Error: ${e.message})`,
        status: 'error',
      });
      continue;
    }

    const advisorText = advisorResult?.content?.[0]?.text || '';

    // Extract intake JSON for next round
    const intakeMatch = advisorText.match(/```json\n([\s\S]*?)\n```/);
    if (intakeMatch) {
      try { intake = JSON.parse(intakeMatch[1]); } catch (e) { /* keep previous */ }
    }

    const name = intake?.name || null;
    const pronouns = intake?.pronouns || 'they/them';
    const resolvedItems = (intake?.items || []).filter(it => it.resolved_size);
    const allResolved = intake?.items?.length > 0 && intake.items.every(it => it.resolved_size);
    const hasItems = intake?.items?.length > 0;
    const needsInfo = hasItems && !allResolved;

    // Extract donation text from advisor output
    const donationMatch = advisorText.match(/\*\*Donation:\*\*\s*([\s\S]*?)(?=\n\n\*\*|\n\*\*Voice|$)/);
    const donation = donationMatch ? donationMatch[1].trim() : null;

    // Extract per-item action text
    const itemActionMatch = advisorText.match(/\*\*For the [^:]+:\*\*\s*(.*?)(?=\n\n|\n\*\*|$)/);
    const itemAction = itemActionMatch ? itemActionMatch[1].trim() : null;

    // Build clean agent response
    let agentResponse = '';
    const greeting = name ? `Thanks ${name}! ` : 'Hi! ';

    if (allResolved && resolvedItems.length > 0) {
      // Order ready — compose the confirmation message
      const systemPickedSize = resolvedItems.some(it => !it.desired_size && it.resolved_size);

      if (systemPickedSize) {
        const desc = resolvedItems.map(it => `a ${it.product} in size ${it.resolved_size}`).join(' and ');
        agentResponse = greeting + `I've gone ahead and created a new order for ${desc}.`;
      } else {
        agentResponse = greeting + `I've gone ahead and created an exchange order for you.`;
      }

      // Donation
      if (donation) {
        agentResponse += '\n\n' + donation;
      }

      // Closing
      const desc = resolvedItems.map(it => `${it.product} in ${it.resolved_size}`).join(' and ');
      agentResponse += `\n\nYour new ${desc} is on its way!`;

    } else if (needsInfo && itemAction) {
      agentResponse = greeting + itemAction;
    } else if (!hasItems) {
      agentResponse = greeting + 'Can you let me know what didn\'t work out?';
    } else {
      // Fallback — use the advisor recommendation section
      const recMatch = advisorText.match(/### [^\n]+ Recommended Response\n\n([\s\S]*?)(?=---\n\n### Audit|$)/);
      const recommendation = recMatch ? recMatch[1].trim() : '';
      agentResponse = recommendation.replace(/\*\*/g, '').replace(/\n\n/g, '\n').slice(0, 500);
    }

    conversationLog.push({
      messageNum: i + 1,
      customer: customerMsg,
      agent: agentResponse,
      status,
      intake_summary: {
        name: intake?.name,
        pronouns: intake?.pronouns,
        buying_for: intake?.buying_for,
        items: (intake?.items || []).map(it => ({
          product: it.product,
          size: it.size,
          issue: it.issue,
          resolved_size: it.resolved_size,
        })),
      },
    });
  }

  // 3. Build the exchange order that WOULD be created (simulation only)
  let orderSimulation = null;
  if (intake?.status === 'ready') {
    const resolvedItems = (intake.items || []).filter(it => it.resolved_size);
    if (resolvedItems.length > 0) {
      orderSimulation = {
        type: 'exchange',
        customer: customer_email,
        name: intake.name || null,
        tags: ['exchange', 'cs-mcp'],
        items: resolvedItems.map(it => ({
          product: it.product,
          from_size: it.size,
          to_size: it.resolved_size,
          color: it.color || null,
        })),
        discount: '100% (exchange)',
        shipping: 'Free ($0.00)',
        total: '$0.00',
      };
    }
  }

  // 4. Format output
  let md = '## Exchange Conversation Test (Simulation)\n\n';
  md += `**Customer:** ${customerInfo}\n`;
  md += `${orderInfo}\n`;
  md += '---\n\n';

  for (const entry of conversationLog) {
    md += `**Message ${entry.messageNum} — Customer:**\n`;
    md += `> ${entry.customer}\n\n`;
    md += `**Message ${entry.messageNum} — AI Agent** (status: ${entry.status}):\n`;
    md += `> ${entry.agent.replace(/\n/g, '\n> ')}\n\n`;

    // Show what the intake looks like after this message
    if (entry.intake_summary.items.length > 0) {
      md += `_Intake: ${entry.intake_summary.items.map(it => `${it.product || '?'} ${it.size || '?'}${it.resolved_size ? ' → ' + it.resolved_size : ''} (${it.issue || '?'})`).join(', ')}`;
      if (entry.intake_summary.name) md += ` | name: ${entry.intake_summary.name}`;
      md += `_\n\n`;
    }
    md += '---\n\n';
  }

  // Show the order that would be created
  if (orderSimulation) {
    md += `## Exchange Order (SIMULATION — not created)\n\n`;
    md += `**Customer:** ${orderSimulation.customer}${orderSimulation.name ? ' (' + orderSimulation.name + ')' : ''}\n`;
    md += `**Tags:** ${orderSimulation.tags.join(', ')}\n\n`;
    md += `**Line items:**\n`;
    for (const item of orderSimulation.items) {
      md += `  ${item.product} — ${item.color || 'same color'} / ${item.to_size}\n`;
      md += `  _(was: ${item.from_size} → now: ${item.to_size})_\n`;
      md += `  Discount: Exchange (100% off) — $0.00\n\n`;
    }
    md += `**Shipping:** Free ($0.00)\n`;
    md += `**Total:** $0.00\n`;
  } else if (intake?.status !== 'ready') {
    md += `## No Exchange Order\n\n`;
    md += `Conversation not yet resolved. Status: ${intake?.status || 'unknown'}\n`;
    md += `Still needed: ${(intake?.items || []).filter(it => !it.resolved_size).map(it => `size confirmation for ${it.product || 'item'}`).join(', ') || 'more information'}\n`;
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
        customer_email: {
          type: 'string',
          description: 'Real customer email from Shopify (used to pull order context)',
        },
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
