/**
 * Exchange/Return Decision Tree
 *
 * Deterministic decision logic for exchange and return conversations.
 * Takes structured intake + order context, returns prescriptions per item.
 *
 * The AI agent handles:
 *   - Parsing customer messages → structured intake (unstructured → structured)
 *   - Composing responses in Jamie's voice (structured → natural language)
 *
 * This module handles everything in between — no AI judgment, all code.
 */

const { getSupabaseClient } = require('../../shared/supabaseClient');

// ---------------------------------------------------------------------------
// Product nicknames — short names for customer-facing messages
// ---------------------------------------------------------------------------

const PRODUCT_NICKNAMES = {
  'THE AJ NO-TUCK SHAPING UNDERWEAR': 'AJ',
  'THE AVA SEAMLESS SHAPING BRA': 'Ava',
  'THE BROOKE SHAPING BRA': 'Brooke',
  'THE CHARLIE NO-TUCK EXTRA CUTE SHAPING UNDERWEAR': 'Charlie',
  'THE CHEEKY NO-TUCK SHAPING BIKINI BOTTOM': 'Cheeky',
  'THE FLO SHAPING DANCE UNDERWEAR': 'Flo',
  'THE MIA HALTER BIKINI TOP': 'Mia',
  'THE RUBY NO-TUCK SHAPING BIKINI BOTTOM': 'Ruby',
  'THE SASSY NO-TUCK SHAPING UNDERWEAR': 'Sassy',
  'THE SERENA NO-TUCK SHAPING SHORTY SHORT': 'Serena',
  'THE SKY NO-TUCK SHAPING ONE-PIECE': 'Sky',
  'THE STELLA HIGH WAISTED SHAPING BIKINI BOTTOM': 'Stella',
  'THE SUNNY QUEENY TANKINI': 'Queeny',
  'MAGICAL SHAPING GEL CHEST PADS': 'Magical Chest Pads',
  'RUBIES SHAPING CHEST PADS': 'Chest Pads',
  'NO-TUCK SHAPING UNDERWEAR': 'No-Tuck Underwear',
  'EVERY GIRL DESERVES TO SHINE ADULT TEE': 'Adult Tee',
  'THE RUBIES BIKINI SET - BIKINI BOTTOM + BIKINI TOP': 'Bikini Set',
  'THE RUBIES MATCHING SET - UNDERWEAR + BRA': 'Matching Set',
  'THE RUBIES SHAPING BUNDLE - 3 AJ UNDERWEAR + 1 BIKINI BOTTOM': 'Shaping Bundle',
  'RUBIES GIFT CARD': 'Gift Card',
  'PROGRESS PRIDE EARRINGS': 'Pride Earrings',
  'PROGRESS PRIDE FLAG': 'Pride Flag',
  'PROGRESS PRIDE PINS': 'Pride Pins',
};

/**
 * Get short nickname for a product. Falls back to the full title if no nickname.
 */
function getProductNickname(fullTitle) {
  if (!fullTitle) return 'item';
  const upper = fullTitle.toUpperCase();

  // Try exact match
  if (PRODUCT_NICKNAMES[upper]) return PRODUCT_NICKNAMES[upper];

  // Try: does any nickname key contain the title or vice versa
  for (const [key, nick] of Object.entries(PRODUCT_NICKNAMES)) {
    if (upper.includes(key) || key.includes(upper)) return nick;
  }

  // Try: extract the person name from "THE [NAME] ..." pattern
  // Handles product name changes (e.g., "THE AJ SHAPING UNDERWEAR" vs "THE AJ NO-TUCK SHAPING UNDERWEAR")
  const nameMatch = fullTitle.match(/^THE\s+(\w+)\s/i);
  if (nameMatch) {
    const name = nameMatch[1].toUpperCase();
    for (const [key, nick] of Object.entries(PRODUCT_NICKNAMES)) {
      if (key.includes('THE ' + name + ' ')) return nick;
    }
    // If the extracted name is a known nickname, just return it capitalized
    const knownNicks = Object.values(PRODUCT_NICKNAMES);
    const capitalized = name.charAt(0) + name.slice(1).toLowerCase();
    if (knownNicks.includes(capitalized)) return capitalized;
  }

  return fullTitle;
}

// ---------------------------------------------------------------------------
// Size constants (shared with exchangeAdvisor.js)
// ---------------------------------------------------------------------------

const NUMERIC_SIZES = ['4', '6', '7', '8', '9', '10', '11', '12', '13', '14', '16'];
const LETTER_SIZES = ['XXS', 'XXS+', 'XS', 'XS+', 'S', 'M', 'L', '1X', '2X', '3X', '4X'];
const SIZE_ALIASES = { 'XL': '1X', 'XXL': '2X', '3XL': '3X', '4XL': '4X', '5XL': '5X' };
const ODD_HALF_SIZES = new Set(['7', '9', '11', '13', 'XXS+', 'XS+']);

function normalizeSize(size) {
  if (!size) return null;
  const s = size.toString().trim().toUpperCase();
  return SIZE_ALIASES[s] || s;
}

function getSizeList(size) {
  const s = normalizeSize(size);
  if (NUMERIC_SIZES.includes(s)) return NUMERIC_SIZES;
  if (LETTER_SIZES.includes(s)) return LETTER_SIZES;
  return null;
}

function getAdjacentSizes(currentSize, direction, count = 2) {
  const s = normalizeSize(currentSize);
  const list = getSizeList(s);
  if (!list) return [];
  const idx = list.indexOf(s);
  if (idx < 0) return [];

  const results = [];
  const step = direction === 'up' ? 1 : -1;
  for (let i = 1; i <= count; i++) {
    const newIdx = idx + (step * i);
    if (newIdx >= 0 && newIdx < list.length) {
      results.push(list[newIdx]);
    }
  }
  return results;
}

