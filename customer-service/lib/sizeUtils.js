/**
 * sizeUtils.js — Single source of truth for RUBIES size constants, normalization,
 * SKU parsing, and variant option helpers.
 *
 * Imported by both decisionTree.js (sizing logic) and productCache.js (variant lookup).
 * Any size-related constant or utility should live here.
 */

// ---------------------------------------------------------------------------
// Size lists
// ---------------------------------------------------------------------------

const NUMERIC_SIZES = ['4', '6', '7', '8', '9', '10', '11', '12', '13', '14', '16'];
const NUMERIC_EVEN = ['4', '6', '8', '10', '12', '14', '16'];
const NUMERIC_FULL = NUMERIC_SIZES; // even + odd

const LETTER_SIZES = ['XXS', 'XXS+', 'XS', 'XS+', 'S', 'M', 'L', '1X', '2X', '3X', '4X'];
const LETTER_NO_PLUS = ['XXS', 'XS', 'S', 'M', 'L', '1X', '2X', '3X', '4X'];
const LETTER_WITH_PLUS = LETTER_SIZES;

// ---------------------------------------------------------------------------
// Aliases & mappings
// ---------------------------------------------------------------------------

/** Canonical alias map — keys are UPPERCASE. Use via normalizeSize(). */
const SIZE_ALIASES = {
  'XL': '1X', 'XXL': '2X', '2XL': '2X', '3XL': '3X', '4XL': '4X', '5XL': '5X',
  'XS1': 'XS+', 'XXS1': 'XXS+',  // SKU barcode format: + replaced with 1
  // Word-form aliases (e.g. free-text wholesale input "Brooke Black Small")
  'SMALL': 'S', 'MEDIUM': 'M', 'LARGE': 'L', 'XLARGE': '1X', 'XXLARGE': '2X',
};

/** Tall size SKU suffixes → canonical tall size labels (lowercase for variant matching). */
const TALL_ALIASES = {
  'st': 's tall', 'mt': 'm tall', 'lt': 'l tall',
  'xlt': '1x tall', '2xlt': '2x tall', '3xlt': '3x tall',
};

/** Youth numeric → adult letter equivalent (lowercase). */
const NUMERIC_TO_LETTER = {
  '10': 'xxs', '11': 'xxs+', '12': 'xs', '13': 'xs+', '14': 's', '16': 'm',
};

/** Uppercase version of NUMERIC_TO_LETTER for decision tree / display contexts. */
const NUMERIC_TO_LETTER_UPPER = {
  '10': 'XXS', '11': 'XXS+', '12': 'XS', '13': 'XS+', '14': 'S', '16': 'M',
};

/** Half-size steps: 1" per step instead of 2". */
const ODD_HALF_SIZES = new Set(['7', '9', '11', '13', 'XXS+', 'XS+']);

/** Chest pad sizing: maps bra/top size → chest pad size (S/M/L). */
const CHEST_PAD_SIZES = ['S', 'M', 'L'];
const CHEST_PAD_MAP = {
  // Youth numeric → pad size
  '6': 'S', '7': 'S', '8': 'S', '9': 'S', '10': 'S',
  '11': 'M', '12': 'M', '13': 'M', '14': 'M', '16': 'M',
  // Adult letter → pad size
  'XXS': 'S', 'XXS+': 'S',
  'XS': 'M', 'XS+': 'M', 'S': 'M', 'M': 'M', 'L': 'M',
  '1X': 'L', '2X': 'L', '3X': 'L', '4X': 'L',
};

// ---------------------------------------------------------------------------
// KNOWN_SIZES — comprehensive set for tokenization & variant matching (lowercase)
// ---------------------------------------------------------------------------

const KNOWN_SIZES = new Set([
  // Numeric
  '4', '6', '7', '8', '9', '10', '11', '12', '13', '14', '16',
  // Letter (lowercase canonical)
  'xxs', 'xxs+', 'xs', 'xs+', 's', 'm', 'l', '1x', '2x', '3x', '4x', '5x',
  // Common aliases (so we recognize them as size tokens before normalizing)
  'xl', 'xxl', '2xl', '3xl', '4xl', '5xl',
  // Word-form aliases (free-text inputs like "Brooke Black Small")
  'small', 'medium', 'large', 'xlarge', 'xxlarge',
  // Tall SKU suffixes
  'st', 'mt', 'lt', 'xlt', '2xlt', '3xlt',
  // Tall display values
  's tall', 'm tall', 'l tall', '1x tall', '2x tall', '3x tall',
]);

/** Uppercase version of KNOWN_SIZES for wholesale CSV parsing. */
const KNOWN_SIZES_UPPER = new Set([
  'XXS', 'XXS+', 'XS', 'XS+', 'S', 'M', 'L', 'XL', 'XXL',
  '1X', '2X', '3X', '4X', '5X',
  '2XL', '3XL', '4XL', '5XL',
  '4', '6', '7', '8', '9', '10', '11', '12', '13', '14', '16',
]);

// ---------------------------------------------------------------------------
// Size parsing & normalization
// ---------------------------------------------------------------------------

/**
 * Parse a size string into base size + variant modifier.
 * "L Tall" → { base: "L", modifier: "Tall" }
 * "LT"    → { base: "L", modifier: "Tall" }
 * "M"     → { base: "M", modifier: null }
 */
