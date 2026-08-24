/**
 * Sizing Engine — Product classification, sizing helpers, and size calculations.
 *
 * Product utilities: nicknames, categories, size lists, grading deltas, one-piece fit.
 * Loaded from Supabase via initCsConfig() at server startup.
 *
 * This file used to also carry walkTree() and the prescribe*() phase functions — the
 * deterministic decision tree that decided CS replies before the advisor moved to Opus
 * plus real tools. That tree stopped being called and was deleted 2026-08-24; git
 * history has it. What remains is only what the live path uses.
 */

const { getSupabaseClient } = require('../../shared/supabaseClient');
const {
  NUMERIC_SIZES, NUMERIC_EVEN, NUMERIC_FULL,
  LETTER_SIZES, LETTER_NO_PLUS, LETTER_WITH_PLUS,
  ODD_HALF_SIZES, CHEST_PAD_SIZES,
  parseSizeVariant, normalizeSize, getSizeModifier,
  formatMeasurementDisplay,
} = require('./sizeUtils');

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

module.exports = {
  // Product nicknames
  getProductNickname,
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
  parseSizeVariant,
  getSizeModifier,
  getChartCategory,
  formatMeasurementDisplay,
  // Live path: the advisor's analyze_onepiece_fit tool destructures these —
  // they were missing from exports, so the tool threw TypeError when invoked.
  analyzeOnepieceFit,
  getSeparatesText,
  KID_LABELS,
  // Config-driven products (populated by initCsConfig)
  initCsConfig,
  PRODUCT_SIZE_OVERRIDES,
  _activeProducts,
  KEYWORD_MATCH_COUNT,
};
