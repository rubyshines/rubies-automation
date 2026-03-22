/**
 * Exchange Advisor MCP Tools
 *
 * Orchestrator tool that pulls together order context, sizing data, donation routing,
 * and decision rules into structured guidance for the AI agent.
 *
 * Tools: exchange_advisor, log_donation_routing
 */

const { getSupabaseClient } = require('../../../shared/supabaseClient');
const { embed } = require('../embeddings');
const { searchCustomers, getCustomerOrders, getCustomerFulfilledOrders, normalizeGid } = require('../shopify');
const { searchProducts } = require('../productCache');

// ---------------------------------------------------------------------------
// Size systems (from productCache.js)
// ---------------------------------------------------------------------------

const NUMERIC_SIZES = ['4', '6', '7', '8', '9', '10', '11', '12', '13', '14', '16'];
const LETTER_SIZES = ['XXS', 'XXS+', 'XS', 'XS+', 'S', 'M', 'L', '1X', '2X', '3X', '4X'];
const SIZE_ALIASES = { 'XL': '1X', 'XXL': '2X', '3XL': '3X', '4XL': '4X', '5XL': '5X' };
const NUMERIC_TO_LETTER = { '10': 'XXS', '11': 'XXS+', '12': 'XS', '13': 'XS+', '14': 'S', '16': 'M' };

function normalizeSize(size) {
  if (!size) return null;
  const s = size.toString().trim().toUpperCase();
  return SIZE_ALIASES[s] || s;
}

function getSizeIndex(size) {
  const s = normalizeSize(size);
  const numIdx = NUMERIC_SIZES.indexOf(s);
  if (numIdx >= 0) return { system: 'numeric', index: numIdx, sizes: NUMERIC_SIZES };
  const letIdx = LETTER_SIZES.indexOf(s);
  if (letIdx >= 0) return { system: 'letter', index: letIdx, sizes: LETTER_SIZES };
  return null;
}

function getAdjacentSizes(currentSize, direction, count = 2) {
  const info = getSizeIndex(currentSize);
  if (!info) return [];

  const results = [];
  const step = direction === 'up' ? 1 : -1;

  for (let i = 1; i <= count; i++) {
    const newIdx = info.index + (step * i);
    if (newIdx >= 0 && newIdx < info.sizes.length) {
      results.push(info.sizes[newIdx]);
    }
  }
  return results;
}

// Grading: fabric delta per size step
// Even sizes: +2" (5cm). Odd/half sizes (swimwear only): +1" (2.5cm)
const ODD_HALF_SIZES = new Set(['7', '9', '11', '13', 'XXS+', 'XS+']);

function getGradingDelta(fromSize, toSize) {
  const from = normalizeSize(fromSize);
  const to = normalizeSize(toSize);
  // If either size is an odd/half size, delta is 1" (2.5cm)
  if (ODD_HALF_SIZES.has(from) || ODD_HALF_SIZES.has(to)) {
    return { inches: 1, cm: 2.5, note: 'half-size step' };
  }
  return { inches: 2, cm: 5, note: 'full-size step' };
}

// ---------------------------------------------------------------------------
// Sizing triage
// ---------------------------------------------------------------------------

function triageSizingIssue(issueDescription) {
  if (!issueDescription) return { type: 'unknown', action: 'ask for more details' };

  const lower = issueDescription.toLowerCase();

  // Way off / wrong size system indicators
  const wayOff = ['way too', 'completely wrong', 'wrong size', 'enormous', 'huge',
    'tiny', 'way bigger', 'way smaller', 'not even close', 'wrong system'];
  if (wayOff.some(w => lower.includes(w))) {
    return {
      type: 'way_off',
      action: 'Request waist measurement (chest for tops, height for one-pieces). Use cm outside North America.',
      needs_measurement: true,
    };
  }

  // Product not working / shaping expectations
  const notWorking = ["doesn't work", "not working", "doesn't do", "doesn't hide",
    "doesn't conceal", "still shows", "still visible", "can see", "not flat"];
  if (notWorking.some(w => lower.includes(w))) {
    return {
      type: 'product_not_working',
      action: 'Probe first: "Can you let me know what didn\'t work out?" Then two-branch: expectations (shaping=feminine mound, NOT flattening) vs. fit issue (ask measurements).',
      needs_measurement: false,
    };
  }

  // Close fit — too tight/small
  if (lower.includes('tight') || lower.includes('small') || lower.includes('snug') || lower.includes('too narrow')) {
    return {
      type: 'close_fit_tight',
      action: 'Offer 1-2 sizes up with exact inch/cm difference. No measurement needed.',
      direction: 'up',
      needs_measurement: false,
    };
  }

  // Close fit — too loose/big
  if (lower.includes('loose') || lower.includes('big') || lower.includes('large') || lower.includes('baggy') || lower.includes('too wide')) {
    return {
      type: 'close_fit_loose',
      action: 'Offer 1-2 sizes down with exact inch/cm difference. No measurement needed.',
      direction: 'down',
      needs_measurement: false,
    };
  }

  // Defect
  if (lower.includes('defect') || lower.includes('broken') || lower.includes('ripped') || lower.includes('torn') || lower.includes('hole') || lower.includes('stitching')) {
    return {
      type: 'defect',
      action: 'Send replacement immediately. Ask for photo (for supplier QA, not verification). Tell customer: "We\'d like to send the photo to our supplier so they can address the quality issue."',
      needs_measurement: false,
    };
  }

  // Refund request
  if (lower.includes('refund') || lower.includes('money back') || lower.includes('return')) {
    return {
      type: 'refund_request',
      action: 'Check within 60-day window. Suggest exchange first with genuine reasoning. If they insist, process refund gracefully.',
      needs_measurement: false,
    };
  }

  return { type: 'general', action: 'Gather more details about the specific issue.', needs_measurement: false };
}

