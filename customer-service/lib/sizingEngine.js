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
const TITLE_TO_HANDLE = {};  // Shopify product title (upper) → handle for exact lookups
/** handle → { youth: [...], adult: [...] } — the catalog's size range, canonically ordered. */
const PRODUCT_SIZES = {};
let _activeProducts = {};
/** keyword -> how many catalog titles contain it. Lower is more specific. */
const KEYWORD_MATCH_COUNT = {};

/**
 * Load product CS config from Supabase product_cs_config table.
 * Must be called once at server startup before any exchange operations.
 * Populates PRODUCT_NICKNAMES, PRODUCT_CATEGORIES, PRODUCT_SIZES.
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
  for (const k of Object.keys(TITLE_TO_HANDLE)) delete TITLE_TO_HANDLE[k];
  for (const k of Object.keys(PRODUCT_SIZES)) delete PRODUCT_SIZES[k];
  for (const k of Object.keys(KEYWORD_MATCH_COUNT)) delete KEYWORD_MATCH_COUNT[k];
  for (const k of Object.keys(_activeProducts)) delete _activeProducts[k];

  // Build title → handle map from products table for exact product resolution,
  // and the per-product size range in the same pass.
  //
  // The size range is the catalog's, not a copy: kid_sizes/adult_sizes are
  // Shopify metafields synced by syncProducts.js, and compare_products already
  // reads them. getSizeList was the one place that didn't, so it fell back to a
  // generic run and offered sizes products are not made in. Loading them here
  // keeps getSizeList synchronous — initCsConfig is already the async boundary
  // and already re-runs on the products webhook, the daily sync and
  // reload_products, so the range refreshes with the catalog.
  const { data: products } = await supabase.from('products').select('title, handle, kid_sizes, adult_sizes');
  if (products) {
    for (const p of products) {
      if (!p.handle) continue;
      if (p.title) TITLE_TO_HANDLE[p.title.toUpperCase()] = p.handle;
      // Canonical order, because adjacency is positional and a metafield array
      // is not guaranteed to be sorted.
      const youth = NUMERIC_SIZES.filter(s => (p.kid_sizes || []).map(normalizeSize).includes(s));
      const adult = LETTER_SIZES.filter(s => (p.adult_sizes || []).map(normalizeSize).includes(s));
      if (youth.length || adult.length) PRODUCT_SIZES[p.handle] = { youth, adult };
    }
  }

  for (const row of data) {
    _activeProducts[row.product_handle] = {
      nickname: row.nickname,
      category: row.category,
      keywords: row.keywords,
      deltaWording: row.delta_wording,
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
 * Product name (exact title, nickname, or customer free text) → catalog handle.
 *
 * Same resolution order as getProductNickname: exact title wins, then the most
 * SPECIFIC matching keyword. Specificity rather than length, for the reason
 * recorded on KEYWORD_MATCH_COUNT — "no-tuck" is in most titles and must never
 * beat "ruby".
 *
 * Returns null when nothing matches, and callers treat that as "no catalog data"
 * rather than "no sizes".
 */
