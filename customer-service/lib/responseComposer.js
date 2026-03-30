/**
 * Response Composer — builds agent response from structured advisor data.
 *
 * Extracted from conversationTester.js so the poller + dashboard can reuse it.
 * Two functions:
 *   composeAgentResponse(structured, previousResponses) → raw text
 *   polishResponse(rawResponse, structured, previousResponses) → polished text
 */

const { getProductNickname, pluralizeNickname, getSizeList, normalizeSize, classifyProduct, getAdjacentSizes, getCumulativeDelta, KID_LABELS } = require('./decisionTree');
const Anthropic = require('@anthropic-ai/sdk');

let _polishClient = null;

// ---------------------------------------------------------------------------
// composeAgentResponse — deterministic text from structured data
// ---------------------------------------------------------------------------

async function composeAgentResponse(s, previousResponses) {
  const greeting = s.customer.name ? `Thanks ${s.customer.name}! ` : 'Hi! ';
  const prescriptionItems = s.prescription.items;
  const allIntakeItems = s.intake.items || [];
  const resolvedItems = allIntakeItems.filter(i => i.resolved_size);
  const isThirdParty = s.customer.buying_for === 'third_party';
  const thirdPartyLabel = s.customer.third_party_label || 'them';
  const orderItems = s.order?.items || [];

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
  const exchangeConfirmed = [];
  const refundConfirmed = [];
  const needsInfo = [];
  const productSwaps = [];
  const sizeRecommendations = [];

  for (const pi of prescriptionItems) {
    if (pi.state === 'SIZE_RECOMMENDATION' || pi.state === 'NEEDS_MEASUREMENT' || pi.state === 'NEEDS_PRODUCT') {
      sizeRecommendations.push(pi);
    } else if (pi.state === 'REFUND_CONFIRMED') {
      refundConfirmed.push(pi);
    } else if (pi.state === 'CONFIRMED' || pi.state === 'AWAITING_DECISION') {
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

  // Also check for resolved items not in prescription
  for (const ri of resolvedItems) {
    const alreadyCounted = exchangeConfirmed.some(e => e.product === ri.product)
      || productSwaps.some(p => p.product === ri.product);
    if (!alreadyCounted) {
      exchangeConfirmed.push({ product: ri.product, _intake: ri });
    }
  }

  // ── Build response parts ──
  const parts = [];

  // 1. Exchange explanations
  for (const item of exchangeConfirmed) {
    const ri = item._intake;
    if (ri._explained) continue;
    const nick = getProductNickname(ri.product);
    const dir = getSizeDirection(ri);
    const isSelfDiag = item.self_diagnosed;

    let text;
    if (item.response_text) {
      text = item.response_text;
    } else if (isSelfDiag && dir === 'down') {
      text = `You're right, if it's too loose the shaping won't work as well. The next size down should work better.`;
    } else if (isSelfDiag && dir === 'up') {
      text = `You're right, if it's too tight the shaping won't sit comfortably. The next size up should work better.`;
    } else if (dir === 'down') {
      text = `For the ${nick}, going one size down sounds right — the ${ri.resolved_size} will be snugger overall.`;
    } else if (dir === 'up') {
      const delta = getCumulativeDelta(ri.size, ri.resolved_size);
      const roomDesc = delta && delta.inches <= 1 ? 'a bit more room' : 'more room';
      text = `For the ${nick}, the ${ri.resolved_size} will give ${youHer} ${roomDesc} which should be a better fit.`;
    }

    if (text) {
      parts.push({ type: 'exchange_explanation', text, product: ri.product });
      ri._explained = true;
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

  // 4. Questions/needs-info
  const sizingItems = [];
  const nonSizingItems = [];
  const matchedIntakeIndices = new Set();
  for (const item of needsInfo) {
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
      const issue = items[0]._intake?.issue || '';
      const direction = /loose|big/.test(issue) ? 'down' : 'up';

      const sizes = items.map(i => normalizeSize(i._intake?.size || '')).filter(Boolean);
      const sizeList = getSizeList(sizes[0], items[0].product);
      if (!sizeList || sizes.length === 0) {
        for (const item of items) parts.push({ type: 'question', text: item.response_text });
        continue;
      }
      const sizeIndices = sizes.map(s => sizeList.indexOf(s)).filter(i => i >= 0);
      const refIdx = direction === 'up' ? Math.max(...sizeIndices) : Math.min(...sizeIndices);
      const refSize = sizeList[refIdx];

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
      const optionsKey = `${refSize}→${adjacent.join(',')}`;
      groupTexts.push({ catLabel, sizeNote, dirWord, optionTexts, optionsKey, isTopCat });
    }

    const mergedTexts = [];
    const seen = new Map();
    for (const g of groupTexts) {
      if (!g.isTopCat && seen.has(g.optionsKey)) {
        const existing = mergedTexts[seen.get(g.optionsKey)];
        existing.catLabel += ` and ${g.catLabel}`;
      } else {
        seen.set(g.optionsKey, mergedTexts.length);
        mergedTexts.push({ ...g });
      }
    }
    let groupedText = mergedTexts.map(g =>
      `The next size ${g.dirWord} for the ${g.catLabel}${g.sizeNote} is ${g.optionTexts.join(', or ')}.`
    ).join(' ') + ` Which sounds better${forWhom}?`;

    const anyIssue = sizingItems[0]._intake?.issue || '';
    const isUncertain = !/a bit|slightly|little bit|a little/.test(anyIssue) &&
      !/a bit|slightly|little bit|a little/.test((s.intake?._latestMessage || '').toLowerCase());
    if (isUncertain && !s.intake?.measurement) {
      const measurePart = isThirdParty ? `your ${s.customer.third_party_label || "child"}'s ` : 'the ';
      groupedText += ` Or if you send me ${measurePart}waist measurement around the belly and just under the belly button I can make a recommendation.`;
    }

    parts.push({ type: 'question', text: groupedText });
  } else {
    for (const item of sizingItems) {
      parts.push({ type: 'question', text: item.response_text });
    }
  }

  // Non-sizing questions
  const measurementRecs = [];
  const askedMeasurements = new Set();
  const otherQuestions = [];
  for (const item of nonSizingItems) {
    const isRecommendation = item.response_text?.includes('recommend') && item.response_text?.includes('measurement');
    const isMeasurementRequest = item.response_text?.includes('send me') && item.response_text?.includes('measurement');
    if (isRecommendation) {
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

  const hasExchanges = exchangeConfirmed.length > 0 || productSwaps.length > 0;
  const hasRefunds = refundConfirmed.length > 0;
  const hasQuestions = parts.some(p => p.type === 'question');

  // Add exchange explanations
  const exchangeParts = parts.filter(p => p.type === 'exchange_explanation' || p.type === 'swap');
  if (exchangeParts.length === 1) {
    let text = exchangeParts[0].text;
    text = text.replace(/^For the \w+, /, '');
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

  // Acknowledge exchange vs reorder question
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

  // Multi-item flags
  const multiItemFlags = (s.prescription.flags || []).filter(f => f.includes('Would you like to exchange'));
  if (multiItemFlags.length > 0) {
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

  // Donation
  if (s.prescription.donation?.text) {
    response += '\n\n' + s.prescription.donation.text;
  }

  // AI tone pass
  response = await polishResponse(response, s, previousResponses);

  return response;
}

// ---------------------------------------------------------------------------
// polishResponse — AI tone pass on deterministic composer output
// ---------------------------------------------------------------------------

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

    let toneContext = '';
    const toneSample = structured.tone_sample;
    if (toneSample) {
      toneContext = `\nVOICE REFERENCE — this is how the founder Jamie actually writes to customers. Match this tone:\n> "${toneSample.message}"\n`;
    }

    try {
      const supabase = require('../../shared/supabaseClient').getSupabaseClient();
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
- Do NOT add a sign-off UNLESS the draft already has one (like "Take care,")
- Do NOT use emojis
- NEVER rearrange the donation/return section. If the draft has an address block (RUBIES Returns / c/o ...), keep it EXACTLY as written including line breaks and ordering. The address block, description, "Your return will be greatly appreciated" line, and "Take care," sign-off must stay in the exact order from the draft.
${customerName ? `- Customer name: ${customerName}` : '- No customer name detected — use "Hi!" not a name'}
${isThirdParty ? `- This is a third-party purchase for their ${thirdPartyLabel} — use appropriate pronouns` : ''}

Return ONLY the polished response text. No explanation.`
      }],
    });

    return result.content[0]?.text || rawResponse;
  } catch (e) {
    console.error('[polishResponse] AI polish failed, using raw:', e.message);
    return rawResponse;
  }
}

module.exports = { composeAgentResponse, polishResponse };
