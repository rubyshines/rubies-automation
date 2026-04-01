/**
 * Exchange Advisor MCP Tools
 *
 * Architecture: AI Parser → Decision Tree → Structured Output
 *
 * 1. AI parser (Claude Sonnet) converts customer message → structured intake
 * 2. Decision tree (pure code) walks phases 0-7 → prescription per item
 * 3. Output includes both markdown (for display) and _structured (for programmatic use)
 *
 * Tools: exchange_advisor, log_donation_routing
 */

const { getSupabaseClient } = require('../../../shared/supabaseClient');
const { searchCustomers, getCustomerOrders, getOrderByNumber } = require('../shopify');
const { walkTree, normalizeSize, getSizeModifier, getMeasureLocation, _activeProducts, initCsConfig } = require('../decisionTree');
const { buildContext, analyzeOrders } = require('../contextBuilder');

// analyzeOrders() moved to contextBuilder.js — imported above

// ---------------------------------------------------------------------------
// Name & pronoun detection (used by regex fallback only)
// ---------------------------------------------------------------------------

function detectExplicitName(messageText) {
  if (!messageText) return null;
  const patterns = [
    /(?:i'm|i am|my name is|this is|it's)\s+([A-Z][a-z]{1,20})\b/i,
    /(?:thanks|cheers|regards|best|sincerely|love|xo)[,!]?\s*\n?\s*([A-Z][a-z]{1,20})\s*$/im,
    /\n\s*([A-Z][a-z]{1,20})\s*$/m,
  ];
  const falsePositives = new Set([
    'Hi', 'Hey', 'Hello', 'Thanks', 'Thank', 'Please', 'The', 'This',
    'My', 'Our', 'Your', 'Just', 'Also', 'And', 'But', 'Order', 'Size',
    'Sent', 'From', 'Iphone', 'Android', 'Gmail',
  ]);
  for (const pattern of patterns) {
    const match = messageText.match(pattern);
    if (match) {
      const name = match[1].trim();
      if (!falsePositives.has(name)) return name;
    }
  }
  return null;
}

function detectPronouns(messageText) {
  if (!messageText) return { pronouns: 'they/them', reason: 'default', isThirdParty: false };
  const lower = messageText.toLowerCase();

  const shePatterns = [
    /\b(?:my|our)\s+(?:daughter|girl|niece|granddaughter)\b/i,
    /\bshe\s+(?:is|was|has|had|loves|liked|needs|wanted|wears|wore|said|thinks|tried)\b/i,
    /\bfor\s+(?:my|our)\s+(?:daughter|girl|niece)\b/i,
    /\bher\s+(?:size|waist|measurement|order|birthday|comfort)\b/i,
  ];
  const hePatterns = [
    /\b(?:my|our)\s+(?:son|boy|nephew|grandson)\b/i,
    /\bhe\s+(?:is|was|has|had|loves|liked|needs|wanted|wears|wore|said|thinks|tried)\b/i,
    /\bfor\s+(?:my|our)\s+(?:son|boy|nephew)\b/i,
    /\bhis\s+(?:size|waist|measurement|order|birthday|comfort)\b/i,
  ];
  const neutralThirdParty = [
    /\b(?:my|our)\s+(?:kid|kiddo|child|little one|teen|teenager|young one|baby)\b/i,
    /\b(?:my|our)\s+(?:partner|spouse|significant other)\b/i,
    /\bfor\s+(?:my|our)\s+(?:kid|kiddo|child|partner)\b/i,
    /\btheir\s+(?:size|waist|measurement|order|birthday|comfort)\b/i,
  ];

  for (const p of shePatterns) {
    const match = lower.match(p);
    if (match) {
      const labelMatch = messageText.match(/\b(?:my|our)\s+(daughter|girl|niece|granddaughter)\b/i);
      return { pronouns: 'she/her', reason: `customer referred to "${match[0].trim()}"`, isThirdParty: true, thirdPartyLabel: labelMatch ? labelMatch[1].toLowerCase() : 'her' };
    }
  }
  for (const p of hePatterns) {
    const match = lower.match(p);
    if (match) {
      const labelMatch = messageText.match(/\b(?:my|our)\s+(son|boy|nephew|grandson)\b/i);
      return { pronouns: 'he/him', reason: `customer referred to "${match[0].trim()}"`, isThirdParty: true, thirdPartyLabel: labelMatch ? labelMatch[1].toLowerCase() : 'him' };
    }
  }
  for (const p of neutralThirdParty) {
    const match = lower.match(p);
    if (match) {
      const labelMatch = messageText.match(/\b(?:my|our)\s+(kid|kiddo|child|little one|teen|teenager|partner|spouse)\b/i);
      return { pronouns: 'they/them', reason: `customer said "${match[0].trim()}" — no gendered pronoun indicated`, isThirdParty: true, thirdPartyLabel: labelMatch ? labelMatch[1].toLowerCase() : 'them' };
    }
  }
  return { pronouns: 'they/them', reason: 'default — no pronouns indicated', isThirdParty: false };
}

// ---------------------------------------------------------------------------
// Structured Intake
// ---------------------------------------------------------------------------

function createEmptyIntake() {
  return {
    status: 'gathering',
    message_type: null,
    customer_intent: null,
    items: [],
    order_number: null,
    conversation_email: null,
    order_email: null,
    email_mismatch: false,
    name: null,
    pronouns: null,
    pronoun_reason: null,
    buying_for: null,
    third_party_label: null,
    issue_type: null,
    measurement: null,
    item_count: null,
    multi_item_confirmed: null,
    resolution_sizes: [],
    refund_eligible: null,
    donation_routing: null,
    notes: [],
  };
}

// ---------------------------------------------------------------------------
// AI-powered intake parser
// ---------------------------------------------------------------------------

const Anthropic = require('@anthropic-ai/sdk');
let _anthropicClient = null;
function getAnthropicClient() {
  if (!_anthropicClient) _anthropicClient = new Anthropic();
  return _anthropicClient;
}

