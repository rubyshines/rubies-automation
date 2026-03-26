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
const { getProductNickname, pluralizeNickname, getSizeList, normalizeSize } = require('../decisionTree');

// Import the advisor handler
const advisorTools = require('./exchangeAdvisor');
const advisorHandler = advisorTools.find(t => t.name === 'exchange_advisor').handler;

// ---------------------------------------------------------------------------
// Response composer — builds agent response from structured data
// ---------------------------------------------------------------------------

async function composeAgentResponse(s, previousResponses) {
  const greeting = s.customer.name ? `Thanks ${s.customer.name}! ` : 'Hi! ';
  const prescriptionItems = s.prescription.items;
  const allIntakeItems = s.intake.items || [];
  const resolvedItems = allIntakeItems.filter(i => i.resolved_size);
  const isThirdParty = s.customer.buying_for === 'third_party';
  const thirdPartyLabel = s.customer.third_party_label || 'them';
  const orderItems = s.order?.items || [];
  const { classifyProduct: classifyProd } = require('../decisionTree');

  const forWhom = isThirdParty
    ? (thirdPartyLabel === 'daughter' || thirdPartyLabel === 'son' || thirdPartyLabel === 'kid' || thirdPartyLabel === 'kiddo'
      ? `for your ${thirdPartyLabel}` : `for ${thirdPartyLabel}`)
    : 'for you';
  const youHer = isThirdParty ? 'her' : 'you';

  // Positive feedback acknowledgment
  const hasFeedback = s.audit?.some(a => /positive feedback/i.test(a));
  let feedbackLine = '';
  if (hasFeedback && isThirdParty) {
    feedbackLine = `So lovely to hear you've been with RUBIES for so long! `;
  } else if (hasFeedback) {
    feedbackLine = `So glad you love RUBIES! `;
  }

  // Safety override — short circuit
  if (s.status === 'safety_override') {
    return 'We\'ll process a refund for you right away. No questions asked. We hope your situation improves.';
  }

  // ── Per-item response builder ──
  // Build a response part for each item, then combine.
  // This handles mixed intent (exchange some + return others + questions for others).

  function getItemQty(item) {
    if (item._orderQty) return item._orderQty;
    let qty = 0;
    const prodLower = (item.product || '').toLowerCase();
    const itemSize = item.size ? normalizeSize(item.size) : null;
    for (const oi of orderItems) {
      if (oi.title?.toLowerCase().includes(prodLower.split(' ')[0])) {
        const oiSkuSize = oi.sku ? normalizeSize(oi.sku.split('-').pop()) : null;
        if (itemSize && oiSkuSize && oiSkuSize !== itemSize) continue;
        qty += oi.quantity;
      }
    }
    return qty || 1;
  }

  function getItemDesc(item) {
    const displayProduct = item.resolved_product || item.product;
    const nick = getProductNickname(displayProduct);
    const qty = getItemQty(item);
    const name = pluralizeNickname(nick, qty);
    const article = /^[aeiou]/i.test(name) ? 'an' : 'a';
    return qty > 1 ? `${qty} ${name}` : `${article} ${name}`;
  }

  function getSizeDirection(item) {
    const fromSize = item.size;
    const toSize = item.resolved_size;
    if (!fromSize || !toSize) return null;
    const list = getSizeList(fromSize, item.product);
    if (!list) return null;
    const fromIdx = list.indexOf(normalizeSize(fromSize));
    const toIdx = list.indexOf(normalizeSize(toSize));
    if (fromIdx < 0 || toIdx < 0) return null;
    return toIdx > fromIdx ? 'up' : toIdx < fromIdx ? 'down' : 'same';
  }

  // Check between-sizes: only when one product exchanged and another in same size+body group kept
  function checkBetweenSizes(item) {
    if (resolvedItems.length !== 1) return false;
    const sameSize = normalizeSize(item.size);
    const cat = classifyProd(item.product);
    const bodyGroup = (cat === 'underwear_top' || cat === 'swim_top') ? 'tops' : 'bottoms';
    const itemProdLower = (item.product || '').toLowerCase();
    return orderItems.some(oi => {
      const oiSize = oi.sku ? normalizeSize(oi.sku.split('-').pop()) : null;
      const oiCat = classifyProd(oi.title);
      const oiBodyGroup = (oiCat === 'underwear_top' || oiCat === 'swim_top') ? 'tops' : 'bottoms';
      return oiSize === sameSize && oiBodyGroup === bodyGroup
        && !oi.title?.toLowerCase().includes(itemProdLower.split(' ')[0]);
    });
  }

  // Group prescription items by state type
  const exchangeConfirmed = []; // items with resolved_size (ready for order)
  const refundConfirmed = [];   // REFUND_CONFIRMED
  const needsInfo = [];         // items needing more info (questions to ask)
  const productSwaps = [];      // try-size swaps

  for (const pi of prescriptionItems) {
    if (pi.state === 'REFUND_CONFIRMED') {
      refundConfirmed.push(pi);
    } else if (pi.state === 'CONFIRMED' || pi.state === 'AWAITING_DECISION') {
      // Check if it's a product swap
      const intakeItem = allIntakeItems.find(ii => ii.product === pi.product);
      if (intakeItem?.resolved_product && intakeItem.resolved_product !== intakeItem.product) {
        productSwaps.push({ ...pi, _intake: intakeItem });
      } else if (intakeItem?.resolved_size) {
        exchangeConfirmed.push({ ...pi, _intake: intakeItem });
      } else if (pi.response_text) {
        needsInfo.push(pi);
      }
    } else if (pi.response_text) {
      needsInfo.push(pi);
    }
  }

  // Also check for resolved items not in prescription (auto-confirmed with no response_text)
  for (const ri of resolvedItems) {
    const alreadyCounted = exchangeConfirmed.some(e => e.product === ri.product)
      || productSwaps.some(p => p.product === ri.product);
    if (!alreadyCounted) {
      exchangeConfirmed.push({ product: ri.product, _intake: ri });
    }
  }

  // ── Build response parts ──
  const parts = [];

  // 1. Exchange explanations (per item — skip if already explained in a previous turn)
  for (const item of exchangeConfirmed) {
    const ri = item._intake;
    if (ri._explained) continue; // Already communicated in a previous message
    const nick = getProductNickname(ri.product);
    const dir = getSizeDirection(ri);
    const isSelfDiag = item.self_diagnosed;
    const isBetween = checkBetweenSizes(ri);

    let text;
    if (isSelfDiag && dir === 'down') {
      text = `You're right, if it's too loose the shaping won't work as well. The next size down should work better.`;
    } else if (isSelfDiag && dir === 'up') {
      text = `You're right, if it's too tight the shaping won't sit comfortably. The next size up should work better.`;
    } else if (isBetween && dir === 'up') {
      text = `That's interesting — our sizing is usually consistent across products, so it's possible you're right between sizes. The ${ri.resolved_size} should give ${youHer} a bit more room which should help.`;
    } else if (isBetween && dir === 'down') {
      text = `That's interesting — our sizing is usually consistent across products, so it's possible you're right between sizes. The ${ri.resolved_size} should be snugger which should help.`;
    } else if (dir === 'down') {
      text = `For the ${nick}, going one size down sounds right — the ${ri.resolved_size} will be snugger overall.`;
    } else if (dir === 'up') {
      text = `For the ${nick}, the ${ri.resolved_size} will give ${youHer} a bit more room which should be a better fit.`;
    }

    if (text) {
      parts.push({ type: 'exchange_explanation', text, product: ri.product });
      ri._explained = true; // Mark so we don't repeat on next turn
    }
  }

  // 2. Product swaps
  for (const item of productSwaps) {
    const ri = item._intake;
    const fromNick = getProductNickname(ri.product);
    const toNick = getProductNickname(ri.resolved_product);
    const article = /^[aeiou]/i.test(toNick) ? 'an' : 'a';
    parts.push({ type: 'swap', text: `Great choice! I've swapped the ${fromNick} for ${article} ${toNick} in size ${ri.resolved_size}.` });
  }

  // 3. Refund confirmations
  for (const item of refundConfirmed) {
    const nick = getProductNickname(item.product);
    parts.push({ type: 'refund', text: item.response_text || `I'll process the return for the ${nick}.` });
  }

  // 4. Questions/needs-info (dedup: only ask for each body part measurement once)
  const askedMeasurements = new Set();
  for (const item of needsInfo) {
    // Dedup measurement requests
    if (item.response_text?.includes('measurement')) {
      const bodyPart = item.response_text.includes('chest') ? 'chest' : 'waist';
      if (askedMeasurements.has(bodyPart)) continue;
      askedMeasurements.add(bodyPart);
    }
    parts.push({ type: 'question', text: item.response_text });
  }

  // ── Compose final response ──
  if (parts.length === 0) {
    if (s.status === 'gathering' || !prescriptionItems.length) {
      return greeting + "Can you let me know what didn't work out?";
    }
    return greeting + (s.prescription.still_needed.length > 0
      ? 'Could you provide: ' + s.prescription.still_needed.join(', ') + '?'
      : "I'd be happy to help — can you tell me more?");
  }

  let response = greeting + feedbackLine;

  // If we have exchanges, build the order summary
  const hasExchanges = exchangeConfirmed.length > 0 || productSwaps.length > 0;
  const hasRefunds = refundConfirmed.length > 0;
  const hasQuestions = parts.some(p => p.type === 'question');

  // Add exchange explanations
  const exchangeParts = parts.filter(p => p.type === 'exchange_explanation' || p.type === 'swap');
  if (exchangeParts.length === 1) {
    // Single item — use the explanation directly (no "For the X" prefix needed if only one)
    let text = exchangeParts[0].text;
    // Remove "For the X, " prefix when only one item
    text = text.replace(/^For the \w+, /, '');
    // Capitalize first letter
    text = text.charAt(0).toUpperCase() + text.slice(1);
    response += text;
  } else if (exchangeParts.length > 1) {
    response += exchangeParts.map(p => p.text).join(' ');
  }

  // Add order creation summary for exchanges
  if (hasExchanges && !hasQuestions) {
    const allResolved = [...exchangeConfirmed.map(e => e._intake), ...productSwaps.map(p => p._intake)];
    const desc = allResolved.map(ri => {
      const displayProduct = ri.resolved_product || ri.product;
      const nick = getProductNickname(displayProduct);
      const qty = getItemQty(ri);
      const name = pluralizeNickname(nick, qty);
      const article = /^[aeiou]/i.test(name) ? 'an' : 'a';
      return qty > 1 ? `${qty} ${name} in size ${ri.resolved_size}` : `${article} ${name} in size ${ri.resolved_size}`;
    }).join(' and ');
    response += ` I've gone ahead and created a new exchange order for ${desc} ${forWhom}.`;
  }

  // Add refund parts
  if (hasRefunds) {
    const refundTexts = parts.filter(p => p.type === 'refund').map(p => p.text);
    response += (hasExchanges ? '\n\n' : '') + refundTexts.join(' ');
  }

  // Add questions
  if (hasQuestions) {
    const questionTexts = parts.filter(p => p.type === 'question').map(p => p.text);
    response += (hasExchanges || hasRefunds ? '\n\n' : '') + questionTexts.join(' ');
  }

  // Crossover note
  if (s.prescription.crossover_note) {
    response += '\n\n' + s.prescription.crossover_note;
  }

  // Donation (combine all returned items)
  if (s.prescription.donation?.text) {
    response += '\n\n' + s.prescription.donation.text;
  }

  // AI tone pass — polish the composed response
  response = await polishResponse(response, s, previousResponses);

  return response;
}

