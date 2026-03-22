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
const { walkTree, normalizeSize } = require('../decisionTree');

// ---------------------------------------------------------------------------
// Order analysis (still needed — tree uses this context)
// ---------------------------------------------------------------------------

function analyzeOrders(orders) {
  const fulfilled = orders.filter(o =>
    o.displayFulfillmentStatus === 'FULFILLED' &&
    !o.cancelledAt &&
    o.displayFinancialStatus !== 'REFUNDED'
  );
  const exchanges = orders.filter(o =>
    !o.cancelledAt &&
    o.displayFulfillmentStatus !== 'FULFILLED' &&
    parseFloat(o.totalPriceSet?.shopMoney?.amount || '999') === 0
  );
  return { fulfilled, exchanges, all: orders };
}

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

RUBIES products: AJ, Charlie, Brooke, Ruby (youth/numeric sizes: 4,6,7,8,9,10,11,12,13,14,16), Ava, Cheeky, Sassy, Flo Dance (adult/letter sizes: XXS,XXS+,XS,XS+,S,M,L,1X,2X,3X,4X), Brooke Bra (tops), Serena Shorty Shorts, Sky One-Piece, Queeny Tankini, Stella Bikini Bottoms.

Size aliases: XL=1X, XXL=2X, 3XL=3X, 4XL=4X. Numeric-to-letter: 10=XXS, 12=XS, 14=S, 16=M.

Return JSON:
{
  "name": string or null — ONLY if they explicitly introduce themselves (sign-off "— Sarah", "I'm Alex"). NEVER guess from email.,
  "pronouns": "she/her" | "he/him" | "they/them" — only gendered if explicit ("my daughter"→she/her, "my son"→he/him). Default they/them.,
  "pronoun_reason": string — why you chose these pronouns,
  "buying_for": "self" | "third_party" | "unclear",
  "third_party_label": string or null — "daughter", "son", "kiddo", "partner", etc.,
  "order_number": string or null — extract order number if mentioned,
  "message_type": "exchange" | "refund" | "defect" | "product_not_working" | "cancellation" | "missing_item" | "wrong_item_shipped" | "general_inquiry" | "unclear",
  "customer_intent": "exchange_same_product" | "exchange_different_product" | "refund" | "unsure" | "cancellation" | null,
  "items": [
    {
      "product": string — product name as close to catalog as possible,
      "size": string or null — their CURRENT size (what they have now),
      "color": string or null,
      "issue": "close_fit_tight" | "close_fit_loose" | "doesnt_fit" | "way_off" | "product_not_working" | "expectation_mismatch" | "defect" | "tight_legs" | "onepiece_fit" | "wrong_item" | "missing" | "none" | "unclear",
      "desired_size": string or null — ONLY if customer named a SPECIFIC size (e.g. "size L", "a 14"). Do NOT fill this in if they said "next size up" or "one size down" — those are directions not specific sizes.,
      "desired_product": string or null — if they want a different product
    }
  ],
  "measurement": { "value": number, "unit": "inches" | "cm", "body_part": "waist" | "chest" | "height" } or null,
  "is_confirmation": boolean — is this message confirming a previous suggestion? ("yes", "sounds good", "go ahead"),
  "confirmed_size": string or null — if confirming, what size are they confirming?,
  "safety_concern": boolean — does the message indicate danger, hiding items, unsafe situation?,
  "positive_feedback": boolean — are they saying something nice about RUBIES?,
  "notes": string or null — anything else notable
}

