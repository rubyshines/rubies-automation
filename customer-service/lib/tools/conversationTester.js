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
const { getProductNickname, pluralizeNickname, getSizeList } = require('../decisionTree');

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
  const isThirdParty = s.customer.buying_for === 'third_party';
  const thirdPartyLabel = s.customer.third_party_label || 'them';

  // "for her/him/them/your daughter" phrasing
  const forWhom = isThirdParty
    ? (thirdPartyLabel === 'daughter' || thirdPartyLabel === 'son' || thirdPartyLabel === 'kid' || thirdPartyLabel === 'kiddo'
      ? `for your ${thirdPartyLabel}` : `for ${thirdPartyLabel}`)
    : 'for you';

  // Positive feedback acknowledgment
  const hasFeedback = s.audit?.some(a => /positive feedback/i.test(a));
  let feedbackLine = '';
  if (hasFeedback && isThirdParty) {
    feedbackLine = `So lovely to hear you've been with RUBIES for so long! `;
  } else if (hasFeedback) {
    feedbackLine = `So glad you love RUBIES! `;
  }

  // Safety override
  if (s.status === 'safety_override') {
    return 'We\'ll process a refund for you right away. No questions asked. We hope your situation improves.';
  }

  // Refund confirmed
  const refundItems = items.filter(i => i.state === 'REFUND_CONFIRMED');
  if (refundItems.length > 0) {
    let response = greeting + refundItems[0].response_text;
    if (s.prescription.donation?.text) {
      response += '\n\n' + s.prescription.donation.text;
    }
    return response;
  }

  // Ready — order can be created
  if (s.status === 'ready' && resolvedItems.length > 0) {
    const orderItems = s.order?.items || [];

    // Build item description
    const desc = resolvedItems.map(i => {
      const displayProduct = i.resolved_product || i.product;
      const nick = getProductNickname(displayProduct);
      let qty = i._orderQty || 0;
      if (!qty) {
        const prodLower = (i.product || '').toLowerCase();
        for (const oi of orderItems) {
          if (oi.title?.toLowerCase().includes(prodLower.split(' ')[0])) {
            qty += oi.quantity;
          }
        }
      }
      qty = qty || 1;
      const name = pluralizeNickname(nick, qty);
      const article = /^[aeiou]/i.test(name) ? 'an' : 'a';
      return qty > 1 ? `${qty} ${name} in size ${i.resolved_size}` : `${article} ${name} in size ${i.resolved_size}`;
    }).join(' and ');

    // Build sizing explanation from audit trail
    let sizingExplanation = '';
    const deltaAudit = s.audit?.find(a => /auto-confirmed.*delta/i.test(a));
    if (deltaAudit) {
      const deltaMatch = deltaAudit.match(/(\d+)"\s*delta/);
      if (deltaMatch) {
        const inches = deltaMatch[1];
        sizingExplanation = ` Size ${resolvedItems[0].resolved_size} will be ${inches}" smaller overall which should give ${isThirdParty ? 'her' : 'you'} a snugger fit.`;
      }
    }

    // Build contextual opening based on direction and issue
    const firstItem = resolvedItems[0];
    const fromSize = firstItem.size;
    const toSize = firstItem.resolved_size;
    const sizeList = getSizeList(fromSize);
    const fromIdx = sizeList?.indexOf(fromSize) ?? -1;
    const toIdx = sizeList?.indexOf(toSize) ?? -1;
    const wentDown = toIdx < fromIdx;

    // Check if customer self-diagnosed (e.g. "shaping not working, too loose")
    const isSelfDiagnosed = s.prescription.items.some(i => i.self_diagnosed);

    let explanation;
    if (isSelfDiagnosed && wentDown) {
      explanation = `You're right, if it's too loose the shaping won't work as well. The next size down should work better.`;
    } else if (isSelfDiagnosed && !wentDown) {
      explanation = `You're right, if it's too tight the shaping won't sit comfortably. The next size up should work better.`;
    } else if (wentDown) {
      explanation = `Going one size down sounds right — the ${toSize} will be snugger overall which should give ${isThirdParty ? 'her' : 'you'} a better fit.`;
    } else {
      explanation = `The ${toSize} will give ${isThirdParty ? 'her' : 'you'} a bit more room which should be a better fit.`;
    }

    let response = greeting + feedbackLine + explanation;
    response += ` I've gone ahead and created a new exchange order for ${desc} ${forWhom}.`;

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

  // Needs info — use the tree's per-item response text + include multi-item flags
  if (s.status === 'needs_info' && items.length > 0) {
    const actionTexts = [...new Set(items.filter(i => i.response_text).map(i => i.response_text))];
    if (actionTexts.length > 0) {
      let response = greeting + feedbackLine + actionTexts.join(' ');
      // Adapt for third-party
      if (isThirdParty) {
        response = response.replace(/\byou\b/g, thirdPartyLabel === 'daughter' || thirdPartyLabel === 'son' ? `your ${thirdPartyLabel}` : thirdPartyLabel);
      }
      // Include multi-item flags in the same message
      const multiItemFlags = (s.prescription.flags || []).filter(f =>
        f.includes('Would you like to exchange')
      );
      if (multiItemFlags.length > 0) {
        response += '\n\nAlso, ' + multiItemFlags[0].replace(/^Order also has /, 'I noticed your order also has ').replace(/ — ask: "/, ' — ').replace(/"$/, '');
      }
      return response;
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
      const result = await advisorHandler({
        customer_email,
        issue_description: customerMsg,
        order_number: order_number || undefined,
        intake,
      });

      s = result._structured;
      if (s) intake = s.intake;

      // Populate header from first advisor call (uses the actual order the advisor resolved)
      if (i === 0 && s) {
        const c = s.customer;
        customerInfo = `${c.email || customer_email} | ${c.country || '?'}`;
        if (c.address) {
          const a = c.address;
          customerInfo += `\nAddress: ${[a.address1, a.city, a.province, a.zip, a.country].filter(Boolean).join(', ')}`;
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

    const agentResponse = composeAgentResponse(s);

    conversationLog.push({
      messageNum: i + 1,
      customer: customerMsg,
      agent: agentResponse,
      status: s.status,
      _structured: s,
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
        items: resolvedItems.map(i => {
          // Use _orderQty from multi-item expansion, or sum matching order line items
          let qty = i._orderQty || 0;
          if (!qty) {
            const prodLower = (i.product || '').toLowerCase();
            for (const oi of orderItems) {
              if (oi.title?.toLowerCase().includes(prodLower.split(' ')[0])) {
                qty += oi.quantity;
              }
            }
          }
          return {
            product: i.resolved_product || i.product,
            from_product: i.resolved_product ? i.product : null,
            from_size: i.size,
            to_size: i.resolved_size,
            color: i.color,
            quantity: qty || 1,
          };
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

  // Check for refund resolution
  let isRefund = false;
  if (conversationLog.length > 0) {
    const lastS = conversationLog[conversationLog.length - 1]._structured;
    isRefund = lastS?.prescription?.items?.some(i => i.state === 'REFUND_CONFIRMED');
  }

  // ── SECTION C: RESOLUTION ──
  md += '## C. Resolution\n\n';
  if (isRefund) {
    const lastS = conversationLog[conversationLog.length - 1]._structured;
    const refundedItems = (intake?.items || []);
    md += `Status: REFUND PROCESSED (simulation)\n`;
    md += `Customer: ${customer_email}${intake?.name ? ' (' + intake.name + ')' : ''}\n\n`;
    for (const item of refundedItems) {
      const nick = getProductNickname(item.product);
      md += `  Refund: ${nick} — ${item.color || 'original color'} / ${item.size || '?'}\n`;
    }
    md += '\n';
  } else if (orderSimulation) {
    md += `Status: EXCHANGE ORDER CREATED (simulation)\n`;
    md += `Customer: ${orderSimulation.customer}${orderSimulation.name ? ' (' + orderSimulation.name + ')' : ''}\n`;
    if (orderSimulation.address) {
      const a = orderSimulation.address;
      md += `Ship to: ${[a.address1, a.city, a.province, a.zip, a.country].filter(Boolean).join(', ')}\n`;
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
        order_number: { type: 'string', description: 'Optional order number to target (e.g. "28774"). If omitted, uses most recent fulfilled order.' },
      },
      required: ['customer_email', 'messages'],
    },
    handler: handleTestConversation,
  },
];

module.exports = tools;