const INTAKE_PARSE_PROMPT = `You are parsing a customer service message from RUBIES, a gender-affirming underwear brand. Extract structured data from this message.

RUBIES products: AJ, Charlie, Brooke, Ruby (youth/numeric sizes: 4,6,7,8,9,10,11,12,13,14,16), Ava, Cheeky, Sassy, Flo Dance (adult/letter sizes: XXS,XXS+,XS,XS+,S,M,L,1X,2X,3X,4X), Brooke Bra (tops), Serena Shorty Shorts, Sky One-Piece, Queeny Tankini, Stella Bikini Bottoms.${Object.values(_activeProducts).length > 0 ? ' ' + Object.values(_activeProducts).map(p => `${p.nickname} (${p.category}${p.sizes ? ', sizes: ' + p.sizes.join(',') : ''})`).join(', ') + '.' : ''}

Size aliases: XL=1X, XXL=2X, 3XL=3X, 4XL=4X. Numeric-to-letter: 10=XXS, 12=XS, 14=S, 16=M.

Return JSON:
{
  "name": string or null — ONLY if they explicitly introduce themselves (sign-off "— Sarah", "I'm Alex"). NEVER guess from email.,
  "pronouns": "she/her" | "he/him" | "they/them" — only gendered if explicit ("my daughter"→she/her, "my son"→he/him). Default they/them.,
  "pronoun_reason": string — why you chose these pronouns,
  "buying_for": "self" | "third_party" | "unclear",
  "third_party_label": string or null — "daughter", "son", "kiddo", "partner", etc.,
  "order_number": string or null — extract order number if mentioned,
  "message_type": "exchange" | "refund" | "defect" | "product_not_working" | "cancellation" | "missing_item" | "wrong_item_shipped" | "sizing_inquiry" | "shipping" | "order_modification" | "product_question" | "wholesale" | "closing" | "return_shipped" | "general_inquiry",
  "sentiment": "kind_words" | "grateful" | "frustrated" | "neutral" | null,
  "customer_intent": "exchange_same_product" | "exchange_different_product" | "refund" | "unsure" | "cancellation" | null,
  "items": [
    {
      "product": string — product name as close to catalog as possible,
      "size": string or null — their CURRENT size (what they have now),
      "color": string or null,
      "issue": "close_fit_tight" | "close_fit_loose" | "doesnt_fit" | "way_off" | "product_not_working" | "product_not_working_loose" | "product_not_working_tight" | "expectation_mismatch" | "defect" | "tight_legs" | "onepiece_fit" | "too_short" | "too_long" | "wrong_item" | "missing" | "none" | "unclear",
      "desired_size": string or null — ONLY if customer named a SPECIFIC size (e.g. "size L", "a 14"). Do NOT fill this in if they said "next size up" or "one size down" — those are directions not specific sizes.,
      "desired_product": string or null — if they want a DIFFERENT product instead (style switch). E.g. customer has Sky One-Piece but says "I'd like to try the tankini instead" → desired_product = "Queeny Tankini"
    }
  ],
  "measurements": [{ "value": number, "unit": "inches" | "cm", "body_part": "waist" | "chest" | "hips" | "height" }] or [] — extract ALL measurements mentioned with the correct body part. "waist" = around the belly just under the belly button. "hips" = around the widest part of the hips/butt. "chest" = where a bra band sits. IMPORTANT: waist and hips are DIFFERENT measurements — do not confuse them. If customer says "32 waist and 37 hips" those are two separate measurements.,
  "is_confirmation": boolean — is this message confirming a previous suggestion? ("yes", "sounds good", "go ahead"),
  "confirmed_size": string or null — if confirming, what size are they confirming?,
  "reference_size": { "product": string, "size": string } or null — if the customer mentions a size that fits them in another product ("I wear size 8 in the AJ"), extract it here. This helps recommend sizing for a new product.,
  "safety_concern": boolean — does the message indicate danger, hiding items, unsafe situation?,
  "positive_feedback": boolean — DEPRECATED, use sentiment field instead. Keep for backward compatibility.,
  "notes": string or null — anything else notable
}

IMPORTANT:
- For names: ONLY extract if they explicitly introduce themselves. "Hi Jamie" is addressing the agent, not their name.
- For sizes: normalize to catalog format (M not Medium, 1X not XL, 14 not fourteen).
- For items: if they say "underwear" without a product name, put "underwear" as product. If "bikini bottom" put that. Be specific. ONLY create items for what the customer CURRENTLY HAS and wants to exchange. Do NOT create items for sizes mentioned in conversation history as previous exchanges or recommendations. For example if the conversation says "the replacement was a L" and the customer says it doesn't fit, create ONE item with size L — do NOT also create an item for whatever size they had before the replacement.
- For issue: "a bit tight/slightly tight/snug" = close_fit_tight. "too small/too tight" = close_fit_tight. "a bit loose/slightly loose" = close_fit_loose. "too big/too loose/baggy/sags/bunches/bunching/not tight enough" = close_fit_loose. If the waist fits fine but the product is loose/bunching elsewhere (front, legs, etc.), that's still close_fit_loose — the overall garment is too big even if the waist is OK. "WAY too big/WAY too small/much too small/much too big/completely wrong/totally wrong size/not even close" = way_off — use this when the customer emphasizes severity with "way", "much", "completely", "totally", or says it's for someone else and it's clearly the wrong size range. "ripped/hole/seam/broken strap" = defect. "doesn't fit/not the right fit/fit issue" WITHOUT specifying tight or loose = doesnt_fit (NOT close_fit_tight or close_fit_loose — we need to ask direction). "doesn't hide/doesn't conceal/can still see/still visible/not flat/doesn't flatten/shows through" = expectation_mismatch (the customer expected flattening but RUBIES shapes, not flattens). "doesn't work" WITHOUT specifics = product_not_working (we need to probe further). IMPORTANT: If customer says "not working/shaping not working" AND also gives a fit clue like "too loose" or "too tight", use product_not_working_loose or product_not_working_tight — this means they understand the product but think the fit is causing the issue.
- EXCLUSIONS: If the customer says "just the X" or "only the X" or "not the Y" or "the Y fits fine", ONLY include the items they want to exchange. Do NOT include items they explicitly said are fine or excluded. For example "just the AJ, the Ruby fits fine" means ONLY the AJ goes in items — do NOT include the Ruby.
- When confirming a size, only apply it to the items the customer is actually exchanging. If they say "1X for the AJ" don't apply 1X to other products.
- RETURNS: "I want to return", "can I return", "I'd like to send back", "return for a refund", "not her style", "wasn't for me" → for the SPECIFIC item being returned, set issue = "refund_request". If the ENTIRE message is about returning (no exchanges), also set message_type = "refund". But if the message is mixed (some items exchanging, some returning), set message_type = "exchange" and use issue = "refund_request" on the individual return items. A "return" means the customer wants their money back, not an exchange. Don't confuse with "exchange" or "swap".
- PRE-PURCHASE SIZING: "what size should I get", "what size for my daughter", "what size fits a 34 waist", "help me choose a size" → message_type = "sizing_inquiry". They have NO order yet — they want to know what size to BUY. Extract product, measurements, kid/adult context. Set item issue = "none".
- SHIPPING: "where's my order", "tracking number", "when will it arrive", "hasn't shipped" → message_type = "shipping"
- ORDER MODIFICATION: "can I cancel", "change my address", "add an item", "modify my order" → message_type = "order_modification"
- PRODUCT QUESTION: "what's the difference between", "do you have X in pink", "what material", "how does it work" → message_type = "product_question"
- WHOLESALE: "wholesale", "bulk order", "retail partner", "stock your products" → message_type = "wholesale"
- STYLE SWITCH: If the customer says they want to try a DIFFERENT product (not just a different size), set customer_intent = "exchange_different_product" and fill in desired_product on each item. CRITICAL: You MUST set desired_product on the items array. Examples:
  - "I'd like to try the tankini instead of the one-piece" → items: [{ product: "Sky One-Piece", size: "L", issue: "onepiece_fit", desired_product: "Queeny Tankini", desired_size: "L" }]
  - "She wants a tankini top and a bikini bottom instead" → items: [{ product: "Sky One-Piece", size: "L", issue: "onepiece_fit", desired_product: "Queeny Tankini", desired_size: "L" }, { product: "Sky One-Piece", size: "L", issue: "onepiece_fit", desired_product: "Stella Bikini Bottom", desired_size: "M" }]
  - "can I swap the Ruby for the Cheeky" → items: [{ product: "Ruby", size: "10", issue: "tight_legs", desired_product: "Cheeky", desired_size: null }]
  If they specify sizes for the new products, set desired_size. If exchanging one product for multiple new ones, create one item per desired product with the original product in "product" and each new product in "desired_product".
- CLOSING: Customer wrapping up a conversation — "thank you!", "sounds good", "no worries", "thanks for the refund" → message_type = "closing"
- RETURN SHIPPED: Customer confirming they sent items back — "I shipped them to the address", "dropped them off at the donation center", "sent them today" → message_type = "return_shipped"
- SENTIMENT: Set the "sentiment" field based on the customer's tone:
  - "kind_words": customer praises RUBIES or the community work ("I love your business", "thank you for supporting trans girls", "what you do is amazing")
  - "grateful": customer thanking for help/action ("thanks for the refund", "appreciate your help")
  - "frustrated": customer expressing disappointment ("this is the second time", "really disappointed", "not working at all")
  - "neutral": just transactional, no strong emotion
  - null: can't determine
  - NOTE: sentiment is INDEPENDENT of message_type. A "closing" message can have "kind_words" sentiment. An "exchange" message can have "frustrated" sentiment.
- CONVERSATION CONTEXT: The message may include a [CONVERSATION HISTORY] section showing previous messages in the thread. Use this to understand what has already been discussed. Key rules:
  - If the conversation was already resolved (agent processed a refund/exchange) and customer is just saying "thank you" or "thanks" → message_type = "positive_feedback"
  - If the customer already explained the issue in previous messages and is now confirming or insisting → set is_confirmation = true or capture their intent accurately
  - If the agent already asked about sizing and the customer is providing measurements → extract the measurements
  - If the customer says they "emailed before" or "following up" → note this in "notes" field
  - A [PREVIOUS AI PROCESSING] section may show what was already parsed, decided, and sent in earlier turns. Use this to avoid re-asking questions or re-recommending sizes. If donation info was already provided, don't repeat it.
  - Focus on the [LATEST CUSTOMER MESSAGE] for the actual request, but use history for context
  - NEVER ask the customer to repeat information they already provided in the conversation history
  - If the customer already confirmed they want a return/refund in previous messages, set customer_intent = "refund" and message_type = "refund"

Return ONLY JSON. No explanation.`;