function parseSizeVariant(size) {
  if (!size) return { base: null, modifier: null };
  const s = size.toString().trim();
  // Match coded patterns like "LT", "MT", "2XT" (letter T suffix on known sizes)
  const codedMatch = s.match(/^(\d{0,1}X?[SMLX]{0,2}\+?)T$/i);
  if (codedMatch) {
    const base = codedMatch[1].toUpperCase();
    const normalized = SIZE_ALIASES[base] || base;
    if (LETTER_SIZES.includes(normalized) || NUMERIC_SIZES.includes(normalized)) {
      return { base: normalized, modifier: 'Tall' };
    }
  }
  // Match "L Tall", "M Regular", "2X Tall", "L Long", etc.
  const spaceMatch = s.match(/^(.+?)\s+(Tall|Regular|Long)$/i);
  if (spaceMatch) {
    let modifier = spaceMatch[2].charAt(0).toUpperCase() + spaceMatch[2].slice(1).toLowerCase();
    if (modifier === 'Long') modifier = 'Tall';
    return { base: spaceMatch[1].trim().toUpperCase(), modifier };
  }
  return { base: s, modifier: null };
}

/**
 * Normalize a size to its canonical uppercase form.
 * Strips modifiers (Tall/Regular), applies aliases (XL→1X, 2XL→2X, etc.)
 * Returns null for falsy input.
 */
function normalizeSize(size) {
  if (!size) return null;
  const { base } = parseSizeVariant(size);
  if (!base) return null;
  const s = base.toUpperCase();
  return SIZE_ALIASES[s] || s;
}

/**
 * Lowercase normalizer for variant matching contexts (productCache, search).
 * "XL" → "1x", "2XL" → "2x", "ST" → "s tall"
 */
function normalizeSizeLower(s) {
  if (!s) return null;
  const lower = s.toLowerCase().trim();
  // Check tall aliases first (only relevant for lowercase/SKU contexts)
  if (TALL_ALIASES[lower]) return TALL_ALIASES[lower];
  // Standard aliases
  const upper = normalizeSize(s);
  return upper ? upper.toLowerCase() : lower;
}

/**
 * Extract the variant modifier (Tall/Regular) from a size string.
 * Returns null if no modifier present.
 */
function getSizeModifier(size) {
  if (!size) return null;
  return parseSizeVariant(size).modifier;
}

// ---------------------------------------------------------------------------
// SKU parsing
// ---------------------------------------------------------------------------

/**
 * Extract and normalize the size from a SKU's last segment.
 * "UNW-PNK-L" → "L", "RJL-PNK-8" → "8", "AJ-SND-XL" → "1X"
 * Returns { raw, normalized } or { raw: null, normalized: null } if no SKU.
 */
function extractSizeFromSku(sku) {
  if (!sku) return { raw: null, normalized: null };
  const raw = sku.split('-').pop();
  return { raw, normalized: normalizeSize(raw) };
}

// ---------------------------------------------------------------------------
// Variant option helpers
// ---------------------------------------------------------------------------

/**
 * Extract the size from a Shopify variant's selectedOptions array.
 * Tries explicit "Size"/"Youth Size" option name first, then falls back to
 * matching option values against KNOWN_SIZES (handles "Option 1"/"Option 2" naming).
 * Returns lowercase normalized size string or null.
 */
function getVariantSize(variant) {
  const opts = variant.selectedOptions || [];
  // Explicit "Size" or "Youth Size" option name
  const sizeOpt = opts.find(o => o.name.toLowerCase().includes('size'));
  if (sizeOpt) return normalizeSizeLower(sizeOpt.value);
  // Fallback: find option whose value is a known size
  for (const o of opts) {
    const val = o.value.toLowerCase().trim();
    if (KNOWN_SIZES.has(val) || KNOWN_SIZES.has(normalizeSizeLower(val))) {
      return normalizeSizeLower(val);
    }
  }
  return null;
}

/**
 * Extract the color from a Shopify variant's selectedOptions array.
 * Tries explicit "Color"/"Colour" option name first, then falls back to
 * the option that isn't the size (handles "Option 1"/"Option 2" naming).
 * Returns lowercase color string or null.
 */
function getVariantColor(variant) {
  const opts = variant.selectedOptions || [];
  // Explicit "Color" or "Colour" option name
  const colorOpt = opts.find(o =>
    o.name.toLowerCase() === 'color' || o.name.toLowerCase() === 'colour'
  );
  if (colorOpt) return colorOpt.value.toLowerCase().trim();
  // Fallback: the option that ISN'T the size
  for (const o of opts) {
    const val = o.value.toLowerCase().trim();
    if (!KNOWN_SIZES.has(val) && !KNOWN_SIZES.has(normalizeSizeLower(val)) && !/^\d+$/.test(val)) {
      return val;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/**
 * Format a measurement value for display. 30 inches → '30"', 58 cm → '58 cm'
 */
function formatMeasurementDisplay(value, unit) {
  return unit === 'cm' ? `${value} cm` : `${value}"`;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Size lists
  NUMERIC_SIZES,
  NUMERIC_EVEN,
  NUMERIC_FULL,
  LETTER_SIZES,
  LETTER_NO_PLUS,
  LETTER_WITH_PLUS,

  // Aliases & mappings
  SIZE_ALIASES,
  TALL_ALIASES,
  NUMERIC_TO_LETTER,
  NUMERIC_TO_LETTER_UPPER,
  ODD_HALF_SIZES,
  CHEST_PAD_SIZES,
  CHEST_PAD_MAP,
  KNOWN_SIZES,
  KNOWN_SIZES_UPPER,

  // Parsing & normalization
  parseSizeVariant,
  normalizeSize,
  normalizeSizeLower,
  getSizeModifier,

  // SKU parsing
  extractSizeFromSku,

  // Variant option helpers
  getVariantSize,
  getVariantColor,

  // Display helpers
  formatMeasurementDisplay,
};
