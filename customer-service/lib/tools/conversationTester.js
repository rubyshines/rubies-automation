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
const { getProductNickname, pluralizeNickname, getSizeList, normalizeSize, classifyProduct, getAdjacentSizes, getCumulativeDelta, KID_LABELS } = require('../decisionTree');

// Import the advisor handler
const advisorTools = require('./exchangeAdvisor');
const advisorHandler = (advisorTools.find(t => t.name === 'cs_advisor') || advisorTools.find(t => t.name === 'exchange_advisor')).handler;

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
    ? (KID_LABELS.has(thirdPartyLabel) ? `for your ${thirdPartyLabel}` : `for ${thirdPartyLabel}`)
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

  // Item clarification needed — ask which items (only if no items have been identified yet)
  if (s.intake?._needsItemClarification && (!allIntakeItems.length || allIntakeItems.every(i => !i.product))) {
    return greeting + `I can see your order has a few different items. Which ones didn't fit right?`;
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

  // Group prescription items by state type
  const exchangeConfirmed = []; // items with resolved_size (ready for order)
  const refundConfirmed = [];   // REFUND_CONFIRMED
  const needsInfo = [];         // items needing more info (questions to ask)
  const productSwaps = [];      // try-size swaps

  const sizeRecommendations = []; // pre-purchase sizing

  for (const pi of prescriptionItems) {
    if (pi.state === 'SIZE_RECOMMENDATION' || pi.state === 'NEEDS_MEASUREMENT' || pi.state === 'NEEDS_PRODUCT') {
      sizeRecommendations.push(pi);
    } else if (pi.state === 'REFUND_CONFIRMED') {
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

    let text;
    // Prefer the tree's response_text if it has one (e.g. measurement note + delta)
    if (item.response_text) {
      text = item.response_text;
    } else if (isSelfDiag && dir === 'down') {
      text = `You're right, if it's too loose the shaping won't work as well. The next size down should work better.`;
    } else if (isSelfDiag && dir === 'up') {
      text = `You're right, if it's too tight the shaping won't sit comfortably. The next size up should work better.`;
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

  // 4. Questions/needs-info — group sizing options by product category
  // When multiple items need sizing, group by category (underwear, swim, etc.)
  // and present options from a single reference size per group.
  const sizingItems = [];
  const nonSizingItems = [];
  const matchedIntakeIndices = new Set();
  for (const item of needsInfo) {
    // Match by product, preferring unmatched intake items to avoid duplicate matches
    let intakeItem = null;
    for (let idx = 0; idx < allIntakeItems.length; idx++) {
      const ii = allIntakeItems[idx];
      if (ii.product === item.product && !ii.resolved_size && !matchedIntakeIndices.has(idx)) {
        intakeItem = ii;
        matchedIntakeIndices.add(idx);
        break;
      }
    }
    if (item.options || (item.response_text && /next size|size up|size down|which.*better|which.*prefer/.test(item.response_text))) {
      sizingItems.push({ ...item, _intake: intakeItem });
    } else {
      nonSizingItems.push(item);
    }
  }

  if (sizingItems.length > 1) {
    // Group by product category display name
    const categoryGroups = new Map();
    for (const item of sizingItems) {
      const cat = classifyProduct(item.product) || 'other';
      let catLabel;
      if (cat === 'swim_top') catLabel = 'bikini top';
      else if (cat === 'swim_bottom') catLabel = 'bikini bottoms';
      else if (cat === 'underwear_top') catLabel = 'bra';
      else if (cat === 'onepiece') catLabel = 'one-piece';
      else if (cat === 'underwear_bottom') catLabel = 'underwear';
      else catLabel = 'other';
      if (!categoryGroups.has(catLabel)) categoryGroups.set(catLabel, []);
      categoryGroups.get(catLabel).push(item);
    }

    const groupTexts = [];
    const useInches = !s.customer?.country || s.customer.country === 'US' || s.customer.country === 'United States';
    for (const [catLabel, items] of categoryGroups) {
      // Determine direction from issue
      const issue = items[0]._intake?.issue || '';
      const direction = /loose|big/.test(issue) ? 'down' : 'up';

      // Pick reference size: largest if too tight (up), smallest if too loose (down)
      const sizes = items.map(i => normalizeSize(i._intake?.size || '')).filter(Boolean);
      const sizeList = getSizeList(sizes[0], items[0].product);
      if (!sizeList || sizes.length === 0) {
        // Fallback: use original per-item text
        for (const item of items) parts.push({ type: 'question', text: item.response_text });
        continue;
      }
      const sizeIndices = sizes.map(s => sizeList.indexOf(s)).filter(i => i >= 0);
      const refIdx = direction === 'up' ? Math.max(...sizeIndices) : Math.min(...sizeIndices);
      const refSize = sizeList[refIdx];

      // Get adjacent sizes from reference
      const adjacent = getAdjacentSizes(refSize, direction, 2, items[0].product);
      if (adjacent.length === 0) {
        for (const item of items) parts.push({ type: 'question', text: item.response_text });
        continue;
      }

      const nick = getProductNickname(items[0].product);
      const isTopCat = catLabel === 'bikini top' || catLabel === 'bra';
      const bodyDesc = isTopCat ? (catLabel === 'bra' ? 'bra band' : 'bikini top band') : 'fabric around the waist';
      const optionTexts = adjacent.map(s => {
        const delta = getCumulativeDelta(refSize, s) || { inches: 2, cm: 5 };
        const unit = useInches ? `${delta.inches}"` : `${delta.cm} cm`;
        const more = direction === 'up' ? (isTopCat ? 'longer' : 'more') : (isTopCat ? 'shorter' : 'less');
        return isTopCat
          ? `${s} which has the ${bodyDesc} ${unit} ${more} than the ${refSize}`
          : `${s} which has ${unit} ${more} ${bodyDesc} compared to the ${refSize}`;
      });

      const sizeNote = sizes.length > 1 ? ` in size ${refSize}` : ` from ${refSize}`;
      const dirWord = direction === 'up' ? 'up' : 'down';
      groupTexts.push(`The next size ${dirWord} for the ${catLabel}${sizeNote} is ${optionTexts.join(', or ')}.`);
    }

    let groupedText = groupTexts.join(' ') + ` Which sounds better${forWhom}?`;

    // Add measurement ask for "too tight/loose" (not "a bit")
    const anyIssue = sizingItems[0]._intake?.issue || '';
    const isUncertain = !/a bit|slightly|little bit|a little/.test(anyIssue) &&
      !/a bit|slightly|little bit|a little/.test((s.intake?._latestMessage || '').toLowerCase());
    if (isUncertain && !s.intake?.measurement) {
      const measurePart = isThirdParty ? `your ${s.customer.third_party_label || "child"}'s ` : 'the ';
      groupedText += ` Or if you send me ${measurePart}waist measurement around the belly and just under the belly button I can make a recommendation.`;
    }

    parts.push({ type: 'question', text: groupedText });
  } else {
    // Single item or no sizing items — use original text
    for (const item of sizingItems) {
      parts.push({ type: 'question', text: item.response_text });
    }
  }

  // Non-sizing questions — group measurement recommendations, dedup measurement requests
  const measurementRecs = []; // "Based on measurement, I'd recommend size X for the Y"
  const askedMeasurements = new Set();
  const otherQuestions = [];
  for (const item of nonSizingItems) {
    const isRecommendation = item.response_text?.includes('recommend') && item.response_text?.includes('measurement');
    const isMeasurementRequest = item.response_text?.includes('send me') && item.response_text?.includes('measurement');
    if (isRecommendation) {
      // Extract product and size from recommendation text
      const sizeMatch = item.response_text.match(/size (\S+)/);
      const nick = getProductNickname(item.product);
      if (sizeMatch && nick) {
        measurementRecs.push({ nick, size: sizeMatch[1] });
      } else {
        otherQuestions.push(item);
      }
    } else if (isMeasurementRequest) {
      const bodyPart = item.response_text.includes('chest') ? 'chest' : 'waist';
      if (askedMeasurements.has(bodyPart)) continue;
      askedMeasurements.add(bodyPart);
      otherQuestions.push(item);
    } else {
      otherQuestions.push(item);
    }
  }

  // Combine measurement recommendations into one sentence
  if (measurementRecs.length > 0) {
    const m = s.intake?.measurement;
    const measureRef = isThirdParty ? `${s.customer.third_party_label || "child"}'s` : 'your';
    const mDisplay = m ? `${m.value} ${m.unit === 'cm' ? 'cm' : '"'}` : '';
    const recParts = measurementRecs.map(r => `a size ${r.size} for the ${r.nick}`);
    const recText = recParts.length === 1 ? recParts[0]
      : recParts.slice(0, -1).join(', ') + ' and ' + recParts[recParts.length - 1];
    const basedOn = mDisplay ? `Based on ${measureRef} measurement of ${mDisplay}, ` : '';
    parts.push({ type: 'question', text: `${basedOn}I'd recommend ${recText}. Shall I set that up?` });
  }

  for (const item of otherQuestions) {
    parts.push({ type: 'question', text: item.response_text });
  }

  // 5. Pre-purchase size recommendations
  if (sizeRecommendations.length > 0) {
    for (const rec of sizeRecommendations) {
      parts.push({ type: 'sizing', text: rec.response_text });
    }
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

  // Acknowledge exchange vs reorder question if customer asked
  const latestMsg = (s.intake?._latestMessage || '').toLowerCase();
  if (/reorder|re-order|should i order|do i need to order/.test(latestMsg) && /exchange/.test(latestMsg)) {
    response += ' No need to reorder — we can handle it as an exchange.';
  }

  // Add sizing recommendations (pre-purchase)
  const sizingTexts = parts.filter(p => p.type === 'sizing').map(p => p.text);
  if (sizingTexts.length > 0) {
    response += sizingTexts.join(' ');
  }

  // Add questions
  if (hasQuestions) {
    const questionTexts = parts.filter(p => p.type === 'question').map(p => p.text);
    response += (hasExchanges || hasRefunds || sizingTexts.length > 0 ? '\n\n' : '') + questionTexts.join(' ');
  }

  // Crossover note
  if (s.prescription.crossover_note) {
    response += '\n\n' + s.prescription.crossover_note;
  }

  // Multi-item flags — ask about other items in the same size
  const multiItemFlags = (s.prescription.flags || []).filter(f => f.includes('Would you like to exchange'));
  if (multiItemFlags.length > 0) {
    // Extract product names from flags and combine into one question
    const flagProducts = multiItemFlags.map(f => {
      const match = f.match(/also has (.+?) in size/);
      return match ? match[1] : null;
    }).filter(Boolean);
    if (flagProducts.length > 0) {
      const productList = flagProducts.length === 1 ? flagProducts[0]
        : flagProducts.slice(0, -1).join(', ') + ' and ' + flagProducts[flagProducts.length - 1];
      response += `\n\nI also see you have ${productList} in the same size — would you like to exchange those too?`;
    }
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

    // Pull tone samples from structured data to ground the voice
    let toneContext = '';
    const toneSample = structured.tone_sample;
    if (toneSample) {
      toneContext = `\nVOICE REFERENCE — this is how the founder Jamie actually writes to customers. Match this tone:\n> "${toneSample.message}"\n`;
    }

    // Also pull a few more samples if available (the advisor only fetches 1, but we can get more)
    try {
      const supabase = require('../../../shared/supabaseClient').getSupabaseClient();
      const { data: extraSamples } = await supabase.rpc('get_tone_samples', { p_situation: 'sizing_recommendation', p_limit: 3 });
      if (extraSamples?.length) {
        toneContext += '\nMORE EXAMPLES of Jamie\'s actual writing:\n';
        for (const s of extraSamples.slice(0, 3)) {
          toneContext += `> "${s.agent_message.substring(0, 200)}"\n`;
        }
      }
    } catch (e) { /* tone table may not exist */ }

    const result = await _polishClient.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: `You are polishing a customer service response for RUBIES, a gender-affirming underwear brand. The response was composed by a deterministic system and needs to read naturally while preserving ALL factual content.
${conversationContext}${toneContext}
CUSTOMER MESSAGE:
${customerMessage}

DRAFT RESPONSE:
${rawResponse}

RULES:
- Preserve EVERY fact: product names, sizes, prices, addresses, donation partner details
- NEVER rephrase or reinterpret sizing statements, measurements, or size chart references. If the draft says "the sizing chart puts you in the M range" do NOT change that to "you're between sizes" or any other interpretation. Keep the exact sizing claim.
- Fix grammar errors
- Make it flow as one natural message — no awkward paragraph breaks between exchange and refund sections
- Match Jamie's voice from the examples above. He's warm and direct — no corporate-speak, no AI-sounding phrases like "is the move", "absolutely", "I'd be happy to", "great choice"
- If the customer said something kind about RUBIES, acknowledge it warmly and briefly even if the draft didn't. This is the ONE exception to adding content.
- Otherwise do NOT add new information, suggestions, or questions not in the draft
- NEVER replace questions with different questions. If the draft asks an open-ended question ("what didn't work out?"), do NOT narrow it to a specific question ("was it too tight?"). Preserve the intent and scope of every question.
- NEVER remove order confirmations, refund confirmations, or donation info — these are actionable
- Do NOT remove sizing explanations or crossover notes
- Do NOT remove offers of help (e.g. "I can help find the right size" or "we can find an alternative")
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

      // Shipping/non-exchange responses have a different structure — handle directly
      if (s && !s.intake && (s.results || s.status === 'route_to_human' || s.status === 'complete' || s.error)) {
        const agentText = result.content?.[0]?.text || '(No response)';
        // Extract just the customer response part from the markdown
        const customerResponseMatch = agentText.match(/\*\*Customer response:\*\*\n([\s\S]*?)(?:\n\n|$)/);
        const cleanResponse = customerResponseMatch?.[1]?.trim() ||
          (s.results?.[0]?.summary) ||
          agentText.replace(/^##.*\n/gm, '').replace(/\*\*[^*]+\*\*[^\n]*/g, '').trim().split('\n').pop()?.trim() ||
          agentText;
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

    const prevResponses = conversationLog.filter(e => e.agent && !e.agent.startsWith('(')).map(e => e.agent);
    const agentResponse = await composeAgentResponse(s, prevResponses);

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
                const oiSkuSize = oi.sku ? normalizeSize(oi.sku.split('-').pop()) : null;
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