/**
 * AI-powered intake parser. Converts unstructured customer message to structured data.
 * @param {string} messageText - Customer's latest message
 * @param {Object|null} existingIntake - Intake from previous call (progressive)
 * @param {Array|null} orderItems - Order line items for context
 */
async function parseExchangeIntake(messageText, existingIntake, orderItems) {
  const intake = existingIntake
    ? { ...existingIntake, items: [...(existingIntake.items || [])], resolution_sizes: [...(existingIntake.resolution_sizes || [])], notes: [...(existingIntake.notes || [])] }
    : createEmptyIntake();
  if (!messageText) return intake;

  // Build order context for the AI
  let orderContext = '';
  if (orderItems && orderItems.length > 0) {
    orderContext = '\n\nORDER ITEMS (use these to match what the customer is referring to):\n';
    for (const li of orderItems) {
      const size = li._skuSize || li.variantTitle || 'unknown';
      orderContext += `- ${li.quantity}x ${li.title} — size: ${size} (SKU: ${li.sku || 'n/a'})\n`;
    }
    orderContext += '\nIMPORTANT: Use the size shown above (derived from SKU) as the definitive current size. When the customer refers to a product, match it to one of these order items and return that size.';
  }

  // Call AI
  let parsed = null;
  try {
    const ai = getAnthropicClient();
    const response = await ai.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [{ role: 'user', content: INTAKE_PARSE_PROMPT + orderContext + '\n\nCustomer message:\n' + messageText.slice(0, 2000) }],
    });
    const text = response.content[0]?.text || '{}';
    parsed = JSON.parse(text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim());
  } catch (e) {
    console.error('[intakeParser] AI parse failed, falling back to regex:', e.message);
    parsed = regexFallbackParse(messageText);
  }

  // Merge into intake (never overwrite confirmed data)
  if (!intake.name && parsed.name) intake.name = parsed.name;

  if (parsed.pronouns && parsed.pronouns !== 'they/them') {
    intake.pronouns = parsed.pronouns;
    intake.pronoun_reason = parsed.pronoun_reason || null;
  } else if (!intake.pronouns) {
    intake.pronouns = parsed.pronouns || 'they/them';
    intake.pronoun_reason = parsed.pronoun_reason || 'default';
  }

  if (!intake.buying_for && parsed.buying_for) intake.buying_for = parsed.buying_for;
  if (!intake.third_party_label && parsed.third_party_label) intake.third_party_label = parsed.third_party_label;
  if (!intake.order_number && parsed.order_number) intake.order_number = parsed.order_number;
  if (!intake.message_type && parsed.message_type && parsed.message_type !== 'unclear') intake.message_type = parsed.message_type;
  if (!intake.customer_intent && parsed.customer_intent) intake.customer_intent = parsed.customer_intent;
  if (parsed.sentiment) intake.sentiment = parsed.sentiment;

  // Items
  // If a try-size swap is pending, don't add new items — the customer's product choice
  // is the swap resolution, not a new exchange request
  const hasPendingSwap = intake.items.some(i => i._pendingTrySizeSwap && !i.resolved_size);
  if (parsed.items?.length && !hasPendingSwap) {
    // Clear body group clarification flag if customer is now specifying items
    if (intake._needsItemClarification) {
      const preservedIssue = intake._preservedIssue;
      const preservedMessage = intake._preservedMessage;
      delete intake._needsItemClarification;
      delete intake._preservedIssue;
      delete intake._preservedMessage;
      // Apply the preserved issue to newly added items if they don't have a specific one
      if (preservedIssue) intake._applyIssueToNewItems = preservedIssue;
      // Restore the original message so isABit/confidence check works
      if (preservedMessage) intake._originalFitMessage = preservedMessage;
    }
    for (const aiItem of parsed.items) {
      const aiProdLower = (aiItem.product || '').toLowerCase();
      const existing = intake.items.find(i => {
        const existingLower = (i.product || '').toLowerCase();
        // Exact match, or one contains the other, or both share a nickname
        if (existingLower === aiProdLower) return true;
        if (existingLower.includes(aiProdLower) || aiProdLower.includes(existingLower)) return true;
        const existingNick = require('../decisionTree').getProductNickname(i.product)?.toLowerCase();
        const aiNick = require('../decisionTree').getProductNickname(aiItem.product)?.toLowerCase();
        if (existingNick && aiNick && existingNick === aiNick) return true;
        return false;
      });
      if (existing) {
        if (!existing.size && aiItem.size) existing.size = normalizeSize(aiItem.size);
        if (!existing.color && aiItem.color) existing.color = aiItem.color;
        // Allow upgrading issue from vague/general to specific
        // product_not_working can upgrade to expectation_mismatch, close_fit_tight, etc.
        const vagueIssues = new Set(['doesnt_fit', 'product_not_working', 'unclear', 'none', null, undefined]);
        if (vagueIssues.has(existing.issue) && aiItem.issue && !vagueIssues.has(aiItem.issue)) existing.issue = aiItem.issue;
        if (!existing.desired_size && aiItem.desired_size) {
          existing.desired_size = normalizeSize(aiItem.desired_size);
          const mod = getSizeModifier(aiItem.desired_size);
          if (mod) existing._variant_modifier = mod;
        }
        // Don't promote desired_size to resolved_size — let the decision tree handle it
        // (it checks for intermediates on swim/onepiece products before confirming)
      } else {
        const desiredMod = aiItem.desired_size ? getSizeModifier(aiItem.desired_size) : null;
        const sizeMod = aiItem.size ? getSizeModifier(aiItem.size) : null;
        intake.items.push({
          product: aiItem.product,
          size: aiItem.size ? normalizeSize(aiItem.size) : null,
          color: aiItem.color || null,
          issue: aiItem.issue && aiItem.issue !== 'unclear' ? aiItem.issue : (intake._applyIssueToNewItems || intake.issue_type || null),
          desired_size: aiItem.desired_size ? normalizeSize(aiItem.desired_size) : null,
          resolved_size: null, // Let the decision tree handle confirmation (checks intermediates)
          resolved_product: aiItem.desired_product || null,
          _variant_modifier: desiredMod || sizeMod || null,
        });
      }
    }
  }

  // When parser returns no items but the message clarifies fit direction,
  // apply it to any unresolved item with a vague issue (doesnt_fit, product_not_working, etc.)
  if ((!parsed.items || parsed.items.length === 0) && intake.items.length > 0) {
    const msgLower = (messageText || '').toLowerCase();
    let clarifiedIssue = null;
    if (/too tight|too small|too snug|waist.*tight|tight.*waist/.test(msgLower)) clarifiedIssue = 'close_fit_tight';
    else if (/too loose|too big|too large|waist.*loose|loose.*waist|baggy|bunching/.test(msgLower)) clarifiedIssue = 'close_fit_loose';
    else if (/a bit tight|slightly tight|little tight/.test(msgLower)) clarifiedIssue = 'close_fit_tight';
    else if (/a bit loose|slightly loose|little loose/.test(msgLower)) clarifiedIssue = 'close_fit_loose';

    if (clarifiedIssue) {
      const vagueIssues = new Set(['doesnt_fit', 'product_not_working', 'unclear', 'none']);
      for (const item of intake.items) {
        if (!item.resolved_size && vagueIssues.has(item.issue)) {
          item.issue = clarifiedIssue;
        }
      }
    }
  }

  // Update issue_type from items — allow upgrading from vague to specific
  if (intake.items.length > 0) {
    const vagueIssueTypes = new Set(['doesnt_fit', 'product_not_working', 'unclear', 'none', null, undefined]);
    const firstSpecificIssue = intake.items.find(i => i.issue && !vagueIssueTypes.has(i.issue))?.issue;
    if (firstSpecificIssue && vagueIssueTypes.has(intake.issue_type)) {
      intake.issue_type = firstSpecificIssue;
    }
  }

  // Handle measurements — support both old single format and new array format
  // IMPORTANT: waist is the primary sizing measurement. Hips are noted but NOT used
  // for size lookup (size charts are waist-based). Chest is stored separately for tops.
  if (parsed.measurements?.length) {
    for (const m of parsed.measurements) {
      if (m.body_part === 'height') {
        intake.height_measurement = m;
      } else if (m.body_part === 'chest') {
        intake.chest_measurement = m;
      } else if (m.body_part === 'waist') {
        intake.measurement = m; // waist = primary for size lookup
      } else if (m.body_part === 'hips' || m.body_part === 'hip') {
        intake.hip_measurement = m; // noted but NOT used for size lookup
      } else {
        // Unknown body part — only use as primary if we don't already have a waist
        if (!intake.measurement) intake.measurement = m;
      }
    }
  } else if (!intake.measurement && parsed.measurement) {
    intake.measurement = parsed.measurement;
  }

  // Try-size swap handling: customer responded to "want to swap for something else?"
  // This fires BEFORE normal confirmation handling because the customer may name a new product
  // (e.g. "I'd love an AJ in 3X") which is_confirmation=true AND has a new product in parsed.items
  const pendingSwapItem = intake.items.find(i => i._pendingTrySizeSwap && !i.resolved_size);
  if (pendingSwapItem && intake._trySizeOffered) {
    // Check if customer chose a product (from parsed.items or from confirmation)
    const chosenProduct = parsed.items?.[0];
    if (chosenProduct && chosenProduct.product) {
      // Customer chose a swap — resolve the pending item
      pendingSwapItem.resolved_product = chosenProduct.product;
      const resolvedSize = chosenProduct.size ? normalizeSize(chosenProduct.size)
        : (chosenProduct.desired_size ? normalizeSize(chosenProduct.desired_size)
        : (parsed.confirmed_size ? normalizeSize(parsed.confirmed_size) : pendingSwapItem.size));
      pendingSwapItem.resolved_size = resolvedSize;
      intake.resolution_sizes.push({
        product: pendingSwapItem.resolved_product,
        from_size: pendingSwapItem.size,
        to_size: resolvedSize,
        from_product: pendingSwapItem.product,
      });
      delete pendingSwapItem._pendingTrySizeSwap;
      // Don't add the parsed item as a NEW intake item — it's the resolution
      parsed.items = [];
    } else if (/refund|money back|just return|no thanks|prefer a refund/i.test(messageText || '')) {
      // Customer declined — mark as refund and track that offer was made
      pendingSwapItem._pendingTrySizeSwap = false;
      pendingSwapItem.issue = 'refund_request';
      if (!intake._exchangeOffered) intake._exchangeOffered = {};
      intake._exchangeOffered[pendingSwapItem.product] = true;
    }
  }

  // Confirmation handling — only fires on subsequent messages when the tree has
  // already presented options and is waiting for a response. On the first message,
  // desired_size is set on the item instead and the tree handles it.
  const hasPendingState = intake.items.some(i => !i.resolved_size && (i._pendingStyleSwitch || intake._awaitingConfirmation));
  if (parsed.is_confirmation && intake.items.length > 0 && (hasPendingState || existingIntake)) {
    const unresolved = intake.items.find(i => !i.resolved_size);
    if (unresolved) {
      // Check for pending style switch (e.g., Ruby → Cheeky)
      if (unresolved._pendingStyleSwitch) {
        unresolved.resolved_product = unresolved._pendingStyleSwitch;
        // "same size" or no size specified → use current size
        const resolvedSize = parsed.confirmed_size ? normalizeSize(parsed.confirmed_size) : unresolved.size;
        unresolved.resolved_size = resolvedSize;
        intake.resolution_sizes.push({
          product: unresolved.resolved_product,
          from_size: unresolved.size,
          to_size: resolvedSize,
          from_product: unresolved.product,
        });
        delete unresolved._pendingStyleSwitch;
      } else if (parsed.confirmed_size || unresolved._pendingSize) {
        const resolvedSize = normalizeSize(parsed.confirmed_size || unresolved._pendingSize);
        unresolved.resolved_size = resolvedSize;
        delete unresolved._pendingSize;
        intake.resolution_sizes.push({ product: unresolved.product, from_size: unresolved.size, to_size: resolvedSize });
      }
    }
  }

  if (parsed.safety_concern) intake._safety_concern = true;
  if (parsed.positive_feedback) intake._positiveFeedback = true;
  if (parsed.reference_size && !intake._referenceSize) {
    intake._referenceSize = { product: parsed.reference_size.product, size: normalizeSize(parsed.reference_size.size) };
  }
  if (!intake.item_count) {
    if (intake.items.length > 1) intake.item_count = 'multiple';
    else if (intake.items.length === 1) intake.item_count = 'single';
  }
  if (parsed.notes) intake.notes.push(parsed.notes);

  intake.status = computeIntakeStatus(intake);
  return intake;
}

