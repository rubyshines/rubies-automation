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
const { getProductNickname, pluralizeNickname, getSizeList, classifyProduct, getAdjacentSizes, getCumulativeDelta, KID_LABELS } = require('../sizingEngine');
const { normalizeSize, extractSizeFromSku } = require('../sizeUtils');
// responseComposer no longer needed — AI advisor composes its own responses

// Import the AI advisor
const { aiAdvisor } = require('../aiAdvisor');

// ---------------------------------------------------------------------------
// Tool handler
// ---------------------------------------------------------------------------

async function handleTestConversation({ customer_email, messages, order_number }) {
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
      const result = await aiAdvisor({
        customer_email,
        issue_description: customerMsg,
        order_number: order_number || undefined,
        intake,
      });

      s = result?._structured;

      // Shipping/non-exchange responses have a different structure — handle directly
      if (s && !s.intake && (s.results || s.status === 'route_to_human' || s.status === 'complete' || s.error)) {
        const agentText = result._composedResponse || result.draft || s.results?.[0]?.summary || '(No response)';
        const cleanResponse = agentText;
        conversationLog.push({ messageNum: i + 1, customer: customerMsg, agent: cleanResponse, status: s.status || 'complete', _structured: s, items: [], name: null, pronouns: null, flags: [] });
        continue;
      }

      if (s) intake = s.intake;

      // Populate header from first advisor call (uses the actual order the advisor resolved)
      if (i === 0 && s) {
        const c = s.customer;
        customerInfo = `${c.email || customer_email} | ${c.country || '?'}`;
        if (c.address) {
          const a = c.address;
          customerInfo += `\nAddress: ${[a.address1, a.address2, a.city, a.province, a.zip, a.country].filter(Boolean).join(', ')}`;
        }
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

    const agentResponse = result?._composedResponse || result?.draft || '(No response composed)';

    conversationLog.push({
      messageNum: i + 1,
      customer: customerMsg,
      agent: agentResponse,
      status: s.status,
      _structured: s,
      items: (s.intake?.items || []).map(it => ({
        product: it.product,
        size: it.size,
        issue: it.issue,
        resolved_size: it.resolved_size,
        desired_size: it.desired_size,
      })),
      name: s.customer?.name,
      pronouns: s.customer?.pronouns,
      flags: s.prescription?.flags,
    });
  }

  // Build the simulated exchange order
  // Capture customer address from last structured result
  let customerAddress = null;
  if (conversationLog.length > 0) {
    const lastS = conversationLog[conversationLog.length - 1]._structured;
    if (lastS?.customer?.address) customerAddress = lastS.customer.address;
  }

  // Use the last structured status (from tree), not intake.status (pre-tree)
  const lastStructuredStatus = conversationLog.length > 0 ? conversationLog[conversationLog.length - 1].status : null;
  // Get order items from last structured result for quantity lookup
  let orderItems = [];
  if (conversationLog.length > 0) {
    const lastS = conversationLog[conversationLog.length - 1]._structured;
    if (lastS?.order?.items) orderItems = lastS.order.items;
  }

  let orderSimulation = null;
  if (lastStructuredStatus === 'ready') {
    const resolvedItems = (intake.items || []).filter(i => i.resolved_size);
    if (resolvedItems.length > 0) {
      orderSimulation = {
        customer: customer_email,
        name: intake.name,
        tags: ['exchange', 'cs-mcp'],
        address: customerAddress,
        items: resolvedItems.flatMap(i => {
          // Expand by color: if _orderColors has multiple colors, create one line per color
          if (i._orderColors && i._orderColors.length > 1) {
            return i._orderColors.map(color => ({
              product: i.resolved_product || i.product,
              from_product: i.resolved_product ? i.product : null,
              from_size: i.size,
              to_size: i.resolved_size,
              color,
              quantity: 1,
            }));
          }
          // Single item or no color info — use _orderQty or sum from order line items
          let qty = i._orderQty || 0;
          if (!qty) {
            const prodLower = (i.product || '').toLowerCase();
            const itemSize = i.size ? normalizeSize(i.size) : null;
            for (const oi of orderItems) {
              if (oi.title?.toLowerCase().includes(prodLower.split(' ')[0])) {
                const oiSkuSize = extractSizeFromSku(oi.sku).normalized;
                if (itemSize && oiSkuSize && oiSkuSize !== itemSize) continue;
                qty += oi.quantity;
              }
            }
          }
          return [{
            product: i.resolved_product || i.product,
            from_product: i.resolved_product ? i.product : null,
            from_size: i.size,
            to_size: i.resolved_size,
            color: i._orderColors?.[0] || i.color,
            quantity: qty || 1,
          }];
        }),
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

  // Check for refund and exchange resolutions
  let hasRefunds = false;
  let refundItems = [];
  if (conversationLog.length > 0) {
    const lastS = conversationLog[conversationLog.length - 1]._structured;
    const refundPrescriptions = (lastS?.prescription?.items || []).filter(i => i.state === 'REFUND_CONFIRMED');
    if (refundPrescriptions.length > 0) {
      hasRefunds = true;
      // Only show refunded items, not all items
      refundItems = (intake?.items || []).filter(ii => {
        const matchingPrescription = refundPrescriptions.find(rp => rp.product === ii.product);
        return matchingPrescription && !ii.resolved_size;
      });
      // Fallback: if no matches by product name, use items with refund_request issue
      if (refundItems.length === 0) {
        refundItems = (intake?.items || []).filter(ii => ii.issue === 'refund_request' || ii.issue === 'none');
      }
    }
  }
  const hasExchanges = orderSimulation && orderSimulation.items.length > 0;

  // ── SECTION C: RESOLUTION ──
  md += '## C. Resolution\n\n';
  if (hasExchanges || hasRefunds) {
    const statuses = [];
    if (hasExchanges) statuses.push('EXCHANGE ORDER CREATED');
    if (hasRefunds) statuses.push('REFUND PROCESSED');
    md += `Status: ${statuses.join(' + ')} (simulation)\n`;
    md += `Customer: ${customer_email}${intake?.name ? ' (' + intake.name + ')' : ''}\n`;
    if (hasExchanges && orderSimulation.address) {
      const a = orderSimulation.address;
      md += `Ship to: ${[a.address1, a.address2, a.city, a.province, a.zip, a.country].filter(Boolean).join(', ')}\n`;
    }
    md += '\n';
    if (hasExchanges) {
      for (const item of orderSimulation.items) {
        const productChange = item.from_product ? ` (was: ${item.from_product})` : '';
        const sizeChange = item.from_size !== item.to_size ? ` (was: ${item.from_size})` : '';
        md += `  Exchange: ${item.quantity}x ${item.product}${productChange} — ${item.color || 'same color'} / ${item.to_size}${sizeChange} — $0.00\n`;
      }
    }
    if (hasRefunds) {
      for (const item of refundItems) {
        const nick = getProductNickname(item.product);
        md += `  Refund: ${nick} — ${item.color || 'original color'} / ${item.size || '?'}\n`;
      }
    }
    if (hasExchanges) {
      md += `\nShipping: Free\n`;
    }
    md += '\n';
  } else if (orderSimulation) {
    md += `Status: EXCHANGE ORDER CREATED (simulation)\n`;
    md += `Customer: ${orderSimulation.customer}${orderSimulation.name ? ' (' + orderSimulation.name + ')' : ''}\n`;
    if (orderSimulation.address) {
      const a = orderSimulation.address;
      md += `Ship to: ${[a.address1, a.address2, a.city, a.province, a.zip, a.country].filter(Boolean).join(', ')}\n`;
    }
    md += '\n';
    for (const item of orderSimulation.items) {
      const productChange = item.from_product ? ` (was: ${item.from_product})` : '';
      const sizeChange = item.from_size !== item.to_size ? ` (was: ${item.from_size})` : '';
      md += `  ${item.quantity}x ${item.product}${productChange} — ${item.color || 'same color'} / ${item.to_size}${sizeChange} — $0.00 exchange\n`;
    }
    md += `\nShipping: Free\n`;
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

const testerDescription = [
  'Simulate a multi-message CS conversation. Provide a customer email and an array of customer messages.',
  'Shows the full conversation: customer info, order context, each message/response pair, intake state,',
  'and the exchange order that WOULD be created (simulation only — no real orders created).',
  'Handles exchanges, refunds, defects, and pre-purchase sizing inquiries.',
].join(' ');

const testerSchema = {
  type: 'object',
  properties: {
    customer_email: { type: 'string', description: 'Real customer email from Shopify (used to pull order context)' },
    messages: {
      type: 'array',
      description: 'Array of customer messages in order, e.g. ["the AJ is too tight", "yes size 14 please — Sarah"]',
      items: { type: 'string' },
    },
    order_number: { type: 'string', description: 'Optional order number to target (e.g. "28774"). If omitted, uses most recent fulfilled order.' },
  },
  required: ['customer_email', 'messages'],
};

const tools = [
  { name: 'test_cs_conversation', description: testerDescription, inputSchema: testerSchema, handler: handleTestConversation },
  { name: 'test_exchange_conversation', description: testerDescription + ' (Alias for test_cs_conversation)', inputSchema: testerSchema, handler: handleTestConversation },
];

module.exports = tools;