// ---------------------------------------------------------------------------
// Order analysis
// ---------------------------------------------------------------------------

function analyzeOrders(orders) {
  // Filter to fulfilled, non-cancelled, non-refunded orders
  const fulfilled = orders.filter(o =>
    o.displayFulfillmentStatus === 'FULFILLED' &&
    !o.cancelledAt &&
    o.displayFinancialStatus !== 'REFUNDED'
  );

  // Identify exchange orders ($0 unfulfilled)
  const exchanges = orders.filter(o =>
    !o.cancelledAt &&
    o.displayFulfillmentStatus !== 'FULFILLED' &&
    parseFloat(o.totalPriceSet?.shopMoney?.amount || '999') === 0
  );

  return { fulfilled, exchanges, all: orders };
}

function extractItemSizes(order) {
  const items = [];
  for (const li of (order.lineItems || [])) {
    const sizeMatch = li.variantTitle?.match(/\b(\d{1,2}|XXS\+?|XS\+?|S|M|L|[1-4]X)\b/i);
    const size = sizeMatch ? normalizeSize(sizeMatch[1]) : null;
    const isBottom = !li.title?.toLowerCase().includes('bra') && !li.title?.toLowerCase().includes('top') && !li.title?.toLowerCase().includes('chest pad');
    const isTop = li.title?.toLowerCase().includes('bra') || li.title?.toLowerCase().includes('top') || li.title?.toLowerCase().includes('chest pad');

    items.push({
      title: li.title,
      variantTitle: li.variantTitle,
      quantity: li.quantity,
      sku: li.sku,
      size,
      category: isTop ? 'top' : 'bottom',
    });
  }
  return items;
}