function regexFallbackParse(messageText) {
  const lower = messageText.toLowerCase();
  const result = { items: [] };

  const orderMatch = messageText.match(/#?\b(\d{4,6})\b/);
  if (orderMatch) {
    const num = parseInt(orderMatch[1], 10);
    if (num >= 1000 && num <= 999999) result.order_number = orderMatch[1];
  }

  result.name = detectExplicitName(messageText);
  const pronounInfo = detectPronouns(messageText);
  result.pronouns = pronounInfo.pronouns;
  result.pronoun_reason = pronounInfo.reason;
  if (pronounInfo.isThirdParty) {
    result.buying_for = 'third_party';
    result.third_party_label = pronounInfo.thirdPartyLabel;
  }

  if (/refund|money back/i.test(lower)) result.message_type = 'refund';
  else if (/defect|broken|ripped|torn|hole/i.test(lower)) result.message_type = 'defect';
  else if (/doesn't work|not working/i.test(lower)) result.message_type = 'product_not_working';
  else if (/exchange|swap|too tight|too loose|too big|too small|doesn't fit/i.test(lower)) result.message_type = 'exchange';

  const configNicknames = Object.values(_activeProducts).map(p => p.nickname);
  const allNicknames = ['AJ','Charlie','Brooke','Ruby','Ava','Cheeky','Sassy','Serena','Flo','Stella','Sky','Queeny', ...configNicknames];
  const productMatchRegex = new RegExp(`\\b(${[...new Set(allNicknames)].join('|')})\\b`, 'gi');
  const productMatch = messageText.match(productMatchRegex);
  if (productMatch) {
    for (const p of [...new Set(productMatch)]) {
      result.items.push({ product: p, size: null, issue: null });
    }
  }
  return result;
}

function computeIntakeStatus(intake) {
  if (intake.items.length > 0 && intake.items.every(i => i.resolved_size)) return 'ready';
  if (intake.items.length > 0 || intake.message_type) return 'needs_info';
  return 'gathering';
}

// ---------------------------------------------------------------------------
// Main handler: exchange_advisor
// ---------------------------------------------------------------------------

async function handleExchangeAdvisor({ customer_email, issue_description, order_number, intake: existingIntake }) {
  // Ensure product config is loaded (normally done at MCP server startup, but
  // needed for standalone/test usage too)
  if (Object.keys(_activeProducts).length === 0) await initCsConfig();

  const supabase = getSupabaseClient();

  // STEPS 0-2: Build shared context (customer + order lookup)
  const ctx = await buildContext({ customer_email, order_number, issue_description, existingIntake });
  let { customer, customerGid, customerCountry, isNorthAmerica, orders, fulfilled, exchanges, all, targetOrder, orderLineItems, effectiveOrderNumber } = ctx;

  // STEP 3: Parse message + route by message type
  const intake = await parseExchangeIntake(issue_description, existingIntake || null, orderLineItems);
  intake._latestMessage = issue_description;
  intake.conversation_email = customer_email;

  // Fallback: upgrade general_inquiry to sizing_inquiry if signals present
  if (intake.message_type === 'general_inquiry' && !effectiveOrderNumber && !existingIntake) {
    const hasMeasurement = intake.measurement || intake.height_measurement;
    const hasProduct = intake.items.length > 0;
    const sizingSignals = /what size|which size|size should|size for|size would|recommend.*size|help.*size/i.test(issue_description || '');
    if ((hasMeasurement || sizingSignals) && hasProduct) {
      intake.message_type = 'sizing_inquiry';
    }
  }

  // ── NON-EXCHANGE ROUTING ──
  // Route message types that don't need order context

  // Pre-purchase sizing — no order needed
  if (intake.message_type === 'sizing_inquiry' && !effectiveOrderNumber && !existingIntake?.order_number) {
    const { classifyProduct: classifyProd } = require('../decisionTree');
    const treeContext = {
      customer: customer || null,
      targetOrder: null, fulfilled: [], exchanges: [], all: [],
      customerCountry: customerCountry || 'US',
      isNorthAmerica: customerCountry ? ['US', 'CA'].includes(customerCountry) : true,
      orderHistory: [],
      measurementType: intake.items.some(i => require('../decisionTree').getChartCategory(i.product, false).measureType === 'chest') ? 'chest' : 'waist',
      isPrePurchase: true,
    };
    const treeResult = await walkTree(intake, treeContext);
    return buildAdvisorResponse(intake, treeResult, { customer, targetOrder: null, orderLineItems: [], fulfilled: [], exchanges: [], customerCountry, isNorthAmerica, toneSample: null });
  }

  // Shipping inquiry — sub-classify: tracking vs info
  if (intake.message_type === 'shipping' && !existingIntake) {
    const msg = (issue_description || '').toLowerCase();
    const isTrackingQuestion = effectiveOrderNumber
      || /where.?s my (order|package)|tracking|hasn.?t (shipped|arrived)|not (received|delivered|arrived)|still (waiting|in transit)|delivery (date|status)|when will (it|my)/i.test(msg);
    const isInfoQuestion = /do you (ship|deliver)|ship to|shipping (cost|rate|fee|charge|price)|how much.*(ship|deliver)|how long.*(ship|deliver|take)|deliver.* to|can (i|you) ship/i.test(msg);

    // Duties reimbursement — customer was charged import fees
    const isDutiesQuestion = /dut(y|ies)|customs|import (cost|fee|tax|charge)|aduana|inklaring|douane|zoll/i.test(msg)
      && /paid|charged|pay|reimburse|refund|receipt|comprobante/i.test(msg);

    if (isDutiesQuestion) {
      const { handleDutiesInquiry } = require('./shippingInfo');
      return handleDutiesInquiry({
        customer_email,
        issue_description,
        _context: { customer, order: targetOrder, customerMessage: issue_description, intake, customerCountry },
      });
    }

    if (isInfoQuestion && !isTrackingQuestion) {
      // Pre-purchase shipping info (rates, countries, delivery times)
      const { handleShippingInfo } = require('./shippingInfo');
      return handleShippingInfo({
        customer_email,
        issue_description,
        _context: { customer, customerMessage: issue_description, intake },
      });
    }

    // Default: tracking lookup
    const shippingTools = require('./shippingLookup');
    const shippingHandler = shippingTools.find(t => t.name === 'shipping_lookup').handler;
    return shippingHandler({
      customer_email,
      order_number: effectiveOrderNumber || undefined,
      _context: { customer, order: targetOrder, orders, customerMessage: issue_description, intake },
    });
  }

  // Order modification — sub-classify address changes vs other mods
  if (intake.message_type === 'order_modification' && !existingIntake) {
    const msg = (issue_description || '').toLowerCase();
    const isAddressChange = /address|wrong (city|zip|street|house)|shipped to.*(old|wrong|incorrect)|forgot.*(apartment|apt|unit|suite|house number|number)/i.test(msg);

    if (isAddressChange) {
      const { handleAddressChange } = require('./shippingInfo');
      return handleAddressChange({
        customer_email,
        issue_description,
        _context: { customer, order: targetOrder, customerMessage: issue_description, intake },
      });
    }

    const isShippingSpeedChange = /expedit|express|fast|rush|overnight|upgrade.*ship|downgrade.*ship|change.*shipping (speed|method)|normal ship|standard ship|slower ship/i.test(msg);

    if (isShippingSpeedChange) {
      const { handleShippingSpeedChange } = require('./shippingInfo');
      return handleShippingSpeedChange({
        customer_email,
        issue_description,
        _context: { customer, order: targetOrder, customerMessage: issue_description, intake },
      });
    }
  }

  // Future routing stubs — acknowledge + route to human
  const stubTypes = {
    order_modification: "I'll look into that for you.",
    product_question: "Great question!",
    wholesale: "Thanks for your interest in wholesale!",
    wrong_item_shipped: "I'm sorry about that mix-up! Let me look into this and get the right items sent over.",
    missing_item: "I'm sorry to hear that. Let me look into this right away.",
    cancellation: "I'll look into that for you.",
    general_inquiry: "Thanks for reaching out!",
  };
  if (stubTypes[intake.message_type] && !existingIntake) {
    const stubText = stubTypes[intake.message_type];
    return {
      content: [{ type: 'text', text: `${stubText} Let me get back to you on this.` }],
      _structured: {
        status: 'route_to_human',
        intake,
        prescription: { items: [{ product: null, state: 'ROUTE_TO_HUMAN', response_text: stubText }], donation: null, crossover_note: null, still_needed: [], flags: [] },
        customer: { email: customer_email, name: intake.name, pronouns: intake.pronouns, buying_for: intake.buying_for, third_party_label: intake.third_party_label, country: customerCountry, address: customer?.defaultAddress },
        order: null,
        exchanges: [],
        tone_sample: null,
        audit: [`Message type: ${intake.message_type} — routed to human`],
      },
    };
  }

  // Positive feedback — warm acknowledgment
  // Closing messages — customer wrapping up or confirming return shipment
  if ((intake.message_type === 'closing' || intake.message_type === 'positive_feedback') && !existingIntake) {
    const hasKindWords = intake.sentiment === 'kind_words';
    const responseText = hasKindWords
      ? "Thanks so much for your kind words!"
      : "Thanks so much!";
    return {
      content: [{ type: 'text', text: responseText }],
      _structured: {
        status: 'complete', intake,
        prescription: { items: [{ product: null, state: 'ACKNOWLEDGED', response_text: responseText }], donation: null, crossover_note: null, still_needed: [], flags: [] },
        customer: { email: customer_email, name: intake.name, pronouns: intake.pronouns, buying_for: intake.buying_for, third_party_label: intake.third_party_label, country: customerCountry, address: customer?.defaultAddress },
        order: null, exchanges: [], tone_sample: null,
        audit: [hasKindWords ? 'Closing with kind words — acknowledged warmly' : 'Closing — brief acknowledgment'],
        _composedResponse: responseText,
      },
    };
  }

  if (intake.message_type === 'return_shipped' && !existingIntake) {
    const responseText = "Thanks so much for sending those back!";
    return {
      content: [{ type: 'text', text: responseText }],
      _structured: {
        status: 'complete', intake,
        prescription: { items: [{ product: null, state: 'ACKNOWLEDGED', response_text: responseText }], donation: null, crossover_note: null, still_needed: [], flags: [] },
        customer: { email: customer_email, name: intake.name, pronouns: intake.pronouns, buying_for: intake.buying_for, third_party_label: intake.third_party_label, country: customerCountry, address: customer?.defaultAddress },
        order: null, exchanges: [], tone_sample: null,
        audit: ['Return shipped — customer confirmed items sent back'],
        _composedResponse: responseText,
      },
    };
  }

  // ── EXCHANGE/REFUND/DEFECT FLOW — needs customer + order ──
  if (!customer) {
    return {
      content: [{ type: 'text', text: 'No customer found for email: ' + customer_email + '. If they have an order number, ask for it — they may have ordered under a different email.' }],
      _structured: { status: 'error', error: 'customer_not_found', intake: existingIntake || createEmptyIntake() },
    };
  }

  // Detect variant modifier (Tall/Regular) from order SKU for one-piece items
  // SKU format: SKY2-BLK-LT → "LT" = L Tall, SKY2-BLK-L → "L" = L Regular
  for (const intakeItem of intake.items) {
    if (intakeItem._variant_modifier) continue; // already set
    const matchedOi = orderLineItems.find(oi => {
      const nick = require('../decisionTree').getProductNickname(oi.title)?.toLowerCase();
      return nick && intakeItem.product?.toLowerCase().includes(nick);
    });
    if (matchedOi?._rawSkuSize) {
      const mod = getSizeModifier(matchedOi._rawSkuSize);
      if (mod) intakeItem._variant_modifier = mod;
    }
  }

  if (customer.email && customer.email.toLowerCase() !== customer_email.toLowerCase()) {
    intake.order_email = customer.email;
    intake.email_mismatch = true;
  } else {
    intake.order_email = customer.email;
  }

  if (targetOrder?.createdAt && intake.refund_eligible === null) {
    const daysSince = Math.floor((Date.now() - new Date(targetOrder.createdAt).getTime()) / 86400000);
    intake.refund_eligible = daysSince <= 60 ? true : 'generous';
  }

  // STEP 3b: Multi-item expansion
  // When customer says "these underwear" or refers to one product generically,
  // but the order has multiple line items of the same product in the same size
  // (e.g. 3x AJ in size 10, different colors), ensure intake reflects all of them.
  // The tree's multi-item logic handles flagging; here we just make sure the
  // intake item knows the correct quantity from the order.
  if (intake.items.length >= 1 && targetOrder) {
    for (const intakeItem of intake.items) {
      if (!intakeItem.size) continue;
      const normalizedSize = normalizeSize(intakeItem.size);
      const intakeWords = (intakeItem.product || '').toLowerCase().split(/\s+/).filter(w => w.length > 1 && w !== 'the');

      // Count matching order line items (same product, same size, possibly different colors)
      let matchingQty = 0;
      const matchingColors = [];
      for (const oi of orderLineItems) {
        const oiTitleLower = (oi.title || '').toLowerCase();
        const oiSize = oi._skuSize;
        const isSameProduct = intakeWords.length > 0 && intakeWords.every(w => oiTitleLower.includes(w));
        // Also match generic "underwear" to any underwear product
        const isGenericMatch = (intakeItem.product || '').toLowerCase() === 'underwear' && !oiTitleLower.match(/bra|top|mia|halter|tankini|chest pad|pad|shorts|one-piece|bikini/);
        if ((isSameProduct || isGenericMatch) && oiSize === normalizedSize) {
          matchingQty += oi.quantity;
          const colorMatch = oi.variantTitle?.match(/^([^/]+)/);
          if (colorMatch) matchingColors.push(colorMatch[1].trim());
          // If generic "underwear" matched, update the product name to the real product
          if (isGenericMatch && !isSameProduct) {
            intakeItem.product = oi.title;
          }
        }
      }
      if (matchingQty > 1) {
        intakeItem._orderQty = matchingQty;
        intakeItem._orderColors = matchingColors;
      }
    }
  }

  // STEP 3c: Multi-size expansion
  // When customer ordered the same product in multiple sizes and says ALL are affected
  // (e.g. "both are too small"), expand into one intake item per size.
  if (intake.items.length >= 1 && targetOrder) {
    const latestMsg = (intake._latestMessage || '').toLowerCase();
    const allAffected = /both|all|neither|too small|too big|way too|don't fit|dont fit/i.test(latestMsg);

    if (allAffected) {
      const itemsToAdd = [];
      for (const intakeItem of intake.items) {
        if (!intakeItem.product) continue;
        const intakeProdLower = intakeItem.product.toLowerCase();
        const intakeNick = require('../decisionTree').getProductNickname(intakeItem.product)?.toLowerCase();

        // Find all order line items for this product in DIFFERENT sizes
        for (const oi of orderLineItems) {
          const oiNick = require('../decisionTree').getProductNickname(oi.title)?.toLowerCase();
          const oiTitleLower = (oi.title || '').toLowerCase();
          const isSameProduct = (intakeNick && oiNick && intakeNick === oiNick)
            || (intakeProdLower.length > 2 && oiTitleLower.includes(intakeProdLower));
          if (!isSameProduct) continue;

          const oiSize = oi._skuSize;
          if (!oiSize || oiSize === normalizeSize(intakeItem.size)) continue;

          const alreadyExists = intake.items.some(i =>
            i.product === intakeItem.product && normalizeSize(i.size) === oiSize
          ) || itemsToAdd.some(i => i.product === intakeItem.product && normalizeSize(i.size) === oiSize);

          if (!alreadyExists) {
            itemsToAdd.push({
              product: intakeItem.product,
              size: oiSize,
              color: intakeItem.color,
              issue: intakeItem.issue,
              desired_size: null,
              resolved_size: null,
              resolved_product: null,
              _variant_modifier: null,
            });
          }
        }
      }
      intake.items.push(...itemsToAdd);
    }
  }

  // STEP 3e: Body group ambiguity check
  // When customer says "these" or "everything" without specifying products, and the order
  // has items across different body groups (tops vs bottoms), ask which items they mean.
  // Auto-assume all only when items are in the same body group.
  const { classifyProduct: classifyProd } = require('../decisionTree');
  if (!existingIntake && intake.items.length > 1 && !intake._bodyGroupConfirmed) {
    const ACCESSORY_CATEGORIES = new Set(['accessory', 'chest_pads', null, undefined]);
    const nonAccessoryItems = intake.items.filter(i => {
      const cat = classifyProd(i.product);
      return !ACCESSORY_CATEGORIES.has(cat);
    });
    if (nonAccessoryItems.length > 1) {
      const bodyGroups = new Set();
      for (const item of nonAccessoryItems) {
        const cat = classifyProd(item.product) || '';
        if (cat.includes('top') || cat.includes('bra')) bodyGroups.add('top');
        else if (cat === 'onepiece') bodyGroups.add('onepiece');
        else bodyGroups.add('bottom'); // underwear_bottom, swim_bottom
      }
      if (bodyGroups.size > 1) {
        // Check if customer was specific — different issues per item means they named each one
        const uniqueIssues = new Set(nonAccessoryItems.map(i => i.issue).filter(Boolean));
        const msgLower = (intake._latestMessage || '').toLowerCase();
        const usedVagueLanguage = /everything|all of|these|they all|whole order/.test(msgLower);
        // Customer was specific if: different issues per item, OR didn't use vague language
        const customerWasSpecific = uniqueIssues.size > 1 || !usedVagueLanguage;

        if (customerWasSpecific) {
          // Customer named specific products with specific issues — trust it
          intake._bodyGroupConfirmed = true;
        } else {
          // Vague — all same issue, all order items included — ask which ones
          const preservedIssue = nonAccessoryItems[0]?.issue || intake.issue_type;
          intake.items = [];
          intake._needsItemClarification = true;
          intake._preservedIssue = preservedIssue;
          intake._preservedMessage = intake._latestMessage;
        }
      }
    }
  }

  intake.status = computeIntakeStatus(intake);

  // STEP 3b: Handle style switch — customer wants different products
  // If no sizing issue mentioned, assume same size and auto-confirm the swap.
  // Only ask for measurements if there's a sizing issue too.
  if (intake.customer_intent === 'exchange_different_product') {
    const hasSizingIssue = intake.items.some(i => i.issue && i.issue !== 'none' && i.issue !== 'unclear' && i.issue !== null);

    if (!hasSizingIssue) {
      // Straight product swap at same size — auto-confirm and respond directly
      for (const item of intake.items) {
        if (!item.resolved_size) item.resolved_size = item.desired_size || item.size;
        if (item.desired_product && !item.resolved_product) item.resolved_product = item.desired_product;
      }

      // Detect the swap details for the response
      const swapDescs = intake.items.map(i => {
        const fromNick = require('../decisionTree').getProductNickname(i.product) || i.product;
        const toNick = require('../decisionTree').getProductNickname(i.resolved_product || i.product) || i.resolved_product || i.product;
        return `the ${fromNick} for a ${toNick} in size ${i.resolved_size}`;
      });
      const swapText = swapDescs.join(' and ');
      const responseText = `No problem. I went ahead and swapped ${swapText} for you.`;
      const audit = [`[Style switch] Straight product swap, no sizing issue. Auto-confirmed: ${swapText}`];

      return {
        content: [{ type: 'text', text: `## Product Swap\n\n**Customer response:**\n${responseText}` }],
        _structured: {
          status: 'ready',
          intake,
          prescription: {
            items: intake.items.map(i => ({
              product: i.product,
              state: 'CONFIRMED',
              response_text: responseText,
              options: null,
              recommendation: null,
            })),
            donation: null,
            crossover_note: null,
            still_needed: [],
            flags: [],
          },
          customer: { email: customer_email, name: intake.name, pronouns: intake.pronouns, buying_for: intake.buying_for, third_party_label: intake.third_party_label, country: customerCountry, address: customer?.defaultAddress },
          order: targetOrder ? {
            name: targetOrder.name,
            date: targetOrder.createdAt?.split('T')[0],
            items: orderLineItems.map(li => ({ title: li.title, variant: li.variantTitle, quantity: li.quantity, sku: li.sku })),
          } : null,
          exchanges: exchanges.slice(0, 3).map(ex => ({ name: ex.name, items: (ex.lineItems || []).map(li => li.title) })),
          tone_sample: null,
          audit,
          phases_completed: ['safety_check', 'identify_customer', 'order_identification', 'style_switch', 'order_creation'],
          _composedResponse: responseText,
        },
      };
    } else if (!intake.measurement && !intake.chest_measurement) {
    // Detect which product categories the customer wants (from desired_product or raw message)
    const msg = (issue_description || '').toLowerCase();
    const wantsTop = intake.items.some(i => i.desired_product && /bra|top|tankini/i.test(i.desired_product)) ||
      /tankini|bra|top/i.test(msg);
    const wantsBottom = intake.items.some(i => i.desired_product && /bottom|bikini|cheeky|ruby|stella/i.test(i.desired_product)) ||
      /bikini bottom|bottom|cheeky|stella/i.test(msg);
    const isThirdParty = intake.buying_for === 'third_party';
    const possessive = isThirdParty ? `your ${intake.third_party_label || "child"}'s` : 'the';

    // Detect if customer wants a swim top (bikini band) or underwear top (bra band)
    const wantsSwimTop = /tankini|bikini top|mia|stella/i.test(msg);
    const chestLocation = wantsSwimTop
      ? 'around the chest where a bikini band would sit'
      : 'around the chest where a bra band would sit';

    let measureAsk;
    if (wantsTop && wantsBottom) {
      measureAsk = `${possessive} measurement ${getMeasureLocation('waist')} and ${possessive} measurement ${chestLocation}`;
    } else if (wantsTop) {
      measureAsk = `${possessive} measurement ${chestLocation}`;
    } else {
      measureAsk = `${possessive} measurement ${getMeasureLocation('waist')}`;
    }

    const responseText = `Thanks so much for sharing all of that detail. Can you send me ${measureAsk} I can help recommend a size?`;
    const audit = [`[Style switch] Customer wants different products (intent: exchange_different_product). Asking for measurements.${wantsTop ? ' Needs chest.' : ''}${wantsBottom ? ' Needs waist.' : ''}`];

    // Build response directly — bypass tree + composer since this is a special case
    return {
      content: [{ type: 'text', text: `## Style Switch\n\n**Customer response:**\n${responseText}` }],
      _structured: {
        status: 'needs_info',
        intake,
        prescription: {
          items: intake.items.map(i => ({
            product: i.product,
            state: 'AWAITING_MEASUREMENT',
            response_text: responseText,
            options: null,
            recommendation: null,
          })),
          donation: null,
          crossover_note: null,
          still_needed: ['measurements for new products'],
          flags: [],
        },
        customer: { email: customer_email, name: intake.name, pronouns: intake.pronouns, buying_for: intake.buying_for, third_party_label: intake.third_party_label, country: customerCountry, address: customer?.defaultAddress },
        order: targetOrder ? {
          name: targetOrder.name,
          date: targetOrder.createdAt?.split('T')[0],
          items: orderLineItems.map(li => ({ title: li.title, variant: li.variantTitle, quantity: li.quantity, sku: li.sku })),
        } : null,
        exchanges: exchanges.slice(0, 3).map(ex => ({ name: ex.name, items: (ex.lineItems || []).map(li => li.title) })),
        tone_sample: null,
        audit,
        phases_completed: ['safety_check', 'identify_customer', 'order_identification', 'style_switch'],
        _composedResponse: responseText,
      },
    };
    } // end else if (has sizing issue + no measurements)
  } // end if (exchange_different_product)

  // STEP 4: Walk the decision tree
  const treeContext = {
    customer, targetOrder, fulfilled, exchanges, all: orders,
    customerCountry, isNorthAmerica,
    orderHistory: fulfilled.slice(0, 5),
    measurementType: intake.items.some(i => require('../decisionTree').getChartCategory(i.product, false).measureType === 'chest') ? 'chest' : 'waist',
  };

  const treeResult = await walkTree(intake, treeContext);

  // Mark intake as awaiting confirmation if tree presented options
  const hasAwaitingState = treeResult.response_parts.some(p =>
    p.type === 'item_action' && (p.state === 'AWAITING_SIZE_CONFIRMATION' || p.state === 'AWAITING_STYLE_CONFIRMATION' || p.state === 'AWAITING_DECISION')
  );
  if (hasAwaitingState) intake._awaitingConfirmation = true;
  else delete intake._awaitingConfirmation;

  // STEP 5: Pull tone sample
  let toneSample = null;
  try {
    const situations = [];
    const firstItemState = treeResult.response_parts.find(p => p.type === 'item_action')?.state;
    if (firstItemState === 'AWAITING_CLARIFICATION') situations.push('product_not_working_probe');
    else if (firstItemState?.includes('SIZE')) situations.push('sizing_recommendation');
    else if (firstItemState === 'AWAITING_PHOTO') situations.push('defect_photo_request');
    situations.push('empathy_acknowledgment');

    for (const sit of situations) {
      const { data: samples } = await supabase.rpc('get_tone_samples', { p_situation: sit, p_limit: 1 });
      if (samples?.length) { toneSample = samples[0]; break; }
    }
  } catch (e) { /* tone table may not exist */ }

  // STEP 6: Build structured result (for programmatic consumers)
  const itemActions = treeResult.response_parts.filter(p => p.type === 'item_action');
  const donationActions = treeResult.response_parts.filter(p => p.type === 'donation');
  const flagActions = treeResult.response_parts.filter(p =>
    ['multi_item_flag', 'multi_size_flag', 'gentle_exception', 'case_by_case', 'escalate'].includes(p.type)
  );

  const structured = {
    status: treeResult.status,
    intake,
    prescription: {
      items: itemActions.map(a => ({
        product: a.product,
        state: a.state,
        response_text: a.text,
        options: a.options || null,
        recommendation: a.recommendation || null,
        skip_donation: a.skip_donation || false,
        crossover_note: a._crossover_note || null,
        self_diagnosed: a.self_diagnosed || false,
      })),
      donation: donationActions[0] ? { type: donationActions[0].type, text: donationActions[0].text } : null,
      crossover_note: treeResult.response_parts.find(p => p.type === 'crossover_note')?.text || null,
      still_needed: treeResult.still_needed,
      flags: flagActions.map(a => a.text),
    },
    customer: {
      email: customer.email,
      country: customerCountry,
      name: intake.name,
      pronouns: intake.pronouns,
      buying_for: intake.buying_for,
      third_party_label: intake.third_party_label,
      address: customer.defaultAddress ? {
        address1: customer.defaultAddress.address1,
        address2: customer.defaultAddress.address2 || '',
        city: customer.defaultAddress.city,
        province: customer.defaultAddress.province,
        country: customer.defaultAddress.country,
        zip: customer.defaultAddress.zip,
      } : null,
    },
    order: targetOrder ? {
      name: targetOrder.name,
      date: targetOrder.createdAt?.split('T')[0],
      items: (targetOrder.lineItems || []).map(li => ({
        title: li.title,
        variant: li.variantTitle,
        quantity: li.quantity,
        sku: li.sku,
      })),
    } : null,
    exchanges: exchanges.slice(0, 3).map(ex => ({
      name: ex.name,
      items: (ex.lineItems || []).map(li => li.title),
    })),
    tone_sample: toneSample ? { situation: toneSample.situation, message: toneSample.agent_message } : null,
    audit: treeResult.audit,
    phases_completed: treeResult.phases_completed,
  };

  // STEP 7: Build markdown output (for display)
  const statusEmoji = { gathering: '🔄', needs_info: '⏳', ready: '✅', safety_override: '🛑' };
  let md = `## Exchange Advisor\n\n`;
  md += `### ${statusEmoji[treeResult.status] || '❓'} Recommended Response\n\n`;

  // Customer + order context
  md += `**Customer:** ${customer.email}`;
  if (intake.name) md += ` (${intake.name})`;
  md += ` | ${customerCountry || '?'} | ${intake.pronouns || 'they/them'}\n`;

  if (targetOrder) {
    md += `**Order ${targetOrder.name}** (${targetOrder.createdAt?.split('T')[0]}):\n`;
    for (const li of orderLineItems) {
      md += `  - ${li.quantity}x ${li.title} — ${li.variantTitle}\n`;
    }
    md += '\n';
  }

  // Warnings
  const nameActions = treeResult.response_parts.filter(p =>
    ['name_warning', 'third_party_adapt', 'kid_sensitivity', 'email_mismatch'].includes(p.type)
  );
  for (const a of nameActions) md += `**${a.text}**\n`;
  if (nameActions.length) md += '\n';

  // Safety override
  if (treeResult.status === 'safety_override') {
    const sa = treeResult.response_parts.find(p => p.priority === 0);
    if (sa) md += `**🛑 ${sa.text}**\n\n`;
  }

  // Ask actions
  const askActions = treeResult.response_parts.filter(p => ['ask_order', 'ask_items', 'ask_info'].includes(p.type));
  if (askActions.length) {
    md += `**Ask the customer:**\n`;
    for (const a of askActions) md += `- ${a.text}\n`;
    md += '\n';
  }

  // Per-item prescriptions
  if (itemActions.length === 1) {
    md += `**For the ${itemActions[0].product || 'item'}:** ${itemActions[0].text}\n\n`;
  } else if (itemActions.length > 1) {
    md += `**Per item:**\n`;
    for (const a of itemActions) md += `- **${a.product || 'item'}:** ${a.text}\n`;
    md += '\n';
  }

  // Flags
  for (const a of flagActions) md += `**⚠️ ${a.text}**\n`;
  if (flagActions.length) md += '\n';

  // Order creation
  const orderActions = treeResult.response_parts.filter(p => p.type === 'create_order');
  for (const a of orderActions) md += `**${a.text}**\n`;
  if (orderActions.length) md += '\n';

  // Donation
  for (const a of donationActions) md += `**Donation:** ${a.text}\n`;
  if (donationActions.length) md += '\n';

  // Positive feedback
  const feedbackActions = treeResult.response_parts.filter(p => p.type === 'positive_feedback');
  for (const a of feedbackActions) md += `**${a.text}**\n`;
  if (feedbackActions.length) md += '\n';

  // Still needed
  if (treeResult.still_needed.length > 0) {
    md += `**Still needed:** ${treeResult.still_needed.join(', ')}\n\n`;
  }

  // Tone
  if (toneSample) md += `**Voice reference:** > "${toneSample.agent_message}"\n\n`;

  // Audit trail
  md += `---\n\n### Audit Trail\n\n`;
  md += `**Status:** ${treeResult.status} | **Phases:** ${treeResult.phases_completed.join(' → ')}\n`;
  md += `**Intake:** type=${intake.message_type || '?'} intent=${intake.customer_intent || '?'} issue=${intake.issue_type || '?'}\n`;
  md += `**Items:** ${intake.items.map(i => `${i.product || '?'} ${i.size || '?'}${i.resolved_size ? '→' + i.resolved_size : ''}`).join(', ') || 'none'}\n`;

  md += '\n**Decision trace:**\n';
  for (const a of treeResult.audit) md += `- ${a}\n`;

  // Intake JSON
  md += `\n### Intake State (pass back on next call)\n`;
  md += '```json\n' + JSON.stringify(intake, null, 2) + '\n```\n';

  return { content: [{ type: 'text', text: md }], _structured: structured };
}

// ---------------------------------------------------------------------------
// Build advisor response for non-exchange flows (pre-purchase, stubs)
// ---------------------------------------------------------------------------

function buildAdvisorResponse(intake, treeResult, opts) {
  const { customer, targetOrder, orderLineItems, fulfilled, exchanges, customerCountry, isNorthAmerica, toneSample } = opts;
  const itemActions = treeResult.response_parts.filter(p => p.type === 'item_action');

  const structured = {
    status: treeResult.status,
    intake,
    prescription: {
      items: itemActions.map(a => ({
        product: a.product,
        state: a.state,
        response_text: a.text,
        options: a.options || null,
        recommendation: a.recommendation || null,
        skip_donation: false,
        crossover_note: null,
        self_diagnosed: false,
      })),
      donation: null,
      crossover_note: null,
      still_needed: treeResult.still_needed,
      flags: [],
    },
    customer: {
      email: customer?.email || intake.conversation_email,
      country: customerCountry || null,
      name: intake.name,
      pronouns: intake.pronouns,
      buying_for: intake.buying_for,
      third_party_label: intake.third_party_label,
      address: customer?.defaultAddress ? {
        address1: customer.defaultAddress.address1,
        address2: customer.defaultAddress.address2 || '',
        city: customer.defaultAddress.city,
        province: customer.defaultAddress.province,
        country: customer.defaultAddress.country,
        zip: customer.defaultAddress.zip,
      } : null,
    },
    order: null,
    exchanges: [],
    tone_sample: toneSample ? { situation: toneSample.situation, message: toneSample.agent_message } : null,
    audit: treeResult.audit,
    phases_completed: treeResult.phases_completed,
  };

  // Simple markdown
  let md = `## CS Advisor\n\n`;
  md += `**Status:** ${treeResult.status}\n`;
  if (customer?.email) md += `**Customer:** ${customer.email}\n`;
  md += '\n';
  for (const a of itemActions) {
    md += `**${a.product || 'Sizing'}:** ${a.text}\n`;
  }
  if (treeResult.still_needed.length > 0) {
    md += `\n**Still needed:** ${treeResult.still_needed.join(', ')}\n`;
  }
  md += '\n**Audit:**\n';
  for (const a of treeResult.audit) md += `- ${a}\n`;
  md += `\n### Intake State (pass back on next call)\n`;
  md += '```json\n' + JSON.stringify(intake, null, 2) + '\n```\n';

  return { content: [{ type: 'text', text: md }], _structured: structured };
}

// ---------------------------------------------------------------------------
// Tool: log_donation_routing
// ---------------------------------------------------------------------------

async function handleLogDonationRouting({ customer_email, order_number, partner_id, items_count, routing_type }) {
  const supabase = getSupabaseClient();

  const { error: logErr } = await supabase
    .from('donation_routings')
    .insert({
      customer_email,
      order_number: order_number || null,
      partner_id: partner_id || null,
      items_count: items_count || 1,
      routing_type: routing_type || 'partner',
    });

  if (logErr) throw new Error(`Failed to log routing: ${logErr.message}`);

  if (partner_id) {
    const { data: partner } = await supabase
      .from('donation_partners')
      .select('donations_routed')
      .eq('id', partner_id)
      .single();

    if (partner) {
      await supabase
        .from('donation_partners')
        .update({ donations_routed: (partner.donations_routed || 0) + 1, updated_at: new Date().toISOString() })
        .eq('id', partner_id);
    }
  }

  return {
    content: [{ type: 'text', text: `## Donation Routing Logged\n\n**Customer:** ${customer_email}\n**Order:** ${order_number || 'N/A'}\n**Items:** ${items_count || 1}\n**Type:** ${routing_type}\n${partner_id ? '**Partner ID:** ' + partner_id + '\n' : ''}` }],
  };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const csAdvisorDescription = [
  'Customer service advisor — call this on EVERY customer message.',
  'Handles: exchanges, refunds, defects, pre-purchase sizing, and routes shipping/order/product questions.',
  'Uses progressive intake: pass the intake JSON from the previous call to accumulate state across messages.',
  'First call: parses the customer message into structured fields (items, sizes, intent, pronouns, etc.).',
  'Subsequent calls: merges new information, never overwrites confirmed data.',
  'Returns structured guidance + the intake JSON to pass back on the next call.',
].join(' ');

const csAdvisorSchema = {
  type: 'object',
  properties: {
    customer_email: { type: 'string', description: 'Customer email address (used to find customer and orders)' },
    issue_description: { type: 'string', description: "The customer's LATEST message (not the full conversation — just the new message)" },
    order_number: { type: 'string', description: 'Optional order number. If omitted, auto-detects from message or uses most recent fulfilled order.' },
    intake: { type: 'object', description: 'The intake JSON from the previous call. Pass this back to accumulate state across messages. Omit on first call.' },
  },
  required: ['customer_email'],
};

const tools = [
  {
    name: 'cs_advisor',
    description: csAdvisorDescription,
    inputSchema: csAdvisorSchema,
    handler: handleExchangeAdvisor,
  },
  {
    name: 'exchange_advisor',
    description: csAdvisorDescription + ' (Alias for cs_advisor)',
    inputSchema: csAdvisorSchema,
    handler: handleExchangeAdvisor,
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
