/**
 * Hybrid CS Advisor — AI-controlled conversation with deterministic tools
 *
 * Architecture: Claude Sonnet controls the conversational flow and judgment,
 * while deterministic functions provide the data (fabric deltas, size charts,
 * donation routing, order details, tone samples).
 *
 * This replaces the decision tree as the conversation controller. Instead of
 * a rigid phase-based tree that overrides customer intent, the AI reads the
 * customer's message and decides what to do, calling tools when it needs data.
 *
 * Compatible with the existing _structured output format.
 */

const Anthropic = require('@anthropic-ai/sdk');
const { getSupabaseClient } = require('../../shared/supabaseClient');
const { buildContext } = require('./contextBuilder');
const {
  normalizeSize,
  getSizeList,
  getAdjacentSizes,
  getCumulativeDelta,
  getGradingDelta,
  getProductNickname,
  classifyProduct,
  getChartCategory,
  formatDelta,
  initCsConfig,
  _activeProducts,
  PRODUCT_NICKNAMES,
  prescribeDonationRouting,
} = require('./decisionTree');

let _client = null;
function getClient() {
  if (!_client) _client = new Anthropic();
  return _client;
}

// ---------------------------------------------------------------------------
// Tool definitions for Claude tool_use
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'get_fabric_delta',
    description: 'Calculate the fabric difference between two sizes for a product. Returns inches and cm delta. Use this to explain to customers how much bigger/smaller a size will be. For bottoms, the delta is "fabric around the waist". For bras, "bra band". For bikini tops, "bikini top band". For other tops, "fabric around the torso".',
    input_schema: {
      type: 'object',
      properties: {
        product: { type: 'string', description: 'Product name (e.g. "AJ", "Sky One-Piece", "Ava")' },
        from_size: { type: 'string', description: 'Current size (e.g. "M", "10", "XS+")' },
        to_size: { type: 'string', description: 'Target size (e.g. "L", "12", "S")' },
      },
      required: ['product', 'from_size', 'to_size'],
    },
  },
  {
    name: 'get_adjacent_sizes',
    description: 'Get the next size(s) up or down from a given size for a product. Returns an array of size labels. Use this when the customer says "next size up/down" to find what that size actually is.',
    input_schema: {
      type: 'object',
      properties: {
        current_size: { type: 'string', description: 'Current size label' },
        direction: { type: 'string', enum: ['up', 'down'], description: 'Direction to look' },
        count: { type: 'number', description: 'How many sizes to return (default 2)' },
        product: { type: 'string', description: 'Product name for size-system lookup' },
      },
      required: ['current_size', 'direction', 'product'],
    },
  },
  {
    name: 'lookup_size_chart',
    description: 'Look up the recommended size for a given body measurement and product. Uses the Supabase size chart. Returns the matching size label. Use this when the customer provides a waist or chest measurement.',
    input_schema: {
      type: 'object',
      properties: {
        product: { type: 'string', description: 'Product name' },
        measurement_value: { type: 'number', description: 'The measurement value (e.g. 32)' },
        measurement_unit: { type: 'string', enum: ['inches', 'cm'], description: 'Unit of measurement' },
        is_kids: { type: 'boolean', description: 'Whether to use the kids size chart (true if size is numeric like 10, 12)' },
      },
      required: ['product', 'measurement_value', 'measurement_unit'],
    },
  },
  {
    name: 'get_donation_partner',
    description: 'Get the donation routing info for a customer exchange. RUBIES donates exchanged items to LGBTQ+ organizations. Returns the partner name, address, and routing instructions. Call this when an exchange is confirmed and you need to tell the customer where to send items.',
    input_schema: {
      type: 'object',
      properties: {
        customer_country: { type: 'string', description: 'Customer country code (e.g. "US", "CA", "AU")' },
        item_count: { type: 'number', description: 'Number of items being returned/donated' },
        customer_address: {
          type: 'object',
          description: 'Customer shipping address for geographic routing',
          properties: {
            address1: { type: 'string' },
            city: { type: 'string' },
            province: { type: 'string' },
            zip: { type: 'string' },
            country: { type: 'string' },
          },
        },
        has_defect: { type: 'boolean', description: 'True if any item has a defect (skip donation for defects)' },
      },
      required: ['customer_country', 'item_count'],
    },
  },
  {
    name: 'get_order_context',
    description: 'Get full customer and order details. Returns customer profile, order line items with SKU-derived sizes, fulfilled orders, and exchange history. Call this at the start of every conversation to understand what the customer ordered.',
    input_schema: {
      type: 'object',
      properties: {
        customer_email: { type: 'string', description: 'Customer email address' },
        order_number: { type: 'string', description: 'Optional specific order number' },
        message: { type: 'string', description: 'Customer message (may contain order number)' },
      },
      required: ['customer_email'],
    },
  },
  {
    name: 'analyze_onepiece_fit',
    description: 'For one-piece swimsuits: analyze whether the customer\'s height and waist measurements result in a good fit, or if they should consider separates (tankini + bikini bottom) instead. Call this whenever a customer has a one-piece sizing issue and you have both waist and height.',
    input_schema: {
      type: 'object',
      properties: {
        product: { type: 'string', description: 'Product name (e.g. "Sky One-Piece")' },
        waist_size: { type: 'string', description: 'Recommended waist size (e.g. "M", "L")' },
        height_inches: { type: 'number', description: 'Customer height in inches (e.g. 66 for 5\'6")' },
        is_kids: { type: 'boolean', description: 'Whether this is for a child' },
      },
      required: ['product', 'waist_size', 'height_inches'],
    },
  },
  {
    name: 'classify_product',
    description: 'Classify a product into its category. Returns the category (underwear_bottom, underwear_top, swim_bottom, swim_top, onepiece, chest_pads) and what measurement type to ask for (waist or chest).',
    input_schema: {
      type: 'object',
      properties: {
        product: { type: 'string', description: 'Product name or nickname' },
      },
      required: ['product'],
    },
  },
  {
    name: 'get_tone_samples',
    description: 'Get examples of how Jamie actually writes to customers in a given situation. Use these to match tone and phrasing. Situations: sizing_recommendation, exchange_confirmation, refund_processing, donation_info, greeting, measurement_request, option_offering, empathy, defect_response',
    input_schema: {
      type: 'object',
      properties: {
        situation: { type: 'string', description: 'The situation type to get tone samples for' },
        limit: { type: 'number', description: 'Max number of samples (default 3)' },
      },
      required: ['situation'],
    },
  },
];

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

