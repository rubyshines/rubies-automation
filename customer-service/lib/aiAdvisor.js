/**
 * AI CS Advisor — AI-controlled conversation with deterministic tools
 *
 * Architecture: Claude Opus controls the conversational flow and judgment,
 * while deterministic functions provide the data (fabric deltas, size charts,
 * donation routing, order details, tone samples).
 *
 * The AI reads the customer's message and decides what to do, calling tools
 * when it needs data.
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
} = require('./sizingEngine');
const { prescribeDonationRouting } = require('./donationRouting');
const { analyzeUnfulfilledOrder } = require('./tracking/fulfillmentChecker');

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
  {
    name: 'compare_products',
    description: 'Find alternative products in the same category as a given product. Returns fit description, best use case, comparison notes, and inventory for a specific size. Use this when an item is out of stock and you need to suggest a swap, or when a customer asks how products differ. Do NOT use this for one-piece → separates swaps (use analyze_onepiece_fit instead).',
    input_schema: {
      type: 'object',
      properties: {
        product: { type: 'string', description: 'Product name to find alternatives for (e.g. "Sassy", "Ruby")' },
        size: { type: 'string', description: 'Size to check inventory for (e.g. "S", "M", "14")' },
      },
      required: ['product'],
    },
  },
  {
    name: 'check_unfulfilled_order',
    description: 'Investigate why an unfulfilled order hasn\'t shipped. Checks inventory levels for each item, pre-order tags, order age in business days, and partial fulfillment. Call this when a customer asks about a delayed or unshipped order.',
    input_schema: {
      type: 'object',
      properties: {
        order_number: { type: 'string', description: 'Order number to investigate' },
      },
      required: ['order_number'],
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
      const { customer_email, customer_name, order_number, message, _preContext } = toolInput;
      const ctx = _preContext || await buildContext({ customer_email, customer_name, order_number, issue_description: message });
      if (!ctx.customer) return { error: `No customer found for ${customer_email}` };

      // Look up DDP status for the customer's country
      let dutiesPrepaid = null;
      if (ctx.customerCountry) {
        try {
          const { getShippingZone } = require('./tools/shippingLookup');
          const zone = await getShippingZone(ctx.customerCountry);
          dutiesPrepaid = zone === 'ddp' || zone === 'us' || zone === 'canada';
        } catch (_) { /* non-critical */ }
      }

      return {
        customer: {
          email: ctx.customer.email,
          name: ctx.customer.firstName,
          country: ctx.customerCountry,
          duties_prepaid: dutiesPrepaid,
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
        resolved_by_name: ctx.resolvedByName || false,
        conversation_email: ctx.conversationEmail || null,
      };
    }

    case 'analyze_onepiece_fit': {
      const { product, waist_size, height_inches, is_kids } = toolInput;
      const { analyzeOnepieceFit, getChartCategory, getSeparatesText } = require('./sizingEngine');
      const { chartCategory } = getChartCategory(product, is_kids || false);
      const waist = normalizeSize(waist_size);
      if (!waist) return { error: `Invalid size: ${waist_size}` };
      const fit = await analyzeOnepieceFit(chartCategory, waist, height_inches, product, true);
      if (fit.type === 'exact') {
        return { fit: 'exact', size: fit.size, variant: fit.variant, message: `${fit.size} ${fit.variant} is the right fit.` };
      } else if (fit.type === 'wiggle') {
        return { fit: 'wiggle', recommended_size: fit.size, variant: fit.variant, waist_size: fit.waistSize, delta: fit.unit, message: `Height suggests ${fit.size} ${fit.variant} (1 size ${fit.moreOrLess} than waist). Should work with a little wiggle room.` };
      } else if (fit.type === 'separates') {
        return { fit: 'separates', waist_size: fit.waistSize, height_size: fit.heightSize, variant: fit.variant, size_diff: fit.sizeDiff, message: `Waist and height are ${fit.sizeDiff} sizes apart. The one-piece won't fit well. Suggest the Queeny tankini paired with the Ruby (standard) or Stella (high-waisted, more coverage) bikini bottom.` };
      } else {
        return { fit: 'outside_range', message: 'Height is outside our chart ranges. Suggest the Queeny tankini paired with the Ruby (standard) or Stella (high-waisted, more coverage) bikini bottom as a safer option.' };
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

    case 'compare_products': {
      const { product, size } = toolInput;
      const category = classifyProduct(product);
      if (!category) return { error: `Unknown product: ${product}` };

      const supabase = getSupabaseClient();
      const { data: catalog } = await supabase.rpc('get_product_catalog', {
        p_collection: null,
        p_category: null,
        p_age_group: null,
      });

      if (!catalog?.length) return { error: 'Could not load product catalog' };

      // Use handle → product_cs_config for stable product identification
      // _activeProducts is keyed by handle with { nickname, category }
      const sourceHandle = Object.entries(_activeProducts).find(([, v]) => v.nickname === product)?.[0];
      const sourceConfig = sourceHandle ? _activeProducts[sourceHandle] : null;
      if (!sourceConfig) return { error: `No product config for: ${product}` };

      // Find alternatives: same category, different product, joined by handle
      const sameCategory = catalog.filter(p => {
        if (p.handle === sourceHandle) return false;
        const config = _activeProducts[p.handle];
        return config && config.category === category;
      });

      const sourceProduct = catalog.find(p => p.handle === sourceHandle);

      // Ensure product cache is loaded for inventory lookups
      const { searchProducts, loadFromSupabase, getProducts } = require('./productCache');
      if (!getProducts()?.length) await loadFromSupabase();

      // Build alternatives with size + inventory filtering
      let alternatives = [];
      for (const p of sameCategory) {
        const config = _activeProducts[p.handle];
        const nick = config.nickname;
        const allSizes = [...(p.kid_sizes || []), ...(p.adult_sizes || [])];

        if (size) {
          const normalizedSize = normalizeSize(size);
          if (!allSizes.some(s => normalizeSize(s) === normalizedSize)) continue;

          // Search by full title — sum inventory across all colors for this size
          const variants = searchProducts(`${p.title} ${size}`);
          const matches = variants.filter(v => {
            const vSize = normalizeSize(v.variantTitle?.split('/').pop()?.trim());
            return vSize === normalizedSize && v.productTitle === p.title;
          });
          const sizeInventory = matches.reduce((sum, v) => sum + (v.inventoryQuantity || 0), 0);
          if (sizeInventory <= 0) continue;

          alternatives.push({
            product: nick,
            fit_description: p.fit_description,
            best_for: p.best_for,
            comparison_notes: p.comparison_notes,
            size,
            inventory_in_size: sizeInventory,
          });
        } else {
          alternatives.push({
            product: nick,
            fit_description: p.fit_description,
            best_for: p.best_for,
            comparison_notes: p.comparison_notes,
            available_sizes: allSizes,
            total_inventory: p.total_inventory,
          });
        }
      }

      // Check source product inventory for the requested size — per-color breakdown
      let sourceInventory = null;
      let sourceColorInventory = [];
      if (size && sourceProduct) {
        const srcVariants = searchProducts(`${sourceProduct.title} ${size}`);
        const srcMatches = srcVariants.filter(v => {
          const vSize = normalizeSize(v.variantTitle?.split('/').pop()?.trim());
          return vSize === normalizeSize(size) && v.productTitle === sourceProduct.title;
        });
        sourceInventory = srcMatches.reduce((sum, v) => sum + (v.inventoryQuantity || 0), 0);
        sourceColorInventory = srcMatches.map(v => ({
          color: v.variantTitle?.split('/')[0]?.trim() || 'Unknown',
          inventory: v.inventoryQuantity || 0,
        })).filter(c => c.inventory > 0);
      }

      return {
        source: {
          product: sourceConfig.nickname,
          category,
          fit_description: sourceProduct?.fit_description,
          best_for: sourceProduct?.best_for,
          comparison_notes: sourceProduct?.comparison_notes,
          ...(size ? { size, total_inventory: sourceInventory, available_colors: sourceColorInventory } : {}),
        },
        alternatives,
      };
    }

    case 'check_unfulfilled_order': {
      const { order_number } = toolInput;
      const { getOrderByNumber } = require('./shopify');
      try {
        const shopifyOrder = await getOrderByNumber(order_number);
        // Map line items to the format analyzeUnfulfilledOrder expects (needs variantId)
        const mapped = {
          ...shopifyOrder,
          lineItems: (shopifyOrder.lineItems || []).map(li => ({
            ...li,
            variantId: li.variant?.id || null,
          })),
        };
        return await analyzeUnfulfilledOrder(mapped);
      } catch (e) {
        return { error: e.message };
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
- Customer email: ${orderContext.customer?.email || 'unknown'}${orderContext.resolved_by_name ? `\n- ⚠️ RESOLVED BY NAME FALLBACK: no customer record exists under the sender's email (${orderContext.conversation_email}). This customer was found by searching their name. Apply the "Resolved by name" verification gates before trusting this match.` : ''}
- Customer country: ${orderContext.customer?.country || 'unknown'}${orderContext.customer?.duties_prepaid != null ? ` (duties ${orderContext.customer.duties_prepaid ? 'PREPAID — we cover customs charges' : 'NOT prepaid — customer responsible'})` : ''}
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

  // Split into static (cacheable) and dynamic parts.
  // Static: rules + tone samples + product links + output format — identical across all tickets.
  // Dynamic: order context — changes per ticket.
  const staticPart = `You are Jamie Alexander, founder of RUBIES, a gender-affirming underwear brand. You are responding to a customer service message.

## Your Approach
You read the customer's message, understand what they actually want, and respond directly. You have access to tools for looking up order details, size charts, fabric deltas, and donation routing. Use them when you need data.

When a customer asks for a specific product, check availability and offer it — trust their product preferences. Sizing is different: if their measurements suggest a different size, flag it.

CRITICAL: Do NOT volunteer order details (order numbers, product names, sizes, quantities) unless the customer has mentioned them first. When the customer sends a generic message like "help me with a return or exchange", just ask what's going on. Do NOT look up their order and list it back to them. Only reference specific order details when:
1. The customer mentions a specific product, size, or order number
2. You need to confirm details for an exchange or refund that's already been discussed
3. The customer asks "what did I order?"
The order context is available to YOU for reference, but don't present it to the customer unprompted.

CRITICAL: NEVER ask for an order number or email address if you already have order context in the system prompt. The customer's order and email were already looked up for you. Use that data directly. Asking for information you already have is the worst possible customer experience.

## EMAIL & CUSTOMER SCENARIOS
- **Order email differs from conversation email:** If the customer account was found, but a specific order has a different email than the conversation, reply to the conversation email and use the order data. Don't ask the customer to re-send from a different address.
- **Resolved by name (not email):** If the context is flagged 'resolved_by_name: true', the customer account was found via a name search, NOT by matching their sender email. Proceed normally using the loaded context IF BOTH: (a) the most recent fulfilled order is within 90 days, AND (b) the customer's message is clearly about that order OR the customer has only one fulfilled order in the last 90 days (there's no ambiguity about which order they mean). If either condition fails — no recent order, or the message is generic AND they have multiple recent orders — do NOT reference any personal info from the loaded context (name, order number, items, address). Instead, ask for the order number or the email they used at checkout before proceeding, and do not take any irreversible actions. Under NO circumstances repeat the customer's name back to them when resolved by name — the Shopify name may be a dead name.
- **Customer not found:** If no customer record could be resolved by email OR by name fallback, ask for the order number or the email they placed the order with.
- **No fulfilled orders:** If the customer has orders but none are fulfilled yet, explain that we need to wait for delivery before we can do an exchange. Offer to help with anything else in the meantime.
- **"Product not working" + self-identified direction:** If the customer says "it's not working" but also mentions it feels tight or loose, treat it as a sizing issue in that direction. Don't ask "what didn't work" — they already told you.

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

**Exchanges — inventory check before confirming:**
Before confirming a size exchange, call compare_products with the product name and target size to verify inventory. If the target size is out of stock, don't offer it. Instead, use the compare_products results to suggest an alternative product in the same size that IS in stock, using the comparison data to explain the difference. Example: "The M is currently out of stock, but the Naomi in M has a similar cheeky cut and is available. Would you like to try that instead?"

**Refunds — when to process vs when to nudge:**
The key question is: has the customer received REAL sizing help from you (Jamie/agent) in this conversation? A "real" exchange offer means you suggested a specific size, mentioned fabric delta, or asked for measurements. The Gorgias bot's generic "would you like to exchange?" does NOT count.

- **Process refund immediately** if: (a) you already offered real sizing help and they still want a refund, (b) safety situation, (c) customer explicitly says "just a refund" or "no exchange" after real help, (d) product fundamentally doesn't work for them (not a sizing issue)
- **Nudge first** if: the customer has only been through the bot's intake flow. Even if they said "return" to the bot, YOUR first response should offer real sizing help based on what they told you (e.g. "too small" → suggest next size up with delta)
- When processing a refund, include donation info in the same message. Do NOT ask them to confirm which items if they already selected them.
- NEVER say "once you've donated/sent the items" or "let me know when you've shipped them." Refunds are processed upfront, not contingent on anything.

### When to offer size OPTIONS (mention fabric delta)
Mention fabric delta ONLY when you are presenting size options for the customer to choose between. Typical pattern: "The [size] will have X" less/more fabric around the waist. Does that sound like it will work?" or "The medium will have 2" less and the small will have 4" less. What sounds better?"
NEVER mention delta when just confirming a size the customer already chose.
NEVER mention delta when creating an order.
Mention fabric delta when the degree of misfit is unclear ("too loose" without "a bit/slightly") and you're presenting size options for the customer to choose between.
IMPORTANT: When offering options, present the NEXT TWO sizes in the relevant direction (use get_adjacent_sizes with count=2), not just one. Show delta for each relative to customer's CURRENT size.

### When to ask for MEASUREMENTS
Ask for measurements when:
- Customer wants to jump multiple sizes (e.g., size 7 to size 12), to verify the size guide was used
- Defect suggests possible sizing issue (broken seam, stretched lining — see defect rules below)
Do NOT ask for measurements when:
- Customer gives a specific target size ("I'd like a medium instead")
- Customer says "next size up/down" or "a bit tight/loose" (this is clear enough)
- Customer says "too big" or "too loose" — you know the direction, offer size options with deltas instead
- Customer already provided a measurement in their message

### When to mention DONATION
Include donation info ONLY when:
- Creating an exchange order (100% of the time)
- Processing a refund (tell them to donate the items)
- Customer asks about returns/shipping items back
Do NOT mention donation when:
- Gathering info, asking questions, offering size options
- You haven't confirmed the exchange yet
CRITICAL: ALWAYS call get_donation_partner when you need donation info. The tool handles all routing logic (single item, no partners, multiple items). Use its response_text. NEVER write a donation address from memory.

### When to ask WHAT HAPPENED vs take action
Use "Can you let me know what didn't work out in case I can help you with another size or recommend another product?" ONLY when:
- Customer says "return" or "refund" without explaining the issue AT ALL
- Customer says "exchange" or "doesn't fit" but gives zero detail about direction (tight vs loose)

Once you know the DIRECTION (tight/loose/big/small), don't ask this question — take action:
- "Too big/loose" → offer next 2 sizes down with deltas
- "Too tight/small" → offer next 2 sizes up with deltas
- "Way off" or huge size jump → ask for measurements to verify

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

### Scenario: Customer says "return" or "refund"
Ask yourself ONE question: have I (Jamie/agent) offered this customer specific sizing help in this conversation?
- **NO** (this is my first real contact, even if a bot chatted with them): Treat it as a sizing conversation. If they said why ("too small", "too big"), offer the next size with fabric delta. If they didn't say why, ask what didn't work. The bot's intake questions don't count as sizing help.
- **YES** (I already suggested sizes, deltas, or asked for measurements, and they still want a refund): Process the refund immediately + donation info. Don't make them ask again.
- If they selected items in a bot flow, you already know which items. Don't ask them to confirm.

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

### Scenario: Defective product
Use judgment about the defect type to determine response:

**Clearly manufacturing defect** (stain, discoloration, gel pad leak, fabric flaw, stitching came undone on arrival): Replace immediately. No questions. Offer to replace related items too (e.g. gel pad stained the bra → replace both). Let them keep the damaged item. Ask for a photo to forward to the supplier — tell the customer this explicitly so they know why.

**Could be wear/sizing issue** (broken seam, stretched lining, rip/tear): Gently probe before replacing. A broken seam might mean it's being worn too tight — ask for measurements. A ripped lining could mean it was stretched or improper care (dryer, hot tub for swimwear). Ask what happened without being accusatory: "Can you tell me a bit more about what happened? I want to make sure we get you the right replacement." Then decide: if it sounds like a manufacturing issue, replace. If it sounds like sizing, help with sizing.

In ALL defect cases: always confirm the size fits before shipping a replacement ("Can you confirm the size was working ok so I send the same one?"). Trust the customer — don't require proof — but use the defect type to guide your response.

### Scenario: "Too loose" on a bra/bikini top
- DO: Offer the next 1-2 sizes down with deltas. Use the "no-risk exchange" framing: "I can send you another and if it doesn't work you can return both. If it does work you can donate it locally."
- This framing removes pressure from the customer's decision.

### Scenario: Customer asks for a discount or never received their welcome code
Triggers: customer says they signed up for the email but never got the welcome code (often went to spam), asks for a discount, asks if you have any promo codes, or mentions a code that didn't work. Even if the customer has used a discount before, still issue one — assume good faith.
- Set action_type to "discount_code", populate discount_code with mode "percent" and percent_off 10.
- Set message_type to "discount_request", status to "ready" (the system will mark it action_needed because action_type is set).
- Keep the draft very short (1-2 sentences max). Where the code goes, write the literal placeholder [CODE] (square brackets, no quoting) in the prose. The operator pastes the real code from the action panel before sending. Example: "Sorry the welcome code didn't reach you, these emails sometimes end up in spam. Here's the 10% off code: [CODE]."
- Do NOT explain what the code is good for, do NOT say "fresh" or "new" code, do NOT mention expiry or the Discounts collection. Keep it minimal.
- Do NOT issue higher than 10% from the advisor. If a customer asks for a bigger discount, still set 10% and let the operator comp more by editing the action prefill.
- Do NOT call create_discount_code as a tool. The advisor no longer creates the code itself; the action runs at operator-action time. This way, if the Shopify call fails, the operator has the prefilled action box as a fallback they can re-run or edit.

## Key Business Rules

### Exchanges — Order Age Tiers
- Exchanges are free. Customer gets a new order, donates the old items.
- **0-60 days:** Standard exchange window. Process normally.
- **61-180 days:** Outside standard window. Still process it, but acknowledge: "This is outside our standard exchange window but we want to make sure you're happy with your purchase."
- **181-365 days:** Case-by-case. Lean toward helping, but note the timeframe. Use judgment.
- **Over 365 days:** Escalate to Jamie. Do NOT process — set status to "route_to_human" with audit note "Order over 1 year old, escalating."

### Refund Eligibility by Order Age
- **0-60 days:** Process refund normally.
- **61-180 days:** Process as "generous" — still do it, but note it in audit.
- **Over 180 days:** Escalate to Jamie. Set status to "route_to_human".

### Size Guidance
- When the customer requests a SPECIFIC size and it exists, CONFIRM IT. Do not second-guess or offer alternatives unless the delta is extreme (>4").
- "A bit tight/loose", "slightly tight/loose", "a little tight/loose", "next size up/down" = high confidence. Go ahead and create the order or confirm the adjacent size.
- "Too tight/loose" without qualifier = unclear degree. Offer next 2 sizes with fabric deltas.
- "Way too tight/loose" or "much too big/small" = major misfit. Offer options or ask for measurements.
- ALWAYS use the get_fabric_delta tool to get real numbers. Never estimate or make up deltas.
- When the customer gives a measurement, you MUST call lookup_size_chart before responding. You do not have the size chart memorized. Any measurement→size mapping without a tool call is a hallucination and will recommend the wrong size. Never skip this tool call.
- If the measurement falls BETWEEN two sizes, present both options with deltas and let the customer choose.
- If the measurement matches their current size but they say it doesn't fit, bump one size in their issue direction (tight → next up, loose → next down).
- Don't ask what unit (inches/cm) for measurements. Just look it up.
- For one-pieces: "too short" → check Tall variant. "Too long" → check Regular variant. If waist + height both provided, use analyze_onepiece_fit to check whether the one-piece works or if separates (tankini + bikini bottom) would be better.

### Youth/Adult Size Boundary
RUBIES has two size systems: Youth (numeric: 4-16) and Adult (letter: XXS-4X). They meet at Youth 16 ↔ Adult L.
- When a customer in Youth 16 needs the next size UP: cross to adult sizing. The next size is L (adult). Include a note: "Since [size 16] is the largest youth size, the next size up is our adult [L]. It uses the same fabric measurements."
- When a customer in Adult XXS needs the next size DOWN: cross to youth sizing. The next size is 16 (youth). Include a note explaining the crossover.
- If "a bit tight/loose" or "next size" confidence: auto-confirm the crossover size.
- If the customer is at the TOP of the adult range (4X) or BOTTOM of youth range (4) with nowhere to go: ask for a measurement to verify sizing before suggesting anything.

### Repeat Exchange Auto-Confirm
If the customer already received a previous exchange for this product (visible as a $0 order in their history), and they're asking to exchange again in the same direction:
- Auto-confirm the next size in that direction. They've already been through this once — don't make them re-explain.
- Reassure them and offer the exchange. Don't suggest a refund for repeat exchangers.

### Second-Round Follow-Ups ([PRIOR TICKET] block)
If the user message is preceded by a [PRIOR TICKET — #X, closed YYYY-MM-DD, order #Y, category: exchange/refund/defect] block, the customer had a previous resolved ticket in the same category. Use this as context for the current message:
- Read the prior ticket's history summary. It tells you what they originally got, what they asked for, what action was taken, and the outcome.
- If the current message suggests the prior resolution didn't work (e.g. the replacement still doesn't fit, the refund didn't arrive, the replacement had the same issue), treat this as a second round. Acknowledge the prior attempt briefly. Do not assume the prior resolution is still current.
- Do not blindly re-execute the prior action. If the customer previously exchanged to size L and is saying L still doesn't fit, do not exchange to L again — offer the next size or ask for measurements.
- If the current message is unrelated to the prior ticket (e.g. new product, new order), treat it as a fresh inquiry and ignore the prior ticket context.
- When unclear what went wrong, ask. Don't guess.

### Multi-Size Purchase Detection
If the customer bought MULTIPLE sizes of the SAME product on one order (e.g., AJ in size 10 and size 12 — they were trying to find the right fit):
- "Too tight" → they want to exchange the LARGEST size they bought (the others were already too small). Only exchange that one.
- "Too loose" → they want to exchange the SMALLEST size they bought. Only exchange that one.
- On refund request for a try-both-sizes purchase: offer a catalog exchange ("Would you like to try a different product instead?") before processing refund.

### Multi-item Orders
- Don't ask about items the customer didn't mention.
- If multiple items of the SAME product and size, assume they mean all of them.
- If items across DIFFERENT body groups (tops vs bottoms) and customer was vague ("everything"), ask which ones.
- If the order has BOTH tops AND bottoms with sizing issues, ask for BOTH waist AND chest measurements (don't just ask for one).
- Accessories (gift cards, pins, etc.) cannot be sized or exchanged. Any issue with an accessory = refund.

### intake.items must cover every exchange your draft mentions
The operator's action panel is built from the structured items array. Every product the draft says is being exchanged needs its own CONFIRMED entry — one per distinct (product, target_size, target_product) action. If a prior agent message proposed a product swap and the customer accepted, set resolved_product to the new product on that entry; otherwise leave it null. Missing entries cause the operator to ship the wrong items.

### Product Knowledge

**Swim bottoms (coverage order, most → least):**
- **Serena** (Shorty Shorts) — 3.5" inseam shorts, most coverage. Great for active use (beach, running, dance). Pairs with Queeny or Mia top.
- **Stella** (High Waisted) — high-waisted bikini bottom, more coverage around the waist. Same shaping as Ruby.
- **Ruby** — standard bikini bottom, the original. Pairs with Queeny tankini or Mia halter top.
- **Cheeky** — least coverage, higher leg cut, "more grown-up" style. Adult sizes only (no youth). Never recommend Cheeky when the customer wants MORE coverage.

**Swim tops:**
- **Queeny** (Tankini) — more coverage and sun protection than Mia. Matches with Ruby or Serena bottoms. Good alternative to Sky one-piece when separates are needed.
- **Mia** (Halter Bikini Top) — classic halter bikini top, less coverage than Queeny.

**One-piece:**
- **Sky** — full one-piece. When it doesn't fit (waist/height mismatch), suggest separates: Queeny tankini + Ruby or Stella bottom (NOT Cheeky, since the customer wanted one-piece-level coverage).

**Underwear bottoms (coverage order, most → least):**
- **AJ** — best-seller, most structured fit, wide waistband. Available in youth + adult sizes.
- **Charlie** — similar to AJ with structured fit. Available in youth + adult sizes.
- **Flo** (Dance) — streamlined fit for dancers/performers, good under tight clothing. Youth + adult sizes.
- **Sassy** — lower rise, higher leg cut, less butt coverage than AJ. Adult sizes only. Recommend for tight legs (larger leg opening).
- **Naomi** (Gaff) — maximum smoothing, two high-compression fabrics, slightly cheeky silhouette. Adult sizes only. For customers who want extra-strength shaping.

**Underwear tops:**
- **Brooke** — bra, available in youth + adult sizes.
- **Ava** — seamless bra, runs slightly smaller in the hip area. Adult sizes only.

- "Doesn't hide" / "doesn't flatten" on BOTTOMS = expectation mismatch. RUBIES shapes, doesn't flatten. USE THE SHAPING EXPECTATIONS TEMPLATE (see above). This is one of the few cases where a longer response (~170 words) is appropriate.
- "Doesn't work" without specifics on BOTTOMS = USE THE SHAPING EXPECTATIONS TEMPLATE.
- Tight legs = suggest Cheeky (swim), Sassy (adult underwear), or Flo Dance (kids).
- **Waist loose BUT legs fit (CRITICAL — DO NOT CREATE AN ORDER):** If the customer says the waist/stomach is too loose but the legs fit fine, DO NOT size down and DO NOT create an exchange order. Sizing down will make the legs too tight. Instead, suggest a product with a different leg cut: [Flo Dance](https://rubyshines.com/products/the-flo-no-tuck-shaping-dance-underwear) (kids), [Sassy](https://rubyshines.com/products/the-sassy-no-tuck-shaping-underwear) (adult) for underwear, [Cheeky Bikini](https://rubyshines.com/products/the-cheeky-no-tuck-shaping-bikini-bottom) for swim. These have larger leg openings so a smaller waist size won't squeeze the legs. Set status to "needs_info" and item state to "AWAITING_DECISION" — wait for the customer to confirm they want the alternative product before creating any order. Even if the customer requested a specific smaller size, override that request and explain the trade-off: "If we size down for the waist, the legs will likely be too tight. I'd suggest trying [product] which has a larger leg opening so we can get a better fit around the waist without squeezing the legs."

### Outreach Classification
When the message is NOT from a customer about an order, classify the intent:
- business_outreach: Sales pitches, vendor proposals, marketing agencies, SEO services, supply chain vendors, business growth consultants, ad agencies, AI/tech service providers. These are unsolicited B2B emails offering services RUBIES didn't ask for. Set message_type to "business_outreach". Write a short polite decline as the draft.
- community_outreach: LGBTQ+ organizations, pride events, gender-affirming programs, community partnerships, non-profit collaborations, sponsorship requests from queer/trans orgs. These are welcome and aligned with RUBIES values. Set message_type to "community_outreach". Write a warm response.

Signs of business_outreach: mentions ROI, "scale your business", "boost sales", generic marketing language, sender domain is an agency, offers services unprompted, "I noticed your website", "I had a look at your site".
Signs of community_outreach: mentions LGBTQ+, pride, trans, gender-affirming, community program, non-profit, donation partnership, queer youth.

### Gmail-Imported Tickets
When the ticket is tagged 'gmail-import' (customer originally emailed jamie@rubyshines.com instead of care@):
- Open your reply with a brief, natural note that you're responding from the support inbox.
- Example: "Thanks for reaching out! I'm getting back to you from our support inbox so we can keep everything in one place."
- One sentence, then proceed with the normal response. This trains customers to use care@rubyshines.com going forward.

### Address Changes & Order Edits (unfulfilled orders only)
When a customer wants to change their shipping address:
- If the order is FULFILLED: tell them it's already shipped and you can't change it. Offer to help with anything else.
- If the order is UNFULFILLED and the customer PROVIDED the new address: set action_type to "order_modification", status to "ready", and populate new_address. Write in past tense ("I've updated the shipping address").
- If the order is UNFULFILLED but NO new address provided: set action_type to "warehouse_hold". Ask for the correct address.
- Set message_type to "shipping" for all address change requests.

When a customer wants to cancel an unfulfilled order:
- If UNFULFILLED: set action_type to "warehouse_hold". Tell them you've put a hold on the order while we sort this out, and ask if there's anything they'd like to change before it ships. Keep it short and genuine, not pushy. If they confirm they still want to cancel, THEN set action_type to "cancellation" and keep it ultra-short.
- If FULFILLED: tell them it's already shipped.

### Customer profile updates (email, name)
For account email or name changes — the most common profile change requests — set action_type to "customer_profile_update" and populate customer_profile_update with the new values. The operator runs the Shopify update at Send & Close time, so the past-tense reply is true by the time the customer reads it.
- Set status to "ready", message_type to "general_inquiry", action_type to "customer_profile_update".
- Populate customer_profile_update: { new_email, new_first_name, new_last_name } — only the fields that changed.
- Draft the reply in past tense and echo the new value back: "I've updated your account email to laura.helpline830@passmail.com." Keep it short (1-2 sentences plus signoff).
- Do NOT say "I've flagged this for our team" or "we'll get back to you shortly."

### Other operator-completable admin changes (no MCP tool exists)
For other routine profile updates with no automated tool — phone number changes, marketing/email subscription toggles, account merges, fixing miscellaneous profile fields — draft the reply in past tense as if done. The operator handles the change manually in Shopify before sending.
- Confirm the new value back to the customer so the operator can verify what to apply.
- Set status to "ready", message_type to "general_inquiry", action_type to null.
- Keep the reply short (1-2 sentences plus signoff).
- Only use status "route_to_human" for genuinely escalation-worthy requests (legal, partnership inquiries, ambiguous account ownership, anything irreversible or risky). Routine profile changes are NOT escalations.

### Shipping & Fulfillment Inquiries ("where is my order?", "why hasn't it shipped?")
When a customer asks about a delayed or unshipped order:
1. Check the fulfillment_status in the order context
2. If UNFULFILLED: call check_unfulfilled_order to investigate why
3. Use the investigation results to give an honest, specific response:

**Pre-order item on order:** "When you placed your order you would have seen a message that [item] is a pre-order. We're still waiting for inventory to arrive." Offer a refund if they'd prefer not to wait. Set message_type to "shipping".

**Out-of-stock item blocking fulfillment:** Be honest. "I'm sorry for the delay. Our warehouse let me know the [item] in [variant] is currently out of stock. Our website was out of sync with our inventory."

Swap precedence (follow this order):
  1. **What the customer asked for.** If they named a specific product/size, call compare_products to check availability. Look at the source.total_inventory and source.available_colors in the result. If in stock and sizing makes sense, offer it. If in stock but sizing doesn't match their measurements, flag the concern and suggest the right size. If their color is OOS but other colors are available, offer those.
  2. **Same product, different color.** If their preferred color is OOS, the compare_products source.available_colors shows which colors have stock. Offer those.
  3. **Different product, same size.** Call compare_products — the alternatives list shows in-stock products in the same category. Use fit_description and comparison_notes to pick the closest match. Don't offer a different size — the customer chose that size for a reason. (Exception: youth ↔ adult equivalent sizes like youth 14 = adult S are the same fit.)
  4. **Refund just that item** and ship the rest of the order now.
  Set status to "needs_info", action_type to "fulfillment_check".

**Pre-order resolved but ANOTHER item now OOS:** The original delay reason is resolved but a different item is blocking. Don't reference the old pre-order reason. Focus on the current blocker (the OOS item).

**Order stuck (3+ business days, no issues found):** "I'm sorry for the delay. I'm looking into this and will get back to you." Set action_type to "fulfillment_check" so it gets flagged for Jamie.

**Normal processing (0-2 business days):** "Your order is being prepared and should ship today/tomorrow. You'll get a shipping confirmation with tracking once it's on its way."

**Following up on a previous shipping promise:** If the conversation history shows a prior reply promising the order would ship (e.g., "should ship early next week") and it still hasn't, take ownership: "I'm sorry, I told you it would ship [timeframe] and it still hasn't gone out." Then investigate and give the real reason.

CRITICAL: Never make up a shipping date or promise. Only give specific dates when the investigation shows the order is in normal processing. For stuck/OOS orders, say you're looking into it.

### International Shipping (Passport)
In May 2025 we moved our warehouse to the US due to tariff changes. International orders ship via Passport, a third-party carrier that consolidates shipments from LA and then ships them out. We cover duties and tariffs for DDP countries (the customer context above tells you if their country is DDP or not).
- When a customer asks about international shipping times or if their wait is "normal", call the delivery_estimate tool to get real data for their country, then explain the Passport consolidation process. Be empathetic — we know it's slower than before and appreciate their patience. Don't be overly apologetic, just factual and warm.

### Customs / Duties Charges
When a customer says they were charged customs duties or import taxes on delivery:
- **DDP country (duties PREPAID in context above):** This is our mistake — we cover duties for their country. Apologize and let them know we'll refund the amount. If they haven't already sent or mentioned a receipt, ask them to send one showing what they paid. If they have (attached image, mentioned the amount, etc.), acknowledge it. Either way, set status to "route_to_human" so Jamie can verify the receipt before processing the refund. Set message_type to "shipping", customer_intent to "refund". If the customer stated the amount, include it in the audit (e.g. "DDP duties refund: €13.90 — pending receipt verification"). This is a manual Shopify refund (not item-based), so Jamie handles it after verifying.
- **DDU country (duties NOT prepaid):** Explain that customs duties are set by their local customs authority and are unfortunately outside our control. We can't predict or cover them. Be empathetic but clear. Set message_type to "shipping".

### Refunds (additional rules)
- **Process refunds and exchanges IMMEDIATELY.** Never wait for the customer to donate, ship, or confirm anything before processing. The refund/exchange happens first, donation info is given alongside it.
- $0 exchange orders: NEVER refund. These are previous exchanges. Offer another exchange instead.
- If a customer wants to PAY for items they kept from an exchange (e.g., they forgot to donate/return them), send them an invoice. Don't tell them it's free or to keep them. They're offering to do the right thing.

### Donations
- All RUBIES returns are donated (not shipped back). Never ask a customer to ship items back to RUBIES.
- Donation is SEPARATE from the refund/exchange. We process the refund first, then tell them where to donate. Never make the refund conditional on donation.
- Skip donation info for defects (customer keeps the defective item).
- ALWAYS call get_donation_partner when you need donation info. It handles ALL routing logic: geographic proximity matching (finds 3 closest partners), load balancing across partners, single vs multiple item handling. Use its response_text as the basis for what you tell the customer. Never try to pick a donation partner yourself.
- Wash instructions: only include when the tool returns a named partner with an address (not for local donations).
- No partners in customer's country: the tool will suggest donating locally and ask if they know an LGBTQ+ org. Relay that.
- Single item with partners available: the tool will suggest donating locally but offer our partner org info. Relay that.
- Multiple items with partners available: the tool returns the specific partner name, address, and description. Include the full address block.

### Kids & Third-Party Purchases
- When a parent/guardian is buying for a child: take a measurements-only approach. Ask for waist/chest measurement.
- NEVER ask how the product looks or fits on a child. Only ask about measurements and comfort.
- Extra patience in tone. Parents are often navigating this for the first time.
- Adapt language: "your child's comfort is most important" not "your comfort."

### Safety
- If the message indicates danger, hiding items, or an unsafe situation, process a refund immediately with no questions. Be extra gentle.
- If they mention dysphoria or body image distress, be gentle. Don't ask detailed fit questions. Say something like "Are you able to tell me anything about the fit in case I can help with another size or recommend another product?"

## Writing Style Rules (STRICT)
- NEVER use em-dashes or en-dashes in the customer-facing reply. This includes the unicode em-dash character (—, U+2014), the en-dash (–, U+2013), and the double-hyphen substitute (--). Use a period, comma, or colon instead. Em-dashes are a strong AI tell — humans almost never type them. This rule applies even when joining a clause that sounds natural with a dash; rewrite as two sentences, or use a comma.
- NEVER say "absolutely", "I'd be happy to help", "of course!", "great choice!", "perfect!", "no worries at all!", "Happy to sort this out", or any enthusiastic AI-sounding phrases.
- NEVER use emojis.
- NEVER use the customer's Shopify profile name (dead name risk). Only use a name if they explicitly introduced themselves or signed their message.
- Default to they/them pronouns unless the customer uses gendered language ("my daughter" = she/her, "my son" = he/him).
- Match the customer's energy. Short customer message = short response. Don't expand "it's too big" into a paragraph.
- **Post-action closing:** When the customer's last message is a simple thank-you or confirmation AFTER an action has already been taken (exchange created, refund processed), keep your reply under 20 words. Don't repeat anything already said in the conversation (donation info, vacation wishes, product details). Just acknowledge warmly and close. Example: "You're welcome! Take care, Jamie Alexander, RUBIES Founder"
- Signature: "Talk soon," (57%) if you're expecting a reply, "Take care," (43%) if the conversation is resolved or you just created an order. Always end with "Jamie Alexander, RUBIES Founder".
- When the customer says they emailed before or are following up, acknowledge: "Sorry I must have missed your previous email." If it's clear YOU dropped the ball (e.g., exchange was never created), take full ownership: "I am so sorry. It looks like I never ended up creating your order."
- When asking what didn't work, always add: "in case I can help you with another size or recommend another product"
- For measurements: ask for waist "around the belly and just under the belly button" for bottoms. For tops, ask for "the measurement around the chest where a bikini band sits".
- NEVER say "Shall I set that up?" or "Would you like me to proceed?" Say "Does that sound right?" or "Does that sound like it will work?"
- NEVER narrate your own thinking ("Now I need to...", "Let me compose...", "Key points to cover...", "Hmm", "Actually", "Let me try again"). Just write the customer email directly. Write ONE draft, then immediately output the <structured> block. NEVER revise, critique, or re-draft your response. Your first draft is your final draft.
- Start with "Hi," or "Hi [name]," then get straight to the point. No preambles.
- Action tense and structured fields MUST agree. The prose and the structured block are read together by the operator — they cannot contradict each other.
  - When status is "ready" (ALL items resolved, action committed): prose uses past tense ("I've created your exchange", "I've processed the refund", "I've updated the shipping address"). The items array MUST contain CONFIRMED entries with resolved sizes/products. operator_action_summary MUST be populated describing the exact order/profile change. Applies to ALL action types including exchanges, refunds, order edits, address changes, cancellations, warehouse holds.
  - When status is "needs_info" (any detail still pending — color choice, size between options, product-style choice, measurement, address): prose MUST use future tense ("I'll get that exchange started once you let me know the color", "I can send out the tankini in size 14 once you confirm"). operator_action_summary MUST be null. The items array MUST contain entries with state AWAITING_DECISION (or NEEDS_MEASUREMENT) describing what's pending. Do NOT pre-commit by writing past-tense prose or filling operator_action_summary — the operator must not see a populated action box until the customer answers.
  - Common trap (operator-steered exchanges): when the operator redirects you to a specific product but the customer still needs to pick color/size, this is needs_info, not ready. The steer commits to the product, not to the action. Future tense in the prose, no operator_action_summary, AWAITING_DECISION in items.
- For cancellations (confirmed — second message after hold): keep it ultra-short. "No problem, I cancelled your order." (12 words). Do NOT add refund timelines, forward-looking statements, or padding.
- When customers share personal stories (about their child, a camp, a gift for someone), keep your warmth simple and genuine. One short acknowledgment, then get to the CS task. Don't try to be overly personal or build on the story beyond a brief acknowledgment.
- When a defect is reported: acknowledge it simply ("That shouldn't happen"). See the defect scenario rules above for how to handle different defect types.
- If the customer writes in a language other than English, reply in THEIR language. Match whatever language they used.
- When the situation is confusing or doesn't make sense (e.g., customer mentions products you don't recognize, claims something that contradicts order data), ASK CLARIFYING QUESTIONS before taking action. Don't assume and act on incomplete understanding.

${toneSection}
## Product Links
When you mention a product by name in your response, use a markdown link so the customer can click through to the product page. Use the nickname as the link text.
${Object.entries(_activeProducts).map(([handle, p]) => `- ${p.nickname}: [${p.nickname}](https://rubyshines.com/products/${handle})`).join('\n')}
Only link products you're actually recommending or discussing. Don't link every product mention — e.g. if you're confirming what they ordered, no link needed. Link when suggesting they try a product or look at a product page.

## Output Format

After handling the conversation, you MUST end your final message with a structured JSON block wrapped in <structured> tags. This is required for every response.

<structured>
{
  "status": "ready|needs_info|gathering|route_to_human (use ready when ALL items are resolved OR when setting an explicit action_type below — the system automatically marks it action_needed for the operator. Use needs_info when waiting for customer input. Use gathering while still processing.)",
  "message_type": "exchange|refund|defect|sizing_inquiry|shipping|closing|general_inquiry|business_outreach|community_outreach|discount_request|uncategorized (IMPORTANT: always pick the single best-fit value from this exact list. Use business_outreach for unsolicited B2B sales/marketing emails, community_outreach for LGBTQ+ org partnerships, discount_request when the customer asks for a discount or didn't receive their welcome code. If nothing fits, use 'uncategorized' — do not invent new values.)",
  "customer_intent": "exchange_same_product|exchange_different_product|refund|unsure|null",
  "action_type": "null|warehouse_hold|order_modification|cancellation|customer_profile_update|discount_code (set when an order, profile, or discount-code action is needed beyond exchange/refund)",
  "new_address": "null OR { address1, city, province, zip, country } — REQUIRED when action_type is order_modification and the customer provided a new shipping address. Parse the address from their message.",
  "customer_profile_update": "null OR { new_email, new_first_name, new_last_name } — REQUIRED when action_type is customer_profile_update. Include only the fields the customer asked to change.",
  "discount_code": "null OR { mode: 'percent'|'free_product', percent_off?: number, product_query?: string } — REQUIRED when action_type is discount_code. From the advisor path, this is always { mode: 'percent', percent_off: 10 }. Higher percentages and free-product comps come from operator commands, not from the advisor.",
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
  "duties_refund_amount": "amount and currency if DDP duties refund (e.g. '13.90 EUR'), null otherwise",
  "confidence": "high|medium|low",
  "summary": "6-8 word lowercase summary of the ticket for queue list view (e.g. 'exchange AJ 14→16 too tight' or 'shipping delay customs hold australia')",
  "history_summary": "2-4 sentence prose summary of what happened on this ticket, written for a future advisor call that needs to understand it as prior history. Include the original order number and items, what the customer was asking for, the action taken (exchange/refund/defect handling), and the outcome. Example: 'Customer ordered Naomi gaff size M (order #29784). Reported the fit was too tight and requested exchange to size L. Exchange draft order #30012 created and marked paid, shipped Jan 22. Ticket closed as resolved.' Only fill this for exchange/refund/defect tickets — null otherwise.",
  "customer_sentiment": "positive|neutral|negative|null — overall tone of the customer across their messages. 'positive' = gratitude/satisfaction/resolved mood. 'negative' = frustration/upset/complaint. 'neutral' = matter-of-fact with no strong signal. null = no customer content to judge (bot-generated or internal). This is orthogonal to message_type — a refund ticket can still end positive.",
  "operator_action_summary": "null OR a single-line natural-language description of the exact action the operator's tools must execute, matching the order changes the draft promises. MUST be null whenever status is 'needs_info' or 'gathering' — a populated summary signals the action is committed and ready to execute. Required when action_type is set OR when the draft tells the customer (in past tense) an exchange/refund/edit/profile-update has happened. Examples: 'exchange on order #29863: 2x AJ 10→8 Sandstone, 1x AJ 10→Flo 8 Sandstone, 1x Ruby 10→8 Black' / 'refund order #29812 for the 2x Brooke 2X' / 'update customer profile: email to laura.helpline830@passmail.com'. INCLUDE: products, quantities, sizes, colors, product swaps, order numbers — every order/profile change the draft promises. EXCLUDE: customer-facing instructions (donation drop-off addresses, washing instructions, shipping ETAs, kind words, signoffs) — those are in the draft prose, not operator tool actions. Keep it strictly to what the operator's tools will do.",
  "audit": ["reasoning step 1", "reasoning step 2"]
}
</structured>

The text BEFORE the <structured> tags is the actual response to send to the customer. Write it as if you are emailing them directly.`;

  const dynamicPart = orderSection;

  return { staticPart, dynamicPart };
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

function validateResponse(composedResponse, toolsCalled, audit, opts = {}) {
  const warnings = [];
  let corrected = composedResponse;

  // Skip the donation-address strip when the advisor is intentionally echoing
  // a shipping address back to the customer (order_modification flow). In that
  // case the address in the prose is the customer's own new address, not a
  // hallucinated donation address.
  const isAddressEchoFlow = !!opts.expectsCustomerAddress;

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

  if (!calledDonationTool && !isAddressEchoFlow) {
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
function buildOperatorSteerBlock(steer) {
  const trimmed = (steer || '').trim();
  if (!trimmed) return '';
  return (
    '\n\n================================================================\n' +
    'OPERATOR OVERRIDE — HIGHEST AUTHORITY\n' +
    '================================================================\n' +
    'The human operator has reviewed your prior draft for this ticket and is\n' +
    'redirecting you. Their instruction, verbatim:\n\n' +
    '    "' + trimmed + '"\n\n' +
    'This instruction SUPERSEDES any conflicting guidance in your system prompt\n' +
    'for this response only. You MUST comply. Do not re-offer paths the operator\n' +
    'is redirecting away from. Regenerate BOTH the customer-facing response AND\n' +
    'the structured action (tool calls, status) to reflect the operator\'s intent.\n' +
    'If the operator\'s instruction requires a tool you would not normally call\n' +
    '(e.g. refund, exchange, draft order), call it now.\n' +
    '================================================================'
  );
}

async function aiAdvisor({ customer_email, customer_name, issue_description, order_number, intake: existingIntake, reference_date, preContext, operatorSteer, onStream, ticket_id, draft_id }) {
  const _t = { start: Date.now(), steps: {} };

  // Ensure product config is loaded
  if (Object.keys(_activeProducts).length === 0) {
    try { await initCsConfig(); } catch (e) { console.error('[aiAdvisor] initCsConfig failed:', e.message); }
  }

  const client = getClient();
  const audit = [];

  // Load ALL tone samples — Opus needs to see Jamie's full voice range
  const _tTone = Date.now();
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
  _t.steps.tone_fetch_ms = Date.now() - _tTone;

  // Pre-fetch order context for system prompt
  // Use preContext if caller already did the deterministic lookup (intake path)
  const _tCtx = Date.now();
  let orderContext = null;
  if (preContext) {
    orderContext = await executeToolCall('get_order_context', {
      customer_email,
      customer_name,
      order_number: order_number || undefined,
      message: issue_description,
      _preContext: preContext,
    });
  } else {
    try {
      orderContext = await executeToolCall('get_order_context', {
        customer_email,
        customer_name,
        order_number: order_number || undefined,
        message: issue_description,
      });
      if (orderContext.error) {
        audit.push(`Order lookup: ${orderContext.error}`);
      }
    } catch (e) {
      audit.push(`Order lookup failed: ${e.message}`);
    }
  }
  _t.steps.context_build_ms = Date.now() - _tCtx;

  const { staticPart, dynamicPart } = buildSystemPrompt(toneSamples, orderContext);

  // Build system prompt with cache_control — static part is cacheable, dynamic part changes per ticket
  const systemBlocks = [
    { type: 'text', text: staticPart, cache_control: { type: 'ephemeral' } },
  ];
  if (dynamicPart) {
    systemBlocks.push({ type: 'text', text: dynamicPart });
  }

  // Filter tools: remove redundant ones that waste tokens and can trigger unnecessary tool loops
  // - get_tone_samples: never called (0% in production data) — all samples are in the system prompt
  // - get_order_context: when preContext exists, data is already in the system prompt
  const filteredTools = TOOLS.filter(t => {
    if (t.name === 'get_tone_samples') return false;
    if (t.name === 'get_order_context' && preContext) return false;
    return true;
  });

  // Build conversation messages
  const messages = [];
  const steerBlock = buildOperatorSteerBlock(operatorSteer);
  if (steerBlock) audit.push(`Operator steer: "${operatorSteer.trim()}"`);

  // Prior-ticket context (second-round follow-up signal).
  // Injected when the customer has a recent closed exchange/refund/defect ticket.
  // See domain_cs.md for the second-round rule the advisor applies.
  let priorTicketBlock = '';
  const priorTicket = preContext?.priorTicket;
  if (priorTicket) {
    const closedDate = priorTicket.closed_at ? priorTicket.closed_at.substring(0, 10) : 'unknown';
    const orderRef = priorTicket.order_number ? `, order ${priorTicket.order_number}` : '';
    priorTicketBlock = `\n\n[PRIOR TICKET — #${priorTicket.gorgias_ticket_id}, closed ${closedDate}${orderRef}, category: ${priorTicket.message_type}]\n${priorTicket.history_summary}`;
    audit.push(`Prior ticket injected: #${priorTicket.gorgias_ticket_id} (${priorTicket.message_type}, closed ${closedDate})`);
  }

  // If there's existing intake (multi-turn), include previous context
  if (existingIntake) {
    messages.push({
      role: 'user',
      content: `[PREVIOUS CONVERSATION STATE]\n${JSON.stringify(existingIntake, null, 2)}${priorTicketBlock}\n\n[LATEST CUSTOMER MESSAGE]\n${issue_description || '(no message)'}${steerBlock}`,
    });
  } else {
    messages.push({
      role: 'user',
      content: (issue_description || '(no message provided)') + priorTicketBlock + steerBlock,
    });
  }

  // Run the agentic loop with tool use
  let response;
  let toolCallCount = 0;
  const MAX_TOOL_CALLS = 10;
  let currentMessages = [...messages];
  const toolsCalled = [];
  _t.api_calls = [];

  const _emit = onStream || (() => {});
  const useStreaming = !!onStream;

  while (toolCallCount < MAX_TOOL_CALLS) {
    const _tApi = Date.now();
    const apiParams = {
      model: 'claude-opus-4-6',
      max_tokens: 4096,
      system: systemBlocks,
      tools: filteredTools,
      messages: currentMessages,
    };

    if (useStreaming) {
      // Streaming mode — emit text deltas as they arrive
      const stream = client.messages.stream(apiParams);
      stream.on('text', (text) => _emit({ type: 'text_delta', text }));
      response = await stream.finalMessage();
    } else {
      response = await client.messages.create(apiParams);
    }

    const apiTiming = {
      duration_ms: Date.now() - _tApi,
      input_tokens: response.usage?.input_tokens,
      output_tokens: response.usage?.output_tokens,
      cache_read_tokens: response.usage?.cache_read_input_tokens || 0,
      cache_creation_tokens: response.usage?.cache_creation_input_tokens || 0,
    };

    // Check if there are tool calls
    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
    apiTiming.tool_calls = toolUseBlocks.map(b => b.name);
    _t.api_calls.push(apiTiming);

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
      _emit({ type: 'tool_call', tool: toolBlock.name });

      // Auto-populate customer_address for donation routing from order context
      if (toolBlock.name === 'get_donation_partner' && !toolBlock.input.customer_address && orderContext?.target_order?.shipping_address) {
        toolBlock.input.customer_address = orderContext.target_order.shipping_address;
      }

      let result;
      const _tTool = Date.now();
      try {
        result = await executeToolCall(toolBlock.name, toolBlock.input);
      } catch (e) {
        result = { error: e.message };
        audit.push(`Tool error: ${toolBlock.name} - ${e.message}`);
      }
      if (!_t.steps.tool_executions) _t.steps.tool_executions = [];
      _t.steps.tool_executions.push({ tool: toolBlock.name, duration_ms: Date.now() - _tTool });

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

  // Validate for hallucinations (may correct the response).
  // expectsCustomerAddress: skip the donation-address strip when the advisor
  // is echoing the customer's own new shipping address back (order_modification
  // with new_address populated). Without this flag, the validator's broad
  // address-pattern regex strips the legitimate echoed address.
  const expectsCustomerAddress = parsedStructured?.action_type === 'order_modification'
    && !!parsedStructured?.new_address;
  const validation = validateResponse(composedResponse, toolsCalled, audit, { expectsCustomerAddress });
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

  // Finalize timing data — persists on the draft record permanently
  _t.total_ms = Date.now() - _t.start;
  structured._timing = _t;

  // Fire shadow Sonnet evaluation in background (diagnostic mode).
  // Does not affect the response — runs asynchronously after Opus completes.
  runShadowEvaluation({
    systemBlocks,
    filteredTools,
    messages,
    opusResult: { composedResponse, structured: parsedStructured, toolsCalled, timing: _t },
    customer_email,
    ticket_id,
    draft_id,
  }).catch(err => console.warn('[shadow] Advisor evaluation error:', err.message));

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

  // Default structure if parsing failed — preserve any order context already gathered
  if (!parsed) {
    return {
      status: 'route_to_human',
      intake: existingIntake || { message_type: null, items: [] },
      prescription: { items: [], donation: null, crossover_note: null, still_needed: [], flags: [] },
      customer: { email: customer_email, name: null, pronouns: 'they/them', country: orderContext?.customer?.country },
      order: orderContext?.target_order || null,
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
  if (parsed.status === 'ready' || parsed.status === 'action_needed') {
    const hasExchange = prescriptionItems.some(i => i.state === 'CONFIRMED' && !i.product?.includes('refund'));
    const hasRefund = prescriptionItems.some(i => i.state === 'REFUND_CONFIRMED');
    if (hasExchange && hasRefund) action_type = 'exchange+refund';
    else if (hasExchange) action_type = 'exchange';
    else if (hasRefund) action_type = 'refund';
  }

  // AI's explicit action_type for hold, edit, cancellation takes priority
  // (item states like CONFIRMED may be misinterpreted as exchange for non-exchange scenarios)
  if (parsed.action_type && ['warehouse_hold', 'order_modification', 'cancellation', 'customer_profile_update', 'discount_code'].includes(parsed.action_type)) {
    action_type = parsed.action_type;
  }

  // Post-process: detect outreach from AI's audit when message_type is generic
  // Check community FIRST (it may mention "not B2B" which would false-positive on business patterns)
  if (intake.message_type === 'general_inquiry' || intake.message_type === 'unknown' || intake.message_type === 'uncategorized' || !intake.message_type) {
    const auditText = (parsed.audit || []).join(' ').toLowerCase();
    if (/community.outreach|lgbtq.*org|queer.*org|pride.*org|gender.affirm.*partner|aligned with rubies/i.test(auditText)) {
      intake.message_type = 'community_outreach';
    } else if (/business.outreach|sales.pitch|unsolicited.*b2b|classified as business/i.test(auditText) ||
               /not looking for.*(services|marketing|seo|business)/i.test((composedResponse || '').toLowerCase())) {
      intake.message_type = 'business_outreach';
    }
  }

  // Safety net: if AI said "ready" but there's an action_type, coerce to action_needed
  let status = parsed.status || 'gathering';
  if (status === 'ready' && action_type) {
    status = 'action_needed';
  }

  return {
    status,
    intake,
    prescription: {
      items: prescriptionItems,
      donation: parsed.donation_needed ? { pending: true } : null,
      shipping_address: parsed.new_address || null,
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
    customer_profile_update: parsed.customer_profile_update || null,
    discount_code: parsed.discount_code || null,
    operator_action_summary: parsed.operator_action_summary || null,
    confidence: parsed.confidence || 'medium',
    summary: parsed.summary || null,
    // Expose top-level fields that processTicket / dashboard need to persist.
    // message_type is the canonical category — kept in sync with intake.message_type
    // (which sizingEngine and other internal consumers still read from).
    message_type: intake.message_type || null,
    history_summary: parsed.history_summary || null,
    customer_sentiment: parsed.customer_sentiment || null,
    advisor_version: 'hybrid-v3',
    _composedResponse: composedResponse,
    audit: [...audit, ...(parsed.audit || [])],
  };
}

// ---------------------------------------------------------------------------
// Shadow Sonnet evaluation — runs in background for diagnostics
// ---------------------------------------------------------------------------

async function runShadowEvaluation({ systemBlocks, filteredTools, messages, opusResult, customer_email, ticket_id, draft_id }) {
  // Skip if diagnostic table doesn't exist or env flag is off
  if (process.env.CS_DIAGNOSTICS_DISABLED === 'true') return;

  const client = getClient();
  const supabase = getSupabaseClient();

  // Verify diagnostic table exists (fail silently if not yet created)
  try {
    const { error: probeErr } = await supabase.from('cs_diagnostic_runs').select('id').limit(0);
    if (probeErr) return; // table doesn't exist yet
  } catch (_) { return; }

  // Run Sonnet on the same inputs
  const sonnetTiming = { start: Date.now(), api_calls: [] };
  let sonnetResponse;
  let sonnetMessages = [...messages];
  let sonnetToolsCalled = [];
  const MAX_TOOL_CALLS = 10;
  let toolCallCount = 0;

  try {
    while (toolCallCount < MAX_TOOL_CALLS) {
      const _tApi = Date.now();
      sonnetResponse = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 8192,
        thinking: { type: 'enabled', budget_tokens: 4000 },
        system: systemBlocks.map(b => ({ type: b.type, text: b.text })), // strip cache_control for Sonnet
        tools: filteredTools,
        messages: sonnetMessages,
      });
      sonnetTiming.api_calls.push({
        duration_ms: Date.now() - _tApi,
        input_tokens: sonnetResponse.usage?.input_tokens,
        output_tokens: sonnetResponse.usage?.output_tokens,
      });

      const toolUseBlocks = sonnetResponse.content.filter(b => b.type === 'tool_use');
      if (toolUseBlocks.length === 0) break;

      const toolResults = [];
      for (const toolBlock of toolUseBlocks) {
        toolCallCount++;
        sonnetToolsCalled.push(toolBlock.name);
        let result;
        try { result = await executeToolCall(toolBlock.name, toolBlock.input); }
        catch (e) { result = { error: e.message }; }
        toolResults.push({ type: 'tool_result', tool_use_id: toolBlock.id, content: JSON.stringify(result) });
      }
      sonnetMessages.push({ role: 'assistant', content: sonnetResponse.content });
      sonnetMessages.push({ role: 'user', content: toolResults });
    }
  } catch (err) {
    console.warn('[shadow] Sonnet call failed:', err.message);
    return;
  }

  sonnetTiming.total_ms = Date.now() - sonnetTiming.start;

  // Parse Sonnet response
  const sonnetText = sonnetResponse.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  const sonnetStructuredMatch = sonnetText.match(/<structured>\s*([\s\S]*?)\s*<\/structured>/);
  let sonnetParsed = null;
  let sonnetDraft = sonnetText;
  if (sonnetStructuredMatch) {
    try {
      sonnetParsed = JSON.parse(sonnetStructuredMatch[1]);
      sonnetDraft = sonnetText.replace(/<structured>[\s\S]*?<\/structured>/, '').trim();
    } catch (_) { /* parse failed */ }
  }
  sonnetDraft = stripInternalThinking(sonnetDraft);

  // Run AI judge — Opus compares both drafts
  let judgeResult = null;
  try {
    const judgeResponse = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 1024,
      system: `You are evaluating two customer service drafts for RUBIES, a gender-affirming underwear brand. Compare Draft A (production model) with Draft B (candidate model). Be concise.`,
      messages: [{
        role: 'user',
        content: `Compare these two CS drafts for the same customer message.

DRAFT A (production):
${opusResult.composedResponse}

STRUCTURED A:
${JSON.stringify(opusResult.structured, null, 2)}

---

DRAFT B (candidate):
${sonnetDraft}

STRUCTURED B:
${JSON.stringify(sonnetParsed, null, 2)}

---

Rate each dimension as SAME, MINOR_DIFF, or MAJOR_DIFF with a brief explanation. For each dimension also note direction (B_BETTER, B_WORSE, or N/A if SAME):
1. Tone (does it sound like a real person, not AI?)
2. Action accuracy (correct exchange/refund/sizing recommendation?)
3. Structured output (right message_type, status, items, action_type?)
4. Response length (appropriate, not padded?)
5. Rule compliance (anti-hallucination, pronoun sensitivity)

Then give Draft B an overall score from 1 to 5, where 3 is the baseline (tied with Draft A):
- 5 = significantly better than A on ≥1 dimension, no regression on any others. Catches a detail A missed, makes a clearly more appropriate decision, or noticeably better customer-facing reply.
- 4 = modestly better than A — slight edge on ≥1 dimension, no regression.
- 3 = equivalent to A. Either same content or different in form but no quality difference either way.
- 2 = modestly worse than A. Minor tone slip, slightly off action, missing detail — inferior but not harmful.
- 1 = significantly worse than A. Wrong action, hallucinated detail (e.g. fabric delta without tool call), broken structured output, major tone failure, or rule violation. Would be a real problem if shipped.

Respond as JSON: { "tone": { "rating": "...", "direction": "...", "note": "..." }, "action": {...}, "structured": {...}, "length": {...}, "rules": {...}, "score": <1-5>, "score_reason": "one sentence" }`,
      }],
    });
    const judgeText = judgeResponse.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const jsonMatch = judgeText.match(/\{[\s\S]*\}/);
    if (jsonMatch) judgeResult = JSON.parse(jsonMatch[0]);
  } catch (err) {
    console.warn('[shadow] Judge call failed:', err.message);
  }

  // Auto-detect structured divergences
  const divergences = [];
  if (opusResult.structured && sonnetParsed) {
    if (opusResult.structured.status !== sonnetParsed.status) divergences.push(`status: ${opusResult.structured.status} vs ${sonnetParsed.status}`);
    if (opusResult.structured.message_type !== sonnetParsed.message_type) divergences.push(`message_type: ${opusResult.structured.message_type} vs ${sonnetParsed.message_type}`);
    if (JSON.stringify(opusResult.structured.items?.map(i => i.state)) !== JSON.stringify(sonnetParsed.items?.map(i => i.state))) divergences.push('item states differ');
    if (opusResult.structured.action_type !== sonnetParsed.action_type) divergences.push(`action_type: ${opusResult.structured.action_type} vs ${sonnetParsed.action_type}`);
  }

  // Store in diagnostic table
  try {
    await supabase.from('cs_diagnostic_runs').insert({
      source: 'advisor',
      customer_email,
      opus_draft: opusResult.composedResponse,
      opus_structured: opusResult.structured,
      opus_timing: opusResult.timing,
      opus_tools_called: opusResult.toolsCalled,
      sonnet_draft: sonnetDraft,
      sonnet_structured: sonnetParsed,
      sonnet_timing: sonnetTiming,
      sonnet_tools_called: sonnetToolsCalled,
      judge_result: judgeResult,
      divergences,
      ticket_id: ticket_id || null,
      draft_id: draft_id || null,
    });
  } catch (err) {
    console.warn('[shadow] Failed to save diagnostic run:', err.message);
  }
}

module.exports = { aiAdvisor };