function getGradingDelta(fromSize, toSize) {
  const from = normalizeSize(fromSize);
  const to = normalizeSize(toSize);
  if (ODD_HALF_SIZES.has(from) || ODD_HALF_SIZES.has(to)) {
    return { inches: 1, cm: 2.5, note: 'half-size step' };
  }
  return { inches: 2, cm: 5, note: 'full-size step' };
}

/**
 * Format the fabric delta for display.
 * @param {string} productType - 'bottom' | 'bra' | 'bikini_top' | 'top' | 'onepiece'
 */
function formatDelta(fromSize, toSize, direction, useInches, productType) {
  const d = getGradingDelta(fromSize, toSize);
  const unit = useInches ? `${d.inches}"` : `${d.cm}cm`;
  const sign = direction === 'up' ? '+' : '-';

  // Be explicit about WHERE the fabric difference is
  let description;
  switch (productType) {
    case 'bra':
      description = `the bra band will be ${unit} ${direction === 'up' ? 'longer' : 'shorter'}`;
      break;
    case 'bikini_top':
      description = `the bikini top band will be ${unit} ${direction === 'up' ? 'longer' : 'shorter'}`;
      break;
    case 'top':
      description = `${sign}${unit} of fabric around the torso`;
      break;
    default:
      description = `${sign}${unit} of fabric around the waist`;
      break;
  }

  return `${toSize} (${description})`;
}

/**
 * Calculate cumulative fabric delta between two sizes (accounting for odd/half sizes).
 * Returns { inches, cm } or null if sizes aren't in the same system.
 */
function getCumulativeDelta(fromSize, toSize) {
  const from = normalizeSize(fromSize);
  const to = normalizeSize(toSize);
  const list = getSizeList(from);
  if (!list || !list.includes(to)) return null;

  const fromIdx = list.indexOf(from);
  const toIdx = list.indexOf(to);
  if (fromIdx === toIdx) return { inches: 0, cm: 0 };

  const step = toIdx > fromIdx ? 1 : -1;
  let totalInches = 0;
  let totalCm = 0;
  let idx = fromIdx;
  while (idx !== toIdx) {
    const nextIdx = idx + step;
    const d = getGradingDelta(list[idx], list[nextIdx]);
    totalInches += d.inches;
    totalCm += d.cm;
    idx = nextIdx;
  }
  return { inches: totalInches, cm: totalCm };
}

// ---------------------------------------------------------------------------
// Phase 0: Safety Override
// ---------------------------------------------------------------------------

function checkSafetyOverride(intake) {
  const signals = [
    'hazardous', 'unsafe', 'dangerous', 'hiding', 'hide them',
    'not safe', 'safety', 'fear', 'scared', 'abusive', 'abuse',
  ];
  const text = (intake._latestMessage || '').toLowerCase();
  for (const signal of signals) {
    if (text.includes(signal)) {
      return {
        override: true,
        action: 'immediate_refund',
        message: 'Process refund immediately. No questions. No conversion attempt. Express hope for their situation.',
        audit: 'SAFETY OVERRIDE: detected "' + signal + '" in message',
      };
    }
  }
  return { override: false };
}

// ---------------------------------------------------------------------------
// Phase 1: Customer Identification
// ---------------------------------------------------------------------------

function prescribeCustomerIdentification(intake, context) {
  const prescription = {
    phase: 'identify_customer',
    actions: [],
    audit: [],
  };

  // Name
  if (intake.name) {
    prescription.audit.push(`Name: "${intake.name}" (explicit from message)`);
  } else {
    prescription.actions.push({ type: 'name_warning', text: 'Do NOT use Shopify profile name — greet without name' });
    prescription.audit.push('Name: not given — dead name risk');
  }

  // Pronouns
  prescription.audit.push(`Pronouns: ${intake.pronouns || 'they/them'} (${intake.pronoun_reason || 'default'})`);

  // Third party
  if (intake.buying_for === 'third_party') {
    prescription.actions.push({
      type: 'third_party_adapt',
      text: `Buying for ${intake.third_party_label || 'someone else'} — adapt language: "your ${intake.third_party_label || 'child'}'s comfort is most important"`,
    });
    if (['daughter', 'girl', 'son', 'boy', 'kid', 'kiddo', 'child'].includes(intake.third_party_label)) {
      prescription.actions.push({
        type: 'kid_sensitivity',
        text: 'Kid: measurements only, never ask how product looks on child, extra patience',
      });
    }
    prescription.audit.push(`Buying for: ${intake.third_party_label} (third party)`);
  }

  // Email mismatch
  if (intake.email_mismatch) {
    prescription.actions.push({
      type: 'email_mismatch',
      text: `Reply to ${intake.conversation_email} — order data from ${intake.order_email}`,
    });
    prescription.audit.push(`Email mismatch: conv=${intake.conversation_email}, order=${intake.order_email}`);
  }

  // Customer not found
  if (!context.customer) {
    prescription.actions.push({
      type: 'ask_info',
      text: 'Customer not found — ask for order number or email they ordered with',
    });
    prescription.still_needed = ['customer_identification'];
  }

  return prescription;
}

// ---------------------------------------------------------------------------
// Phase 2: Order & Item Identification
// ---------------------------------------------------------------------------