function checkMultiItemOpportunity(orderItems, exchangeItem) {
  if (!exchangeItem?.size || !exchangeItem?.category) return null;

  const sameCategory = orderItems.filter(i =>
    i.category === exchangeItem.category &&
    i.size === exchangeItem.size &&
    i.title !== exchangeItem.title
  );

  if (sameCategory.length > 0) {
    return {
      flag: true,
      message: `This order has ${sameCategory.length} other ${exchangeItem.category}(s) in size ${exchangeItem.size}. Ask: "Just this item, or would you like to exchange all of them?"`,
      items: sameCategory,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// One-piece fit check — waist vs. height dimensional mismatch
// ---------------------------------------------------------------------------

/**
 * Check if a one-piece can fit both the customer's waist and height.
 * Returns { fits, waistSize, heightFit, recommendation }
 *
 * If the size that fits their waist doesn't cover their height (even in Tall),
 * no one-piece will work → recommend tankini + bikini bottoms.
 */
async function checkOnepieceFit(supabase, waistInches, heightInches, chartCategory) {
  if (!waistInches || !heightInches) return null;

  const category = chartCategory || 'adult_onepiece';

  // Find size(s) that fit the waist
  const { data: waistMatches } = await supabase.rpc('find_size_by_measurement', {
    p_chart_category: category,
    p_measurement_type: 'waist',
    p_value: waistInches,
  });

  if (!waistMatches || waistMatches.length === 0) {
    return { fits: false, reason: 'waist_out_of_range', recommendation: 'Waist measurement is outside all one-piece sizes.' };
  }

  const waistSize = waistMatches[0].size_label;

  // Check if that size covers their height (Regular or Tall)
  const { data: heightOptions } = await supabase
    .from('size_charts')
    .select('size_label, min_inches, max_inches, notes')
    .eq('chart_category', category)
    .eq('measurement_type', 'height')
    .eq('size_label', waistSize);

  if (!heightOptions || heightOptions.length === 0) {
    // This size has no height data (e.g., kids sizes 4-13) — can't check, assume OK
    return { fits: true, waistSize, heightFit: 'no_height_data' };
  }

  // Check Regular and Tall
  const regular = heightOptions.find(h => h.notes === 'Regular');
  const tall = heightOptions.find(h => h.notes === 'Tall');

  if (regular && heightInches >= regular.min_inches && heightInches <= regular.max_inches) {
    return { fits: true, waistSize, heightFit: 'Regular' };
  }
  if (tall && heightInches >= tall.min_inches && heightInches <= tall.max_inches) {
    return { fits: true, waistSize, heightFit: 'Tall' };
  }

  // Mismatch — waist fits this size but height doesn't
  // Check if ANY size covers both
  const { data: allWaist } = await supabase
    .from('size_charts')
    .select('size_label, min_inches, max_inches')
    .eq('chart_category', category)
    .eq('measurement_type', 'waist');

  const { data: allHeight } = await supabase
    .from('size_charts')
    .select('size_label, min_inches, max_inches, notes')
    .eq('chart_category', category)
    .eq('measurement_type', 'height');

  // One-piece has more wiggle room than bikini bottoms — customer can go up or down
  // one even size to fit the torso. Check adjacent sizes with that tolerance.
  let anyFit = null;
  for (const w of (allWaist || [])) {
    // Allow up to one even size step (~2") tolerance on waist for one-pieces
    if (waistInches >= w.min_inches - 2 && waistInches <= w.max_inches + 2) {
      const heights = (allHeight || []).filter(h => h.size_label === w.size_label);
      for (const h of heights) {
        if (heightInches >= h.min_inches && heightInches <= h.max_inches) {
          anyFit = { size: w.size_label, fit: h.notes, waistStretch: waistInches < w.min_inches ? 'slightly tight' : waistInches > w.max_inches ? 'slightly loose' : 'good' };
          break;
        }
      }
    }
    if (anyFit) break;
  }

  if (anyFit) {
    return {
      fits: true,
      waistSize: anyFit.size,
      heightFit: anyFit.fit,
      note: `Size ${anyFit.size} ${anyFit.fit} covers the height, but waist may be ${anyFit.waistStretch}`,
    };
  }

  // No size works for both dimensions — even with one-piece wiggle room (±1 even size)
  return {
    fits: false,
    waistSize,
    reason: 'dimensional_mismatch',
    recommendation: `Waist fits size ${waistSize} but height (${heightInches}") is outside that size's range, even accounting for one-piece flexibility (can go ±1 even size from ideal waist fit). No one-piece size covers both dimensions. Recommend pairing a tankini (https://rubyshines.com/products/the-queeny-tankini) with regular or high-waisted bikini bottoms for similar coverage with flexible fit. Note: for one-pieces, fitting the bottoms is most important — there's more wiggle room than bikini bottoms. But when waist and height are too far apart, the two-piece is the better option.`,
  };
}

// ---------------------------------------------------------------------------
// Donation routing
// ---------------------------------------------------------------------------

async function getDonationRouting(supabase, customerCountry, itemsCount) {
  if (!customerCountry) {
    return {
      type: 'unknown',
      message: 'Could not determine customer country. Ask for their shipping address.',
    };
  }

  // Check for partners in country
  const { data: partners } = await supabase.rpc('get_donation_partners_by_country', {
    p_country_code: customerCountry,
    p_limit: 3,
  });

  if (!partners || partners.length === 0) {
    return {
      type: 'local_no_partner',
      message: `No donation partners in ${customerCountry}. Ask customer to donate locally to any organization supporting the gender-diverse community. Also ask if they know LGBTQ+ organizations we could partner with in their country.`,
      partners: [],
    };
  }

  if (itemsCount <= 1) {
    return {
      type: 'local_single',
      message: 'Single item — ask customer to donate locally (not worth shipping to a partner).',
      partners: [],
    };
  }

  // Multiple items — recommend the partner with fewest donations routed
  const recommended = partners[0]; // Already sorted by donations_routed ASC
  return {
    type: 'partner',
    message: `Multiple items — recommend donating to: ${recommended.name} in ${recommended.city}, ${recommended.region}.`,
    recommended_partner: recommended,
    all_partners: partners,
  };
}

// ---------------------------------------------------------------------------
// Name & pronoun detection
// ---------------------------------------------------------------------------
// CRITICAL: Never use names from Shopify profile or shipping address — may be
// dead names. Only use a name the customer explicitly provides in their message.
// Default to they/them unless the customer clearly indicates otherwise.

/**
 * Scan the customer's message for an explicit self-introduction.
 * Returns the name if found, null otherwise.
 */
function detectExplicitName(messageText) {
  if (!messageText) return null;

  const patterns = [
    // "I'm Sarah", "I am Sarah", "my name is Sarah"
    /(?:i'm|i am|my name is|this is|it's)\s+([A-Z][a-z]{1,20})\b/i,
    // "— Sarah", "Thanks, Sarah", "Cheers, Sarah" (sign-off)
    /(?:thanks|cheers|regards|best|sincerely|love|xo)[,!]?\s*\n?\s*([A-Z][a-z]{1,20})\s*$/im,
    // Standalone name at very end of message (common email sign-off)
    /\n\s*([A-Z][a-z]{1,20})\s*$/m,
  ];

  for (const pattern of patterns) {
    const match = messageText.match(pattern);
    if (match) {
      const name = match[1].trim();
      // Filter out common false positives
      const falsePositives = new Set([
        'Hi', 'Hey', 'Hello', 'Thanks', 'Thank', 'Please', 'The', 'This',
        'My', 'Our', 'Your', 'Just', 'Also', 'And', 'But', 'Order', 'Size',
        'Sent', 'From', 'Iphone', 'Android', 'Gmail',
      ]);
      if (!falsePositives.has(name)) return name;
    }
  }

  return null;
}

/**
 * Detect pronouns from the customer's message.
 * Only assigns gendered pronouns when the customer is EXPLICIT.
 * Returns { pronouns, reason, isThirdParty, thirdPartyLabel }
 */
function detectPronouns(messageText) {
  if (!messageText) return { pronouns: 'they/them', reason: 'default', isThirdParty: false };

  const lower = messageText.toLowerCase();

  // Third-party references (parent buying for child, partner, etc.)
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

  // Gender-neutral third-party references — stay with they/them
  const neutralThirdParty = [
    /\b(?:my|our)\s+(?:kid|kiddo|child|little one|teen|teenager|young one|baby)\b/i,
    /\b(?:my|our)\s+(?:partner|spouse|significant other)\b/i,
    /\bfor\s+(?:my|our)\s+(?:kid|kiddo|child|partner)\b/i,
    /\btheir\s+(?:size|waist|measurement|order|birthday|comfort)\b/i,
  ];

  // Check she/her
  for (const p of shePatterns) {
    const match = lower.match(p);
    if (match) {
      // Extract the third-party label (daughter, girl, etc.)
      const labelMatch = messageText.match(/\b(?:my|our)\s+(daughter|girl|niece|granddaughter)\b/i);
      return {
        pronouns: 'she/her',
        reason: `customer referred to "${match[0].trim()}"`,
        isThirdParty: true,
        thirdPartyLabel: labelMatch ? labelMatch[1].toLowerCase() : 'her',
      };
    }
  }

  // Check he/him
  for (const p of hePatterns) {
    const match = lower.match(p);
    if (match) {
      const labelMatch = messageText.match(/\b(?:my|our)\s+(son|boy|nephew|grandson)\b/i);
      return {
        pronouns: 'he/him',
        reason: `customer referred to "${match[0].trim()}"`,
        isThirdParty: true,
        thirdPartyLabel: labelMatch ? labelMatch[1].toLowerCase() : 'him',
      };
    }
  }

  // Check neutral third-party
  for (const p of neutralThirdParty) {
    const match = lower.match(p);
    if (match) {
      const labelMatch = messageText.match(/\b(?:my|our)\s+(kid|kiddo|child|little one|teen|teenager|partner|spouse)\b/i);
      return {
        pronouns: 'they/them',
        reason: `customer said "${match[0].trim()}" — no gendered pronoun indicated`,
        isThirdParty: true,
        thirdPartyLabel: labelMatch ? labelMatch[1].toLowerCase() : 'them',
      };
    }
  }

  // Default: no signal at all
  return { pronouns: 'they/them', reason: 'default — no pronouns indicated', isThirdParty: false };
}

// ---------------------------------------------------------------------------
// Structured Intake — progressive accumulation across messages
// ---------------------------------------------------------------------------
// The intake is a structured object that gets filled in over multiple calls.
// Each call parses the latest customer message and merges into existing state.
// When all required fields are filled → status becomes "ready".
//
// Flow:
//   Call 1: customer says "the AJ is too tight" → intake has items, issue_type, but no order
//   Call 2: customer says "order #1234, — Sarah" → intake now has order, name
//   Call 3: customer says "yes size 16 please" → intake has resolution, status: ready
//
// The AI agent passes `intake` back on each call. The tool merges, never overwrites
// unless the new value is more specific.

function createEmptyIntake() {
  return {
    status: 'gathering',          // gathering | needs_info | ready | complete
    message_type: null,           // exchange | refund | product_not_working | defect | unknown
    customer_intent: null,        // exchange_same_product | exchange_different_product | refund | unsure
    items: [],                    // [{product, size, color, issue, resolved_size, variant_id}]
    order_number: null,           // extracted from message or provided
    conversation_email: null,     // email the customer wrote from (reply here)
    order_email: null,            // email the order was placed with (may differ — e.g. different login)
    email_mismatch: false,        // true if conversation_email != order_email
    name: null,                   // only if explicitly provided by customer
    pronouns: null,               // they/them | she/her | he/him
    pronoun_reason: null,
    buying_for: null,             // self | third_party
    third_party_label: null,      // daughter, son, kiddo, child, etc.
    issue_type: null,             // close_fit_tight | close_fit_loose | way_off | expectation_mismatch | defect | unknown
    measurement: null,            // {value, unit, body_part} or null
    item_count: null,             // single | multiple
    multi_item_confirmed: null,   // true (just this item) | false (all of them) | null (not asked yet)
    resolution_sizes: [],         // [{product, from_size, to_size}] — confirmed by customer
    refund_eligible: null,        // true | false | 'generous' (outside window but we accommodate)
    donation_routing: null,       // filled after exchange confirmed
    notes: [],                    // freeform observations across messages
  };
}

/**
 * Parse a customer message using AI and merge into existing intake state.
 * Uses Claude Sonnet for reliable extraction from unstructured text.
 * Only fills fields that are currently null/empty — never overwrites confirmed data.
 */

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
      "issue": "close_fit_tight" | "close_fit_loose" | "way_off" | "product_not_working" | "expectation_mismatch" | "defect" | "tight_legs" | "onepiece_fit" | "wrong_item" | "missing" | "none" | "unclear",
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
- For issue: "too small/tight/snug" = close_fit_tight. "too big/loose/baggy/sags" = close_fit_loose. "way too big/completely wrong" = way_off. "ripped/hole/seam/broken strap" = defect.

Return ONLY JSON. No explanation.`;

/**
 * @param {string} messageText - Customer's latest message
 * @param {Object|null} existingIntake - Intake from previous call (progressive)
 * @param {Array|null} orderItems - Order line items for context, e.g. [{title, variantTitle, quantity, sku}]
 */
async function parseExchangeIntake(messageText, existingIntake, orderItems) {
  const intake = existingIntake
    ? { ...existingIntake, items: [...(existingIntake.items || [])], resolution_sizes: [...(existingIntake.resolution_sizes || [])], notes: [...(existingIntake.notes || [])] }
    : createEmptyIntake();
  if (!messageText) return intake;

  // Build order context string for the AI parser
  let orderContext = '';
  if (orderItems && orderItems.length > 0) {
    orderContext = '\n\nORDER ITEMS (use these to match what the customer is referring to):\n';
    for (const li of orderItems) {
      orderContext += `- ${li.quantity}x ${li.title} — ${li.variantTitle} (SKU: ${li.sku || 'n/a'})\n`;
    }
    orderContext += '\nWhen the customer refers to a product, match it to one of these order items. Return the product name and current size exactly as shown above.';
  }

  // Call AI to parse the message
  let parsed = null;
  try {
    const ai = getAnthropicClient();
    const response = await ai.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: INTAKE_PARSE_PROMPT + orderContext + '\n\nCustomer message:\n' + messageText.slice(0, 2000),
      }],
    });
    const text = response.content[0]?.text || '{}';
    parsed = JSON.parse(text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim());
  } catch (e) {
    console.error('[intakeParser] AI parse failed, falling back to regex:', e.message);
    // Fallback: use regex for critical fields only
    parsed = regexFallbackParse(messageText);
  }

  // Merge AI-parsed fields into intake (never overwrite confirmed data)

  // Name
  if (!intake.name && parsed.name) {
    intake.name = parsed.name;
  }

  // Pronouns (only upgrade, never downgrade from gendered to they/them)
  if (parsed.pronouns && parsed.pronouns !== 'they/them') {
    intake.pronouns = parsed.pronouns;
    intake.pronoun_reason = parsed.pronoun_reason || null;
  } else if (!intake.pronouns) {
    intake.pronouns = parsed.pronouns || 'they/them';
    intake.pronoun_reason = parsed.pronoun_reason || 'default';
  }

  // Buying for
  if (!intake.buying_for && parsed.buying_for) {
    intake.buying_for = parsed.buying_for;
  }
  if (!intake.third_party_label && parsed.third_party_label) {
    intake.third_party_label = parsed.third_party_label;
  }

  // Order number
  if (!intake.order_number && parsed.order_number) {
    intake.order_number = parsed.order_number;
  }

  // Message type
  if (!intake.message_type && parsed.message_type && parsed.message_type !== 'unclear') {
    intake.message_type = parsed.message_type;
  }

  // Customer intent
  if (!intake.customer_intent && parsed.customer_intent) {
    intake.customer_intent = parsed.customer_intent;
  }

  // Items — merge new items, don't duplicate
  if (parsed.items?.length) {
    for (const aiItem of parsed.items) {
      const existing = intake.items.find(i =>
        i.product?.toLowerCase() === aiItem.product?.toLowerCase()
      );
      if (existing) {
        // Enrich existing item
        if (!existing.size && aiItem.size) existing.size = normalizeSize(aiItem.size);
        if (!existing.color && aiItem.color) existing.color = aiItem.color;
        if (!existing.issue && aiItem.issue && aiItem.issue !== 'unclear') existing.issue = aiItem.issue;
        if (!existing.desired_size && aiItem.desired_size) existing.desired_size = normalizeSize(aiItem.desired_size);
        if (!existing.resolved_size && aiItem.desired_size) existing.resolved_size = normalizeSize(aiItem.desired_size);
      } else {
        // New item
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

  // Issue type (from first item or parsed)
  if (!intake.issue_type && intake.items.length > 0) {
    const firstIssue = intake.items.find(i => i.issue && i.issue !== 'unclear')?.issue;
    if (firstIssue) intake.issue_type = firstIssue;
  }

  // Measurement
  if (!intake.measurement && parsed.measurement) {
    intake.measurement = parsed.measurement;
  }

  // Confirmation handling
  if (parsed.is_confirmation && parsed.confirmed_size && intake.items.length > 0) {
    const resolvedSize = normalizeSize(parsed.confirmed_size);
    const unresolved = intake.items.find(i => !i.resolved_size);
    if (unresolved) {
      unresolved.resolved_size = resolvedSize;
      intake.resolution_sizes.push({
        product: unresolved.product,
        from_size: unresolved.size,
        to_size: resolvedSize,
      });
    }
  }

  // Safety concern flag
  if (parsed.safety_concern) {
    intake._safety_concern = true;
  }

  // Item count
  if (!intake.item_count) {
    if (intake.items.length > 1) intake.item_count = 'multiple';
    else if (intake.items.length === 1) intake.item_count = 'single';
  }

  // Notes
  if (parsed.notes) {
    intake.notes.push(parsed.notes);
  }

  // Update status
  intake.status = computeIntakeStatus(intake);

  return intake;
}

/**
 * Regex fallback for when AI parsing fails (network error, rate limit, etc.)
 * Only extracts the most critical fields.
 */
function regexFallbackParse(messageText) {
  const lower = messageText.toLowerCase();
  const result = { items: [] };

  // Order number
  const orderMatch = messageText.match(/#?\b(\d{4,6})\b/);
  if (orderMatch) {
    const num = parseInt(orderMatch[1], 10);
    if (num >= 1000 && num <= 999999) result.order_number = orderMatch[1];
  }

  // Name
  result.name = detectExplicitName(messageText);

  // Pronouns
  const pronounInfo = detectPronouns(messageText);
  result.pronouns = pronounInfo.pronouns;
  result.pronoun_reason = pronounInfo.reason;
  if (pronounInfo.isThirdParty) {
    result.buying_for = 'third_party';
    result.third_party_label = pronounInfo.thirdPartyLabel;
  }

  // Message type
  if (/refund|money back/i.test(lower)) result.message_type = 'refund';
  else if (/defect|broken|ripped|torn|hole/i.test(lower)) result.message_type = 'defect';
  else if (/doesn't work|not working/i.test(lower)) result.message_type = 'product_not_working';
  else if (/exchange|swap|too tight|too loose|too big|too small|doesn't fit/i.test(lower)) result.message_type = 'exchange';

  // Products
  const productMatch = messageText.match(/\b(AJ|Charlie|Brooke|Ruby|Ava|Cheeky|Sassy|Serena|Flo|Stella|Sky|Queeny)\b/gi);
  if (productMatch) {
    for (const p of [...new Set(productMatch)]) {
      result.items.push({ product: p, size: null, issue: null });
    }
  }

  return result;
}

/**
 * Determine what's still missing and whether we're ready to act.
 */
function computeIntakeStatus(intake) {
  if (intake.items.length > 0 && intake.items.every(i => i.resolved_size)) return 'ready';
  if (intake.items.length > 0 || intake.message_type) return 'needs_info';
  return 'gathering';
}

// Import the decision tree
const { walkTree } = require('../decisionTree');

// ---------------------------------------------------------------------------
// Tool: exchange_advisor (powered by decision tree)
// ---------------------------------------------------------------------------

async function handleExchangeAdvisor({ customer_email, issue_description, order_number, intake: existingIntake }) {
  const supabase = getSupabaseClient();

  // ═══════════════════════════════════════════════════════════════════
  // STEP 1: Find customer
  // ═══════════════════════════════════════════════════════════════════

  let customers = await searchCustomers(customer_email);
  let customer = customers[0] || null;
  let customerGid = customer?.id;
  let customerCountry = customer?.defaultAddress?.countryCodeV2 || customer?.defaultAddress?.country || null;
  let isNorthAmerica = ['US', 'CA'].includes(customerCountry);

  // ═══════════════════════════════════════════════════════════════════
  // STEP 2: Find orders + target order
  // ═══════════════════════════════════════════════════════════════════

  let orders = [];
  if (customer) {
    try {
      const result = await getCustomerOrders(customerGid, 20);
      orders = result.orders;
    } catch (err) {
      // Will handle below
    }
  }

  const { fulfilled, exchanges, all } = analyzeOrders(orders);
  let targetOrder = null;
  const effectiveOrderNumber = order_number || existingIntake?.order_number || null;

  if (effectiveOrderNumber) {
    const normalized = effectiveOrderNumber.toString().replace('#', '');
    targetOrder = all.find(o => o.name?.replace('#', '') === normalized);

    // Order not found under this customer — try direct order lookup (email mismatch)
    if (!targetOrder) {
      try {
        const { getOrderByNumber } = require('../shopify');
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

  if (!targetOrder) {
    targetOrder = fulfilled[0] || null;
  }

  if (!customer) {
    return { content: [{ type: 'text', text: `No customer found for email: ${customer_email}. If they have an order number, ask for it — they may have ordered under a different email.` }] };
  }

  // ═══════════════════════════════════════════════════════════════════
  // STEP 3: Parse message WITH order context
  // ═══════════════════════════════════════════════════════════════════

  const orderLineItems = targetOrder?.lineItems || [];
  const intake = await parseExchangeIntake(issue_description, existingIntake || null, orderLineItems);
  intake._latestMessage = issue_description;
  intake.conversation_email = customer_email;

  // Set email mismatch if detected
  if (customer.email && customer.email.toLowerCase() !== customer_email.toLowerCase()) {
    intake.order_email = customer.email;
    intake.email_mismatch = true;
  } else {
    intake.order_email = customer.email;
  }

  // Compute refund eligibility
  if (targetOrder?.createdAt && intake.refund_eligible === null) {
    const daysSince = Math.floor((Date.now() - new Date(targetOrder.createdAt).getTime()) / 86400000);
    intake.refund_eligible = daysSince <= 60 ? true : 'generous';
  }

  intake.status = computeIntakeStatus(intake);

  // ═══════════════════════════════════════════════════════════════════
  // WALK THE DECISION TREE
  // ═══════════════════════════════════════════════════════════════════

  // Build context object for the tree
  const treeContext = {
    customer,
    targetOrder,
    fulfilled,
    exchanges,
    all: orders,
    customerCountry,
    isNorthAmerica,
    orderHistory: fulfilled.slice(0, 5),
    measurementType: intake.items.some(i => i.product?.toLowerCase().match(/bra|top/)) ? 'chest' : 'waist',
  };

  const treeResult = await walkTree(intake, treeContext);

  // ═══════════════════════════════════════════════════════════════════
  // PULL TONE SAMPLES for the AI to compose the response
  // ═══════════════════════════════════════════════════════════════════

  let toneSample = null;
  try {
    // Pick situation based on what the tree prescribed
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

  // ═══════════════════════════════════════════════════════════════════
  // BUILD OUTPUT: Recommended Response + Audit Trail
  // ═══════════════════════════════════════════════════════════════════

  const statusEmoji = { gathering: '🔄', needs_info: '⏳', ready: '✅', safety_override: '🛑' };
  let md = `## Exchange Advisor\n\n`;

  // --- SECTION 1: Recommended Response ---
  md += `### ${statusEmoji[treeResult.status] || '❓'} Recommended Response\n\n`;

  // Greeting / name / pronoun guidance
  const nameActions = treeResult.response_parts.filter(p => p.type === 'name_warning' || p.type === 'third_party_adapt' || p.type === 'kid_sensitivity' || p.type === 'email_mismatch');
  for (const a of nameActions) {
    md += `**${a.text}**\n`;
  }
  if (nameActions.length) md += '\n';

  // Customer + order context (always show so reviewer knows what we're working with)
  md += `**Customer:** ${customer?.email || customer_email}`;
  if (intake.name) md += ` (${intake.name})`;
  md += ` | ${customerCountry || '?'} | ${intake.pronouns || 'they/them'}\n`;

  if (targetOrder) {
    md += `**Order ${targetOrder.name}** (${targetOrder.createdAt?.split('T')[0]}):\n`;
    for (const li of (targetOrder.lineItems || [])) {
      md += `  - ${li.quantity}x ${li.title} — ${li.variantTitle}\n`;
    }
    md += '\n';
  }

  if (exchanges.length > 0) {
    md += `**Previous exchanges:** ${exchanges.slice(0, 3).map(ex => `${ex.name} (${ex.lineItems?.map(li => li.title).join(', ')})`).join('; ')}\n\n`;
  }

  // Main action items — what to say/do
  const itemActions = treeResult.response_parts.filter(p => p.type === 'item_action');
  const askActions = treeResult.response_parts.filter(p => p.type === 'ask_order' || p.type === 'ask_items' || p.type === 'ask_info');
  const orderActions = treeResult.response_parts.filter(p => p.type === 'create_order');
  const donationActions = treeResult.response_parts.filter(p => p.type === 'donation');
  const feedbackActions = treeResult.response_parts.filter(p => p.type === 'positive_feedback');
  const flagActions = treeResult.response_parts.filter(p => p.type === 'multi_item_flag' || p.type === 'multi_size_flag' || p.type === 'gentle_exception' || p.type === 'case_by_case' || p.type === 'escalate');

  // Safety override
  if (treeResult.status === 'safety_override') {
    const safetyAction = treeResult.response_parts.find(p => p.priority === 0);
    if (safetyAction) md += `**🛑 ${safetyAction.text}**\n\n`;
  }

  // Things we need to ask
  if (askActions.length) {
    md += `**Ask the customer:**\n`;
    for (const a of askActions) md += `- ${a.text}\n`;
    md += '\n';
  }

  // Per-item prescriptions (the core)
  if (itemActions.length) {
    if (itemActions.length === 1) {
      const a = itemActions[0];
      md += `**For the ${a.product || 'item'}:** ${a.text}\n\n`;
    } else {
      md += `**Per item:**\n`;
      for (const a of itemActions) {
        md += `- **${a.product || 'item'}:** ${a.text}\n`;
      }
      md += '\n';
    }
  }

  // Flags (multi-item, order age, etc.)
  if (flagActions.length) {
    for (const a of flagActions) md += `**⚠️ ${a.text}**\n`;
    md += '\n';
  }

  // Order creation
  if (orderActions.length) {
    for (const a of orderActions) md += `**${a.text}**\n`;
    md += '\n';
  }

  // Donation
  if (donationActions.length) {
    for (const a of donationActions) md += `**Donation:** ${a.text}\n`;
    md += '\n';
  }

  // Positive feedback
  if (feedbackActions.length) {
    for (const a of feedbackActions) md += `**${a.text}**\n`;
    md += '\n';
  }

  // Still needed summary
  if (treeResult.still_needed.length > 0) {
    md += `**Still needed:** ${treeResult.still_needed.join(', ')}\n\n`;
  }

  // Tone reference
  if (toneSample) {
    md += `**Voice reference:** > "${toneSample.agent_message}"\n\n`;
  }

  // --- SECTION 2: Audit Trail ---
  md += `---\n\n### Audit Trail\n\n`;
  md += `**Status:** ${treeResult.status} | **Phases:** ${treeResult.phases_completed.join(' → ')}\n`;

  // Intake summary
  md += `**Intake:** type=${intake.message_type || '?'} intent=${intake.customer_intent || '?'} issue=${intake.issue_type || '?'}\n`;
  md += `**Items:** ${intake.items.map(i => `${i.product || '?'} ${i.size || '?'}${i.resolved_size ? '→' + i.resolved_size : ''}`).join(', ') || 'none'}\n`;
  md += `**Order:** ${intake.order_number ? '#' + intake.order_number : targetOrder?.name || '?'} | **Name:** ${intake.name || 'not given'} | **Pronouns:** ${intake.pronouns || 'they/them'} | **Buying for:** ${intake.buying_for || '?'}\n`;
  md += `**Customer:** ${customer?.email || customer_email} | ${customerCountry || '?'} | ${customer?.numberOfOrders || orders.length} orders\n`;

  if (targetOrder) {
    md += `**Target order:** ${targetOrder.name} (${targetOrder.createdAt?.split('T')[0]}) — ${targetOrder.displayFulfillmentStatus}\n`;
    md += `**Items in order:** ${(targetOrder.lineItems || []).map(li => li.title + ' ' + li.variantTitle).join(', ')}\n`;
  }

  // Decision trace
  md += '\n**Decision trace:**\n';
  for (const a of treeResult.audit) {
    md += `- ${a}\n`;
  }

  // --- Intake JSON (pass back on next call) ---
  md += `\n### Intake State (pass back on next call)\n`;
  md += '```json\n' + JSON.stringify(intake, null, 2) + '\n```\n';

  return { content: [{ type: 'text', text: md }] };
}


// ---------------------------------------------------------------------------
// Tool: log_donation_routing
// ---------------------------------------------------------------------------

async function handleLogDonationRouting({ customer_email, order_number, partner_id, items_count, routing_type }) {
  const supabase = getSupabaseClient();

  // Insert routing log
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

  // Increment partner counter if applicable
  if (partner_id) {
    const { data: partner } = await supabase
      .from('donation_partners')
      .select('donations_routed')
      .eq('id', partner_id)
      .single();

    if (partner) {
      const { error: updateErr } = await supabase
        .from('donation_partners')
        .update({
          donations_routed: (partner.donations_routed || 0) + 1,
          updated_at: new Date().toISOString(),
        })
        .eq('id', partner_id);

      if (updateErr) console.error('[exchangeAdvisor] Warning: failed to increment partner counter:', updateErr.message);
    }
  }

  let md = `## Donation Routing Logged\n\n`;
  md += `**Customer:** ${customer_email}\n`;
  md += `**Order:** ${order_number || 'N/A'}\n`;
  md += `**Items:** ${items_count || 1}\n`;
  md += `**Type:** ${routing_type}\n`;
  if (partner_id) md += `**Partner ID:** ${partner_id}\n`;

  return { content: [{ type: 'text', text: md }] };
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
        customer_email: {
          type: 'string',
          description: 'Customer email address (used to find customer and orders)',
        },
        issue_description: {
          type: 'string',
          description: 'The customer\'s LATEST message (not the full conversation — just the new message)',
        },
        order_number: {
          type: 'string',
          description: 'Optional order number. If omitted, auto-detects from message or uses most recent fulfilled order.',
        },
        intake: {
          type: 'object',
          description: 'The intake JSON from the previous call. Pass this back to accumulate state across messages. Omit on first call.',
        },
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
        customer_email: {
          type: 'string',
          description: 'Customer email address',
        },
        order_number: {
          type: 'string',
          description: 'Order number associated with this exchange',
        },
        partner_id: {
          type: 'number',
          description: 'Donation partner ID (from donation_partners table). Omit for local donations.',
        },
        items_count: {
          type: 'number',
          description: 'Number of items being donated (default: 1)',
        },
        routing_type: {
          type: 'string',
          description: 'Routing type: "partner" (sent to partner org), "local_single" (1 item, donate locally), "local_no_partner" (no partner in country)',
        },
      },
      required: ['customer_email', 'routing_type'],
    },
    handler: handleLogDonationRouting,
  },
];

module.exports = tools;