// ---------------------------------------------------------------------------
// AI Tone Pass — smooths deterministic composer output
// ---------------------------------------------------------------------------

const Anthropic = require('@anthropic-ai/sdk');
let _polishClient = null;

async function polishResponse(rawResponse, structured, previousResponses) {
  try {
    if (!_polishClient) _polishClient = new Anthropic();

    const customerMessage = structured.intake?._latestMessage || '';
    const customerName = structured.customer?.name || null;
    const isThirdParty = structured.customer?.buying_for === 'third_party';
    const thirdPartyLabel = structured.customer?.third_party_label || null;

    let conversationContext = '';
    if (previousResponses && previousResponses.length > 0) {
      conversationContext = '\nPREVIOUS AGENT RESPONSES (already sent — do NOT repeat explanations but DO include any NEW confirmations):\n';
      for (const prev of previousResponses) {
        conversationContext += `- ${prev}\n`;
      }
    }

    const result = await _polishClient.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: `You are polishing a customer service response for RUBIES, a gender-affirming underwear brand. The response was composed by a deterministic system and needs to read naturally while preserving ALL factual content.
${conversationContext}
CUSTOMER MESSAGE:
${customerMessage}

DRAFT RESPONSE:
${rawResponse}

RULES:
- Preserve EVERY fact: product names, sizes, prices, addresses, donation partner details
- Fix grammar errors
- Make it flow as one natural message — no awkward paragraph breaks between exchange and refund sections
- Keep it concise and warm — RUBIES voice is playful, respectful, confident, approachable
- If the customer said something kind about RUBIES (compliments, "love what you're doing", "keep up the good work", etc.), acknowledge it warmly and briefly even if the draft didn't. This is the ONE exception to adding content.
- Otherwise do NOT add new information, suggestions, or questions not in the draft
- NEVER remove order confirmations ("created an exchange order for X"), refund confirmations ("I'll process the return"), or donation info. These are actionable — the customer needs to know what was done.
- Do NOT remove sizing explanations or crossover notes
- Do NOT add a sign-off (no "Take care", no signature)
- Do NOT use emojis
${customerName ? `- Customer name: ${customerName}` : '- No customer name detected — use "Hi!" not a name'}
${isThirdParty ? `- This is a third-party purchase for their ${thirdPartyLabel} — use appropriate pronouns` : ''}

Return ONLY the polished response text. No explanation.`
      }],
    });

    return result.content[0]?.text || rawResponse;
  } catch (e) {
    // If AI fails, return raw response — better than nothing
    console.error('[polishResponse] AI polish failed, using raw:', e.message);
    return rawResponse;
  }
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

    const prevResponses = conversationLog.filter(e => e.agent && !e.agent.startsWith('(')).map(e => e.agent);
    const agentResponse = await composeAgentResponse(s, prevResponses);

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
            const itemSize = i.size ? normalizeSize(i.size) : null;
            for (const oi of orderItems) {
              if (oi.title?.toLowerCase().includes(prodLower.split(' ')[0])) {
                // If the item has a specific size, only count order items matching that size
                // This prevents counting ALL Charlies when only the 4X is being returned
                const oiSkuSize = oi.sku ? normalizeSize(oi.sku.split('-').pop()) : null;
                if (itemSize && oiSkuSize && oiSkuSize !== itemSize) continue;
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
      md += `Ship to: ${[a.address1, a.city, a.province, a.zip, a.country].filter(Boolean).join(', ')}\n`;
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