function resolveHandle(productName) {
  if (!productName) return null;
  const upper = String(productName).toUpperCase();
  if (TITLE_TO_HANDLE[upper]) return TITLE_TO_HANDLE[upper];

  const lower = upper.toLowerCase();
  const matches = Object.entries(_activeProducts)
    .filter(([, cfg]) => (cfg.keywords || []).some(kw => lower.includes(kw.toLowerCase())))
    .map(([handle, cfg]) => {
      const best = (cfg.keywords || [])
        .filter(kw => lower.includes(kw.toLowerCase()))
        .sort((a, b) => (KEYWORD_MATCH_COUNT[a] || 1) - (KEYWORD_MATCH_COUNT[b] || 1) || b.length - a.length)[0];
      return { handle, count: KEYWORD_MATCH_COUNT[best] || 1, len: best?.length || 0 };
    })
    .sort((a, b) => a.count - b.count || b.len - a.len);
  return matches.length ? matches[0].handle : null;
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
 *
 * Searches the waist size first, then outward through the WHOLE size list nearest
 * first. It used to stop at ±1, which made `analyzeOnepieceFit`'s `separates`
 * branch unreachable — that branch needs a match two or more sizes away, and the
 * search could never return one. Everything past ±1 fell through to
 * `height_outside_range`, whose customer-facing message says "height is outside
 * our chart ranges".
 *
 * That message was frequently FALSE, and wrong in the least forgivable
 * direction. The adult chart bands barely move with size (XS-L Regular 62-66,
 * S-L Tall 66-70, 1X-3X Regular 66-69 and Tall 69-73), so the gap is entirely at
 * the ends of the range: a 2X customer at 63" was told her height was outside our
 * charts when 63" sits squarely in the Regular band two sizes down, and the same
 * held for XXS/XS at Tall heights. 24 of 90 waist-by-height combinations returned
 * that false statement, all of them at the size extremes — the customers most
 * likely to read "outside our range" as "they don't make anything for me".
 *
 * With the full search, distance decides the answer in analyzeOnepieceFit: same
 * size is exact, one away is wiggle, two or more is separates, and no match
 * anywhere is the only case that is genuinely outside our charts.
 *
 * At equal distance the SMALLER size wins, which is what the ±1 version did
 * (it pushed idx-1 before idx+1); preserved deliberately so no existing wiggle
 * answer changes.
 *
 * @param {string} chartCategory - e.g. 'adult_onepiece'
 * @param {string} waistSize - recommended waist size label
 * @param {number} heightInInches - customer height in inches
 * @param {string} productName - for getSizeList adjacency
 * @returns {Promise<{variant: string|null, size: string}>}
 */
async function lookupHeightVariant(chartCategory, waistSize, heightInInches, productName) {
  const supabase = getSupabaseClient();
  // One query for the whole chart rather than one per size. Searching the full
  // list a size at a time would have meant up to ten sequential round trips on a
  // tool the advisor calls mid-conversation; a height chart is ~14 rows, so
  // fetching it whole and matching in memory is both faster and simpler than the
  // two-query version this replaces.
  const { data: rows } = await supabase
    .from('size_charts')
    .select('size_label, notes, min_inches, max_inches')
    .eq('chart_category', chartCategory)
    .eq('measurement_type', 'height');

  const fits = (e) => e && heightInInches >= e.min_inches && heightInInches <= e.max_inches;
  // Tall is checked before Regular at each size, as it always has been.
  const variantAt = (size) => {
    const at = (rows || []).filter(e => e.size_label === size);
    if (fits(at.find(e => e.notes === 'Tall'))) return 'Tall';
    if (fits(at.find(e => e.notes === 'Regular'))) return 'Regular';
    return null;
  };

  const own = variantAt(waistSize);
  if (own) return { variant: own, size: waistSize };

  // Then outward through the rest of the list, nearest first, smaller side first
  // at equal distance (what the old ±1 version did — preserved so no existing
  // wiggle answer changes).
  const waistList = getSizeList(waistSize, productName);
  const waistIdx = waistList?.indexOf(waistSize) ?? -1;
  if (waistIdx >= 0 && waistList) {
    for (let d = 1; d < waistList.length; d++) {
      for (const idx of [waistIdx - d, waistIdx + d]) {
        if (idx < 0 || idx >= waistList.length) continue;
        const variant = variantAt(waistList[idx]);
        if (variant) return { variant, size: waistList[idx] };
      }
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

  // The product's OWN range, from the catalog. Single source of truth: these are
  // the Shopify kid_sizes/adult_sizes metafields synced into Supabase, which is
  // also what compare_products reads, so the advisor's two answers to "what
  // sizes does this come in" cannot disagree. The youth and adult runs are held
  // separately rather than concatenated — joined end to end they make youth 16
  // the size below adult XS, and a step down from XS walks out of adult sizing.
  //
  // Falls through to the generic run when the catalog has nothing for this
  // product: tests and cold start have no products table, and an accessory has
  // no size axis. A missing range must degrade to the old behaviour, never to
  // "no sizes at all".
  const handle = resolveHandle(productName);
  const range = handle ? PRODUCT_SIZES[handle] : null;
  if (range) {
    const wantsAdult = LETTER_SIZES.includes(s);
    const own = wantsAdult ? range.adult : range.youth;
    if (own.length) return own.includes(s) ? own : null;
    // Empty run on a product that HAS the other one is a fact, not a gap: the
    // Naomi is adult-only, so there is no youth Naomi to size anyone into.
    // Falling through here would hand back a generic youth list and let the
    // advisor offer one. A product with neither run has no PRODUCT_SIZES entry
    // at all and never reaches this branch.
    if ((wantsAdult ? range.youth : range.adult).length) return null;
  }

  const category = productName ? classifyProduct(productName) : null;

  // An accessory has no size axis. Without this a pin or a pair of earrings
  // falls through to a garment run, because its SKU's trailing segment happens
  // to parse as a size ("S" on the earrings, "3" on the pins).
  if (category === 'accessory') return null;

  // Chest pads fall back to S, M, L when the catalog has no range for them.
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
  PRODUCT_SIZES,
  resolveHandle,
  _activeProducts,
  KEYWORD_MATCH_COUNT,
};