function prescribeOrderIdentification(intake, context) {
  const prescription = {
    phase: 'identify_orders',
    actions: [],
    still_needed: [],
    audit: [],
  };

  // Order identification
  if (!intake.order_number && !context.targetOrder) {
    if (context.fulfilled?.length === 1) {
      prescription.audit.push(`Auto-selected only fulfilled order: ${context.fulfilled[0].name}`);
    } else if (context.fulfilled?.length > 1) {
      prescription.actions.push({
        type: 'ask_order',
        text: 'Multiple recent orders — ask which one: ' + context.fulfilled.slice(0, 4).map(o => o.name).join(', '),
      });
      prescription.still_needed.push('order_number');
    } else {
      prescription.actions.push({
        type: 'ask_order',
        text: 'No fulfilled orders found — ask for order number',
      });
      prescription.still_needed.push('order_number');
    }
  } else {
    prescription.audit.push(`Order: ${intake.order_number ? '#' + intake.order_number : context.targetOrder?.name || 'unknown'}`);
  }

  // Order age check
  if (context.targetOrder?.createdAt) {
    const days = Math.floor((Date.now() - new Date(context.targetOrder.createdAt).getTime()) / 86400000);
    if (days <= 60) {
      prescription.audit.push(`Order age: ${days} days (within 60-day window)`);
    } else if (days <= 180) {
      prescription.actions.push({
        type: 'gentle_exception',
        text: `Order is ${days} days old — outside 60-day window. Gently note: "This is outside our standard window but we want to make sure you're happy"`,
      });
      prescription.audit.push(`Order age: ${days} days (accommodating as exception)`);
    } else if (days <= 365) {
      prescription.actions.push({
        type: 'case_by_case',
        text: `Order is ${days} days old — lean toward helping but note the timeframe`,
      });
      prescription.audit.push(`Order age: ${days} days (case-by-case)`);
    } else {
      prescription.actions.push({
        type: 'escalate',
        text: `Order is ${days} days old (>1 year) — escalate to Jamie`,
      });
      prescription.audit.push(`Order age: ${days} days (ESCALATE)`);
    }
  }

  // Item identification
  if (intake.items.length === 0) {
    prescription.actions.push({
      type: 'ask_items',
      text: 'Which item(s) are you looking to exchange/return?',
    });
    prescription.still_needed.push('items');
  } else {
    for (const item of intake.items) {
      prescription.audit.push(`Item: ${item.product || '?'} size ${item.size || '?'} — ${item.issue || 'no issue specified'}`);
    }
  }

  // Multi-item logic (current order only, never past orders):
  //
  // 1. SAME product, same size (multiple qty or colors) → assume ALL unless customer explicitly said otherwise
  // 2. DIFFERENT product, same size, same category (bottoms/tops) → ask "would you like to exchange the [other product] too?"
  //
  if (intake.items.length >= 1 && context.targetOrder) {
    const orderItems = (context.targetOrder.lineItems || []);

    for (const intakeItem of intake.items) {
      if (!intakeItem.size) continue;
      const normalizedSize = normalizeSize(intakeItem.size);
      const isBottom = !intakeItem.product?.toLowerCase().match(/bra|top|chest pad/);

      for (const oi of orderItems) {
        const oiIsBottom = !oi.title?.toLowerCase().match(/bra|top|chest pad/);
        if (isBottom !== oiIsBottom) continue; // Different category (bottoms vs tops)

        const oiSizeMatch = oi.variantTitle?.match(/\b(\d{1,2}|XXS\+?|XS\+?|S|M|L|[1-4]X)\b/i);
        const oiSize = oiSizeMatch ? normalizeSize(oiSizeMatch[1]) : null;
        if (oiSize !== normalizedSize) continue; // Different size

        // Is this the SAME product (including different colors)?
        const isSameProduct = intakeItem.product && oi.title &&
          (oi.title.toLowerCase().includes(intakeItem.product.toLowerCase()) ||
           intakeItem.product.toLowerCase().includes(oi.title.toLowerCase()));

        if (isSameProduct) {
          // Same product, same size — assume customer means all of them
          // (could be multiple colors). No need to ask.
          // Just note it in audit for awareness.
          if (oi.quantity > 1) {
            prescription.audit.push(`Same product: ${oi.title} qty ${oi.quantity} — assuming all included`);
          }
        } else {
          // DIFFERENT product, same size, same category → ask
          const alreadyTracked = intake.items.some(i =>
            i.product && oi.title &&
            oi.title.toLowerCase().includes(i.product.toLowerCase())
          );
          if (!alreadyTracked) {
            prescription.actions.push({
              type: 'multi_item_flag',
              text: `Order also has ${oi.title} in size ${oiSize} — ask: "Would you like to exchange that one too?"`,
            });
            prescription.audit.push(`Multi-item flag: ${oi.title} size ${oiSize} (different product, same size + category)`);
            break; // Only flag once per category
          }
        }
      }
    }
  }

  // Multi-size purchase detection
  // Only flag if the SAME product appears in genuinely DIFFERENT sizes (not just different colors)
  if (context.targetOrder) {
    const items = context.targetOrder.lineItems || [];
    const productSizes = {};
    for (const li of items) {
      const key = li.title;
      // Extract size from SKU (last segment) — deterministic
      const skuSize = li.sku ? normalizeSize(li.sku.split('-').pop()) : null;
      if (!productSizes[key]) productSizes[key] = new Set();
      if (skuSize) productSizes[key].add(skuSize);
    }
    for (const [product, sizeSet] of Object.entries(productSizes)) {
      const uniqueSizes = [...sizeSet];
      if (uniqueSizes.length > 1) {
        prescription.actions.push({
          type: 'multi_size_flag',
          text: `Customer bought ${getProductNickname(product)} in ${uniqueSizes.length} different sizes (${uniqueSizes.join(', ')}) — sizing uncertainty. Offer measurement help.`,
        });
        prescription.audit.push(`Multi-size purchase: ${product} in ${uniqueSizes.join(', ')}`);
      }
    }
  }

  return prescription;
}

// ---------------------------------------------------------------------------
// Phase 3: Action Classification
// ---------------------------------------------------------------------------

