/**
 * Sizing Engine — Product classification, sizing helpers, and size calculations.
 *
 * Product utilities: nicknames, categories, size lists, grading deltas, one-piece fit.
 * Loaded from Supabase via initCsConfig() at server startup.
 *
 * NOTE: Also contains legacy walkTree() and prescribe*() functions. These are no longer
 * in the active execution path (aiAdvisor handles all CS logic) but remain for test
 * coverage of utility functions they exercise. Will be removed in a follow-up cleanup.
 */

const { getSupabaseClient } = require('../../shared/supabaseClient');
const { prescribeDonationRouting } = require('./donationRouting');
const {
  NUMERIC_SIZES, NUMERIC_EVEN, NUMERIC_FULL,
  LETTER_SIZES, LETTER_NO_PLUS, LETTER_WITH_PLUS,
  SIZE_ALIASES, NUMERIC_TO_LETTER_UPPER, ODD_HALF_SIZES,
  CHEST_PAD_SIZES, CHEST_PAD_MAP,
  parseSizeVariant, normalizeSize, getSizeModifier,
  extractSizeFromSku, formatMeasurementDisplay,
} = require('./sizeUtils');
const { tightLegsTargets, offeredSizeFor } = require('./styleSwitch');

// ---------------------------------------------------------------------------
// Product maps — populated by initCsConfig() from Supabase at server startup.
// Empty until init is called. Do NOT hardcode products here.
// Use: npm run cs-manage-product  to add/edit products.
// ---------------------------------------------------------------------------

const PRODUCT_NICKNAMES = {};
const PRODUCT_CATEGORIES = {};
const PRODUCT_SIZE_OVERRIDES = {};
const TITLE_TO_HANDLE = {};  // Shopify product title (upper) → handle for exact lookups
let _activeProducts = {};
/** keyword -> how many catalog titles contain it. Lower is more specific. */
const KEYWORD_MATCH_COUNT = {};

/**
 * Load product CS config from Supabase product_cs_config table.
 * Must be called once at server startup before any exchange operations.
 * Populates PRODUCT_NICKNAMES, PRODUCT_CATEGORIES, PRODUCT_SIZE_OVERRIDES.
 */
async function initCsConfig() {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc('get_cs_product_config');
  if (error) throw new Error(`[DecisionTree] Failed to load CS config: ${error.message}`);
  if (!data || data.length === 0) {
    console.error('[DecisionTree] WARNING: No products in product_cs_config. Run: npm run cs-seed-cs-config');
    return;
  }

  // Clear and repopulate (mutate in place to preserve exported references)
  for (const k of Object.keys(PRODUCT_NICKNAMES)) delete PRODUCT_NICKNAMES[k];
  for (const k of Object.keys(PRODUCT_CATEGORIES)) delete PRODUCT_CATEGORIES[k];
  for (const k of Object.keys(PRODUCT_SIZE_OVERRIDES)) delete PRODUCT_SIZE_OVERRIDES[k];
  for (const k of Object.keys(TITLE_TO_HANDLE)) delete TITLE_TO_HANDLE[k];
  for (const k of Object.keys(KEYWORD_MATCH_COUNT)) delete KEYWORD_MATCH_COUNT[k];
  for (const k of Object.keys(_activeProducts)) delete _activeProducts[k];

  // Build title → handle map from products table for exact product resolution
  const { data: products } = await supabase.from('products').select('title, handle');
  if (products) {
    for (const p of products) {
      if (p.title && p.handle) TITLE_TO_HANDLE[p.title.toUpperCase()] = p.handle;
    }
  }

  for (const row of data) {
    _activeProducts[row.product_handle] = {
      nickname: row.nickname,
      category: row.category,
      keywords: row.keywords,
      deltaWording: row.delta_wording,
      sizes: row.sizes_override,
      styleSwitch: row.style_switch,
    };

    // Populate nickname lookup (keyword-based for fuzzy matching)
    for (const kw of row.keywords) {
      // Register multiple prefix patterns so includes-matching works with Shopify titles
      PRODUCT_NICKNAMES[`THE ${kw.toUpperCase()}`] = row.nickname;
      PRODUCT_NICKNAMES[`RUBIES ${kw.toUpperCase()}`] = row.nickname;
      PRODUCT_NICKNAMES[kw.toUpperCase()] = row.nickname;
      PRODUCT_CATEGORIES[kw] = row.category;
    }

    // Per-product size overrides (only when non-standard)
    if (row.sizes_override?.length) {
      for (const kw of row.keywords) {
        PRODUCT_SIZE_OVERRIDES[kw] = row.sizes_override;
      }
    }
  }

  // How many catalog titles each keyword appears in. A keyword that matches
  // several products is generic and must never beat a keyword that identifies
  // exactly one: "no-tuck" is in the AJ, Ruby, Sassy, Cheeky and Naomi titles,
  // while "ruby" is in one. Sorting by keyword LENGTH got this backwards, since
  // "no-tuck" (7) outranks "ruby" (4), which is how a Ruby bikini complaint
  // could be classified as underwear.
  // Counted over titles AND handles: the product table is not always loaded
  // (tests, cold start), and a handle carries the same words as its title, so
  // using both keeps specificity working everywhere rather than silently
  // degrading to the length rule that caused the bug.
  const corpus = [...Object.keys(TITLE_TO_HANDLE), ...Object.keys(_activeProducts)]
    .map(x => x.toUpperCase());
  for (const kw of Object.keys(PRODUCT_CATEGORIES)) {
    const needle = kw.toUpperCase();
    KEYWORD_MATCH_COUNT[kw] = corpus.filter(t => t.includes(needle)).length || 1;
  }

  console.error(`[DecisionTree] Loaded ${data.length} products from product_cs_config`);
}

/**
 * Get short nickname for a product. Falls back to the full title if no nickname.
 * Uses handle-based lookup (exact) first, then keyword matching (fuzzy) for free text.
 */