async function executeToolCall(toolName, toolInput) {
  switch (toolName) {
    case 'get_fabric_delta': {
      const { product, from_size, to_size } = toolInput;
      const from = normalizeSize(from_size);
      const to = normalizeSize(to_size);
      if (!from || !to) return { error: `Invalid sizes: ${from_size} -> ${to_size}` };

      const delta = getCumulativeDelta(from, to);
      if (!delta) return { error: `Cannot calculate delta between ${from} and ${to} (different size systems?)` };

      const fromIdx = getSizeList(from, product)?.indexOf(from) ?? -1;
      const toIdx = getSizeList(to, product)?.indexOf(to) ?? -1;
      const direction = toIdx > fromIdx ? 'up' : 'down';

      const cat = classifyProduct(product);
      let bodyPart;
      if (cat === 'underwear_top') bodyPart = 'bra band';
      else if (cat === 'swim_top') bodyPart = 'bikini top band';
      else if (cat === 'top') bodyPart = 'fabric around the torso';
      else bodyPart = 'fabric around the waist';

      return {
        from_size: from,
        to_size: to,
        delta_inches: delta.inches,
        delta_cm: delta.cm,
        direction,
        body_part: bodyPart,
        description: direction === 'up'
          ? `The ${to} has ${delta.inches}" (${delta.cm} cm) more ${bodyPart} than the ${from}`
          : `The ${to} has ${delta.inches}" (${delta.cm} cm) less ${bodyPart} than the ${from}`,
      };
    }

    case 'get_adjacent_sizes': {
      const { current_size, direction, count, product } = toolInput;
      const normalized = normalizeSize(current_size);
      if (!normalized) return { error: `Invalid size: ${current_size}` };
      const sizes = getAdjacentSizes(normalized, direction, count || 2, product);
      const results = sizes.map(s => {
        const delta = getCumulativeDelta(normalized, s);
        return { size: s, delta_inches: delta?.inches, delta_cm: delta?.cm };
      });
      return { current_size: normalized, direction, adjacent_sizes: results };
    }

    case 'lookup_size_chart': {
      const { product, measurement_value, measurement_unit, is_kids } = toolInput;
      const { chartCategory, measureType } = getChartCategory(product, is_kids || false);
      const supabase = getSupabaseClient();
      try {
        const { data: sizeMatches } = await supabase.rpc('find_size_by_measurement', {
          p_chart_category: chartCategory,
          p_measurement_type: measureType,
          p_value: measurement_value,
          p_unit: measurement_unit,
        });
        if (sizeMatches?.length > 0) {
          return {
            recommended_size: sizeMatches[0].size_label,
            chart_category: chartCategory,
            measurement_type: measureType,
            all_matches: sizeMatches.map(m => ({ size: m.size_label, min: m.min_value, max: m.max_value })),
          };
        }
        return { error: 'No matching size found for that measurement', chart_category: chartCategory };
      } catch (e) {
        return { error: `Size chart lookup failed: ${e.message}` };
      }
    }

    case 'get_donation_partner': {
      const { customer_country, item_count, customer_address, has_defect } = toolInput;
      // Reuse the deterministic donation routing from decisionTree
      const intake = {
        items: has_defect
          ? [{ issue: 'defect' }]
          : Array.from({ length: item_count }, () => ({ issue: 'close_fit_tight' })),
      };
      const context = {
        customerCountry: customer_country,
        customer: customer_address ? { defaultAddress: customer_address } : null,
        targetOrder: { lineItems: intake.items.map(() => ({ title: 'item', quantity: 1 })) },
      };
      const result = await prescribeDonationRouting(intake, context);
      return {
        type: result.type || (result.skip ? 'skip_defect' : 'unknown'),
        response_text: result.response_text || null,
        partner: result.partner ? {
          name: result.partner.name,
          city: result.partner.city,
          address: result.partner.address,
          description: result.partner.description,
        } : null,
        audit: result.audit,
      };
    }

    case 'get_order_context': {
      const { customer_email, order_number, message } = toolInput;
      const ctx = await buildContext({ customer_email, order_number, issue_description: message });
      if (!ctx.customer) return { error: `No customer found for ${customer_email}` };

      return {
        customer: {
          email: ctx.customer.email,
          name: ctx.customer.firstName,
          country: ctx.customerCountry,
          address: ctx.customer.defaultAddress ? {
            address1: ctx.customer.defaultAddress.address1,
            city: ctx.customer.defaultAddress.city,
            province: ctx.customer.defaultAddress.province,
            zip: ctx.customer.defaultAddress.zip,
            country: ctx.customer.defaultAddress.country,
          } : null,
        },
        target_order: ctx.targetOrder ? {
          name: ctx.targetOrder.name,
          created_at: ctx.targetOrder.createdAt,
          days_since_order: Math.floor((Date.now() - new Date(ctx.targetOrder.createdAt).getTime()) / 86400000),
          fulfillment_status: ctx.targetOrder.displayFulfillmentStatus,
          financial_status: ctx.targetOrder.displayFinancialStatus,
          shipping_address: ctx.targetOrder.shippingAddress || null,
          line_items: ctx.orderLineItems.map(li => ({
            title: li.title,
            variant: li.variantTitle,
            quantity: li.quantity,
            sku: li.sku,
            sku_size: li._skuSize,
            raw_sku_size: li._rawSkuSize,
          })),
        } : null,
        fulfilled_order_count: ctx.fulfilled.length,
        exchange_orders: ctx.exchanges.slice(0, 3).map(ex => ({
          name: ex.name,
          items: (ex.lineItems || []).map(li => ({ title: li.title, variant: li.variantTitle })),
        })),
        order_count: ctx.all.length,
      };
    }

    case 'analyze_onepiece_fit': {
      const { product, waist_size, height_inches, is_kids } = toolInput;
      const { analyzeOnepieceFit, getChartCategory, getSeparatesText } = require('./decisionTree');
      const { chartCategory } = getChartCategory(product, is_kids || false);
      const waist = normalizeSize(waist_size);
      if (!waist) return { error: `Invalid size: ${waist_size}` };
      const fit = await analyzeOnepieceFit(chartCategory, waist, height_inches, product, true);
      if (fit.type === 'exact') {
        return { fit: 'exact', size: fit.size, variant: fit.variant, message: `${fit.size} ${fit.variant} is the right fit.` };
      } else if (fit.type === 'wiggle') {
        return { fit: 'wiggle', recommended_size: fit.size, variant: fit.variant, waist_size: fit.waistSize, delta: fit.unit, message: `Height suggests ${fit.size} ${fit.variant} (1 size ${fit.moreOrLess} than waist). Should work with a little wiggle room.` };
      } else if (fit.type === 'separates') {
        return { fit: 'separates', waist_size: fit.waistSize, height_size: fit.heightSize, variant: fit.variant, size_diff: fit.sizeDiff, message: `Waist and height are ${fit.sizeDiff} sizes apart. The one-piece won't fit well. Suggest a tankini top paired with a bikini bottom for more flexible fit.` };
      } else {
        return { fit: 'outside_range', message: 'Height is outside our chart ranges. Suggest separates (tankini + bikini bottom) as a safer option.' };
      }
    }

    case 'classify_product': {
      const { product } = toolInput;
      const category = classifyProduct(product);
      const { chartCategory, measureType } = getChartCategory(product, false);
      return { product, category, chart_category: chartCategory, measurement_type: measureType, ask_for: measureType === 'chest' ? 'measurement around the chest where a bra/bikini band would sit' : 'measurement around the belly, just under the belly button' };
    }

    case 'get_tone_samples': {
      const { situation, limit } = toolInput;
      const supabase = getSupabaseClient();
      try {
        const { data } = await supabase.rpc('get_tone_samples', {
          p_situation: situation,
          p_limit: limit || 3,
        });
        return {
          situation,
          samples: (data || []).map(s => ({
            customer_message: s.customer_message?.substring(0, 200),
            agent_message: s.agent_message?.substring(0, 300),
          })),
        };
      } catch (e) {
        return { error: `Tone samples lookup failed: ${e.message}`, samples: [] };
      }
    }

    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

// ---------------------------------------------------------------------------
// System prompt builder
// ---------------------------------------------------------------------------

function buildSystemPrompt(toneSamples, orderContext) {
  let orderSection = '';
  if (orderContext) {
    orderSection = `
## Customer & Order Context
- Customer email: ${orderContext.customer?.email || 'unknown'}
- Customer country: ${orderContext.customer?.country || 'unknown'}
${orderContext.target_order ? `- Order: ${orderContext.target_order.name} (placed ${orderContext.target_order.created_at?.split('T')[0] || 'unknown'}, ${orderContext.target_order.days_since_order} days ago)
- Fulfillment: ${orderContext.target_order.fulfillment_status}
- Items: ${orderContext.target_order.line_items.map(li => `${li.quantity}x ${li.title} size ${li.sku_size} (SKU: ${li.sku})`).join(', ')}` : '- No order found'}
${orderContext.exchange_orders?.length ? `- Previous exchanges: ${orderContext.exchange_orders.map(ex => ex.name).join(', ')}` : ''}
`;
  }

  let toneSection = '';
  if (toneSamples?.length) {
    toneSection = `
## Jamie's Actual Writing — MATCH THIS VOICE EXACTLY
These are real examples of how Jamie writes. Study the phrasing, length, and word choices. Use Jamie's EXACT phrases when the situation matches — do not rephrase or "improve" them. Jamie's voice is the gold standard.

CRITICAL: When explaining how the shaping works, use Jamie's EXACT phrasing from these samples. Never use clinical or anatomical language that Jamie doesn't use. If Jamie says "reshape the front area to create a feminine mound" — use that, not your own version.

${toneSamples.map((s, i) => `[${s.situation}]${s.customer_message ? `\nCustomer: "${s.customer_message}"` : ''}
Jamie: "${s.agent_message}"`).join('\n\n')}
`;
  }

  return `You are Jamie Alexander, founder of RUBIES, a gender-affirming underwear brand. You are responding to a customer service message.

## Your Approach
You read the customer's message, understand what they actually want, and respond directly. You have access to tools for looking up order details, size charts, fabric deltas, and donation routing. Use them when you need data.

CRITICAL: Do NOT volunteer order details (order numbers, product names, sizes, quantities) unless the customer has mentioned them first. When the customer sends a generic message like "help me with a return or exchange", just ask what's going on. Do NOT look up their order and list it back to them. Only reference specific order details when:
1. The customer mentions a specific product, size, or order number
2. You need to confirm details for an exchange or refund that's already been discussed
3. The customer asks "what did I order?"
The order context is available to YOU for reference, but don't present it to the customer unprompted.

CRITICAL: NEVER ask for an order number or email address if you already have order context in the system prompt. The customer's order and email were already looked up for you. Use that data directly. Asking for information you already have is the worst possible customer experience.

## ANTI-HALLUCINATION RULES (ABSOLUTE, NEVER VIOLATE)
These rules override everything else. Violations cause real harm to customers.

1. **NEVER state a donation address, partner name, or city without calling get_donation_partner first.** If you cannot call the tool, say "I can send you the donation info" and stop. Do NOT guess or recall donation addresses from memory. Every donation address you remember is wrong.
2. **NEVER state a size exists or doesn't exist without checking.** Use get_adjacent_sizes to verify what sizes are available. Do NOT say "that's the largest size" or "XS doesn't exist for this product" unless a tool confirmed it.
3. **NEVER state a fabric delta number without calling get_fabric_delta first.** Do NOT estimate, round, or recall deltas from memory. Every delta you remember is wrong.
4. **NEVER describe order contents from memory.** The order context in the system prompt tells you what's in the order. If the context says "2x AJ size M", trust it. Do NOT say "I see a one-piece" if the context says underwear.
5. **NEVER fabricate product details, size availability, or measurements.** If you are unsure, say "let me check" or ask the customer. Never guess.
6. **When mentioning deltas, ALWAYS reference the customer's CURRENT size as the baseline.** Say "the L will have 4 inches less than the 2X you have" not "the L has 2 inches more than the 1X". The customer cares about the difference from what they own.

## RESPONSE LENGTH (CRITICAL)
- Target 40-100 words. Median should be ~70 words.
- Short replies (20-35 words) are fine for simple clarifying questions, confirmations, or quick actions.
- ONLY go above 100 words when you are BOTH creating an exchange AND including donation info. That combination naturally runs 80-120 words.
- The longest responses (~170 words) happen only for the "doesn't work / shaping expectations" explanation. Almost nothing else should exceed 120 words.
- NEVER pad responses with unnecessary context, summaries, or reassurance.
- ONE question per response. Almost never ask two questions. 65% of Jamie's responses have ZERO questions.

## KEY DECISION RULES (from 200 real conversations)

### When to ACT immediately (no confirmation needed)
The same principle applies to exchanges AND refunds: if the customer's intent is unambiguous, just do it. Don't ask them to repeat what they already told you.

**Exchanges — create the order immediately when ALL of these are true:**
- The customer gave an EXPLICIT target size (e.g. "I'd like a medium", "exchange for size 12", "next size up") — not just "too loose" or "too big"
- The items to exchange are unambiguous (customer named them or there's only one item)
- The sizing makes sense (not a huge jump like 7 to 12 without a measurement)
If the customer says "too loose" or "too big" WITHOUT specifying a target size, do NOT create an order. Instead, offer 1-2 size options with deltas, or ask for a measurement.
When you create an order, ALWAYS include donation info in the same message.

**Refunds — process immediately when ANY of these are true:**
- Customer has said "return" or "refund" AFTER you (Jamie/agent) personally offered a specific exchange with sizing details. A generic bot message like "would you like to exchange?" does NOT count — only a response that included specific sizing help (fabric delta, size recommendation, product suggestion) counts as a real exchange offer.
- Customer has said "return" or "refund" more than once AFTER receiving a real exchange offer from you (not just the bot's intake flow)
- Safety situation
- Customer explicitly says "just a refund" or "no exchange"
When processing a refund, include donation info. Do NOT ask them to confirm which items if they already selected them or you can deduce them from the order.

### When to offer size OPTIONS (mention fabric delta)
Mention fabric delta ONLY when you are presenting size options for the customer to choose between. Typical pattern: "The [size] will have X" less/more fabric around the waist. Does that sound like it will work?" or "The medium will have 2" less and the small will have 4" less. What sounds better?"
NEVER mention delta when just confirming a size the customer already chose.
NEVER mention delta when creating an order.
Delta is used in only ~10% of responses, specifically when the degree of misfit is unclear ("too loose" without "a bit/slightly").
IMPORTANT: When offering options, present the NEXT TWO sizes in the relevant direction (use get_adjacent_sizes with count=2), not just one. Show delta for each relative to customer's CURRENT size.

### When to ask for MEASUREMENTS
Ask for measurements when:
- Customer says something is wrong but you can't determine HOW wrong (e.g., "too big" without saying which size they want)
- Customer wants to jump multiple sizes (e.g., size 7 to size 12), to verify the size guide was used
- Customer provides no sizing direction at all, just "doesn't fit"
Do NOT ask for measurements when:
- Customer gives a specific target size ("I'd like a medium instead")
- Customer says "next size up/down" or "a bit tight/loose" (this is clear enough)
- Customer already provided a measurement in their message

### When to mention DONATION
Include donation info ONLY when:
- Creating an exchange order (100% of the time)
- Processing a refund (tell them to donate the items)
- Customer asks about returns/shipping items back
Do NOT mention donation when:
- Gathering info, asking questions, offering size options
- You haven't confirmed the exchange yet
CRITICAL: You MUST call get_donation_partner to get the real address. NEVER write a donation address from memory.

### When to ask WHAT HAPPENED vs ask for MEASUREMENTS
Use "Can you let me know what didn't work out in case I can help you with another size or recommend another product?" ONLY when:
- Customer says "return" or "refund" without explaining the issue AT ALL
- Customer says "exchange" but gives zero detail about what's wrong
Do NOT use this vague question when:
- Customer has ALREADY explained the issue (e.g., "too big", "too tight", "doesn't fit", "doesn't work", "ripped")
- Customer is following up on a previous conversation

BE DECISIVE: When you know it's a sizing issue, skip the vague "what didn't work out" and go straight to asking for measurements: "Can you send me the waist measurement around the belly and just under the belly button? I can help recommend a size." Jamie asks for the ONE specific thing he needs to take action, not open-ended questions.

## SPECIFIC SCENARIO RULES (from holdout analysis)

### Scenario: Customer says "too big" or "too loose" (even without target size)
- DO: Call get_adjacent_sizes to find the next 2 sizes down, then call get_fabric_delta for each
- DO: Offer both options with deltas: "The [size1] will have X" less and the [size2] will have Y" less. Which sounds better?"
- DO NOT: Ask the vague "what didn't work out" question (they already told you: too big)
- DO NOT: Jump straight to creating an order (you don't know which size they want yet)

### Scenario: Customer says "doesn't work" / "doesn't hide" / "doesn't flatten" on BOTTOMS
- This requires the SHAPING EXPECTATIONS template (~170 words). Use it near-verbatim:
"In situations like this we can usually find something that works. If you are feeling the shaping is not working it's often due to two reasons: either the fit is off or there is a mismatch of expectations.

In terms of the fit, unlike 'tucking' bottoms they are intended to be worn comfortably. Not too tight or too loose. If you send me the waist measurement around the belly and just under the belly button and height I can double check the sizing.

In terms of expectations our shaping bottoms are meant to reshape the front area to create a feminine mound. This is in contrast to 'tucking' or 'gaffing' underwear which completely flattens the area. This is why our shaping bottoms are very comfortable and can be worn for all activities.

Ultimately your comfort is most important so let me know what you would like to do next. I'd be happy to send out another order if you would like to try another size."
- DO NOT: Offer a refund. DO NOT: Ask a short clarifying question. Use the template.

### Scenario: Customer says "return" or "refund" and the reason is FIT-RELATED
PRIORITY ORDER (apply the FIRST rule that matches):
1. If YOU (Jamie/agent) have already offered a specific exchange with sizing details in this conversation AND the customer still says "return" or "refund": PROCESS THE REFUND. The customer has decided after receiving real help.
2. If the customer has said "return" or "refund" more than once AFTER you offered specific exchange help: PROCESS THE REFUND. Don't make them ask three times.
3. Otherwise — even if a bot or template offered a generic "would you like to exchange?" — treat this as YOUR first real contact. The bot's intake flow doesn't count as a sizing conversation. Ask what didn't work, suggest a size based on what they told you (e.g. "too small" → offer one size up with fabric delta), or ask for measurements. Jamie almost NEVER processes a refund without first offering specific sizing help.

### Scenario: Customer already explained the issue AND firmly requests refund after YOU offered specific exchange help
- DO: Process the refund immediately + include donation info
- DO NOT: Ask "what didn't work out" again. They already told you.
- NOTE: Going through the Gorgias bot's generic return flow does NOT count as having received specific exchange help. If the only "offer" was the bot saying "would you like to exchange?", you should still offer real sizing help first.
- DO NOT: Ask them to confirm which items. If they selected items in a bot flow or listed them in a message, you already know. Cross-reference with the order to identify the items. Just process it.
- Signs the customer has already explained: they describe fit issues, they mention specific products, they've been through a bot flow that collected details, they selected items for return

### Scenario: $0 exchange order (items don't fit)
- A $0 order means this is a PREVIOUS exchange. The customer got free replacement items and those don't fit either.
- DO: Reassure them, offer to find the right size, offer another exchange
- DO NOT: Process a refund. These customers already invested effort in finding the right fit.

### Scenario: Customer follows up on a missing exchange
- DO: Take ownership ("I am so sorry, it looks like I never ended up creating your order"), create the order, set expedited shipping
- DO NOT: Ask the customer to re-explain what they wanted

### Scenario: Large order (5+ items) with size change request (MANDATORY RULE)
When the order has 5 or more items, your response MUST:
1. Be UNDER 40 words total
2. Just confirm the scope: "I see you have [N] items on this order. Can you confirm which ones you'd like to exchange?"
   Or if they already specified: "Just to confirm, are you looking for me to exchange all [N] items for the sizes you requested?"
3. DO NOT analyze individual items, sizes, or deltas
4. DO NOT add sizing commentary, cautions, or suggestions
5. DO NOT second-guess any of the customer's size choices
6. This is a HARD RULE. Even if the customer provided detailed sizing info, just confirm scope first.

### Scenario: Defective product (ripped, gel pad leaked, etc.)
- DO: Acknowledge proactively, offer to replace the item AND related items (e.g., if gel pad leaked and stained the bra, replace both)
- DO: Let them keep the damaged item
- DO NOT: Ask for photos first. Jamie trusts the customer and acts immediately.
- DO NOT: Require proof before offering help

### Scenario: "Too loose" on a bra/bikini top
- DO: Offer the next 1-2 sizes down with deltas. Use the "no-risk exchange" framing: "I can send you another and if it doesn't work you can return both. If it does work you can donate it locally."
- This framing removes pressure from the customer's decision.

## Key Business Rules

### Exchanges (60-day window)
- Exchanges are free. Customer gets a new order, donates the old items.
- If the order is over 60 days old, still process it graciously (mark as "generous").

### Size Guidance
- When the customer requests a SPECIFIC size and it exists, CONFIRM IT. Do not second-guess or offer alternatives unless the delta is extreme (>4").
- "A bit tight/loose", "slightly tight/loose", "next size up/down" = high confidence. Go ahead and create the order or confirm the adjacent size.
- "Too tight/loose" without qualifier = unclear degree. Offer 1-2 options with fabric deltas.
- "Way too tight/loose" or "much too big/small" = major misfit. Offer options or ask for measurements.
- ALWAYS use the get_fabric_delta tool to get real numbers. Never estimate or make up deltas.
- When the customer gives a measurement, use lookup_size_chart to find the right size.
- Don't ask what unit (inches/cm) for measurements. Just look it up.
- For one-pieces, if they say "too short", check if they want the Tall variant.

### Multi-item Orders
- Don't ask about items the customer didn't mention.
- If multiple items of the SAME product and size, assume they mean all of them.
- If items across DIFFERENT body groups (tops vs bottoms) and customer was vague ("everything"), ask which ones.

### Product Knowledge
- "Doesn't hide" / "doesn't flatten" on BOTTOMS = expectation mismatch. RUBIES shapes, doesn't flatten. USE THE SHAPING EXPECTATIONS TEMPLATE (see above). This is one of the few cases where a longer response (~170 words) is appropriate.
- "Doesn't work" without specifics on BOTTOMS = USE THE SHAPING EXPECTATIONS TEMPLATE.
- Tight legs = suggest Cheeky (swim), Sassy (adult underwear), or Flo Dance (kids).

### Outreach Classification
When the message is NOT from a customer about an order, classify the intent:
- business_outreach: Sales pitches, vendor proposals, marketing agencies, SEO services, supply chain vendors, business growth consultants, ad agencies, AI/tech service providers. These are unsolicited B2B emails offering services RUBIES didn't ask for. Set message_type to "business_outreach". Write a short polite decline as the draft.
- community_outreach: LGBTQ+ organizations, pride events, gender-affirming programs, community partnerships, non-profit collaborations, sponsorship requests from queer/trans orgs. These are welcome and aligned with RUBIES values. Set message_type to "community_outreach". Write a warm response.

Signs of business_outreach: mentions ROI, "scale your business", "boost sales", generic marketing language, sender domain is an agency, offers services unprompted, "I noticed your website", "I had a look at your site".
Signs of community_outreach: mentions LGBTQ+, pride, trans, gender-affirming, community program, non-profit, donation partnership, queer youth.

### Address Changes & Order Edits (unfulfilled orders only)
When a customer wants to change their shipping address:
- If the order is FULFILLED: tell them it's already shipped and you can't change it. Offer to help with anything else.
- If the order is UNFULFILLED:
  - First message (wrong address reported, no new address yet): set action_type to "warehouse_hold". Ask for the correct address. The dashboard will suggest holding the order.
  - Second message (customer provides new address): set action_type to "order_modification". The dashboard will suggest editing the order to update the address.

When a customer wants to cancel an unfulfilled order:
- If UNFULFILLED: set action_type to "cancellation". Keep the response ultra-short.
- If FULFILLED: tell them it's already shipped.

### Refunds (Jamie suggests exchange first, but listens)
- On GENUINE first contact (no prior exchange offer in the thread): suggest an exchange alternative BEFORE processing a refund.
- If fit-related AND genuine first contact: treat as a sizing conversation. Ask for measurements or suggest a size.
- BUT the "fit-related = sizing conversation" rule ONLY applies before you (Jamie/agent) have offered specific exchange help. If YOU already offered sizing details and the customer still says "return", process the refund. The Gorgias bot's generic intake flow does NOT count as having offered exchange help.
- Also process a refund immediately for: (a) safety situations, (b) customer says they already tried exchanging, (c) customer clearly wants money back and has explained why the product fundamentally doesn't work for them.
- $0 exchange orders: NEVER refund. These are previous exchanges. Offer another exchange instead.
- If a customer wants to PAY for items they kept from an exchange (e.g., they forgot to donate/return them), send them an invoice. Don't tell them it's free or to keep them. They're offering to do the right thing.

### Donations
- Skip donation info for defects (customer keeps the defective item).
- Wash instructions only for named donation partner (not for local donations).
- Single item in a country with partners = "feel free to donate locally" (not worth shipping).

### Safety
- If the message indicates danger, hiding items, or an unsafe situation, process a refund immediately with no questions. Be extra gentle.
- If they mention dysphoria or body image distress, be gentle. Don't ask detailed fit questions. Say something like "Are you able to tell me anything about the fit in case I can help with another size or recommend another product?"

## Writing Style Rules (STRICT)
- NEVER use emdashes (--). Use periods or commas instead.
- NEVER say "absolutely", "I'd be happy to help", "of course!", "great choice!", "perfect!", "no worries at all!", "Happy to sort this out", or any enthusiastic AI-sounding phrases.
- NEVER use emojis.
- NEVER use the customer's Shopify profile name (dead name risk). Only use a name if they explicitly introduced themselves or signed their message.
- Default to they/them pronouns unless the customer uses gendered language ("my daughter" = she/her, "my son" = he/him).
- Match the customer's energy. Short customer message = short response. Don't expand "it's too big" into a paragraph.
- Signature: "Talk soon," (57%) if you're expecting a reply, "Take care," (43%) if the conversation is resolved or you just created an order. Always end with "Jamie Alexander, RUBIES Founder".
- When the customer says they emailed before or are following up, acknowledge: "Sorry I must have missed your previous email." If it's clear YOU dropped the ball (e.g., exchange was never created), take full ownership: "I am so sorry. It looks like I never ended up creating your order."
- When asking what didn't work, always add: "in case I can help you with another size or recommend another product"
- For measurements: ask for waist "around the belly and just under the belly button" for bottoms. For tops, ask for "the measurement around the chest where a bikini band sits".
- NEVER say "Shall I set that up?" or "Would you like me to proceed?" Say "Does that sound right?" or "Does that sound like it will work?"
- NEVER narrate your own thinking ("Now I need to...", "Let me compose...", "Key points to cover..."). Just write the customer email directly.
- Start with "Hi," or "Hi [name]," then get straight to the point. No preambles.
- When an action is being taken (exchange, refund, address change, cancellation), write as though it's ALREADY DONE, not future tense. The operator executes the action before sending your response. Say "I've updated your address" not "I'll update your address". Say "I've processed the refund" not "I'll process the refund". Say "I cancelled your order" not "I'll cancel your order".
- For cancellations: keep it ultra-short. "No problem, I cancelled your order." (12 words). Do NOT add refund timelines, forward-looking statements, or padding.
- When customers share personal stories (about their child, a camp, a gift for someone), keep your warmth simple and genuine. One short acknowledgment, then get to the CS task. Don't try to be overly personal or build on the story beyond a brief acknowledgment.
- When a defect is reported: acknowledge it simply ("That shouldn't happen"), offer a replacement, but ALWAYS confirm the size before shipping ("Can you confirm the suit fit ok so you would want the same size?"). Don't assume.
- If the customer writes in a language other than English, reply in THEIR language. Match whatever language they used.
- When the situation is confusing or doesn't make sense (e.g., customer mentions products you don't recognize, claims something that contradicts order data), ASK CLARIFYING QUESTIONS before taking action. Don't assume and act on incomplete understanding.
${orderSection}${toneSection}
## Output Format

After handling the conversation, you MUST end your final message with a structured JSON block wrapped in <structured> tags. This is required for every response.

<structured>
{
  "status": "ready|needs_info|gathering|route_to_human|complete",
  "message_type": "exchange|refund|defect|sizing_inquiry|shipping|closing|general_inquiry|business_outreach|community_outreach (IMPORTANT: use business_outreach for unsolicited B2B sales/marketing emails, community_outreach for LGBTQ+ org partnerships)",
  "customer_intent": "exchange_same_product|exchange_different_product|refund|unsure|null",
  "action_type": "null|warehouse_hold|order_modification|cancellation (set when an order action is needed beyond exchange/refund)",
  "items": [
    {
      "product": "product name",
      "current_size": "size they have",
      "resolved_size": "size they're getting (null if unresolved)",
      "resolved_color": "color they want (null if same color or not specified)",
      "resolved_product": "different product if style switch (null if same)",
      "issue": "close_fit_tight|close_fit_loose|doesnt_fit|way_off|defect|...",
      "state": "CONFIRMED|AWAITING_DECISION|NEEDS_MEASUREMENT|REFUND_CONFIRMED|ROUTE_TO_HUMAN"
    }
  ],
  "donation_needed": true/false,
  "customer_name": "name or null",
  "customer_pronouns": "they/them|she/her|he/him",
  "buying_for": "self|third_party",
  "third_party_label": "daughter|son|child|null",
  "confidence": "high|medium|low",
  "audit": ["reasoning step 1", "reasoning step 2"]
}
</structured>

The text BEFORE the <structured> tags is the actual response to send to the customer. Write it as if you are emailing them directly.`;
}

// ---------------------------------------------------------------------------
// Strip internal thinking from AI response
// ---------------------------------------------------------------------------

function stripInternalThinking(text) {
  if (!text) return text;

  // Find where the actual customer email starts.
  // Jamie's emails always start with "Hi," or "Hi [Name]," or occasionally
  // "No problem" / "Thanks" / "Sorry" / "Doh!" / "Ok" / "Hola," etc.
  // Internal thinking includes phrases like "Now I have everything",
  // "Let me compose", "Key points to cover", "I'll", "I need to", etc.

  // Strategy: find the first line that looks like the start of an email
  const emailStartPatterns = [
    /^Hi[\s,]/m,
    /^Hey[\s,]/m,
    /^Hola[\s,]/m,
    /^No problem/m,
    /^Thanks /m,
    /^Sorry /m,
    /^Ooops/m,
    /^Ok[, ]/m,
    /^Doh!/m,
    /^D[eé]sol[eé]/m,
    /^For sure/m,
    /^That was really/m,
    /^Glad /m,
    /^Aww/m,
  ];

  for (const pattern of emailStartPatterns) {
    const match = text.match(pattern);
    if (match && match.index > 0) {
      // There's text before the email greeting - likely internal thinking
      const before = text.substring(0, match.index).trim();
      // Only strip if the "before" text looks like thinking (contains planning words)
      if (/\b(compose|respond|response|key points|cover|I('ll| need| should| have)|thinking|let me|now I|plan|analysis|context|approach|consider|confirm|measurement|customer|order history|doesn't clearly|looking at|verify|check|before I|want to make sure)\b/i.test(before)) {
        return text.substring(match.index).trim();
      }
    }
  }

  return text;
}

// ---------------------------------------------------------------------------
// Post-generation validation — catch obvious hallucinations
// ---------------------------------------------------------------------------

function validateResponse(composedResponse, toolsCalled, audit) {
  const warnings = [];
  let corrected = composedResponse;

  // Check if response mentions a donation address but get_donation_partner was never called
  // Detect specific address patterns (street addresses, PO Boxes, c/o lines, multi-line addresses)
  const calledDonationTool = toolsCalled.some(t => t === 'get_donation_partner');
  const addressPatterns = [
    // "send them to:\n<address block>" or "send items to:\n<address block>"
    /send\s+(?:them|the items?|it|your items?|these)\s+to\s*:?\s*\n[\s\S]{10,200}?\n\n/gi,
    // "c/o <anything>\n<address>"
    /c\/o\s+[^\n]+\n[^\n]+\n[^\n]+/gi,
    // "PO Box" lines with surrounding address
    /(?:^|\n).*PO\s*Box[^\n]*(?:\n[^\n]+){0,3}/gim,
    // Bolded or labeled address blocks like "**RUBIES Returns**\n..."
    /\*{0,2}RUBIES\s+Returns\*{0,2}\s*\n[\s\S]{10,200}?\n\n/gi,
    // Generic multi-line address: number + street, city, state/province, zip
    /\d+\s+[A-Z][a-z]+[^\n]{5,60}\n[A-Z][a-z]+[^\n]{3,40}\n?[A-Z]{2}\s+\d{4,6}/gi,
  ];

  if (!calledDonationTool) {
    for (const pattern of addressPatterns) {
      if (pattern.test(corrected)) {
        warnings.push('HALLUCINATION_FIX: Stripped hallucinated donation address (get_donation_partner was never called)');
        // Replace the address block with a generic donation mention
        corrected = corrected.replace(pattern, '');
        // Clean up any leftover "Please send" or "send to:" fragments
        corrected = corrected.replace(/(?:Please\s+)?[Ss]end\s+(?:them|the items?|it|your items?|these)\s+to\s*:?\s*\n?\s*\n/g, '');
        // If we stripped an address, add a generic donation line if donation was mentioned
        if (/donat/i.test(corrected) && !/donate.*locally|I can send you the donation info/i.test(corrected)) {
          corrected = corrected.replace(
            /(donat\w+[^.]*\.)/i,
            'I can send you the donation info separately.'
          );
        }
        break;
      }
    }
    // Also catch any remaining "PO Box" or "c/o" mentions that slipped through
    if (/\b(PO Box|c\/o)\b/i.test(corrected)) {
      corrected = corrected.replace(/[^\n]*\b(PO Box|c\/o)\b[^\n]*/gi, '');
      warnings.push('HALLUCINATION_FIX: Stripped remaining address fragments');
    }
  }

  // Check if response mentions specific delta numbers but get_fabric_delta was never called
  const mentionsDelta = /\b\d+["″]\s*(more|less|of)\s*(fabric|around)/i.test(corrected);
  const calledDeltaTool = toolsCalled.some(t => t === 'get_fabric_delta');
  if (mentionsDelta && !calledDeltaTool) {
    warnings.push('HALLUCINATION_RISK: Response mentions fabric delta but get_fabric_delta was never called');
  }

  // Check if response claims a size doesn't exist or is the "largest/smallest"
  const claimsNoSize = /\b(doesn't come in|not available in|largest size|smallest size|don't carry|isn't a size)\b/i.test(corrected);
  const calledAdjacentSizes = toolsCalled.some(t => t === 'get_adjacent_sizes');
  if (claimsNoSize && !calledAdjacentSizes) {
    warnings.push('HALLUCINATION_RISK: Response claims size availability limits but get_adjacent_sizes was never called');
  }

  for (const w of warnings) {
    audit.push(w);
  }

  return { warnings, corrected };
}

// ---------------------------------------------------------------------------
// Main hybrid advisor function
// ---------------------------------------------------------------------------

/**
 * Hybrid CS Advisor — AI-controlled conversation with deterministic tools.
 *
 * @param {Object} params
 * @param {string} params.customer_email - Customer email address
 * @param {string} [params.issue_description] - Customer's latest message
 * @param {string} [params.order_number] - Explicit order number
 * @param {Object} [params.intake] - Previous intake state (for multi-turn)
 * @param {string} [params.reference_date] - ISO date for time-sensitive logic
 * @returns {Promise<Object>} Compatible _structured output
 */
async function hybridAdvisor({ customer_email, issue_description, order_number, intake: existingIntake, reference_date }) {
  // Ensure product config is loaded
  if (Object.keys(_activeProducts).length === 0) {
    try { await initCsConfig(); } catch (e) { console.error('[hybridAdvisor] initCsConfig failed:', e.message); }
  }

  const client = getClient();
  const audit = [];

  // Load ALL tone samples — Opus needs to see Jamie's full voice range
  let toneSamples = [];
  try {
    const supabase = getSupabaseClient();
    const { data } = await supabase
      .from('cs_tone_samples')
      .select('situation, customer_message, agent_message')
      .limit(51);
    if (data?.length) {
      toneSamples = data.map(s => ({
        situation: s.situation,
        customer_message: s.customer_message?.substring(0, 200),
        agent_message: s.agent_message?.substring(0, 400),
      }));
    }
  } catch (e) { /* tone table may not exist yet */ }

  // Pre-fetch order context for system prompt
  let orderContext = null;
  try {
    orderContext = await executeToolCall('get_order_context', {
      customer_email,
      order_number: order_number || undefined,
      message: issue_description,
    });
    if (orderContext.error) {
      audit.push(`Order lookup: ${orderContext.error}`);
    }
  } catch (e) {
    audit.push(`Order lookup failed: ${e.message}`);
  }

  const systemPrompt = buildSystemPrompt(toneSamples, orderContext);

  // Build conversation messages
  const messages = [];

  // If there's existing intake (multi-turn), include previous context
  if (existingIntake) {
    messages.push({
      role: 'user',
      content: `[PREVIOUS CONVERSATION STATE]\n${JSON.stringify(existingIntake, null, 2)}\n\n[LATEST CUSTOMER MESSAGE]\n${issue_description || '(no message)'}`,
    });
  } else {
    messages.push({
      role: 'user',
      content: issue_description || '(no message provided)',
    });
  }

  // Run the agentic loop with tool use
  let response;
  let toolCallCount = 0;
  const MAX_TOOL_CALLS = 10;
  let currentMessages = [...messages];
  const toolsCalled = [];

  while (toolCallCount < MAX_TOOL_CALLS) {
    response = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 2000,
      system: systemPrompt,
      tools: TOOLS,
      messages: currentMessages,
    });

    // Check if there are tool calls
    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');

    if (toolUseBlocks.length === 0) {
      // No more tool calls, AI is done
      break;
    }

    // Execute each tool call
    const toolResults = [];
    for (const toolBlock of toolUseBlocks) {
      toolCallCount++;
      toolsCalled.push(toolBlock.name);
      audit.push(`Tool call: ${toolBlock.name}(${JSON.stringify(toolBlock.input).substring(0, 100)})`);

      // Auto-populate customer_address for donation routing from order context
      if (toolBlock.name === 'get_donation_partner' && !toolBlock.input.customer_address && orderContext?.target_order?.shipping_address) {
        toolBlock.input.customer_address = orderContext.target_order.shipping_address;
      }

      let result;
      try {
        result = await executeToolCall(toolBlock.name, toolBlock.input);
      } catch (e) {
        result = { error: e.message };
        audit.push(`Tool error: ${toolBlock.name} - ${e.message}`);
      }

      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolBlock.id,
        content: JSON.stringify(result),
      });
    }

    // Add assistant message + tool results to conversation
    currentMessages.push({ role: 'assistant', content: response.content });
    currentMessages.push({ role: 'user', content: toolResults });
  }

  // Extract the final text response
  const textBlocks = response.content.filter(b => b.type === 'text');
  const fullText = textBlocks.map(b => b.text).join('\n');

  // Parse the structured data from the response
  const structuredMatch = fullText.match(/<structured>\s*([\s\S]*?)\s*<\/structured>/);
  let parsedStructured = null;
  let composedResponse = fullText;

  if (structuredMatch) {
    try {
      parsedStructured = JSON.parse(structuredMatch[1]);
      // Remove the structured block from the customer-facing response
      composedResponse = fullText.replace(/<structured>[\s\S]*?<\/structured>/, '').trim();
    } catch (e) {
      audit.push(`Failed to parse structured output: ${e.message}`);
    }
  }

  // Strip internal thinking leaks from the customer-facing response.
  // The AI sometimes narrates its own process before writing the actual email.
  // Pattern: anything before "Hi," or "Hi [Name]," is internal thinking.
  composedResponse = stripInternalThinking(composedResponse);

  // Validate for hallucinations (may correct the response)
  const validation = validateResponse(composedResponse, toolsCalled, audit);
  composedResponse = validation.corrected;

  // Build compatible _structured output
  const structured = buildCompatibleStructured(parsedStructured, composedResponse, {
    customer_email,
    orderContext,
    existingIntake,
    audit,
  });

  // Build markdown summary
  let md = `## Hybrid CS Advisor\n\n`;
  md += `**Status:** ${structured.status}\n`;
  md += `**Confidence:** ${structured.confidence}\n`;
  if (structured.customer?.email) md += `**Customer:** ${structured.customer.email}\n`;
  if (structured.order?.name) md += `**Order:** ${structured.order.name}\n`;
  md += `\n**Response:**\n${composedResponse}\n`;
  md += `\n**Audit:**\n`;
  for (const a of structured.audit) md += `- ${a}\n`;
  if (existingIntake) {
    md += `\n### Intake State (pass back on next call)\n`;
    md += '```json\n' + JSON.stringify(structured.intake, null, 2) + '\n```\n';
  }

  return {
    content: [{ type: 'text', text: md }],
    _structured: structured,
  };
}

// ---------------------------------------------------------------------------
// Build compatible _structured from AI output
// ---------------------------------------------------------------------------

function buildCompatibleStructured(parsed, composedResponse, opts) {
  const { customer_email, orderContext, existingIntake, audit } = opts;

  // Default structure if parsing failed
  if (!parsed) {
    return {
      status: 'route_to_human',
      intake: existingIntake || { message_type: null, items: [] },
      prescription: { items: [], donation: null, crossover_note: null, still_needed: [], flags: [] },
      customer: { email: customer_email, name: null, pronouns: 'they/them', country: orderContext?.customer?.country },
      order: null,
      action_type: null,
      confidence: 'low',
      advisor_version: 'hybrid-v3',
      _composedResponse: composedResponse,
      audit: [...audit, 'Failed to parse structured output from AI'],
    };
  }

  // Map AI items to prescription format
  const prescriptionItems = (parsed.items || []).map(item => ({
    product: item.product,
    state: item.state || 'AWAITING_DECISION',
    response_text: null,
    options: null,
    recommendation: item.resolved_size ? { size: item.resolved_size } : null,
    skip_donation: false,
    crossover_note: null,
    self_diagnosed: false,
  }));

  // Build intake from AI output (for multi-turn compatibility)
  const intake = existingIntake ? { ...existingIntake } : {
    message_type: parsed.message_type || null,
    customer_intent: parsed.customer_intent || null,
    items: (parsed.items || []).map(item => ({
      product: item.product,
      size: item.current_size || null,
      color: item.resolved_color || null,
      issue: item.issue || null,
      desired_size: item.resolved_size || null,
      resolved_size: item.state === 'CONFIRMED' ? item.resolved_size : null,
      resolved_color: item.resolved_color || null,
      resolved_product: item.resolved_product || null,
    })),
    name: parsed.customer_name || null,
    pronouns: parsed.customer_pronouns || 'they/them',
    buying_for: parsed.buying_for || 'self',
    third_party_label: parsed.third_party_label || null,
    order_number: orderContext?.target_order?.name?.replace('#', '') || null,
    conversation_email: customer_email,
  };

  // On multi-turn conversations, merge AI's newly resolved sizes into carried-forward intake items.
  // The existingIntake from prior turns may have null resolved_size that the AI has now confirmed.
  if (existingIntake && parsed.items?.length) {
    for (const aiItem of parsed.items) {
      if (aiItem.state === 'CONFIRMED' && aiItem.resolved_size) {
        const match = intake.items?.find(i => i.product === aiItem.product && !i.resolved_size);
        if (match) {
          match.resolved_size = aiItem.resolved_size;
          match.resolved_color = aiItem.resolved_color || match.resolved_color;
          match.resolved_product = aiItem.resolved_product || match.resolved_product;
          if (!match.desired_size) match.desired_size = aiItem.resolved_size;
        }
      }
    }
  }

  // Compute action_type from prescription items (which have the resolved states)
  let action_type = null;
  const actionableStatuses = ['ready', 'complete'];
  if (actionableStatuses.includes(parsed.status)) {
    const hasExchange = prescriptionItems.some(i => i.state === 'CONFIRMED' && !i.product?.includes('refund'));
    const hasRefund = prescriptionItems.some(i => i.state === 'REFUND_CONFIRMED');
    if (hasExchange && hasRefund) action_type = 'exchange+refund';
    else if (hasExchange) action_type = 'exchange';
    else if (hasRefund) action_type = 'refund';
  }

  // AI's explicit action_type for hold, edit, cancellation takes priority
  // (item states like CONFIRMED may be misinterpreted as exchange for non-exchange scenarios)
  if (parsed.action_type && ['warehouse_hold', 'order_modification', 'cancellation'].includes(parsed.action_type)) {
    action_type = parsed.action_type;
  }

  // Post-process: detect outreach from AI's audit when message_type is generic
  // Check community FIRST (it may mention "not B2B" which would false-positive on business patterns)
  if (intake.message_type === 'general_inquiry' || intake.message_type === 'unknown' || !intake.message_type) {
    const auditText = (parsed.audit || []).join(' ').toLowerCase();
    if (/community.outreach|lgbtq.*org|queer.*org|pride.*org|gender.affirm.*partner|aligned with rubies/i.test(auditText)) {
      intake.message_type = 'community_outreach';
    } else if (/business.outreach|sales.pitch|unsolicited.*b2b|classified as business/i.test(auditText) ||
               /not looking for.*(services|marketing|seo|business)/i.test((composedResponse || '').toLowerCase())) {
      intake.message_type = 'business_outreach';
    }
  }

  return {
    status: parsed.status || 'gathering',
    intake,
    prescription: {
      items: prescriptionItems,
      donation: parsed.donation_needed ? { pending: true } : null,
      crossover_note: null,
      still_needed: [],
      flags: [],
    },
    customer: {
      email: customer_email,
      name: parsed.customer_name || null,
      pronouns: parsed.customer_pronouns || 'they/them',
      buying_for: parsed.buying_for || 'self',
      third_party_label: parsed.third_party_label || null,
      country: orderContext?.customer?.country || null,
      address: orderContext?.customer?.address || null,
    },
    order: orderContext?.target_order ? {
      name: orderContext.target_order.name,
      date: orderContext.target_order.created_at?.split('T')[0],
      items: orderContext.target_order.line_items.map(li => ({
        title: li.title,
        variant: li.variant,
        quantity: li.quantity,
        sku: li.sku,
      })),
    } : null,
    action_type,
    confidence: parsed.confidence || 'medium',
    advisor_version: 'hybrid-v3',
    _composedResponse: composedResponse,
    audit: [...audit, ...(parsed.audit || [])],
  };
}

module.exports = { hybridAdvisor };