function prescribeActionClassification(intake) {
  const prescription = {
    phase: 'classify_actions',
    items: [],
    audit: [],
  };

  for (const item of intake.items) {
    const classified = {
      product: item.product,
      size: item.size,
      action: null,
      audit: null,
    };

    if (item.issue === 'defect' || item.issue === 'DEFECT') {
      classified.action = 'defect';
      classified.audit = 'Defect reported';
    } else if (item.resolved_size) {
      classified.action = 'exchange_confirmed';
      classified.audit = `Already confirmed: ${item.size} → ${item.resolved_size}`;
    } else if (item.issue === 'close_fit_tight' || item.issue === 'too_tight') {
      classified.action = 'sizing_exchange';
      classified.direction = 'up';
      classified.audit = 'Close fit — too tight, size up';
    } else if (item.issue === 'close_fit_loose' || item.issue === 'too_loose') {
      classified.action = 'sizing_exchange';
      classified.direction = 'down';
      classified.audit = 'Close fit — too loose, size down';
    } else if (item.issue === 'way_off') {
      classified.action = 'sizing_exchange_measurement';
      classified.audit = 'Way off — need measurement';
    } else if (item.issue === 'product_not_working' || item.issue === 'expectation_mismatch') {
      classified.action = 'probe_needed';
      classified.audit = 'Product not working — need to probe';
    } else if (item.issue === 'doesnt_fit' || item.issue === 'fit_issue') {
      // Customer said "doesn't fit" without specifying tight or loose
      classified.action = 'fit_direction_unclear';
      classified.audit = 'Fit issue without direction — ask tight vs loose';
    } else if (item.issue === 'tight_legs') {
      classified.action = 'style_switch';
      classified.audit = 'Tight legs — recommend alternative style';
    } else if (item.issue === 'onepiece_fit') {
      classified.action = 'onepiece_check';
      classified.audit = 'One-piece fit — need waist + height';
    } else if (item.issue === 'refund_request') {
      classified.action = 'refund';
      classified.audit = 'Refund requested';
    } else if (item.issue === 'unclear' || item.issue === 'none') {
      // Customer said it doesn't fit but didn't say how — ask product-specific fit question
      classified.action = 'fit_direction_unclear';
      classified.audit = 'Fit issue but direction unclear — ask tight vs loose';
    } else {
      classified.action = 'needs_clarification';
      classified.audit = 'Issue unclear — ask what didn\'t work';
    }

    prescription.items.push(classified);
    prescription.audit.push(`${item.product || '?'}: ${classified.action} (${classified.audit})`);
  }

  return prescription;
}

// ---------------------------------------------------------------------------
// Phase 4: Sizing Resolution
// ---------------------------------------------------------------------------