IMPORTANT:
- For names: ONLY extract if they explicitly introduce themselves. "Hi Jamie" is addressing the agent, not their name.
- For sizes: normalize to catalog format (M not Medium, 1X not XL, 14 not fourteen).
- For items: if they say "underwear" without a product name, put "underwear" as product. If "bikini bottom" put that. Be specific.
- For issue: "too small/tight/snug" = close_fit_tight. "too big/loose/baggy/sags" = close_fit_loose. "way too big/completely wrong" = way_off. "ripped/hole/seam/broken strap" = defect. "doesn't fit/not the right fit/fit issue" WITHOUT specifying tight or loose = doesnt_fit (NOT close_fit_tight or close_fit_loose — we need to ask direction).
- EXCLUSIONS: If the customer says "just the X" or "only the X" or "not the Y" or "the Y fits fine", ONLY include the items they want to exchange. Do NOT include items they explicitly said are fine or excluded. For example "just the AJ, the Ruby fits fine" means ONLY the AJ goes in items — do NOT include the Ruby.
- When confirming a size, only apply it to the items the customer is actually exchanging. If they say "1X for the AJ" don't apply 1X to other products.

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

  // Items
  if (parsed.items?.length) {
    for (const aiItem of parsed.items) {
      const existing = intake.items.find(i => i.product?.toLowerCase() === aiItem.product?.toLowerCase());
      if (existing) {
        if (!existing.size && aiItem.size) existing.size = normalizeSize(aiItem.size);
        if (!existing.color && aiItem.color) existing.color = aiItem.color;
        // Allow upgrading issue from vague (doesnt_fit, unclear, none) to specific (close_fit_tight, etc.)
        const vagueIssues = new Set(['doesnt_fit', 'unclear', 'none', null, undefined]);
        if (vagueIssues.has(existing.issue) && aiItem.issue && !vagueIssues.has(aiItem.issue)) existing.issue = aiItem.issue;
        if (!existing.desired_size && aiItem.desired_size) existing.desired_size = normalizeSize(aiItem.desired_size);
        if (!existing.resolved_size && aiItem.desired_size) existing.resolved_size = normalizeSize(aiItem.desired_size);
      } else {
        intake.items.push({
          product: aiItem.product,
          size: aiItem.size ? normalizeSize(aiItem.size) : null,
          color: aiItem.color || null,
          issue: aiItem.issue && aiItem.issue !== 'unclear' ? aiItem.issue : (intake.issue_type || null),
          desired_size: aiItem.desired_size ? normalizeSize(aiItem.desired_size) : null,
          resolved_size: aiItem.desired_size ? normalizeSize(aiItem.desired_size) : null,
          resolved_product: aiItem.desired_product || null,
        });
      }
    }
  }

  // Update issue_type from items — allow upgrading from vague to specific
  if (intake.items.length > 0) {
    const vagueIssueTypes = new Set(['doesnt_fit', 'unclear', 'none', null, undefined]);
    const firstSpecificIssue = intake.items.find(i => i.issue && !vagueIssueTypes.has(i.issue))?.issue;
    if (firstSpecificIssue && vagueIssueTypes.has(intake.issue_type)) {
      intake.issue_type = firstSpecificIssue;
    }
  }

  if (!intake.measurement && parsed.measurement) intake.measurement = parsed.measurement;

  // Confirmation handling
  if (parsed.is_confirmation && parsed.confirmed_size && intake.items.length > 0) {
    const resolvedSize = normalizeSize(parsed.confirmed_size);
    const unresolved = intake.items.find(i => !i.resolved_size);
    if (unresolved) {
      unresolved.resolved_size = resolvedSize;
      intake.resolution_sizes.push({ product: unresolved.product, from_size: unresolved.size, to_size: resolvedSize });
    }
  }

  if (parsed.safety_concern) intake._safety_concern = true;
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

  const productMatch = messageText.match(/\b(AJ|Charlie|Brooke|Ruby|Ava|Cheeky|Sassy|Serena|Flo|Stella|Sky|Queeny)\b/gi);
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
  const supabase = getSupabaseClient();

  // STEP 0: Quick-extract order number from message BEFORE order lookup
  // This is a simple regex — not AI. We need it before we know which order to pull.
  let messageOrderNumber = null;
  if (issue_description) {
    const orderMatch = issue_description.match(/#\s*(\d{4,6})\b/) || issue_description.match(/order\s*#?\s*(\d{4,6})\b/i);
    if (orderMatch) {
      const num = parseInt(orderMatch[1], 10);
      if (num >= 1000 && num <= 999999) messageOrderNumber = orderMatch[1];
    }
  }

  // STEP 1: Find customer
  let customers = await searchCustomers(customer_email);
  let customer = customers[0] || null;
  let customerGid = customer?.id;
  let customerCountry = customer?.defaultAddress?.countryCodeV2 || customer?.defaultAddress?.country || null;
  let isNorthAmerica = ['US', 'CA'].includes(customerCountry);

  // STEP 2: Find orders + target order
  let orders = [];
  if (customer) {
    try {
      const result = await getCustomerOrders(customerGid, 20);
      orders = result.orders;
    } catch (err) { /* handled below */ }
  }

  const { fulfilled, exchanges, all } = analyzeOrders(orders);
  let targetOrder = null;
  // Priority: explicit param > message extraction > previous intake > auto-detect
  const effectiveOrderNumber = order_number || messageOrderNumber || existingIntake?.order_number || null;

  if (effectiveOrderNumber) {
    const normalized = effectiveOrderNumber.toString().replace('#', '');
    targetOrder = all.find(o => o.name?.replace('#', '') === normalized);

    if (!targetOrder) {
      try {
        const orderResult = await getOrderByNumber(effectiveOrderNumber);
        if (orderResult) {
          targetOrder = orderResult;
          const orderCustomerEmail = orderResult.customer?.email;
          if (orderCustomerEmail && orderCustomerEmail.toLowerCase() !== customer_email.toLowerCase()) {
            const orderCustomers = await searchCustomers(orderCustomerEmail);
            if (orderCustomers.length) {
              customer = orderCustomers[0];
              customerGid = customer.id;
              customerCountry = customer.defaultAddress?.countryCodeV2 || customer.defaultAddress?.country || null;
              isNorthAmerica = ['US', 'CA'].includes(customerCountry);
              const result = await getCustomerOrders(customerGid, 20);
              orders = result.orders;
            }
          }
        }
      } catch (err) { /* order not found */ }
    }
  }

  if (!targetOrder) targetOrder = fulfilled[0] || null;

  if (!customer) {
    return {
      content: [{ type: 'text', text: 'No customer found for email: ' + customer_email + '. If they have an order number, ask for it — they may have ordered under a different email.' }],
      _structured: { status: 'error', error: 'customer_not_found', intake: existingIntake || createEmptyIntake() },
    };
  }

  // STEP 3: Extract size from SKU (deterministic) and parse message WITH order context
  const orderLineItems = (targetOrder?.lineItems || []).map(li => {
    // SKU format: PRODUCT-COLOR-SIZE (e.g., AJ-PNK-16, MIA-BLK-S, UNW-PNK-L)
    // The last segment is always the size
    const skuSize = li.sku ? li.sku.split('-').pop() : null;
    return { ...li, _skuSize: skuSize ? normalizeSize(skuSize) : null };
  });
  const intake = await parseExchangeIntake(issue_description, existingIntake || null, orderLineItems);
  intake._latestMessage = issue_description;
  intake.conversation_email = customer_email;

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

  intake.status = computeIntakeStatus(intake);

  // STEP 4: Walk the decision tree
  const treeContext = {
    customer, targetOrder, fulfilled, exchanges, all: orders,
    customerCountry, isNorthAmerica,
    orderHistory: fulfilled.slice(0, 5),
    measurementType: intake.items.some(i => i.product?.toLowerCase().match(/bra|top/)) ? 'chest' : 'waist',
  };

  const treeResult = await walkTree(intake, treeContext);

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

const tools = [
  {
    name: 'exchange_advisor',
    description: [
      'Exchange decision advisor — call this on EVERY customer message during an exchange conversation.',
      'Uses progressive intake: pass the intake JSON from the previous call to accumulate state across messages.',
      'First call: parses the customer message into structured fields (items, sizes, intent, pronouns, etc.).',
      'Subsequent calls: merges new information, never overwrites confirmed data.',
      'When intake status = "ready", all required fields are filled — create the exchange order.',
      'When status = "needs_info", the "Still Needed" section tells you exactly what to ask.',
      'Returns structured guidance + the intake JSON to pass back on the next call.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        customer_email: { type: 'string', description: 'Customer email address (used to find customer and orders)' },
        issue_description: { type: 'string', description: "The customer's LATEST message (not the full conversation — just the new message)" },
        order_number: { type: 'string', description: 'Optional order number. If omitted, auto-detects from message or uses most recent fulfilled order.' },
        intake: { type: 'object', description: 'The intake JSON from the previous call. Pass this back to accumulate state across messages. Omit on first call.' },
      },
      required: ['customer_email'],
    },
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