function getProductNickname(fullTitle) {
  if (!fullTitle) return 'item';
  const upper = fullTitle.toUpperCase();

  // Try exact title → handle → nickname (most reliable, avoids keyword collisions)
  const handle = TITLE_TO_HANDLE[upper];
  if (handle && _activeProducts[handle]) return _activeProducts[handle].nickname;

  // Try exact keyword match
  if (PRODUCT_NICKNAMES[upper]) return PRODUCT_NICKNAMES[upper];

  // Try: does any nickname key contain the title or vice versa. Ranked by the
  // same specificity rule as classifyProduct, so a generic keyword never wins
  // over one that names a single product.
  // Keys are registered as "KW", "THE KW" and "RUBIES KW"; strip the prefix
  // before the specificity lookup, which is keyed on the bare keyword.
  const bareCount = (key) => KEYWORD_MATCH_COUNT[key.replace(/^(THE|RUBIES)\s+/, '').toLowerCase()] || 1;
  const fuzzy = Object.entries(PRODUCT_NICKNAMES)
    .filter(([key]) => upper.includes(key) || key.includes(upper))
    .sort((a, b) => bareCount(a[0]) - bareCount(b[0]) || b[0].length - a[0].length);
  if (fuzzy.length) return fuzzy[0][1];

  // Fallback: extract person name from old "THE [NAME] ..." title format (pre-2026 style).
  // Titles no longer start with "THE" but this handles stale references in order history.
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

/**
 * Get product page URL from a nickname. Returns null if not found.
 */
function getProductUrl(nickname) {
  if (!nickname) return null;
  const lower = nickname.toLowerCase();
  for (const [handle, prod] of Object.entries(_activeProducts)) {
    if (prod.nickname.toLowerCase() === lower) {
      return `https://rubyshines.com/products/${handle}`;
    }
  }
  return null;
}


/**
 * Build a human-friendly product list text from the loaded config.
 */
function buildProductListText() {
  const byCategory = {};
  for (const prod of Object.values(_activeProducts)) {
    if (prod.category === 'accessory' || prod.category === 'chest_pads') continue;
    if (!byCategory[prod.category]) byCategory[prod.category] = [];
    byCategory[prod.category].push(prod.nickname);
  }
  const parts = [];
  if (byCategory.underwear_bottom?.length) parts.push(`underwear (${byCategory.underwear_bottom.join(', ')})`);
  if (byCategory.swim_bottom?.length) parts.push(`bikini bottoms (${byCategory.swim_bottom.join(', ')})`);
  if (byCategory.underwear_top?.length) parts.push(`bras (${byCategory.underwear_top.join(', ')})`);
  if (byCategory.swim_top?.length) parts.push(`swim tops (${byCategory.swim_top.join(', ')})`);
  if (byCategory.onepiece?.length) parts.push(`the ${byCategory.onepiece.join(', ')} one-piece`);
  return parts.length
    ? `Which product are you looking at? We have ${parts.join(', ')}.`
    : 'Which product are you looking at? We have underwear (AJ, Charlie, Sassy), bikini bottoms (Ruby, Stella), bras (Brooke), swim shorts (Serena), and the Sky one-piece.';
}

/**
 * Pluralize a product nickname when quantity > 1.
 * "AJ" → "AJs", "Sassy" → "Sassys", "Chest Pads" stays "Chest Pads"
 */
function pluralizeNickname(nickname, quantity) {
  if (!nickname || quantity <= 1) return nickname;
  // Already plural
  if (nickname.endsWith('s') || nickname.endsWith('Pads')) return nickname;
  return nickname + 's';
}

// ---------------------------------------------------------------------------
// Size constants — imported from sizeUtils.js (single source of truth)
// ---------------------------------------------------------------------------
const KID_LABELS = new Set(['daughter', 'girl', 'son', 'boy', 'kid', 'kiddo', 'child', 'kids']);

// Chest pad, half-size constants — imported from sizeUtils.js

// ── Product category classification ────────────────────────────────────────
// PRODUCT_CATEGORIES is populated by initCsConfig() from Supabase.
// Categories determine which size system a product uses:
//   swim_bottom: kids = even+odd (4-16), adult = letter with plus (XXS+ XS+)
//   swim_top:    kids = even only (4-16), adult = letter no plus
//   underwear_bottom: kids = even only (4-16), adult = letter no plus
//   underwear_top:    kids = even only (6-16), adult = letter no plus
//   onepiece:    kids = even+odd (4-16), adult = letter with plus
//   chest_pads:  S, M, L only
//   accessory:   no sizing rules

function classifyProduct(productName) {
  if (!productName) return null;

  // Try exact title → handle → category (most reliable)
  const handle = TITLE_TO_HANDLE[productName.toUpperCase()];
  if (handle && _activeProducts[handle]) return _activeProducts[handle].category;

  // Fall back to keyword matching for free text (nicknames, customer messages)
  const lower = productName.toLowerCase();
  // Most specific keyword wins: fewest catalog titles matched, then longest.
  // Length alone is the wrong signal -- see KEYWORD_MATCH_COUNT above.
  const entries = Object.entries(PRODUCT_CATEGORIES)
    .filter(([keyword]) => lower.includes(keyword))
    .sort((a, b) => (KEYWORD_MATCH_COUNT[a[0]] || 1) - (KEYWORD_MATCH_COUNT[b[0]] || 1)
      || b[0].length - a[0].length);
  return entries.length ? entries[0][1] : null;
}

// Which categories use even+odd (full range) numeric sizes?
const FULL_NUMERIC_CATEGORIES = new Set(['swim_bottom', 'onepiece']);
// Which categories use letter sizes with plus (XXS+, XS+)?
const PLUS_LETTER_CATEGORIES = new Set(['swim_bottom', 'onepiece']);

// parseSizeVariant, normalizeSize, getSizeModifier — imported from sizeUtils.js

/**
 * Determine the size chart category for measurement lookups.
 * @param {string} productName - Product name or nickname
 * @param {boolean} isKids - Whether to use kids or adult chart
 * @returns {{ chartCategory: string, measureType: string }}
 */
// formatMeasurementDisplay — imported from sizeUtils.js

/**
 * Get the measurement location description for a body part.
 */
/**
 * Get the "suggest separates" text for one-piece mismatch.
 * @param {string} reason - 'mismatch' (waist + height too far apart) or 'height_outside' (height outside chart)
 * @param {string} measureRef - "your" or "your daughter's"
 */
/**
 * Get the "suggest separates" text for one-piece mismatch.
 * @param {string} reason - 'mismatch' (waist + height too far apart) or 'height_outside' (height outside chart)
 * @param {string} measureRef - "your" or "your daughter's"
 * @param {boolean} isExchange - true if customer already owns the one-piece (ask if they'd consider switching)
 */
function getSeparatesText(reason, measureRef, isExchange = false) {
  const prefix = reason === 'mismatch'
    ? `Based on ${measureRef} waist and height, unfortunately the one-piece won't be the right fit.`
    : `Based on ${measureRef} height, unfortunately the one-piece won't be the right fit.`;
  const suggestion = 'In many cases you could consider pairing the tankini with our regular or high waisted bikini bottom. This two-piece can offer almost as much coverage as a one-piece but with a more flexible fit.';
  if (isExchange) {
    return `${prefix} ${suggestion} Would you like to explore that option instead?`;
  }
  return `${prefix} ${suggestion}`;
}

function getMeasureLocation(measureType, product) {
  if (measureType === 'waist') return 'around the belly, just under the belly button';
  // Use product category to determine "bra band" vs "bikini band"
  const cat = product ? classifyProduct(product) : null;
  if (cat === 'swim_top') return 'around the chest where a bikini band would sit';
  return 'around the chest where a bra band would sit';
}

function getChartCategory(productName, isKids) {
  const cat = classifyProduct(productName);
  const isTop = cat === 'underwear_top' || cat === 'swim_top';
  const isOnepiece = cat === 'onepiece';
  const isSwim = cat === 'swim_bottom' || cat === 'swim_top';
  let chartCategory;
  if (isOnepiece) chartCategory = isKids ? 'kids_onepiece' : 'adult_onepiece';
  else if (isTop) chartCategory = isKids ? 'kids_tops' : 'adult_tops';
  else if (isSwim) chartCategory = isKids ? 'kids_swimwear_bottoms' : 'adult_swimwear_bottoms';
  else chartCategory = isKids ? 'kids_underwear_bottoms' : 'adult_underwear_bottoms';
  const measureType = isTop ? 'chest' : 'waist';
  return { chartCategory, measureType };
}

/**
 * Look up the height variant (Regular/Tall) for a one-piece at a given waist size.
 * Checks the recommended size first, then adjacent sizes (±1).
 * @param {string} chartCategory - e.g. 'adult_onepiece'
 * @param {string} waistSize - recommended waist size label
 * @param {number} heightInInches - customer height in inches
 * @param {string} productName - for getSizeList adjacency
 * @returns {Promise<{variant: string|null, size: string}>}
 */
async function lookupHeightVariant(chartCategory, waistSize, heightInInches, productName) {
  const supabase = getSupabaseClient();
  // Check at the recommended waist size
  const { data: heightEntries } = await supabase
    .from('size_charts')
    .select('size_label, notes, min_inches, max_inches')
    .eq('chart_category', chartCategory)
    .eq('measurement_type', 'height')
    .eq('size_label', waistSize);

  const tallEntry = heightEntries?.find(e => e.notes === 'Tall');
  const regEntry = heightEntries?.find(e => e.notes === 'Regular');
  if (tallEntry && heightInInches >= tallEntry.min_inches && heightInInches <= tallEntry.max_inches) {
    return { variant: 'Tall', size: waistSize };
  }
  if (regEntry && heightInInches >= regEntry.min_inches && heightInInches <= regEntry.max_inches) {
    return { variant: 'Regular', size: waistSize };
  }

  // Check adjacent sizes (±1)
  const waistList = getSizeList(waistSize, productName);
  const waistIdx = waistList?.indexOf(waistSize) ?? -1;
  const adjacentSizes = [];
  if (waistIdx > 0) adjacentSizes.push(waistList[waistIdx - 1]);
  if (waistIdx < (waistList?.length || 0) - 1) adjacentSizes.push(waistList[waistIdx + 1]);

  for (const adjSize of adjacentSizes) {
    const { data: adjEntries } = await supabase
      .from('size_charts')
      .select('size_label, notes, min_inches, max_inches')
      .eq('chart_category', chartCategory)
      .eq('measurement_type', 'height')
      .eq('size_label', adjSize);
    const adjTall = adjEntries?.find(e => e.notes === 'Tall');
    const adjReg = adjEntries?.find(e => e.notes === 'Regular');
    if (adjTall && heightInInches >= adjTall.min_inches && heightInInches <= adjTall.max_inches) {
      return { variant: 'Tall', size: adjSize };
    }
    if (adjReg && heightInInches >= adjReg.min_inches && heightInInches <= adjReg.max_inches) {
      return { variant: 'Regular', size: adjSize };
    }
  }

  return { variant: null, size: waistSize };
}

/**
 * Analyze one-piece fit given waist size + height. Returns recommendation:
 * - { type: 'exact', size, variant } — waist and height agree
 * - { type: 'wiggle', size, variant, waistSize, delta } — height needs ±1 size, waist has wiggle room
 * - { type: 'separates', waistSize, heightSize, variant, sizeDiff } — too far apart, suggest bikini set
 * - { type: 'height_outside_range' } — height doesn't match any chart entry
 * @param {string} chartCategory - e.g. 'adult_onepiece'
 * @param {string} waistSize - recommended size from waist measurement
 * @param {number} heightInInches - customer height
 * @param {string} productName - for adjacency lookups
 * @param {boolean} useInches - for delta display
 */
async function analyzeOnepieceFit(chartCategory, waistSize, heightInInches, productName, useInches) {
  const { variant, size: heightMatchSize } = await lookupHeightVariant(chartCategory, waistSize, heightInInches, productName);

  if (variant && heightMatchSize === waistSize) {
    return { type: 'exact', size: waistSize, variant };
  }
  if (variant) {
    const waistList = getSizeList(waistSize, productName);
    const waistIdx = waistList?.indexOf(waistSize) ?? -1;
    const heightIdx = waistList?.indexOf(heightMatchSize) ?? -1;
    const sizeDiff = Math.abs(waistIdx - heightIdx);
    if (sizeDiff <= 1) {
      const delta = getCumulativeDelta(waistSize, heightMatchSize);
      const unit = useInches ? `${delta?.inches || 2}"` : `${delta?.cm || 5} cm`;
      const moreOrLess = heightIdx > waistIdx ? 'more' : 'less';
      return { type: 'wiggle', size: heightMatchSize, variant, waistSize, delta, unit, moreOrLess };
    }
    return { type: 'separates', waistSize, heightSize: heightMatchSize, variant, sizeDiff };
  }
  return { type: 'height_outside_range' };
}

function getSizeList(size, productName) {
  const s = normalizeSize(size);

  // Check per-product size overrides first (e.g. Naomi: XS–2X only)
  if (productName) {
    const lower = productName.toLowerCase();
    for (const [keyword, sizes] of Object.entries(PRODUCT_SIZE_OVERRIDES)) {
      if (lower.includes(keyword)) return sizes.includes(s) ? sizes : null;
    }
  }

  const category = productName ? classifyProduct(productName) : null;

  // Chest pads only have S, M, L
  if (category === 'chest_pads') return CHEST_PAD_SIZES;

  if (LETTER_SIZES.includes(s)) {
    if (category) {
      return PLUS_LETTER_CATEGORIES.has(category) ? LETTER_WITH_PLUS : LETTER_NO_PLUS;
    }
    return LETTER_SIZES; // fallback: full list
  }
  if (NUMERIC_SIZES.includes(s)) {
    if (category) {
      return FULL_NUMERIC_CATEGORIES.has(category) ? NUMERIC_FULL : NUMERIC_EVEN;
    }
    return NUMERIC_SIZES; // fallback: full list
  }
  return null;
}

function getAdjacentSizes(currentSize, direction, count = 2, productName) {
  const s = normalizeSize(currentSize);
  const list = getSizeList(s, productName);
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

/**
 * Find sizes between fromSize and toSize (exclusive of both endpoints).
 * Returns [] if there are no intermediates (e.g. even-only products going 10→12).
 */
function getIntermediateSizes(fromSize, toSize, productName) {
  const from = normalizeSize(fromSize);
  const to = normalizeSize(toSize);
  const list = getSizeList(from, productName);
  if (!list || !list.includes(to)) return [];

  const fromIdx = list.indexOf(from);
  const toIdx = list.indexOf(to);
  if (Math.abs(fromIdx - toIdx) <= 1) return []; // adjacent, no intermediates

  const step = toIdx > fromIdx ? 1 : -1;
  const result = [];
  for (let i = fromIdx + step; i !== toIdx; i += step) {
    result.push(list[i]);
  }
  return result;
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
// Geographic helpers — geocoding + distance
// ---------------------------------------------------------------------------

// geocodeAddress, haversineDistance, prescribeDonationRouting — moved to donationRouting.js

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
    if (KID_LABELS.has(intake.third_party_label)) {
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
    const days = Math.floor(((context.referenceDate || new Date()).getTime() - new Date(context.targetOrder.createdAt).getTime()) / 86400000);
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
      const intakePC = classifyProduct(intakeItem.product);
      const intakeBodyGroup = (intakePC === 'accessory' || intakePC === 'chest_pads') ? 'accessory'
        : intakePC === 'onepiece' ? 'onepiece'
        : intakePC === 'swim_bottom' ? 'swim_bottoms'
        : intakePC === 'swim_top' ? 'swim_tops'
        : intakePC === 'underwear_top' ? 'underwear_tops'
        : 'underwear_bottoms';

      for (const oi of orderItems) {
        const oiPC = classifyProduct(oi.title);
        const oiBodyGroup = (oiPC === 'accessory' || oiPC === 'chest_pads') ? 'accessory'
          : oiPC === 'onepiece' ? 'onepiece'
          : oiPC === 'swim_bottom' ? 'swim_bottoms'
          : oiPC === 'swim_top' ? 'swim_tops'
          : oiPC === 'underwear_top' ? 'underwear_tops'
          : 'underwear_bottoms';
        if (intakeBodyGroup !== oiBodyGroup) continue; // Different body group
        if (intakeBodyGroup === 'accessory') continue; // Never flag accessories for multi-item exchange

        const oiSizeMatch = oi.variantTitle?.match(/\b(\d{1,2}|XXS\+?|XS\+?|S|M|L|[1-4]X)\b/i);
        const oiSize = oiSizeMatch ? normalizeSize(oiSizeMatch[1]) : null;
        if (oiSize !== normalizedSize) continue; // Different size

        // Is this the SAME product (including different colors)?
        // Check nickname match first (most reliable), then fall back to word-level matching
        const intakeNick = getProductNickname(intakeItem.product)?.toLowerCase();
        const oiNickSame = getProductNickname(oi.title)?.toLowerCase();
        const intakeWords = (intakeItem.product || '').toLowerCase().split(/\s+/).filter(w => w.length > 1 && w !== 'the');
        const oiTitleLower = (oi.title || '').toLowerCase();
        const isSameProduct = (intakeNick && oiNickSame && intakeNick === oiNickSame)
          || (intakeWords.length > 0 && intakeWords.every(w => oiTitleLower.includes(w)));

        if (isSameProduct) {
          // Same product, same size — assume customer means all of them
          // (could be multiple colors). No need to ask.
          // Just note it in audit for awareness.
          if (oi.quantity > 1) {
            prescription.audit.push(`Same product: ${oi.title} qty ${oi.quantity} — assuming all included`);
          }
        } else {
          // DIFFERENT product, same size, same category → ask
          // Check if this order item is already being exchanged (in intake items)
          const oiNick = getProductNickname(oi.title)?.toLowerCase();
          const alreadyTracked = intake.items.some(i => {
            if (!i.product) return false;
            const iProd = i.product.toLowerCase();
            const iNick = getProductNickname(i.product)?.toLowerCase();
            return (oi.title && oi.title.toLowerCase().includes(iProd))
              || iProd.includes(oiNick || '')
              || iNick === oiNick;
          });
          // Don't flag if customer explicitly compared products (they're already aware)
          if (!alreadyTracked && !intake._crossProductComparison) {
            prescription.actions.push({
              type: 'multi_item_flag',
              text: `Order also has ${getProductNickname(oi.title)} in size ${oiSize} — ask: "Would you like to exchange that one too?"`,
            });
            prescription.audit.push(`Multi-item flag: ${oi.title} size ${oiSize} (different product, same size + category)`);
            // Don't break — flag all untracked items in the same body group
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
      const skuSize = extractSizeFromSku(li.sku).normalized;
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
        // Tag intake items from this product so Phase 3 knows it was a try-both-sizes purchase
        for (const item of intake.items) {
          if (item.product && product.toLowerCase().includes((getProductNickname(item.product) || '').toLowerCase())) {
            item._multiSizePurchase = true;
            item._multiSizeSizes = uniqueSizes;
          }
        }
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

    // True accessories (gift cards, pins, etc.) can't be sized — any return/issue = refund
    const itemCat = classifyProduct(item.product);
    if (itemCat === 'accessory') {
      classified.action = 'refund';
      classified.audit = 'Accessory product — not sizeable, treating as refund';
      prescription.items.push(classified);
      prescription.audit.push(`${item.product || '?'}: ${classified.action} (${classified.audit})`);
      continue;
    }

    if (item.issue === 'defect' || item.issue === 'DEFECT') {
      classified.action = 'defect';
      classified.audit = 'Defect reported';
    } else if (item.issue === 'wrong_item' || item.issue === 'missing') {
      classified.action = 'wrong_item';
      classified.audit = `${item.issue === 'wrong_item' ? 'Wrong item shipped' : 'Missing item'}`;
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
    } else if (item.issue === 'product_not_working_tight') {
      classified.action = 'sizing_exchange';
      classified.direction = 'up';
      classified.self_diagnosed = true;
      classified.audit = 'Product not working + customer identified tight — self-diagnosed sizing, size up';
    } else if (item.issue === 'product_not_working_loose') {
      classified.action = 'sizing_exchange';
      classified.direction = 'down';
      classified.self_diagnosed = true;
      classified.audit = 'Product not working + customer identified loose — self-diagnosed sizing, size down';
    } else if (item.issue === 'way_off') {
      classified.action = 'sizing_exchange_measurement';
      classified.audit = 'Way off — need measurement';
    } else if (item.issue === 'expectation_mismatch') {
      // Shaping explanation only applies to bottoms — tops just ask about fit
      const emCategory = classifyProduct(item.product);
      const emIsBottom = !emCategory || emCategory === 'swim_bottom' || emCategory === 'underwear_bottom' || emCategory === 'onepiece';
      if (emIsBottom) {
        classified.action = 'expectation_mismatch';
        classified.audit = 'Expectation mismatch (bottoms) — shaping vs tucking explanation needed';
      } else {
        classified.action = 'fit_direction_unclear';
        classified.audit = 'Product not working (top) — ask about fit, no shaping explanation';
      }
    } else if (item.issue === 'product_not_working') {
      classified.action = 'probe_needed';
      classified.audit = 'Product not working — need to probe';
    } else if (item.issue === 'doesnt_fit' || item.issue === 'fit_issue') {
      // Customer said "doesn't fit" without specifying tight or loose
      classified.action = 'fit_direction_unclear';
      classified.audit = 'Fit issue without direction — ask tight vs loose';
    } else if (item.issue === 'tight_legs') {
      classified.action = 'style_switch';
      classified.audit = 'Tight legs — recommend alternative style';
    } else if (item.issue === 'too_short' || item.issue === 'too_long') {
      // One-piece height variant issue — Regular ↔ Tall
      classified.action = 'height_variant_check';
      classified.heightDirection = item.issue === 'too_short' ? 'tall' : 'regular';
      classified.audit = `One-piece ${item.issue === 'too_short' ? 'too short → check if Tall needed' : 'too long → check if Regular needed'}`;
    } else if (item.issue === 'onepiece_fit') {
      classified.action = 'onepiece_check';
      classified.audit = 'One-piece fit — need waist + height';
    } else if (item.issue === 'refund_request' || intake.message_type === 'refund') {
      // Check if this is a "tried two sizes, returning the one that didn't fit"
      const intakeItem = intake.items.find(i => i.product === item.product);
      if (intakeItem?._multiSizePurchase) {
        classified.action = 'try_size_return';
        classified.audit = 'Ordered multiple sizes to try, returning unwanted — offer catalog exchange';
      } else {
        classified.action = 'refund';
        classified.audit = 'Refund/return requested';
      }
    } else if (item.issue === 'unclear' || item.issue === 'none') {
      // Check if the overall message_type gives us a clue
      if (intake.message_type === 'refund') {
        classified.action = 'refund';
        classified.audit = 'Refund/return requested (from message type)';
      } else if (intake.message_type === 'defect') {
        classified.action = 'defect';
        classified.audit = 'Defect (from message type)';
      } else if (intake.message_type === 'wrong_item_shipped' || intake.message_type === 'missing_item') {
        classified.action = 'wrong_item';
        classified.audit = `${intake.message_type === 'wrong_item_shipped' ? 'Wrong item shipped' : 'Missing item'} (from message type)`;
      } else if (intake.message_type === 'product_not_working') {
        classified.action = 'probe_needed';
        classified.audit = 'Product not working (from message type)';
      } else {
        // Customer said it doesn't fit but didn't say how — ask product-specific fit question
        classified.action = 'fit_direction_unclear';
        classified.audit = 'Fit issue but direction unclear — ask tight vs loose';
      }
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

/**
 * Stock + restock for every style we might suggest for tight legs, keyed by
 * nickname. Built here because prescribeSizingResolution must stay synchronous.
 *
 * Fail-soft on purpose: if this throws we return null, tightLegsTargets skips
 * the availability filter, and the reply degrades to the previous behaviour
 * rather than the customer getting no answer at all.
 */
async function resolveStyleSwitchAvailability(items) {
  try {
    const sized = (items || []).filter(i => i.size);
    if (!sized.length) return null;

    const { searchProducts, loadFromSupabase, getProducts } = require('./productCache');
    if (!getProducts()?.length) await loadFromSupabase();
    const { restockEtaForSkus } = require('./restockEta');

    const handleToTitle = {};
    for (const [t, h] of Object.entries(TITLE_TO_HANDLE)) handleToTitle[h] = t;

    const out = {};
    for (const [handle, cfg] of Object.entries(_activeProducts)) {
      if (!cfg.styleSwitch?.recommendFor?.tightLegs) continue;
      for (const item of sized) {
        const wanted = offeredSizeFor(cfg.styleSwitch.recommendFor, item.size);
        if (!wanted) continue;
        // searchProducts is fuzzy and returns other products: a search for
        // "Naomi M" surfaces the Ava in M too. Without the title check its 168
        // units counted as Naomi stock and the out-of-stock style stayed
        // offerable, which is the whole bug this filter exists to prevent.
        const title = handleToTitle[handle];
        if (!title) continue;
        const variants = searchProducts(`${title} ${wanted}`).filter((v) => {
          if (v.productTitle !== title) return false;
          const vSize = normalizeSize(v.variantTitle?.split('/').pop()?.trim());
          return vSize === wanted;
        });
        const qty = variants.reduce((sum, v) => sum + (v.inventoryQuantity || 0), 0);
        if (qty > 0) { out[cfg.nickname] = { inStock: true, restock: null }; continue; }
        const skus = variants.map(v => v.sku).filter(Boolean);
        out[cfg.nickname] = { inStock: false, restock: skus.length ? await restockEtaForSkus(skus) : null };
      }
    }
    return Object.keys(out).length ? out : null;
  } catch (e) {
    console.warn(`[sizingEngine] style-switch availability lookup failed: ${e.message}`);
    return null;
  }
}

async function prescribeSizingResolution(classifiedItems, intake, context, { availability } = {}) {
  const prescription = {
    phase: 'sizing_resolution',
    items: [],
    still_needed: [],
    audit: [],
  };

  const isThirdParty = intake.buying_for === 'third_party';
  const useInches = context.isNorthAmerica;

  // Detect repeat exchanges — customer already received an exchange for this product before
  const previousExchangeProducts = new Set();
  for (const ex of (context.exchanges || [])) {
    for (const li of (ex.lineItems || ex.items || [])) {
      const title = (li.title || li).toLowerCase();
      previousExchangeProducts.add(title);
    }
  }

  // Consolidate multi-size purchases: when the same product appears in multiple sizes
  // and the customer says "too tight," only process the largest size (recommend up from there).
  // If "too loose," only process the smallest size (recommend down from there).
  const skipItems = new Set();
  const productSizeGroups = {};
  for (let idx = 0; idx < classifiedItems.length; idx++) {
    const ci = classifiedItems[idx];
    const nick = getProductNickname(ci.product)?.toLowerCase() || ci.product?.toLowerCase();
    if (!productSizeGroups[nick]) productSizeGroups[nick] = [];
    productSizeGroups[nick].push({ idx, size: ci.size, issue: ci.issue });
  }
  for (const [nick, group] of Object.entries(productSizeGroups)) {
    if (group.length <= 1) continue;
    // Multiple sizes of same product — keep only the most relevant one
    const latestMsg = (intake._latestMessage || '').toLowerCase();
    const isTight = group.some(g => /tight|small/.test(g.issue || '')) || /too tight|too small|larger size|size up|bigger/i.test(latestMsg);
    const isLoose = !isTight && (group.some(g => /loose|big/.test(g.issue || '')) || /too loose|too big|smaller size|size down/i.test(latestMsg));
    const sizeList = getSizeList(group[0].size, classifiedItems[group[0].idx].product);
    if (sizeList) {
      const sorted = group.sort((a, b) => {
        const idxA = sizeList.indexOf(normalizeSize(a.size));
        const idxB = sizeList.indexOf(normalizeSize(b.size));
        return idxA - idxB;
      });
      // Keep the largest if tight (recommend up), smallest if loose (recommend down)
      const keepIdx = isTight ? sorted[sorted.length - 1].idx : sorted[0].idx;
      for (const g of group) {
        if (g.idx !== keepIdx) skipItems.add(g.idx);
      }
      prescription.audit.push(`Multi-size ${nick}: keeping ${classifiedItems[keepIdx].size} (${isTight ? 'largest' : 'smallest'}), skipping others`);
    }
  }

  for (const item of classifiedItems) {
    // Skip consolidated multi-size items
    if (skipItems.has(classifiedItems.indexOf(item))) {
      continue;
    }

    const rx = {
      product: item.product,
      size: item.size,
      state: null,
      response_text: null,
      options: null,
      audit: null,
      self_diagnosed: item.self_diagnosed || false,
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
        const itemCategory = classifyProduct(item.product);
        let productType = 'bottom';
        if (itemCategory === 'underwear_top') {
          // Brooke = bra, Ava = bra
          productType = 'bra';
        } else if (itemCategory === 'swim_top') {
          // Mia = bikini_top, Queeny/Sunny = top (tankini)
          const prodLowerDelta = (item.product || '').toLowerCase();
          productType = prodLowerDelta.includes('mia') || prodLowerDelta.includes('halter') ? 'bikini_top' : 'top';
        }

        // Check if customer already requested a specific size
        const intakeItem = intake.items.find(i => i.product === item.product);
        const desiredSize = intakeItem?.resolved_size || intakeItem?.desired_size;
        if (desiredSize) {
          // If customer provided a measurement, cross-reference with the size chart
          let measurementNote = null;
          if (intake.measurement && intake.measurement.value) {
            const mVal = intake.measurement.value;
            const mUnit = intake.measurement.unit === 'cm' ? 'cm' : 'inches';
            const isKidsM = NUMERIC_SIZES.includes(currentSize);
            const { chartCategory: chartCat, measureType } = getChartCategory(item.product, isKidsM);

            try {
              const supabase = getSupabaseClient();
              const { data: sizeMatches } = await supabase.rpc('find_size_by_measurement', {
                p_chart_category: chartCat,
                p_measurement_type: measureType,
                p_value: mVal,
                p_unit: mUnit,
              });
              const chartSize = sizeMatches?.[0]?.size_label || null;
              const mDisplay = formatMeasurementDisplay(mVal, mUnit);

              if (chartSize === currentSize) {
                // Chart says current size should fit — but customer says it doesn't
                measurementNote = `The chart works for most but there can sometimes be exceptions. Based on your measurement of ${mDisplay} the sizing chart puts you in the ${currentSize} range.`;
              } else if (chartSize === normalizeSize(desiredSize)) {
                // Chart agrees with their requested size
                measurementNote = `Based on your measurement of ${mDisplay} the ${normalizeSize(desiredSize)} looks like a good fit.`;
              } else if (chartSize) {
                // Chart suggests a different size
                measurementNote = `Based on your measurement of ${mDisplay} the chart suggests a size ${chartSize}.`;
              }
            } catch (e) { /* chart lookup failed — continue without note */ }
          }

          // Customer asked for a specific size — check if delta is ≤2" (confident) or >2" (confirm)
          const delta = getCumulativeDelta(currentSize, normalizeSize(desiredSize));
          if (delta && delta.inches <= 2) {
            // Check if this product has half-steps (swim_bottom, onepiece).
            // These products have more size options (odd sizes, plus sizes) so we always
            // present options and confirm — even for adjacent sizes — because the customer
            // may not know about nearby alternatives.
            const hasHalfSteps = FULL_NUMERIC_CATEGORIES.has(itemCategory) || PLUS_LETTER_CATEGORIES.has(itemCategory);

            if (hasHalfSteps) {
              // Half-step product — present the requested size + one more in the same direction
              const intermediates = getIntermediateSizes(currentSize, normalizeSize(desiredSize), item.product);
              const beyondDesired = getAdjacentSizes(normalizeSize(desiredSize), direction, 1, item.product);
              const allOptions = [...intermediates, normalizeSize(desiredSize), ...beyondDesired];
              // Deduplicate and cap at 2 options max
              const seen = new Set();
              const uniqueOptions = allOptions.filter(s => { if (seen.has(s)) return false; seen.add(s); return true; }).slice(0, 2);

              // Preserve variant modifier (Tall/Regular) for one-pieces
              const variantMod = getSizeModifier(desiredSize) || getSizeModifier(item.size) || intakeItem?._variant_modifier || null;
              const modSuffix = variantMod ? ` ${variantMod}` : '';
              const currentDisplay = `${currentSize}${modSuffix}`;

              const optionDetails = uniqueOptions.map(s => {
                const d = getCumulativeDelta(currentSize, s) || { inches: 1, cm: 2.5 };
                const unit = useInches ? `${d.inches}"` : `${d.cm} cm`;
                const more = direction === 'up' ? 'more' : 'less';
                const sizeDisplay = `${s}${modSuffix}`;
                let description;
                switch (productType) {
                  case 'bra': description = `which has the bra band ${unit} ${direction === 'up' ? 'longer' : 'shorter'} than the ${currentDisplay}`; break;
                  case 'bikini_top': description = `which has the bikini top band ${unit} ${direction === 'up' ? 'longer' : 'shorter'} than the ${currentDisplay}`; break;
                  case 'top': description = `which has ${unit} ${more} fabric around the torso compared to the ${currentDisplay}`; break;
                  default: description = `which has ${unit} ${more} fabric around the waist compared to the ${currentDisplay}`; break;
                }
                return { size: s, delta: d, formatted: `${sizeDisplay} ${description}` };
              });

              rx.state = 'AWAITING_SIZE_CONFIRMATION';
              rx.options = optionDetails;

              // For swim/onepiece, suggest measurement when there's any sizing uncertainty
              // "too big/small", "close fit", or "way off" — fit is critical for swimwear
              const issueText = (intakeItem?.issue || '').toLowerCase();
              const isUncertain = /too_loose|too_tight|close_fit_loose|close_fit_tight|way_off/.test(issueText);
              const measureType = (productType === 'bra' || productType === 'bikini_top' || productType === 'top') ? 'chest' : 'waist';
              const measureLocation = getMeasureLocation(measureType, item.product);
              const isOnepiece = itemCategory === 'onepiece';
              const heightAsk = isOnepiece ? ' and your height' : '';
              const heightReason = isOnepiece ? ' and whether Regular or Tall would work best' : '';
              const thirdPartyMeasure = isThirdParty ? `your ${intake.third_party_label || "child"}'s ` : 'the ';
              // Check if order has both tops and bottoms — ask for both measurements
              const allCats = new Set(classifiedItems.map(ci => classifyProduct(ci.product)).filter(Boolean));
              const hasBoth = (allCats.has('swim_bottom') || allCats.has('underwear_bottom') || allCats.has('onepiece')) &&
                (allCats.has('swim_top') || allCats.has('underwear_top'));
              const topProd = hasBoth ? classifiedItems.find(ci => { const c = classifyProduct(ci.product); return c === 'swim_top' || c === 'underwear_top'; }) : null;
              const bothMeasureAsk = hasBoth
                ? `${thirdPartyMeasure}measurement ${getMeasureLocation('waist')} and the measurement ${getMeasureLocation('chest', topProd?.product)}`
                : `${thirdPartyMeasure}measurement ${measureLocation}`;
              const measureAsk = isUncertain
                ? ` If you send me ${bothMeasureAsk}${heightAsk} I can double check the sizing${heightReason}.`
                : (isOnepiece ? ` If you send me ${thirdPartyMeasure}height I can also confirm whether Regular or Tall is the right fit.` : '');

              // Bridge: acknowledge the customer's requested size and explain why we're showing options
              const requestedIsFirst = uniqueOptions[0] === normalizeSize(desiredSize);
              const desiredDisplay = `${normalizeSize(desiredSize)}${modSuffix}`;
              const bridge = requestedIsFirst
                ? ''
                : `Since we have half sizes, there are a couple of options close to the ${desiredDisplay} you asked about. `;
              const measurePre = measurementNote ? `${measurementNote} ` : '';
              // Don't ask for measurement again if they already provided one
              const finalMeasureAsk = intake.measurement ? '' : measureAsk;
              rx.response_text = `${measurePre}${bridge}The ${optionDetails.map(o => o.formatted).join(', and the ')}. Which would you prefer?${finalMeasureAsk}`;
              rx.audit = `Specific size requested: ${currentSize} → ${desiredSize} (${delta.inches}" delta, ≤2" — half-step product, presenting options: ${uniqueOptions.join(', ')}${measurementNote ? ' + measurement note' : ''}${isUncertain && !intake.measurement ? ' + measurement ask' : ''})`;
              prescription.still_needed.push(`size_confirmation for ${item.product}`);
            } else {
              // No half-steps (underwear/tops) — single step, auto-confirm with delta as FYI
              rx.state = 'CONFIRMED';
              if (intakeItem && !intakeItem.resolved_size) intakeItem.resolved_size = normalizeSize(desiredSize);
              if (!intake.resolution_sizes.some(r => r.product === item.product)) {
                intake.resolution_sizes.push({ product: item.product, from_size: currentSize, to_size: normalizeSize(desiredSize) });
              }
              const unit = useInches ? `${delta.inches}"` : `${delta.cm} cm`;
              let deltaAside;
              switch (productType) {
                case 'bra': deltaAside = `the bra band will be ${unit} ${direction === 'up' ? 'longer' : 'shorter'} than the ${currentSize}`; break;
                case 'bikini_top': deltaAside = `the bikini top band will be ${unit} ${direction === 'up' ? 'longer' : 'shorter'} than the ${currentSize}`; break;
                case 'top': deltaAside = `that's ${unit} ${direction === 'up' ? 'more' : 'less'} fabric around the torso compared to the ${currentSize}`; break;
                default: deltaAside = `that's ${unit} ${direction === 'up' ? 'more' : 'less'} fabric around the waist compared to the ${currentSize}`; break;
              }
              // Build the FYI text for the auto-confirmed exchange
              const deltaDesc = `${unit} ${direction === 'up' ? 'more' : 'less'} fabric around the waist compared to the ${currentSize}`;
              const fyi = [];
              if (measurementNote) fyi.push(measurementNote);
              fyi.push(`The ${normalizeSize(desiredSize)} has ${deltaDesc}.`);
              rx.response_text = fyi.join(' ');
              rx.audit = `Specific size requested: ${currentSize} → ${desiredSize} (${delta.inches}" delta, ≤2", no half-steps — auto-confirmed${measurementNote ? ', measurement note included' : ''})`;
            }
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
            rx.response_text = `You'd like to go from ${currentSize} to ${desiredSize} — does that sound right to you?`;
            rx.audit = `Specific size requested: ${currentSize} → ${desiredSize} (could not calculate delta — confirming)`;
            prescription.still_needed.push(`size_confirmation for ${item.product}`);
          }
          break;
        }

        // Customer described the problem but didn't request a specific size
        // Confidence: "a bit tight/loose" → 1 step, auto-confirm. "too tight/loose" → offer options.
        const issueText = (intakeItem?.issue || item.issue || '').toLowerCase();
        const fitPattern = /a bit (tight|loose|big|small|snug|large)|slightly (tight|loose|big|small|snug|large)|little bit (tight|loose|big|small|snug|large)|a little (tight|loose|big|small|snug|large)/;
        const isABit = /a bit|slightly|little bit|a little/.test(issueText) ||
          fitPattern.test((intake._latestMessage || '').toLowerCase()) ||
          fitPattern.test((intake._originalFitMessage || '').toLowerCase());
        const nextSizePattern = /next size|one size (up|down|smaller|bigger|larger)/;
        const isNextSize = nextSizePattern.test((intake._latestMessage || '').toLowerCase()) ||
          nextSizePattern.test((intake._originalFitMessage || '').toLowerCase());

        const adjacent = getAdjacentSizes(currentSize, direction, 2, item.product);

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
              rx.response_text = `Size 16 is the largest youth size. The next size up moves into adult sizing — size L (${desc}). Does that sound right to you?`;
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
              rx.response_text = `XXS is the smallest adult size. The next size down moves into youth sizing — size 16. Does that sound right to you?`;
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

        // If measurement is available, look up recommended size and use that instead of blind options
        // Use chest measurement for tops, waist measurement for bottoms
        const isTopProduct = productType === 'bra' || productType === 'bikini_top' || productType === 'top';
        const relevantMeasurement = isTopProduct ? (intake.chest_measurement || intake.measurement) : intake.measurement;
        if (relevantMeasurement && !isABit && !isNextSize) {
          const m = relevantMeasurement;
          const isKidsM = NUMERIC_SIZES.includes(normalizeSize(item.size));
          const { chartCategory, measureType } = getChartCategory(item.product, isKidsM);
          const mUnit = m.unit === 'cm' ? 'cm' : 'inches';
          const nick = getProductNickname(item.product);
          try {
            const supabase = getSupabaseClient();
            const { data: sizeMatches } = await supabase.rpc('find_size_by_measurement', {
              p_chart_category: chartCategory,
              p_measurement_type: measureType,
              p_value: m.value,
              p_unit: mUnit,
            });
            if (sizeMatches && sizeMatches.length > 0) {
              // If measurement falls exactly between two sizes, present both options
              if (sizeMatches.length >= 2 && sizeMatches[0].size_label !== sizeMatches[1].size_label) {
                const size1 = sizeMatches[0].size_label;
                const size2 = sizeMatches[1].size_label;
                rx.state = 'AWAITING_SIZE_CONFIRMATION';
                rx.options = [{ size: size1 }, { size: size2 }];
                rx.response_text = `For the ${nick} you are in between a size ${size1} and ${size2}. Let me know which you would like.`;
                if (intakeItem) intakeItem._pendingSize = size1; // default to first
                rx.audit = `Measurement ${m.value} ${mUnit} is between ${size1} and ${size2} — asking customer to choose`;
                prescription.still_needed.push(`size_confirmation for ${item.product}`);
                break;
              }

              let recommendedSize = sizeMatches[0].size_label;

              // If the recommended size is the SAME as what they already have and it doesn't fit,
              // bump one size in the direction of the issue (tight → size up, loose → size down)
              let isSizeChartException = false;
              if (normalizeSize(recommendedSize) === normalizeSize(currentSize)) {
                const issueDirection = /tight|small|digging/.test(intakeItem?.issue || '') ? 'up' : 'down';
                const adjSizes = getAdjacentSizes(currentSize, issueDirection, 1, item.product);
                if (adjSizes.length > 0) {
                  recommendedSize = adjSizes[0];
                  isSizeChartException = true;
                  rx.audit = `Measurement lookup → ${sizeMatches[0].size_label} but customer already has ${currentSize} and it's too ${issueDirection === 'up' ? 'tight' : 'loose'} → bumping to ${recommendedSize}`;
                }
              }

              // Check if this is a repeat exchange — auto-confirm instead of asking
              const isRepeatExchange = isSizeChartException || previousExchangeProducts.has(item.product?.toLowerCase()) ||
                [...previousExchangeProducts].some(p => p.includes((getProductNickname(item.product) || '').toLowerCase()));

              if (isRepeatExchange || isSizeChartException) {
                // Auto-confirm — don't ask, just do it
                rx.state = 'CONFIRMED';
                if (intakeItem) intakeItem.resolved_size = recommendedSize;
                if (!intake.resolution_sizes.some(r => r.product === item.product)) {
                  intake.resolution_sizes.push({ product: item.product, from_size: currentSize, to_size: recommendedSize });
                }
                rx.response_text = `Sorry to hear the ${currentSize} didn't work out. The sizing chart works for most but there can be exceptions. I'm going to send over a size ${recommendedSize} for the ${nick}.`;
                rx.audit = (rx.audit || `Measurement → ${recommendedSize}`) + ` (repeat exchange — auto-confirmed)`;
              } else {
                rx.state = 'AWAITING_SIZE_CONFIRMATION';
                const measureRef = isThirdParty ? `your ${intake.third_party_label || "child"}'s` : 'the';
                rx.response_text = `Based on ${measureRef} measurement of ${m.value} ${mUnit}, I'd recommend a size ${recommendedSize} for the ${nick}. Does that sound right to you?`;
              }
              if (intakeItem) intakeItem._pendingSize = recommendedSize;
              if (!rx.audit) rx.audit = `Measurement available — lookup: ${m.value} ${mUnit} ${measureType} in ${chartCategory} → ${recommendedSize}`;
              prescription.still_needed.push(`size_confirmation for ${item.product}`);
              break;
            }
          } catch (e) { /* measurement lookup failed — fall through to options */ }
        }

        // Build size options with cumulative fabric deltas
        const sizeList = getSizeList(currentSize, item.product);
        const optionDetails = adjacent.map(s => {
          const delta = getCumulativeDelta(currentSize, s) || { inches: 2, cm: 5 };
          const unit = useInches ? `${delta.inches}"` : `${delta.cm} cm`;
          const sign = direction === 'up' ? '+' : '-';
          const more = direction === 'up' ? 'more' : 'less';
          let description;
          switch (productType) {
            case 'bra': description = `which has the bra band ${unit} ${direction === 'up' ? 'longer' : 'shorter'} than the ${currentSize}`; break;
            case 'bikini_top': description = `which has the bikini top band ${unit} ${direction === 'up' ? 'longer' : 'shorter'} than the ${currentSize}`; break;
            case 'top': description = `which has ${unit} ${more} fabric around the torso compared to the ${currentSize}`; break;
            default: description = `which has ${unit} ${more} fabric around the waist compared to the ${currentSize}`; break;
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
        } else if (previousExchangeProducts.has(item.product?.toLowerCase()) ||
          [...previousExchangeProducts].some(p => p.includes((getProductNickname(item.product) || '').toLowerCase()))) {
          // Repeat exchange — auto-confirm the next size, don't ask
          const next = adjacent[0];
          rx.state = 'CONFIRMED';
          if (intakeItem) intakeItem.resolved_size = next;
          if (!intake.resolution_sizes.some(r => r.product === item.product)) {
            intake.resolution_sizes.push({ product: item.product, from_size: currentSize, to_size: next });
          }
          rx.response_text = `Sorry to hear the ${currentSize} didn't work out. The sizing chart works for most but there can be exceptions. I'm going to send over a size ${next} for the ${nick}.`;
          rx.audit = `Repeat exchange — auto-confirmed: ${currentSize} → ${next}`;
        } else {
          // Lower confidence — offer options, ask to confirm
          rx.state = 'AWAITING_SIZE_CONFIRMATION';
          rx.options = optionDetails;

          // For one-pieces, also ask for height to confirm Regular vs Tall
          const isOnepieceOpt = itemCategory === 'onepiece';
          const heightNote = isOnepieceOpt
            ? ` If you send me ${isThirdParty ? `your ${intake.third_party_label || "child"}'s ` : 'your '}height I can also confirm whether Regular or Tall is the right fit.`
            : '';

          if (adjacent.length === 1) {
            rx.response_text = `The next size ${direction} is ${optionDetails[0].formatted} — does that sound right to you?${heightNote}`;
          } else {
            rx.response_text = `The next size ${direction} is ${optionDetails[0].formatted}, or ${optionDetails[1].formatted}. Which sounds better?${heightNote}`;
          }

          rx.audit = `Close fit ${direction}: ${currentSize} → ${adjacent.join(' or ')} | offered with fabric delta, awaiting confirmation${isOnepieceOpt ? ' + height ask' : ''}`;
          prescription.still_needed.push(`size_confirmation for ${item.product}`);
        }
        break;
      }

      case 'sizing_exchange_measurement': {
        if (intake.measurement) {
          // We have measurement — look up the size from size_charts table
          const m = intake.measurement;
          const isKidsM = NUMERIC_SIZES.includes(normalizeSize(item.size));
          const { chartCategory, measureType } = getChartCategory(item.product, isKidsM);
          const unit = m.unit === 'cm' ? 'cm' : 'inches';
          const nick = getProductNickname(item.product);

          try {
            const supabase = getSupabaseClient();
            const { data: sizeMatches } = await supabase.rpc('find_size_by_measurement', {
              p_chart_category: chartCategory,
              p_measurement_type: measureType,
              p_value: m.value,
              p_unit: unit,
            });

            if (sizeMatches && sizeMatches.length > 0) {
              const recommendedSize = sizeMatches[0].size_label;
              rx.state = 'AWAITING_SIZE_CONFIRMATION';
              const measureRef = isThirdParty ? `your ${intake.third_party_label || "child"}'s` : 'the';
              rx.response_text = `Based on ${measureRef} measurement of ${m.value} ${unit}, I'd recommend a size ${recommendedSize} for the ${nick}. Does that sound right to you?`;
              const intakeItemM = intake.items.find(i => i.product === item.product);
              if (intakeItemM) intakeItemM._pendingSize = recommendedSize;
              rx.audit = `Measurement lookup: ${m.value} ${unit} ${measureType} in ${chartCategory} → ${recommendedSize}`;
              prescription.still_needed.push(`size_confirmation for ${item.product}`);
            } else {
              // No match in current product's chart — check if measurement fits a different
              // size system (e.g. youth product but adult measurement, or vice versa).
              // Try the alternate chart (kids↔adult) for the same product type.
              const altChartCategory = isKidsM
                ? chartCategory.replace('kids_', 'adult_')
                : chartCategory.replace('adult_', 'kids_');
              let altMatch = null;
              try {
                const { data: altMatches } = await supabase.rpc('find_size_by_measurement', {
                  p_chart_category: altChartCategory,
                  p_measurement_type: measureType,
                  p_value: m.value,
                  p_unit: unit,
                });
                if (altMatches?.length) altMatch = altMatches[0];
              } catch (e) { /* alt chart lookup failed */ }

              if (altMatch) {
                // Measurement matches the other size system — recommend switching product
                const altIsAdult = altChartCategory.startsWith('adult_');
                const altSizeLabel = altMatch.size_label;

                // Find the right adult/youth product to recommend
                // Look for an active product in the same general category with the right size system
                const currentBodyType = isTopM ? 'top' : 'bottom';
                const altProducts = Object.values(_activeProducts).filter(p => {
                  if (altIsAdult) {
                    // Need an adult product — one that has letter sizes
                    return (currentBodyType === 'bottom'
                      ? (p.category === 'underwear_bottom' || p.category === 'swim_bottom')
                      : (p.category === 'underwear_top' || p.category === 'swim_top'))
                      && LETTER_SIZES.includes(normalizeSize(altSizeLabel));
                  } else {
                    // Need a youth product — one that has numeric sizes
                    return (currentBodyType === 'bottom'
                      ? (p.category === 'underwear_bottom')
                      : (p.category === 'underwear_top'))
                      && NUMERIC_SIZES.includes(normalizeSize(altSizeLabel));
                  }
                });

                // Default recommendation per category
                const categoryDefaults = {
                  'underwear_bottom': 'AJ',
                  'underwear_top': 'Brooke',
                  'swim_bottom': 'Ruby',
                  'swim_top': 'Mia',
                  'onepiece': 'Sky',
                };
                const itemCat = catM || (currentBodyType === 'bottom' ? 'underwear_bottom' : 'underwear_top');
                const altCat = altIsAdult
                  ? itemCat.replace('kids_', '').replace(/^swim_/, 'underwear_') // kids swim → adult underwear
                  : itemCat;
                const defaultNick = categoryDefaults[altCat] || categoryDefaults[itemCat];
                const recommendedProduct = (defaultNick && altProducts.find(p => p.nickname === defaultNick))
                  || altProducts[0];
                const recName = recommendedProduct?.nickname || (altIsAdult ? 'adult underwear' : 'youth underwear');
                const mDisplay = formatMeasurementDisplay(m.value, unit);

                rx.state = 'AWAITING_SIZE_CONFIRMATION';
                // Count how many items of this product are being exchanged
                const sameProductCount = intake.items.filter(i => i.product === item.product).length;
                const qtyText = sameProductCount > 1 ? `${sameProductCount} pairs` : 'one';
                const productContext = isKidsM
                  ? `The ${nick} is actually our youth line — based on your measurement of ${mDisplay}, I'd recommend our ${recName} in size ${altSizeLabel} instead.`
                  : `Based on your measurement of ${mDisplay}, I'd recommend the ${recName} in size ${altSizeLabel}.`;
                rx.response_text = `${productContext} I'll send ${qtyText} out as an exchange.`;
                rx._product_switch = { from: nick, to: recName, size: altSizeLabel };
                rx.audit = `Measurement ${m.value} ${unit} doesn't match ${chartCategory} — matches ${altChartCategory} → ${altSizeLabel}. Recommending product switch: ${nick} → ${recName}`;
                prescription.still_needed.push(`size_confirmation for ${item.product}`);
              } else {
                // Doesn't match either chart — ask to re-measure
                rx.state = 'AWAITING_SIZE_CONFIRMATION';
                const measureLoc2 = getMeasureLocation(measureType, item.product);
                rx.response_text = `The measurement of ${m.value} ${unit} doesn't fall exactly in our size chart for the ${nick}. Could you double-check? It should be measured ${measureLoc2}.`;
                rx.audit = `Measurement lookup: ${m.value} ${unit} — no match in ${chartCategory} or ${altChartCategory}`;
                prescription.still_needed.push(`measurement for ${item.product}`);
              }
            }
          } catch (e) {
            rx.state = 'AWAITING_SIZE_CONFIRMATION';
            rx.response_text = `Based on your measurement, I'd recommend trying a smaller size. Shall I help find the right one?`;
            rx.audit = `Measurement lookup failed: ${e.message}`;
            prescription.still_needed.push(`size_confirmation for ${item.product}`);
          }
        } else {
          rx.state = 'AWAITING_MEASUREMENT';
          const measureType = item.product?.toLowerCase().match(/bra|top/) ? 'chest' : 'waist';
          const unit = useInches ? 'inches' : 'cm';
          const thirdPartyPrefix = isThirdParty ? `your ${intake.third_party_label || "child"}'s ` : '';
          const catWayOff = classifyProduct(item.product);
          const isOnepieceWayOff = catWayOff === 'onepiece';
          const heightAskWayOff = isOnepieceWayOff ? ' and your height' : '';
          const heightReasonWayOff = isOnepieceWayOff ? ' and whether Regular or Tall would work best' : '';

          // Check if order has BOTH tops and bottoms — ask for both measurements in one go
          const allCategories = new Set(classifiedItems.map(ci => classifyProduct(ci.product)).filter(Boolean));
          const hasBottoms = allCategories.has('swim_bottom') || allCategories.has('underwear_bottom') || allCategories.has('onepiece');
          const hasTops = allCategories.has('swim_top') || allCategories.has('underwear_top');
          const needsBothMeasurements = hasBottoms && hasTops;

          if (needsBothMeasurements) {
            // Find the actual top product to get correct wording (bra band vs bikini band)
            const topProduct = classifiedItems.find(ci => { const c = classifyProduct(ci.product); return c === 'swim_top' || c === 'underwear_top'; });
            const waistLocation = getMeasureLocation('waist');
            const chestLocation = getMeasureLocation('chest', topProduct?.product);
            rx.response_text = `If you send me ${thirdPartyPrefix ? thirdPartyPrefix : 'the '}measurement ${waistLocation} and the measurement ${chestLocation} I can help recommend the right size${heightReasonWayOff}.`;
            rx.audit = `Way off — asking for BOTH waist + chest measurements (order has tops + bottoms)`;
          } else {
            const measureLocation = getMeasureLocation(measureType);
            rx.response_text = `If you send me ${thirdPartyPrefix ? thirdPartyPrefix : 'the '}measurement ${measureLocation}${heightAskWayOff} I can help recommend the right size${heightReasonWayOff}.`;
            rx.audit = `Way off — asking for ${measureType} measurement${isOnepieceWayOff ? ' + height' : ''}`;
          }
          prescription.still_needed.push(`measurement for ${item.product}`);
        }
        break;
      }

      case 'probe_needed': {
        rx.state = 'AWAITING_CLARIFICATION';
        const probeNick = getProductNickname(item.product);
        if (isThirdParty) {
          rx.response_text = `Can you let me know what didn't work out for your ${intake.third_party_label || 'child'} with the ${probeNick} in case I can help with another size or recommend another product?`;
        } else {
          rx.response_text = `Can you let me know what didn't work out with the ${probeNick} in case I can help with another size or recommend another product?`;
        }
        rx.audit = 'Product not working — probing before deciding path';
        prescription.still_needed.push(`clarification for ${item.product}`);
        break;
      }

      case 'expectation_mismatch': {
        // Customer says it "doesn't work" / "doesn't hide" / "can still see"
        // Two-branch explanation: fit issue vs expectation mismatch
        rx.state = 'AWAITING_DECISION';
        const emNick = getProductNickname(item.product);
        const comfortRef = isThirdParty
          ? `your ${intake.third_party_label || "child"}'s comfort is most important`
          : 'your comfort is most important';
        const theyRef = isThirdParty ? (intake.pronouns === 'she/her' ? 'she' : 'they') : 'you';
        const themRef = isThirdParty ? (intake.pronouns === 'she/her' ? 'her' : 'them') : 'you';
        const measureAsk = isThirdParty
          ? `your ${intake.third_party_label || "child"}'s measurement`
          : 'the measurement';

        // This case only fires for bottoms (tops are redirected to fit_direction_unclear in classification)
        rx.response_text = `If ${theyRef} ${theyRef === 'she' ? 'is' : 'are'} feeling the shaping is not working it's often due to two reasons: either the fit is off or there is a mismatch of expectations.\n\nIn terms of the fit, unlike "tucking" bottoms they are intended to be worn comfortably. Not too tight or too loose. If you send me ${measureAsk} around the belly and just under the belly button I can double check the sizing.\n\nIn terms of expectations, our shaping bottoms are meant to reshape the front area to create a feminine mound. This is in contrast to "tucking" or "gaffing" underwear which completely flattens the area. This is why our shaping bottoms are very comfortable and can be worn for all activities.\n\nUltimately ${comfortRef} so let me know what ${theyRef === 'she' ? 'she' : 'you'} would like to do next. I'd be happy to send out another size to try.`;
        rx.audit = 'Expectation mismatch — two-branch explanation (fit vs expectations)';
        prescription.still_needed.push(`decision for ${item.product}`);
        break;
      }

      case 'height_variant_check': {
        // One-piece height variant issue: too short → need Tall, too long → need Regular
        // Ask for height + waist so we can make a complete recommendation
        const heightNick = getProductNickname(item.product);
        const heightIntakeItem = intake.items.find(i => i.product === item.product);
        const currentMod = heightIntakeItem?._variant_modifier || null;
        const targetMod = item.heightDirection === 'tall' ? 'Tall' : 'Regular';

        if (intake.height_measurement && intake.measurement) {
          // We have both measurements — look up the right size + variant
          const waistSize = normalizeSize(item.size);
          const isKidsH = NUMERIC_SIZES.includes(waistSize);
          const chartCat = isKidsH ? 'kids_onepiece' : 'adult_onepiece';

          try {
            const supabase = getSupabaseClient();
            // Look up waist size
            const { data: waistMatches } = await supabase.rpc('find_size_by_measurement', {
              p_chart_category: chartCat,
              p_measurement_type: 'waist',
              p_value: intake.measurement.value,
              p_unit: intake.measurement.unit === 'cm' ? 'cm' : 'inches',
            });
            const recommendedWaist = waistMatches?.[0]?.size_label || waistSize;

            const heightVal = intake.height_measurement.value;
            const heightUnit = intake.height_measurement.unit === 'cm' ? 'cm' : 'inches';
            const heightInInches = heightUnit === 'cm' ? heightVal / 2.54 : heightVal;
            const fit = await analyzeOnepieceFit(chartCat, recommendedWaist, heightInInches, item.product, useInches);

            if (fit.type === 'exact') {
              rx.state = 'AWAITING_SIZE_CONFIRMATION';
              rx.response_text = `Based on your measurements, the ${fit.size} ${fit.variant} should be the right fit. Does that sound right to you?`;
              rx.audit = `Height check: ${waistSize} ${currentMod || 'Regular'} → ${fit.size} ${fit.variant} (measurement-based)`;
            } else if (fit.type === 'wiggle') {
              rx.state = 'AWAITING_SIZE_CONFIRMATION';
              rx.response_text = `Based on your measurements, the ${fit.size} ${fit.variant} would be the best fit for your height. The waist will have ${fit.unit} ${fit.moreOrLess} fabric compared to the ${fit.waistSize}, but there's some wiggle room in the bottoms so it should work well. Does that sound right to you?`;
              rx.audit = `Height check: waist→${fit.waistSize} but height→${fit.size} ${fit.variant} (1 size ${fit.moreOrLess === 'more' ? 'up' : 'down'} for height, wiggle room)`;
            } else if (fit.type === 'separates') {
              rx.state = 'AWAITING_DECISION';
              rx.response_text = getSeparatesText('mismatch', 'your', true);
              rx.audit = `Height check: waist→${fit.waistSize} but height→${fit.heightSize} ${fit.variant} (${fit.sizeDiff} sizes apart) — suggesting separates`;
            } else {
              rx.state = 'AWAITING_DECISION';
              rx.response_text = getSeparatesText('height_outside', 'your', true);
              rx.audit = `Height check: height ${heightVal} ${heightUnit} outside all chart ranges — suggesting separates`;
            }
          } catch (e) {
            rx.state = 'AWAITING_SIZE_CONFIRMATION';
            rx.response_text = `Shall I set up the exchange for the ${heightNick} in ${waistSize} ${targetMod}?`;
            rx.audit = `Height check: measurement lookup failed (${e.message}) — confirming requested variant`;
          }
          prescription.still_needed.push(`size_confirmation for ${item.product}`);
        } else {
          // Need measurements — ask for both height and waist
          rx.state = 'AWAITING_MEASUREMENT';
          const thirdPartyPrefix = isThirdParty ? `your ${intake.third_party_label || "child"}'s ` : '';
          rx.response_text = `For the one-piece, if you send me ${thirdPartyPrefix}height and the measurement around the belly just under the belly button, I can recommend the right size and whether Regular or Tall would work best.`;
          rx.audit = `Height variant issue (${item.heightDirection}) — asking for height + waist measurements`;
          prescription.still_needed.push(`height_and_waist for ${item.product}`);
        }
        break;
      }

      case 'style_switch': {
        // Determine recommendation based on product type + size system
        const sizeList = item.size ? getSizeList(normalizeSize(item.size), item.product) : null;
        // Kids = numeric size system, but size 16 is the youth/adult boundary — treat as adult
        const normSize = normalizeSize(item.size);
        const isKids = sizeList && !LETTER_SIZES.includes(normSize) && normSize !== '16';
        const productCategory = classifyProduct(item.product);
        const isSwim = productCategory === 'swim_bottom' || productCategory === 'swim_top';

        // Targets come from product_cs_config, not a hardcoded list, so adding
        // or rescoping a style updates the advisor (via compare_products) and
        // this recommendation together. A swim complaint looks for swim bottoms;
        // a one-piece has no target at all, which is why the empty case below
        // must not fall through to naming an underwear style.
        const currentNick = getProductNickname(item.product);
        const targetCategory = isSwim ? 'swim_bottom' : productCategory;
        const targets = tightLegsTargets({
          activeProducts: _activeProducts,
          category: targetCategory,
          isKids,
          size: item.size,
          excludeNickname: currentNick,
          // Supplied by the caller (see fetchStyleSwitchAvailability in
          // aiAdvisor). Absent in tests and older callers, which then behave
          // exactly as before.
          availability,
        }).map(t => ({ ...t, link: getProductUrl(t.nickname) || '' }));
        // "Already on a widest-leg style, and nothing else to move them to."
        const isSameProduct = targets.length === 0;

        // Check if customer confirmed waist is fine — if not, ask for measurement too
        const msgStyle = (intake._latestMessage || '').toLowerCase();
        const waistConfirmed = /waist.*(fine|good|ok|fits|perfect|great)|fits.*waist/.test(msgStyle);
        const thirdPartyMeasure = isThirdParty ? `your ${intake.third_party_label || "child"}'s` : 'the';
        const measureAsk = waistConfirmed ? '' : `if you send me ${thirdPartyMeasure} waist measurement around the belly and just under the belly button I can make sure the sizing is right.`;

        if (isSameProduct) {
          // Already on the widest leg opening product — offer sizing up, and adult alternative if near boundary
          rx.state = 'AWAITING_SIZE_CONFIRMATION';
          const nearAdultBoundary = !isSwim && isKids === false && (normSize === '14' || normSize === '16');
          // Also check: youth product at size 14+ should offer adult alternative
          const isYouthNearBoundary = !isSwim && normSize === '14' && !LETTER_SIZES.includes(normSize);
          const numericToAdult = { '10': 'XXS', '11': 'XXS+', '12': 'XS', '13': 'XS+', '14': 'S', '16': 'M' };
          const adultEquiv = numericToAdult[normSize] || null;
          const sassyUrl = getProductUrl('Sassy') || '';
          const adultAlt = (nearAdultBoundary || isYouthNearBoundary) && adultEquiv
            ? ` Or you could try the Sassy in size ${adultEquiv}, the equivalent in our adult line, which has a different cut: ${sassyUrl}`
            : '';
          rx.response_text = `The ${currentNick} already has one of the widest leg openings in our range. Sizing up would give more room in the legs.${adultAlt}${measureAsk ? ' ' + measureAsk.charAt(0).toUpperCase() + measureAsk.slice(1) : ''}`;
          rx.audit = `Tight legs on ${currentNick} — no other style-switch target, suggesting size up${adultAlt ? ' + adult alternative' : ''}`;
          prescription.still_needed.push(`size_confirmation for ${item.product}`);
        } else {
          rx.state = 'AWAITING_STYLE_CONFIRMATION';
          const lead = targets[0];
          const offered = targets.slice(0, 2);
          // Only name a size when it differs from the one they gave us, i.e.
          // when a youth numeric crosses into the style's adult lettering.
          const sizeNote = lead.crossesToAdult && lead.size ? ` in size ${lead.size}` : '';
          // Out of stock but close enough to be worth waiting for: say so with
          // the vague phrase, never a precise date.
          const waitNote = lead.inStock === false && lead.restock?.sellable_phrase
            ? ` It should be back in stock ${lead.restock.sellable_phrase.replace(/,\s*\d{4}$/, '')}.`
            : '';

          // Founder wording: lead with the roomier leg opening, and give "cut
          // higher" as the REASON for it rather than on its own. Alone it reads
          // as "more revealing"; tied to the opening it reads as the fit
          // benefit, which is what the customer is asking about. No pronoun, so
          // it reads the same whether they are buying for themselves or someone
          // else.
          const why = (plural) => plural
            ? 'have roomier leg openings as they are cut higher, so the thighs get more room without sizing up the waist'
            : 'has a roomier leg opening as it is cut higher, so the thighs get more room without sizing up the waist';

          if (offered.length > 1) {
            // Two styles share the wider cut. Name the everyday pick rather than
            // stating the trade-off: the Naomi is a gaff, so it buys compression
            // at some cost to all-day comfort, and we do not say that outright.
            const names = offered.map(t => `the ${t.nickname}`).join(' and ');
            const links = offered.map(t => `${t.nickname}: ${t.link}`).join(' ');
            const everydayPick = offered.find(t => t.everyday) || lead;
            rx.response_text = `${names.charAt(0).toUpperCase() + names.slice(1)}${sizeNote} ${why(true)}. The ${everydayPick.nickname} is better for all day wear. Would you like to try one? ${links}${measureAsk ? ' Also, ' + measureAsk : ''}`;
          } else {
            rx.response_text = `The ${lead.nickname}${sizeNote} ${why(false)}.${waitNote} Would you like to try that instead? ${lead.link}${measureAsk ? ' Also, ' + measureAsk : ''}`;
          }

          rx.recommendation = { product: lead.nickname, link: lead.link, alternatives: offered.slice(1) };
          // Store the pending style switch on the intake item so confirmation uses the new product
          const intakeItemStyle = intake.items.find(ii => ii.product === item.product);
          if (intakeItemStyle) {
            intakeItemStyle._pendingStyleSwitch = lead.nickname;
          }
          rx.audit = `Tight legs → ${offered.map(t => t.nickname).join(' / ')} (${isKids ? 'kids' : 'adult'}, ${isSwim ? 'swim' : 'underwear'})`;
          prescription.still_needed.push(`style_confirmation for ${item.product}`);
        }
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
          rx.response_text = `For the one-piece, if you send me the measurement around the belly, just under the belly button, and your height, I can help recommend the right size.`;
          rx.audit = 'One-piece — need waist + height';
          prescription.still_needed.push(`waist_and_height for ${item.product}`);
        }
        break;
      }

      case 'defect': {
        const defectNick = getProductNickname(item.product);
        rx.state = 'ESCALATE_TO_HUMAN';
        rx.response_text = `So sorry about that! Could you send a photo of the issue? I'd like to forward it to our supplier so they can look into it.`;
        rx.skip_donation = true;
        rx.route_to_human = true;
        rx.audit = `Defect: apologize + ask photo + route to human`;
        prescription.still_needed.push(`photo for ${item.product}`);
        break;
      }

      case 'wrong_item': {
        const wrongNick = getProductNickname(item.product);
        rx.state = 'ESCALATE_TO_HUMAN';
        rx.response_text = `So sorry about that! I'll get the correct ${wrongNick} sent out to you right away.`;
        rx.skip_donation = true;
        rx.route_to_human = true;
        rx.audit = `Wrong item/missing: apologize + send replacement + route to human`;
        break;
      }

      case 'try_size_return':
      case 'refund': {
        // All returns: always offer a free exchange first, then process refund if declined.
        const nick = getProductNickname(item.product);
        const intakeItemRef = intake.items.find(i => i.product === item.product);

        // Check eligibility
        let eligible = 'unknown';
        if (context.targetOrder?.createdAt) {
          const days = Math.floor(((context.referenceDate || new Date()).getTime() - new Date(context.targetOrder.createdAt).getTime()) / 86400000);
          eligible = days <= 60 ? 'yes' : days <= 180 ? 'generous' : 'escalate';
        }

        // Has the exchange offer already been made?
        const alreadyOffered = intake._exchangeOffered?.[item.product];

        if (alreadyOffered) {
          // Customer already declined — process refund
          rx.state = 'REFUND_CONFIRMED';
          rx.refund_confirmed = true;
          rx.response_text = `No problem at all! I'll process the return for the ${nick}.`;
          rx.refund_eligible = eligible;
          rx.audit = `Refund confirmed — customer declined exchange offer. Eligible: ${eligible}.`;
        } else if (!intake._returnProbed?.[item.product]) {
          // Check if customer already gave a reason (style, preference, etc.)
          const intakeIssue = (intakeItemRef?.issue || '').toLowerCase();
          const latestMsg = (intake._latestMessage || '').toLowerCase();
          const hasStyleReason = /didn't like|don't like|not .* style|wasn't .* style|not for me|not for her|not for him|didn't suit|doesn't suit|prefer|not what .* expected/.test(latestMsg);
          const hasReason = hasStyleReason || /refund_request/.test(intakeIssue) && hasStyleReason;

          if (hasReason) {
            // Customer already explained — skip probe, go straight to exchange offer
            rx.state = 'AWAITING_DECISION';
            rx.response_text = `No problem! Is there anything else from our catalog you'd like to exchange the ${nick} for? We'd ship it out for free. If you'd prefer a refund we can do that too.`;
            rx.refund_eligible = eligible;
            rx.audit = `Return requested — eligible: ${eligible}. Reason given ("${hasStyleReason ? 'style' : 'preference'}"), skipping probe, offering exchange.`;
            if (!intake._returnProbed) intake._returnProbed = {};
            intake._returnProbed[item.product] = true;
            if (!intake._exchangeOffered) intake._exchangeOffered = {};
            intake._exchangeOffered[item.product] = true;
            prescription.still_needed.push(`return_decision for ${item.product}`);
          } else {
            // No reason given — probe what didn't work
            rx.state = 'AWAITING_CLARIFICATION';
            const returnCat = classifyProduct(item.product);
            const isOnepieceReturn = returnCat === 'onepiece';
            const thirdPartyWho = isThirdParty ? `for your ${intake.third_party_label || 'child'} ` : '';
            const thirdPartyPossessive = isThirdParty ? `your ${intake.third_party_label || "child"}'s ` : '';

            if (isOnepieceReturn) {
              rx.response_text = `Can you let me know what didn't work out ${thirdPartyWho}with the one-piece? If it's a fit issue, feel free to send ${thirdPartyPossessive || 'the '}waist measurement around the belly just under the belly button and ${thirdPartyPossessive || ''}height — I can check the sizing and we can always send out a new size. And if the one-piece isn't the right fit we can always find an alternative that works.`;
            } else {
              rx.response_text = `Can you let me know what didn't work out ${thirdPartyWho}with the ${nick}? If it's a sizing issue I can help find the right size, or if the style isn't quite right we can always find an alternative that works.`;
            }
            rx.refund_eligible = eligible;
            rx.audit = `Return requested — eligible: ${eligible}. Probing what didn't work before offering swap.`;
            if (!intake._returnProbed) intake._returnProbed = {};
            intake._returnProbed[item.product] = true;
            prescription.still_needed.push(`return_reason for ${item.product}`);
          }
        } else {
          // Already probed — now offer the free exchange
          rx.state = 'AWAITING_DECISION';
          rx.response_text = `Would you like to swap the ${nick} for something else from our catalog? We'd ship it out for free — could be a different style or color. Totally up to you though — if you'd prefer a refund we can do that too.`;
          rx.refund_eligible = eligible;
          rx.audit = `Return requested — eligible: ${eligible}. Offering free exchange before refund.`;
          if (!intake._exchangeOffered) intake._exchangeOffered = {};
          intake._exchangeOffered[item.product] = true;
          if (intakeItemRef) intakeItemRef._pendingTrySizeSwap = true;
          prescription.still_needed.push(`exchange_or_refund_decision for ${item.product}`);
        }
        break;
      }

      case 'fit_direction_unclear': {
        // Customer says "doesn't fit" but didn't say tight or loose.
        // Ask a product-specific fit question.
        rx.state = 'AWAITING_CLARIFICATION';
        const fitCategory = classifyProduct(item.product);
        const isOnepiece = fitCategory === 'onepiece';
        const isTop = fitCategory === 'underwear_top' || fitCategory === 'swim_top';
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
        const clarNick = getProductNickname(item.product) || 'item';
        if (isThirdParty) {
          rx.response_text = `Can you let me know what didn't work out for your ${intake.third_party_label || 'child'} with the ${clarNick} in case I can help with another size or recommend another product?`;
        } else {
          rx.response_text = `Can you let me know what didn't work out with the ${clarNick} in case I can help with another size or recommend another product?`;
        }
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

// Phase 6: Donation Routing — moved to donationRouting.js (imported at top)

// Phase 7: Positive feedback — handled by AI parser via intake._positiveFeedback

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

// ---------------------------------------------------------------------------
// Pre-Purchase Sizing — recommends sizes for customers who haven't ordered yet
// ---------------------------------------------------------------------------

async function prescribePrePurchaseSizing(intake, context) {
  const items = [];
  const still_needed = [];
  const audit = [];
  const useInches = context.isNorthAmerica !== false;
  const isThirdParty = intake.buying_for === 'third_party';
  const thirdPartyLabel = intake.third_party_label || 'child';

  // If no products specified, ask which product
  if (intake.items.length === 0) {
    still_needed.push('which product');
    items.push({
      state: 'NEEDS_PRODUCT',
      response_text: buildProductListText(),
    });
    audit.push('No product specified — asking');
    return { items, still_needed, audit };
  }

  for (const intakeItem of intake.items) {
    const product = intakeItem.product;
    const nick = getProductNickname(product) || product;
    const cat = classifyProduct(product);
    const isTop = cat === 'underwear_top' || cat === 'swim_top';
    const isOnepiece = cat === 'onepiece';

    // Determine kid vs adult
    const isKidContext = isThirdParty && KID_LABELS.has(thirdPartyLabel);
    let isKids;
    if (intake.measurement) {
      const waistVal = intake.measurement.value;
      const waistUnit = intake.measurement.unit;
      const waistInches = waistUnit === 'cm' ? waistVal / 2.54 : waistVal;
      // Also consider height — over 5'2" (62") is likely adult
      const heightInches = intake.height_measurement
        ? (intake.height_measurement.unit === 'cm' ? intake.height_measurement.value / 2.54 : intake.height_measurement.value)
        : null;
      if (heightInches && heightInches >= 62) isKids = false; // 5'2"+ = adult regardless
      else if (waistInches < 28) isKids = true;
      else if (waistInches >= 32) isKids = false;
      else isKids = isKidContext; // 28-32" overlap — use context
    } else {
      isKids = isKidContext;
    }

    // Determine which measurement we need
    const needsHeight = isOnepiece;
    const measureBodyPart = isTop ? 'chest' : 'waist';
    const measureLocation = getMeasureLocation(measureBodyPart);
    const thirdPartyPrefix = isThirdParty ? `your ${thirdPartyLabel}'s ` : '';

    // Check if we have the needed measurement
    const hasMeasurement = measureBodyPart === 'chest'
      ? intake.measurement?.body_part === 'chest'
      : intake.measurement;
    const hasHeight = intake.height_measurement;

    if (!hasMeasurement) {
      // Check for reference size from another product ("I wear size 8 in the AJ")
      const ref = intake._referenceSize;
      if (ref && ref.size) {
        const refNick = getProductNickname(ref.product) || ref.product;
        const refCat = classifyProduct(ref.product);
        const targetCat = cat;
        const refIsBottom = !refCat || refCat.includes('bottom') || refCat === 'onepiece';
        const targetIsBottom = !targetCat || targetCat.includes('bottom') || targetCat === 'onepiece';
        const sameBodyGroup = (refIsBottom && targetIsBottom) || (!refIsBottom && !targetIsBottom);

        if (sameBodyGroup) {
          // Check if target product has odd sizes (swim) while reference doesn't (underwear) or vice versa
          const refSizes = getSizeList(ref.size, ref.product);
          const targetSizes = getSizeList(ref.size, product);
          const targetHasOddSizes = targetSizes && targetSizes.some(s => ['7', '9', '11', '13'].includes(s));
          const refHasOddSizes = refSizes && refSizes.some(s => ['7', '9', '11', '13'].includes(s));

          if (targetHasOddSizes && !refHasOddSizes) {
            // Target has odd sizes that reference doesn't — mention half-size options
            const refSize = normalizeSize(ref.size);
            const sizeIdx = targetSizes?.indexOf(refSize) ?? -1;
            const options = [];
            if (sizeIdx > 0) {
              const smaller = targetSizes[sizeIdx - 1];
              const delta = getCumulativeDelta(refSize, smaller);
              if (delta) options.push(`${smaller} which has ${formatMeasurementDisplay(delta.inches, 'inches')} less fabric around the waist`);
            }
            if (sizeIdx >= 0 && sizeIdx < (targetSizes?.length || 0) - 1) {
              const larger = targetSizes[sizeIdx + 1];
              const delta = getCumulativeDelta(refSize, larger);
              if (delta) options.push(`${larger} which has ${formatMeasurementDisplay(delta.inches, 'inches')} more fabric around the waist`);
            }
            const measureRef = isThirdParty ? `your ${thirdPartyLabel}'s` : 'your';
            let text = `Our sizing is consistent across bottoms, so the ${refSize} in the ${nick} would be the same fit as ${measureRef} ${refNick}.`;
            if (options.length > 0) {
              text += ` The ${nick} also comes in half sizes — there's a ${options.join(', or a ')} if you'd like to go slightly smaller or larger.`;
            }
            items.push({ state: 'SIZE_RECOMMENDATION', product: nick, recommendedSize: refSize, response_text: text });
            audit.push(`${nick}: reference ${refNick} ${refSize} → same size, odd sizes available: ${options.length}`);
            continue;
          } else {
            // Same size system — straightforward
            const measureRef = isThirdParty ? `your ${thirdPartyLabel}'s` : 'your';
            const bodyLabel = targetIsBottom ? 'bottoms' : 'tops';
            items.push({
              state: 'SIZE_RECOMMENDATION', product: nick, recommendedSize: normalizeSize(ref.size),
              response_text: `Our sizing is consistent across ${bodyLabel}, so the ${normalizeSize(ref.size)} in the ${nick} should be the same fit as ${measureRef} ${refNick}.`,
            });
            audit.push(`${nick}: reference ${refNick} ${ref.size} → same size system, consistent`);
            continue;
          }
        }
      }

      const heightAsk = needsHeight ? ' and height' : '';
      still_needed.push(`${measureBodyPart} measurement for ${nick}`);
      items.push({
        state: 'NEEDS_MEASUREMENT',
        product: nick,
        response_text: `If you send me ${thirdPartyPrefix}the measurement ${measureLocation}${heightAsk} I can recommend the right size for the ${nick}.`,
      });
      audit.push(`${nick}: no measurement — asking for ${measureBodyPart}${needsHeight ? ' + height' : ''}`);
      continue;
    }

    if (needsHeight && !hasHeight) {
      still_needed.push(`height for ${nick}`);
      items.push({
        state: 'NEEDS_MEASUREMENT',
        product: nick,
        response_text: `For the one-piece, if you also send me ${thirdPartyPrefix}height I can recommend the right size and whether Regular or Tall would work best.`,
      });
      audit.push(`${nick}: have waist but need height for one-piece`);
      continue;
    }

    // Look up size from measurement
    const m = intake.measurement;
    const { chartCategory, measureType } = getChartCategory(product, isKids);
    const mUnit = m.unit === 'cm' ? 'cm' : 'inches';

    try {
      const supabase = getSupabaseClient();
      const { data: sizeMatches } = await supabase.rpc('find_size_by_measurement', {
        p_chart_category: chartCategory,
        p_measurement_type: measureType,
        p_value: m.value,
        p_unit: mUnit,
      });

      if (sizeMatches && sizeMatches.length > 0) {
        const recommendedSize = sizeMatches[0].size_label;
        const mDisplay = formatMeasurementDisplay(m.value, mUnit);
        const measureRef = isThirdParty ? `your ${thirdPartyLabel}'s` : 'your';

        // For one-piece with height, do full fit analysis
        if (needsHeight && hasHeight) {
          const h = intake.height_measurement;
          const heightInInches = h.unit === 'cm' ? h.value / 2.54 : h.value;
          try {
            const fit = await analyzeOnepieceFit(chartCategory, recommendedSize, heightInInches, product, useInches);
            if (fit.type === 'exact') {
              items.push({
                state: 'SIZE_RECOMMENDATION', product: nick, recommendedSize: fit.size, variant: fit.variant,
                response_text: `Based on ${measureRef} measurements, I'd recommend a size ${fit.size} ${fit.variant} for the ${nick}.`,
              });
              audit.push(`${nick}: waist ${m.value} ${mUnit} → ${fit.size}, height → ${fit.variant}`);
            } else if (fit.type === 'wiggle') {
              items.push({
                state: 'SIZE_RECOMMENDATION', product: nick, recommendedSize: fit.size, variant: fit.variant,
                response_text: `Based on ${measureRef} measurements, I'd recommend a size ${fit.size} ${fit.variant} for the ${nick}. The waist will have ${fit.unit} ${fit.moreOrLess} fabric compared to the ${fit.waistSize}, but there's some wiggle room in the bottoms so it should work well.`,
              });
              audit.push(`${nick}: waist → ${fit.waistSize}, height → ${fit.size} ${fit.variant} (wiggle room)`);
            } else if (fit.type === 'separates') {
              items.push({
                state: 'SUGGEST_SEPARATES', product: nick,
                response_text: getSeparatesText('mismatch', measureRef),
              });
              audit.push(`${nick}: waist → ${fit.waistSize}, height → ${fit.heightSize} ${fit.variant} (${fit.sizeDiff} sizes apart) — suggesting separates`);
            } else {
              items.push({
                state: 'SUGGEST_SEPARATES', product: nick,
                response_text: getSeparatesText('height_outside', measureRef),
              });
              audit.push(`${nick}: height outside chart ranges — suggesting separates`);
            }
          } catch (e) {
            // Fallback — just recommend waist size without variant
            items.push({
              state: 'SIZE_RECOMMENDATION', product: nick, recommendedSize, variant: null,
              response_text: `Based on ${measureRef} measurement of ${mDisplay}, I'd recommend a size ${recommendedSize} for the ${nick}.`,
            });
            audit.push(`${nick}: ${m.value} ${mUnit} → ${recommendedSize} (height check failed: ${e.message})`);
          }
        } else {
          items.push({
            state: 'SIZE_RECOMMENDATION', product: nick, recommendedSize, variant: null,
            response_text: `Based on ${measureRef} measurement of ${mDisplay}, I'd recommend a size ${recommendedSize} for the ${nick}.`,
          });
          audit.push(`${nick}: ${m.value} ${mUnit} in ${chartCategory} → ${recommendedSize}`);
        }
      } else {
        // No match — try alternate chart (kids↔adult)
        const altChartCategory = isKids
          ? chartCategory.replace('kids_', 'adult_')
          : chartCategory.replace('adult_', 'kids_');
        const { data: altMatches } = await supabase.rpc('find_size_by_measurement', {
          p_chart_category: altChartCategory,
          p_measurement_type: measureType,
          p_value: m.value,
          p_unit: mUnit,
        });
        if (altMatches?.length) {
          const altSize = altMatches[0].size_label;
          const mDisplay = formatMeasurementDisplay(m.value, mUnit);
          const measureRef = isThirdParty ? `your ${thirdPartyLabel}'s` : 'your';
          const agePrefix = isKids ? `${thirdPartyPrefix ? 'They would' : 'You would'} be in our adult sizing — ` : '';

          // For one-piece, run height analysis on the alt chart too
          if (needsHeight && hasHeight) {
            const h = intake.height_measurement;
            const heightInInches = h.unit === 'cm' ? h.value / 2.54 : h.value;
            try {
              const fit = await analyzeOnepieceFit(altChartCategory, altSize, heightInInches, product, useInches);
              if (fit.type === 'exact') {
                items.push({ state: 'SIZE_RECOMMENDATION', product: nick, recommendedSize: fit.size, variant: fit.variant,
                  response_text: `${agePrefix}Based on ${measureRef} measurements, I'd recommend a size ${fit.size} ${fit.variant} for the ${nick}.` });
              } else if (fit.type === 'wiggle') {
                items.push({ state: 'SIZE_RECOMMENDATION', product: nick, recommendedSize: fit.size, variant: fit.variant,
                  response_text: `${agePrefix}Based on ${measureRef} measurements, I'd recommend a size ${fit.size} ${fit.variant} for the ${nick}. The waist will have ${fit.unit} ${fit.moreOrLess} fabric compared to the ${fit.waistSize}, but there's some wiggle room.` });
              } else if (fit.type === 'separates') {
                items.push({ state: 'SUGGEST_SEPARATES', product: nick,
                  response_text: getSeparatesText('mismatch', measureRef) });
              } else {
                items.push({ state: 'SUGGEST_SEPARATES', product: nick,
                  response_text: getSeparatesText('height_outside', measureRef) });
              }
              audit.push(`${nick}: ${m.value} ${mUnit} in ${altChartCategory} → ${altSize}, height analysis: ${fit.type}`);
            } catch (e) {
              items.push({ state: 'SIZE_RECOMMENDATION', product: nick, recommendedSize: altSize,
                response_text: `${agePrefix}Based on ${measureRef} measurement of ${mDisplay}, I'd recommend a size ${altSize} for the ${nick}.` });
              audit.push(`${nick}: ${m.value} ${mUnit} in ${altChartCategory} → ${altSize} (height check failed)`);
            }
          } else {
            items.push({
              state: 'SIZE_RECOMMENDATION', product: nick, recommendedSize: altSize,
              response_text: `${agePrefix}Based on ${measureRef} measurement of ${mDisplay}, I'd recommend a size ${altSize} for the ${nick}.`,
            });
            audit.push(`${nick}: ${m.value} ${mUnit} not in ${chartCategory}, found in ${altChartCategory} → ${altSize}`);
          }
        } else {
          items.push({
            state: 'SIZE_UNCLEAR',
            product: nick,
            response_text: `I wasn't able to find an exact size match for ${m.value} ${mUnit} in the ${nick}. Could you double check the measurement ${measureLocation}?`,
          });
          audit.push(`${nick}: ${m.value} ${mUnit} — no match in ${chartCategory} or ${altChartCategory}`);
          still_needed.push(`measurement confirmation for ${nick}`);
        }
      }
    } catch (e) {
      items.push({
        state: 'SIZE_UNCLEAR',
        product: nick,
        response_text: `I'd recommend checking our size guide for the ${nick} — https://rubyshines.com/pages/size-guide`,
      });
      audit.push(`${nick}: measurement lookup failed (${e.message})`);
    }
  }

  return { items, still_needed, audit };
}

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

  // Phase 0: Safety override (AI parser detects via intake._safety_concern)
  if (intake._safety_concern) {
    result.status = 'safety_override';
    result.response_parts.push({ type: 'action', priority: 0, text: 'Safety concern detected. Process immediate refund, no questions asked.' });
    result.audit.push('[Phase 0] Safety override — AI parser detected safety concern');
    return result;
  }
  result.phases_completed.push('safety_check');

  // Pre-purchase sizing — skip order/item phases, go straight to sizing
  if (context.isPrePurchase) {
    // Phase 1 still runs for name/pronoun detection
    const phase1 = prescribeCustomerIdentification(intake, context);
    result.audit.push(...phase1.audit.map(a => `[Phase 1] ${a}`));
    result.phases_completed.push('identify_customer');

    const prePurchase = await prescribePrePurchaseSizing(intake, context);
    result.response_parts.push(...prePurchase.items.map(a => ({
      type: 'item_action', priority: 4, product: a.product,
      text: a.response_text, state: a.state, options: a.options || null,
      recommendation: a.recommendedSize || null,
    })));
    result.audit.push(...prePurchase.audit.map(a => `[Pre-purchase] ${a}`));
    result.still_needed.push(...prePurchase.still_needed);
    result.phases_completed.push('pre_purchase_sizing');
    result.status = prePurchase.still_needed.length === 0 ? 'ready' : 'needs_info';
    return result;
  }

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

    // Phase 4: Sizing resolution. Availability is resolved here, at the async
    // boundary, and handed down so the prescription itself stays synchronous
    // and pure.
    const availability = await resolveStyleSwitchAvailability(phase3.items);
    const phase4 = await prescribeSizingResolution(phase3.items, intake, context, { availability });
    for (const item of phase4.items) {
      if (item.response_text || item.self_diagnosed) {
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
          self_diagnosed: item.self_diagnosed || false,
        });
      }
      // Add measurement note as separate response part (fires even when item is auto-confirmed)
      if (item._measurement_note) {
        result.response_parts.push({
          type: 'measurement_note',
          priority: 3, // before delta — sets context
          text: item._measurement_note,
          product: item.product,
        });
      }
      // Add delta FYI as separate response part (fires even when item is auto-confirmed)
      if (item._delta_aside) {
        result.response_parts.push({
          type: 'delta_aside',
          priority: 4,
          text: item._delta_aside,
          product: item.product,
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
  // An item is "confirmed" if it has a resolved size (exchange), is a defect (replacement), or was refund-confirmed
  const refundConfirmedProducts = new Set(
    result.response_parts.filter(p => p.type === 'item_action' && p.state === 'REFUND_CONFIRMED').map(p => p.product)
  );
  const allConfirmed = intake.items.length > 0 && intake.items.every(i =>
    i.resolved_size || i.issue === 'defect' || refundConfirmedProducts.has(i.product)
  );
  // Hold order creation if multi-item flags are pending — wait for customer to respond
  // about the other items before creating the order
  const hasMultiItemFlags = result.response_parts.some(p => p.type === 'multi_item_flag');
  const multiItemAnswered = intake._multiItemAnswered || false;
  if (allConfirmed && (!hasMultiItemFlags || multiItemAnswered)) {
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

  // Phase 7: Positive feedback (detected by AI parser, not deterministic matching)
  if (intake._positiveFeedback) {
    result.response_parts.push({ type: 'positive_feedback', priority: 7, text: 'Acknowledge kind words' });
    result.audit.push(`[Phase 7] Positive feedback detected by AI parser`);
  }

  // Determine overall status
  if (result.still_needed.length === 0 && allConfirmed && (!hasMultiItemFlags || multiItemAnswered)) {
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
  // Product nicknames
  getProductNickname,
  getProductUrl,
  pluralizeNickname,
  PRODUCT_NICKNAMES,
  // Product classification
  classifyProduct,
  PRODUCT_CATEGORIES,
  // Size utilities (shared)
  normalizeSize,
  getSizeList,
  getAdjacentSizes,
  getGradingDelta,
  formatDelta,
  getCumulativeDelta,
  getIntermediateSizes,
  parseSizeVariant,
  getSizeModifier,
  getChartCategory,
  formatMeasurementDisplay,
  getMeasureLocation,
  // Live path: the advisor's analyze_onepiece_fit tool destructures these —
  // they were missing from exports, so the tool threw TypeError when invoked.
  analyzeOnepieceFit,
  getSeparatesText,
  KID_LABELS,
  prescribePrePurchaseSizing,
  // Config-driven products (populated by initCsConfig)
  initCsConfig,
  PRODUCT_SIZE_OVERRIDES,
  _activeProducts,
  KEYWORD_MATCH_COUNT,
};