function prescribeSizingResolution(classifiedItems, intake, context) {
  const prescription = {
    phase: 'sizing_resolution',
    items: [],
    still_needed: [],
    audit: [],
  };

  const isThirdParty = intake.buying_for === 'third_party';
  const useInches = context.isNorthAmerica;

  for (const item of classifiedItems) {
    const rx = {
      product: item.product,
      size: item.size,
      state: null,
      response_text: null,
      options: null,
      audit: null,
    };

    switch (item.action) {
      case 'exchange_confirmed': {
        rx.state = 'CONFIRMED';
        rx.response_text = null; // No response needed, already confirmed
        rx.audit = `Already confirmed: ${item.size} → ${intake.items.find(i => i.product === item.product)?.resolved_size}`;
        break;
      }

      case 'sizing_exchange': {
        const currentSize = normalizeSize(item.size);
        if (!currentSize) {
          rx.state = 'AWAITING_SIZE';
          rx.response_text = `What size is the ${item.product} currently?`;
          rx.audit = 'Need current size before recommending';
          prescription.still_needed.push(`current_size for ${item.product}`);
          break;
        }

        const direction = item.direction;

        // Determine product type for fabric delta description
        const prodLower = (item.product || '').toLowerCase();
        let productType = 'bottom';
        if (prodLower.includes('brooke') || prodLower.match(/\bbra\b/)) productType = 'bra';
        else if (prodLower.includes('mia') || prodLower.includes('halter')) productType = 'bikini_top';
        else if (prodLower.match(/\btop\b/) || prodLower.includes('tankini')) productType = 'top';

        // Check if customer already requested a specific size
        const intakeItem = intake.items.find(i => i.product === item.product);
        const desiredSize = intakeItem?.resolved_size || intakeItem?.desired_size;

        if (desiredSize) {
          // Customer asked for a specific size — check if delta is ≤2" (confident) or >2" (confirm)
          const delta = getCumulativeDelta(currentSize, normalizeSize(desiredSize));
          if (delta && delta.inches <= 2) {
            // Small jump (≤1 even size) — process immediately
            rx.state = 'CONFIRMED';
            if (intakeItem && !intakeItem.resolved_size) intakeItem.resolved_size = normalizeSize(desiredSize);
            if (!intake.resolution_sizes.some(r => r.product === item.product)) {
              intake.resolution_sizes.push({ product: item.product, from_size: currentSize, to_size: normalizeSize(desiredSize) });
            }
            rx.response_text = null;
            rx.audit = `Specific size requested: ${currentSize} → ${desiredSize} (${delta.inches}" delta, ≤2" — auto-confirmed)`;
          } else if (delta) {
            // Big jump (>2") — confirm with fabric delta
            const unit = useInches ? `${delta.inches}"` : `${delta.cm} cm`;
            let bodyDesc;
            switch (productType) {
              case 'bra': bodyDesc = `the bra band will be ${unit} ${direction === 'up' ? 'longer' : 'shorter'}`; break;
              case 'bikini_top': bodyDesc = `the bikini top band will be ${unit} ${direction === 'up' ? 'longer' : 'shorter'}`; break;
              case 'top': bodyDesc = `that's ${unit} ${direction === 'up' ? 'more' : 'less'} fabric around the torso`; break;
              default: bodyDesc = `that's ${unit} ${direction === 'up' ? 'more' : 'less'} fabric around the waist`; break;
            }
            rx.state = 'AWAITING_SIZE_CONFIRMATION';
            rx.response_text = `Size ${normalizeSize(desiredSize)} from ${currentSize} — ${bodyDesc}. Is that what you're after?`;
            rx.audit = `Specific size requested: ${currentSize} → ${desiredSize} (${delta.inches}" delta, >2" — confirming)`;
            prescription.still_needed.push(`size_confirmation for ${item.product}`);
          } else {
            // Can't calculate delta (different size systems?) — confirm
            rx.state = 'AWAITING_SIZE_CONFIRMATION';
            rx.response_text = `You'd like to go from ${currentSize} to ${desiredSize} — shall I set that up?`;
            rx.audit = `Specific size requested: ${currentSize} → ${desiredSize} (could not calculate delta — confirming)`;
            prescription.still_needed.push(`size_confirmation for ${item.product}`);
          }
          break;
        }

        // Customer described the problem but didn't request a specific size
        // Confidence: "a bit tight/loose" → 1 step, auto-confirm. "too tight/loose" → offer options.
        const issueText = (intakeItem?.issue || item.issue || '').toLowerCase();
        const isABit = /a bit|slightly|little bit|a little/.test(issueText) ||
          /a bit|slightly|little bit|a little/.test((intake._latestMessage || '').toLowerCase());
        const isNextSize = /next size/.test((intake._latestMessage || '').toLowerCase());

        const adjacent = getAdjacentSizes(currentSize, direction, 2);

        if (adjacent.length === 0) {
          // Check if we're at the youth→adult boundary (size 16 going up)
          const isYouthSystem = NUMERIC_SIZES.includes(currentSize);
          const isAtTop = isYouthSystem && currentSize === '16' && direction === 'up';
          const isAtBottom = !isYouthSystem && currentSize === 'XXS' && direction === 'down';

          if (isAtTop) {
            // Youth 16 = Adult M. Next up is L.
            const adultNext = 'L';
            const crossoverNote = 'Just a heads up — size 16 is the largest youth size so this moves into adult sizing.';

            if (isABit || isNextSize) {
              // High confidence — auto-confirm, note the crossover
              rx.state = 'CONFIRMED';
              if (intakeItem) intakeItem.resolved_size = adultNext;
              if (!intake.resolution_sizes.some(r => r.product === item.product)) {
                intake.resolution_sizes.push({ product: item.product, from_size: currentSize, to_size: adultNext });
              }
              rx.response_text = null;
              rx._crossover_note = crossoverNote;
              rx.audit = `Youth→adult crossover: 16 → L (auto-confirmed, high confidence "${isABit ? 'a bit' : 'next size'}")`;
            } else {
              // Lower confidence — confirm with delta
              const adultDelta = getCumulativeDelta('M', adultNext) || { inches: 2, cm: 5 };
              const unit = useInches ? `${adultDelta.inches}"` : `${adultDelta.cm}cm`;
              let desc;
              switch (productType) {
                case 'bra': desc = `the bra band will be ${unit} longer`; break;
                case 'bikini_top': desc = `the bikini top band will be ${unit} longer`; break;
                case 'top': desc = `+${unit} of fabric around the torso`; break;
                default: desc = `+${unit} of fabric around the waist`; break;
              }
              rx.state = 'AWAITING_SIZE_CONFIRMATION';
              rx.response_text = `Size 16 is the largest youth size. The next size up moves into adult sizing — size L (${desc}). Shall I set that up?`;
              rx.audit = `Youth→adult crossover: 16 → L (confirming, lower confidence)`;
              prescription.still_needed.push(`size_confirmation for ${item.product}`);
            }
          } else if (isAtBottom) {
            if (isABit || isNextSize) {
              rx.state = 'CONFIRMED';
              if (intakeItem) intakeItem.resolved_size = '16';
              if (!intake.resolution_sizes.some(r => r.product === item.product)) {
                intake.resolution_sizes.push({ product: item.product, from_size: currentSize, to_size: '16' });
              }
              rx.response_text = null;
              rx._crossover_note = 'Just a heads up — XXS is the smallest adult size so this moves into youth sizing (size 16).';
              rx.audit = `Adult→youth crossover: XXS → 16 (auto-confirmed, high confidence)`;
            } else {
              rx.state = 'AWAITING_SIZE_CONFIRMATION';
              rx.response_text = `XXS is the smallest adult size. The next size down moves into youth sizing — size 16. Shall I set that up?`;
              rx.audit = `Adult→youth crossover: XXS → 16 (confirming, lower confidence)`;
              prescription.still_needed.push(`size_confirmation for ${item.product}`);
            }
          } else {
            rx.state = 'AWAITING_MEASUREMENT';
            rx.response_text = `${currentSize} is ${direction === 'up' ? 'the largest' : 'the smallest'} size available. Could you send your ${context.measurementType || 'waist'} measurement so I can help find the right fit?`;
            rx.audit = `At size boundary (${currentSize}), need measurement`;
            prescription.still_needed.push(`measurement for ${item.product}`);
          }
          break;
        }

        // Build size options with cumulative fabric deltas
        const sizeList = getSizeList(currentSize);
        const optionDetails = adjacent.map(s => {
          const delta = getCumulativeDelta(currentSize, s) || { inches: 2, cm: 5 };
          const unit = useInches ? `${delta.inches}"` : `${delta.cm} cm`;
          const sign = direction === 'up' ? '+' : '-';
          const more = direction === 'up' ? 'more' : 'less';
          let description;
          switch (productType) {
            case 'bra': description = `which has the bra band ${unit} ${direction === 'up' ? 'longer' : 'shorter'}`; break;
            case 'bikini_top': description = `which has the bikini top band ${unit} ${direction === 'up' ? 'longer' : 'shorter'}`; break;
            case 'top': description = `which has ${unit} ${more} fabric around the torso`; break;
            default: description = `which has ${unit} ${more} fabric around the waist`; break;
          }
          return { size: s, delta, formatted: `${s} ${description}` };
        });

        if ((isABit || isNextSize) && adjacent.length >= 1) {
          // High confidence — one size step, auto-confirm
          const next = adjacent[0];
          const delta = optionDetails[0].delta;
          rx.state = 'CONFIRMED';
          if (intakeItem) intakeItem.resolved_size = next;
          if (!intake.resolution_sizes.some(r => r.product === item.product)) {
            intake.resolution_sizes.push({ product: item.product, from_size: currentSize, to_size: next });
          }
          rx.response_text = null; // Will be handled by order creation
          rx.audit = `High confidence ("${isABit ? 'a bit' : 'next size'}") — auto-confirmed: ${currentSize} → ${next} (${delta.inches}" delta)`;
        } else {
          // Lower confidence — offer options, ask to confirm
          rx.state = 'AWAITING_SIZE_CONFIRMATION';
          rx.options = optionDetails;

          if (adjacent.length === 1) {
            rx.response_text = `The next size ${direction} is ${optionDetails[0].formatted} — shall I set that up?`;
          } else {
            rx.response_text = `The next size ${direction} is ${optionDetails[0].formatted}, or ${optionDetails[1].formatted}. Which sounds better?`;
          }

          rx.audit = `Close fit ${direction}: ${currentSize} → ${adjacent.join(' or ')} | offered with fabric delta, awaiting confirmation`;
          prescription.still_needed.push(`size_confirmation for ${item.product}`);
        }
        break;
      }

      case 'sizing_exchange_measurement': {
        if (intake.measurement) {
          // We have measurement — look up the size
          rx.state = 'AWAITING_SIZE_CONFIRMATION';
          rx.response_text = `Based on your measurement, I'd recommend size [LOOKUP_NEEDED]. Shall I set that up?`;
          rx.audit = `Measurement provided: ${intake.measurement.value} ${intake.measurement.unit} — lookup needed`;
          rx.lookup_needed = {
            measurement: intake.measurement,
            product: item.product,
          };
          prescription.still_needed.push(`size_confirmation for ${item.product}`);
        } else {
          rx.state = 'AWAITING_MEASUREMENT';
          const measureType = item.product?.toLowerCase().match(/bra|top/) ? 'chest' : 'waist';
          const unit = useInches ? 'inches' : 'cm';
          rx.response_text = `Could you send me the ${measureType} measurement around the ${measureType === 'waist' ? 'belly, just under the belly button' : 'chest where a bra band would sit'}, in ${unit}?`;
          rx.audit = `Way off — asking for ${measureType} measurement in ${unit}`;
          prescription.still_needed.push(`measurement for ${item.product}`);
        }
        break;
      }

      case 'probe_needed': {
        rx.state = 'AWAITING_CLARIFICATION';
        rx.response_text = `Can you let me know what didn't work out with the ${item.product}?`;
        rx.audit = 'Product not working — probing before deciding path';
        prescription.still_needed.push(`clarification for ${item.product}`);
        break;
      }

      case 'style_switch': {
        // Determine recommendation based on product type + size system
        const sizeList = item.size ? getSizeList(normalizeSize(item.size)) : null;
        const isKids = sizeList === NUMERIC_SIZES;
        const isSwim = item.product?.toLowerCase().match(/bikini|swim/);

        let recommendation, link;
        if (isSwim) {
          recommendation = 'Cheeky Bikini Bottoms';
          link = 'https://rubyshines.com/collections/adults-swimwear';
        } else if (isKids) {
          recommendation = 'Flo Dance Underwear';
          link = 'https://rubyshines.com/collections/kids-underwear';
        } else {
          recommendation = 'Sassy';
          link = 'https://rubyshines.com/collections/adults-underwear';
        }

        rx.state = 'AWAITING_STYLE_CONFIRMATION';
        rx.response_text = `For leg openings, the ${recommendation} has the largest cut. Would you like to try that instead? ${link}`;
        rx.recommendation = { product: recommendation, link };
        rx.audit = `Tight legs → ${recommendation} (${isKids ? 'kids' : 'adult'}, ${isSwim ? 'swim' : 'underwear'})`;
        prescription.still_needed.push(`style_confirmation for ${item.product}`);
        break;
      }

      case 'onepiece_check': {
        if (intake.measurement) {
          rx.state = 'ONEPIECE_FIT_CHECK';
          rx.response_text = 'Checking one-piece fit with your measurements...';
          rx.lookup_needed = { type: 'onepiece_fit', measurement: intake.measurement };
          rx.audit = 'One-piece — have measurement, need fit check';
        } else {
          rx.state = 'AWAITING_MEASUREMENT';
          const unit = useInches ? 'inches' : 'cm';
          rx.response_text = `For the one-piece, I need both your waist measurement (around the belly, just under the belly button) and your height, in ${unit}.`;
          rx.audit = 'One-piece — need waist + height';
          prescription.still_needed.push(`waist_and_height for ${item.product}`);
        }
        break;
      }

      case 'defect': {
        // Check order history for pattern
        const sameTypeCount = (context.orderHistory || []).filter(o =>
          o.lineItems?.some(li =>
            li.title?.toLowerCase().includes(item.product?.toLowerCase()) &&
            li.variantTitle?.includes(item.size)
          )
        ).length;

        if (sameTypeCount > 1) {
          // Multiple items same size — likely genuine defect
          rx.state = 'AWAITING_PHOTO';
          rx.response_text = `Could you send a photo of the issue? We'd like to forward it to our supplier so they can address the quality issue. I'll send a replacement right away.`;
          rx.defect_likely_genuine = true;
          rx.audit = `Defect: ${sameTypeCount} orders with same product+size → likely genuine. Ask photo, send replacement.`;
        } else {
          // Only item — might be wearing too tight
          rx.state = 'AWAITING_MEASUREMENT_AND_PHOTO';
          rx.response_text = `Could you send a photo? We'd like to forward it to our supplier. Also, just to make sure we send the right size for the replacement, could you send your ${item.product?.toLowerCase().match(/bra|top/) ? 'chest' : 'waist'} measurement?`;
          rx.defect_likely_genuine = false;
          rx.audit = `Defect: only item in this size → check if wearing too tight. Ask photo + measurement.`;
        }
        // Defects: customer keeps original, no donation routing
        rx.skip_donation = true;
        prescription.still_needed.push(`photo for ${item.product}`);
        break;
      }

      case 'refund': {
        // Check eligibility
        let eligible = 'unknown';
        if (context.targetOrder?.createdAt) {
          const days = Math.floor((Date.now() - new Date(context.targetOrder.createdAt).getTime()) / 86400000);
          eligible = days <= 60 ? 'yes' : days <= 180 ? 'generous' : 'escalate';
        }

        rx.state = 'AWAITING_DECISION';
        // Gently suggest exchange first
        rx.response_text = `Before we process the refund, would you be open to trying a different size or style? Sometimes a small adjustment makes all the difference.`;
        rx.refund_eligible = eligible;
        rx.audit = `Refund requested — eligible: ${eligible}. Suggesting exchange first.`;
        prescription.still_needed.push(`decision for ${item.product}`);
        break;
      }

      case 'fit_direction_unclear': {
        // Customer says "doesn't fit" but didn't say tight or loose.
        // Ask a product-specific fit question.
        rx.state = 'AWAITING_CLARIFICATION';
        const prodLowerFit = (item.product || '').toLowerCase();
        const isBra = prodLowerFit.includes('bra');
        const isBikiniTop = prodLowerFit.includes('mia') || prodLowerFit.includes('halter') || prodLowerFit.includes('tankini');
        const isTop = isBra || isBikiniTop || prodLowerFit.includes('top');
        const isOnepiece = prodLowerFit.includes('one') || prodLowerFit.includes('sky');
        const nick = getProductNickname(item.product);

        if (isOnepiece) {
          rx.response_text = `Can you let me know how the ${nick} fits? For example, does the bottom feel too tight or too loose around the waist, or does the top come up too high or sit too low?`;
        } else if (isTop) {
          rx.response_text = `Can you let me know how the ${nick} fits? Was it too tight or too loose up top?`;
        } else {
          rx.response_text = `Can you let me know how the ${nick} fits? Was the waist too tight or too loose?`;
        }
        rx.audit = `Fit direction unclear — asking product-specific question (${isOnepiece ? 'onepiece' : isTop ? 'top' : 'bottom'})`;
        prescription.still_needed.push(`fit_direction for ${item.product}`);
        break;
      }

      case 'needs_clarification':
      default: {
        rx.state = 'AWAITING_CLARIFICATION';
        rx.response_text = `Can you let me know what didn't work out with the ${getProductNickname(item.product) || 'item'}?`;
        rx.audit = 'Unclear issue — asking for clarification';
        prescription.still_needed.push(`clarification for ${item.product || 'item'}`);
        break;
      }
    }

    prescription.items.push(rx);
    prescription.audit.push(`${rx.product || '?'}: ${rx.state} — ${rx.audit}`);
  }

  return prescription;
}

// ---------------------------------------------------------------------------
// Phase 5: Order Creation (prescription only — actual creation is separate)
// ---------------------------------------------------------------------------

function prescribeOrderCreation(intake) {
  const readyItems = intake.items.filter(i => i.resolved_size);
  if (readyItems.length === 0) return null;

  return {
    phase: 'create_order',
    items: readyItems.map(i => ({
      product: i.product,
      from_size: i.size,
      to_size: i.resolved_size,
      to_product: i.resolved_product || null,
    })),
    response_text: `I'll set up the exchange: ${readyItems.map(i => `${i.product} ${i.size} → ${i.resolved_size}`).join(', ')}. Shall I confirm?`,
    audit: `Order creation: ${readyItems.length} items ready`,
  };
}

// ---------------------------------------------------------------------------
// Phase 6: Donation Routing
// ---------------------------------------------------------------------------

async function prescribeDonationRouting(intake, context) {
  // Skip for defects
  const hasDefect = intake.items.some(i => i.issue === 'defect');
  const nonDefectItems = intake.items.filter(i => i.issue !== 'defect');
  if (nonDefectItems.length === 0) {
    return {
      phase: 'donation_routing',
      skip: true,
      reason: 'All items are defects — customer keeps originals',
      audit: 'Skipped: defect items keep original',
    };
  }

  const country = context.customerCountry;
  const itemCount = nonDefectItems.length;

  if (!country) {
    return {
      phase: 'donation_routing',
      response_text: 'Ask for shipping address to determine donation routing',
      audit: 'Need country for donation routing',
    };
  }

  const supabase = getSupabaseClient();
  let partners = [];
  try {
    const { data } = await supabase.rpc('get_donation_partners_by_country', {
      p_country_code: country,
      p_limit: 3,
    });
    partners = data || [];
  } catch (e) { /* no partners table yet */ }

  const programExplanation = 'We have moved to a model where all RUBIES returns will be donated to organizations that run gender-affirming programs.';
  const washReminder = 'Please wash any items that have been worn or tried on before donating.';

  if (partners.length === 0) {
    return {
      phase: 'donation_routing',
      type: 'local_no_partner',
      response_text: `${programExplanation} Feel free to donate locally to any organization that supports the gender-diverse community. ${washReminder} Do you know of any LGBTQ+ organizations in your area we could partner with?`,
      audit: `No partners in ${country} — local donation + ask for org referral`,
    };
  }

  if (itemCount <= 1) {
    return {
      phase: 'donation_routing',
      type: 'local_single',
      response_text: `${programExplanation} Since you only have one item to return, feel free to donate it locally to any organization that supports the gender-diverse community. ${washReminder}`,
      audit: `Single item in ${country} — local donation (not worth shipping to partner)`,
    };
  }

  // Multiple items — route to partner with fewest donations
  const partner = partners[0]; // Already sorted by donations_routed ASC
  return {
    phase: 'donation_routing',
    type: 'partner',
    partner,
    response_text: `${programExplanation} Since you have multiple items, you can donate to ${partner.name} at ${partner.address}. They ${partner.description.toLowerCase()} ${washReminder}`,
    audit: `${itemCount} items → ${partner.name} (${partner.city}, ${country}) — ${partner.donations_routed} previous donations`,
  };
}

// ---------------------------------------------------------------------------
// Phase 7: Positive feedback detection
// ---------------------------------------------------------------------------

function checkPositiveFeedback(messageText) {
  if (!messageText) return null;
  const lower = messageText.toLowerCase();
  const signals = [
    'love rubies', 'love your', 'love the product', 'love these', 'amazing',
    'thank you so much', 'wonderful', 'you guys are great', 'fantastic',
    'love what you do', 'great brand', 'so happy', 'love them',
  ];
  for (const signal of signals) {
    if (lower.includes(signal)) {
      return {
        detected: true,
        response_text: 'Thank them genuinely for their kind words. Ask them to spread the word about RUBIES.',
        audit: `Positive feedback detected: "${signal}"`,
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main: Walk the full tree
// ---------------------------------------------------------------------------

/**
 * Walk the decision tree for a conversation.
 *
 * @param {Object} intake - The structured intake (progressive, from parseExchangeIntake)
 * @param {Object} context - Order/customer context from Shopify
 *   { customer, targetOrder, fulfilled, exchanges, all, customerCountry,
 *     isNorthAmerica, orderHistory }
 * @returns {Object} Full prescription with per-item actions + audit trail
 */
async function walkTree(intake, context) {
  const result = {
    // The prescription — what to say/do
    status: 'gathering',
    response_parts: [],   // Ordered list of things to include in the response
    still_needed: [],      // What we're waiting for

    // Audit trail — why
    audit: [],
    phases_completed: [],
    rules_fired: [],       // Rule keys that influenced decisions
  };

  // Phase 0: Safety override
  const safety = checkSafetyOverride(intake);
  if (safety.override) {
    result.status = 'safety_override';
    result.response_parts.push({ type: 'action', priority: 0, text: safety.message });
    result.audit.push(safety.audit);
    return result;
  }
  result.phases_completed.push('safety_check');

  // Phase 1: Customer identification
  const phase1 = prescribeCustomerIdentification(intake, context);
  result.response_parts.push(...phase1.actions.map(a => ({ type: a.type, priority: 1, text: a.text })));
  result.audit.push(...phase1.audit.map(a => `[Phase 1] ${a}`));
  if (phase1.still_needed?.length) {
    result.still_needed.push(...phase1.still_needed);
  } else {
    result.phases_completed.push('identify_customer');
  }

  // Phase 2: Order & item identification
  if (context.customer) {
    const phase2 = prescribeOrderIdentification(intake, context);
    result.response_parts.push(...phase2.actions.map(a => ({ type: a.type, priority: 2, text: a.text })));
    result.audit.push(...phase2.audit.map(a => `[Phase 2] ${a}`));
    result.still_needed.push(...phase2.still_needed);
    if (phase2.still_needed.length === 0 && intake.items.length > 0) {
      result.phases_completed.push('identify_orders');
    }
  }

  // Phase 3: Action classification (if we have items)
  if (intake.items.length > 0) {
    const phase3 = prescribeActionClassification(intake);
    result.audit.push(...phase3.audit.map(a => `[Phase 3] ${a}`));
    result.phases_completed.push('classify_actions');

    // Phase 4: Sizing resolution
    const phase4 = prescribeSizingResolution(phase3.items, intake, context);
    for (const item of phase4.items) {
      if (item.response_text) {
        result.response_parts.push({
          type: 'item_action',
          priority: 4,
          product: item.product,
          text: item.response_text,
          state: item.state,
          options: item.options || null,
          recommendation: item.recommendation || null,
          skip_donation: item.skip_donation || false,
          _crossover_note: item._crossover_note || null,
        });
      }
      // Add crossover note as separate response part (fires even when item is auto-confirmed)
      if (item._crossover_note) {
        result.response_parts.push({
          type: 'crossover_note',
          priority: 4,
          text: item._crossover_note,
          product: item.product,
        });
      }
    }
    result.audit.push(...phase4.audit.map(a => `[Phase 4] ${a}`));
    result.still_needed.push(...phase4.still_needed);
    if (phase4.still_needed.length === 0) {
      result.phases_completed.push('sizing_resolution');
    }
  }

  // Phase 5: Order creation (if all items confirmed)
  const allConfirmed = intake.items.length > 0 && intake.items.every(i => i.resolved_size || i.issue === 'defect');
  if (allConfirmed) {
    const phase5 = prescribeOrderCreation(intake);
    if (phase5) {
      result.response_parts.push({ type: 'create_order', priority: 5, text: phase5.response_text, items: phase5.items });
      result.audit.push(`[Phase 5] ${phase5.audit}`);
      result.phases_completed.push('create_order');
    }
  }

  // Phase 6: Donation routing (after order created)
  if (allConfirmed) {
    const phase6 = await prescribeDonationRouting(intake, context);
    if (!phase6.skip) {
      result.response_parts.push({ type: 'donation', priority: 6, text: phase6.response_text });
    }
    result.audit.push(`[Phase 6] ${phase6.audit}`);
    result.phases_completed.push('donation_routing');
  }

  // Phase 7: Positive feedback
  const feedback = checkPositiveFeedback(intake._latestMessage);
  if (feedback) {
    result.response_parts.push({ type: 'positive_feedback', priority: 7, text: feedback.response_text });
    result.audit.push(`[Phase 7] ${feedback.audit}`);
  }

  // Determine overall status
  if (result.still_needed.length === 0 && allConfirmed) {
    result.status = 'ready';
  } else if (intake.items.length > 0) {
    result.status = 'needs_info';
  } else {
    result.status = 'gathering';
  }

  // Sort response parts by priority
  result.response_parts.sort((a, b) => a.priority - b.priority);

  return result;
}

module.exports = {
  walkTree,
  checkSafetyOverride,
  prescribeCustomerIdentification,
  prescribeOrderIdentification,
  prescribeActionClassification,
  prescribeSizingResolution,
  prescribeOrderCreation,
  prescribeDonationRouting,
  checkPositiveFeedback,
  // Product nicknames
  getProductNickname,
  PRODUCT_NICKNAMES,
  // Size utilities (shared)
  normalizeSize,
  getSizeList,
  getAdjacentSizes,
  getGradingDelta,
  formatDelta,
  getCumulativeDelta,
};
