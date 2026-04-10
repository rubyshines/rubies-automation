const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  NUMERIC_SIZES, NUMERIC_EVEN, NUMERIC_FULL,
  LETTER_SIZES, LETTER_NO_PLUS, LETTER_WITH_PLUS,
  SIZE_ALIASES, TALL_ALIASES, NUMERIC_TO_LETTER, NUMERIC_TO_LETTER_UPPER,
  ODD_HALF_SIZES, CHEST_PAD_SIZES, CHEST_PAD_MAP,
  KNOWN_SIZES, KNOWN_SIZES_UPPER,
  parseSizeVariant, normalizeSize, normalizeSizeLower, getSizeModifier,
  extractSizeFromSku,
  getVariantSize, getVariantColor,
  formatMeasurementDisplay,
} = require('../lib/sizeUtils');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('Size constants', () => {
  it('NUMERIC_SIZES has 11 entries (4-16 including odd)', () => {
    assert.equal(NUMERIC_SIZES.length, 11);
    assert.ok(NUMERIC_SIZES.includes('7'));
    assert.ok(NUMERIC_SIZES.includes('13'));
  });

  it('NUMERIC_EVEN has 7 entries (4-16 even only)', () => {
    assert.equal(NUMERIC_EVEN.length, 7);
    assert.ok(!NUMERIC_EVEN.includes('7'));
    assert.ok(!NUMERIC_EVEN.includes('9'));
  });

  it('NUMERIC_FULL is the same array as NUMERIC_SIZES', () => {
    assert.equal(NUMERIC_FULL, NUMERIC_SIZES);
  });

  it('LETTER_SIZES includes plus sizes', () => {
    assert.ok(LETTER_SIZES.includes('XXS+'));
    assert.ok(LETTER_SIZES.includes('XS+'));
  });

  it('LETTER_NO_PLUS excludes plus sizes', () => {
    assert.ok(!LETTER_NO_PLUS.includes('XXS+'));
    assert.ok(!LETTER_NO_PLUS.includes('XS+'));
  });

  it('LETTER_WITH_PLUS is the same as LETTER_SIZES', () => {
    assert.equal(LETTER_WITH_PLUS, LETTER_SIZES);
  });

  it('SIZE_ALIASES maps XL family to numbered X sizes', () => {
    assert.equal(SIZE_ALIASES['XL'], '1X');
    assert.equal(SIZE_ALIASES['XXL'], '2X');
    assert.equal(SIZE_ALIASES['2XL'], '2X');
    assert.equal(SIZE_ALIASES['3XL'], '3X');
    assert.equal(SIZE_ALIASES['4XL'], '4X');
    assert.equal(SIZE_ALIASES['5XL'], '5X');
  });

  it('SIZE_ALIASES maps barcode format (XS1→XS+, XXS1→XXS+)', () => {
    assert.equal(SIZE_ALIASES['XS1'], 'XS+');
    assert.equal(SIZE_ALIASES['XXS1'], 'XXS+');
  });

  it('TALL_ALIASES maps SKU suffixes to tall labels', () => {
    assert.equal(TALL_ALIASES['st'], 's tall');
    assert.equal(TALL_ALIASES['lt'], 'l tall');
    assert.equal(TALL_ALIASES['xlt'], '1x tall');
    assert.equal(TALL_ALIASES['2xlt'], '2x tall');
  });

  it('NUMERIC_TO_LETTER maps youth sizes to adult equivalents (lowercase)', () => {
    assert.equal(NUMERIC_TO_LETTER['10'], 'xxs');
    assert.equal(NUMERIC_TO_LETTER['11'], 'xxs+');
    assert.equal(NUMERIC_TO_LETTER['12'], 'xs');
    assert.equal(NUMERIC_TO_LETTER['16'], 'm');
  });

  it('NUMERIC_TO_LETTER_UPPER maps youth sizes to adult equivalents (uppercase)', () => {
    assert.equal(NUMERIC_TO_LETTER_UPPER['10'], 'XXS');
    assert.equal(NUMERIC_TO_LETTER_UPPER['14'], 'S');
    assert.equal(NUMERIC_TO_LETTER_UPPER['16'], 'M');
  });

  it('ODD_HALF_SIZES contains half-step sizes', () => {
    assert.ok(ODD_HALF_SIZES.has('7'));
    assert.ok(ODD_HALF_SIZES.has('9'));
    assert.ok(ODD_HALF_SIZES.has('XXS+'));
    assert.ok(!ODD_HALF_SIZES.has('8'));
    assert.ok(!ODD_HALF_SIZES.has('S'));
  });

  it('CHEST_PAD_MAP covers all numeric + letter sizes', () => {
    assert.equal(CHEST_PAD_MAP['6'], 'S');
    assert.equal(CHEST_PAD_MAP['10'], 'S');
    assert.equal(CHEST_PAD_MAP['12'], 'M');
    assert.equal(CHEST_PAD_MAP['L'], 'M');
    assert.equal(CHEST_PAD_MAP['1X'], 'L');
    assert.equal(CHEST_PAD_MAP['4X'], 'L');
  });

  it('KNOWN_SIZES contains numeric, letter, aliases, and tall sizes (all lowercase)', () => {
    assert.ok(KNOWN_SIZES.has('4'));
    assert.ok(KNOWN_SIZES.has('xxs'));
    assert.ok(KNOWN_SIZES.has('xxs+'));
    assert.ok(KNOWN_SIZES.has('1x'));
    assert.ok(KNOWN_SIZES.has('xl'));    // alias
    assert.ok(KNOWN_SIZES.has('st'));    // tall SKU suffix
    assert.ok(KNOWN_SIZES.has('s tall'));  // tall display
  });

  it('KNOWN_SIZES_UPPER contains uppercase sizes for CSV parsing', () => {
    assert.ok(KNOWN_SIZES_UPPER.has('XXS'));
    assert.ok(KNOWN_SIZES_UPPER.has('XXS+'));
    assert.ok(KNOWN_SIZES_UPPER.has('1X'));
    assert.ok(KNOWN_SIZES_UPPER.has('XL'));
    assert.ok(KNOWN_SIZES_UPPER.has('4'));
    assert.ok(KNOWN_SIZES_UPPER.has('16'));
  });
});

// ---------------------------------------------------------------------------
// parseSizeVariant
// ---------------------------------------------------------------------------

describe('parseSizeVariant', () => {
  it('returns base + null modifier for plain sizes', () => {
    assert.deepEqual(parseSizeVariant('L'), { base: 'L', modifier: null });
    assert.deepEqual(parseSizeVariant('2X'), { base: '2X', modifier: null });
    assert.deepEqual(parseSizeVariant('10'), { base: '10', modifier: null });
  });

  it('parses coded tall suffixes (LT, MT)', () => {
    assert.deepEqual(parseSizeVariant('LT'), { base: 'L', modifier: 'Tall' });
    assert.deepEqual(parseSizeVariant('MT'), { base: 'M', modifier: 'Tall' });
    assert.deepEqual(parseSizeVariant('ST'), { base: 'S', modifier: 'Tall' });
  });

  it('parses spaced tall/regular modifiers', () => {
    assert.deepEqual(parseSizeVariant('L Tall'), { base: 'L', modifier: 'Tall' });
    assert.deepEqual(parseSizeVariant('M Regular'), { base: 'M', modifier: 'Regular' });
    assert.deepEqual(parseSizeVariant('2X Tall'), { base: '2X', modifier: 'Tall' });
  });

  it('treats "Long" as "Tall"', () => {
    assert.deepEqual(parseSizeVariant('L Long'), { base: 'L', modifier: 'Tall' });
  });

  it('is case-insensitive for modifiers', () => {
    assert.deepEqual(parseSizeVariant('l tall'), { base: 'L', modifier: 'Tall' });
    assert.deepEqual(parseSizeVariant('m TALL'), { base: 'M', modifier: 'Tall' });
  });

  it('returns null base for null/undefined/empty input', () => {
    assert.deepEqual(parseSizeVariant(null), { base: null, modifier: null });
    assert.deepEqual(parseSizeVariant(undefined), { base: null, modifier: null });
    assert.deepEqual(parseSizeVariant(''), { base: null, modifier: null });
  });
});

// ---------------------------------------------------------------------------
// normalizeSize
// ---------------------------------------------------------------------------

describe('normalizeSize', () => {
  it('returns uppercase canonical form', () => {
    assert.equal(normalizeSize('l'), 'L');
    assert.equal(normalizeSize('xs'), 'XS');
    assert.equal(normalizeSize('2x'), '2X');
  });

  it('applies SIZE_ALIASES', () => {
    assert.equal(normalizeSize('XL'), '1X');
    assert.equal(normalizeSize('xl'), '1X');
    assert.equal(normalizeSize('XXL'), '2X');
    assert.equal(normalizeSize('2XL'), '2X');
    assert.equal(normalizeSize('3XL'), '3X');
    assert.equal(normalizeSize('5XL'), '5X');
  });

  it('applies barcode aliases', () => {
    assert.equal(normalizeSize('XS1'), 'XS+');
    assert.equal(normalizeSize('XXS1'), 'XXS+');
  });

  it('strips tall modifiers', () => {
    assert.equal(normalizeSize('L Tall'), 'L');
    assert.equal(normalizeSize('LT'), 'L');
    assert.equal(normalizeSize('2X Tall'), '2X');
  });

  it('passes through numeric sizes unchanged', () => {
    assert.equal(normalizeSize('4'), '4');
    assert.equal(normalizeSize('10'), '10');
    assert.equal(normalizeSize('16'), '16');
  });

  it('returns null for null/undefined', () => {
    assert.equal(normalizeSize(null), null);
    assert.equal(normalizeSize(undefined), null);
    assert.equal(normalizeSize(''), null);
  });
});

// ---------------------------------------------------------------------------
// normalizeSizeLower
// ---------------------------------------------------------------------------

describe('normalizeSizeLower', () => {
  it('returns lowercase canonical form', () => {
    assert.equal(normalizeSizeLower('L'), 'l');
    assert.equal(normalizeSizeLower('XS'), 'xs');
    assert.equal(normalizeSizeLower('2X'), '2x');
  });

  it('applies SIZE_ALIASES in lowercase', () => {
    assert.equal(normalizeSizeLower('XL'), '1x');
    assert.equal(normalizeSizeLower('XXL'), '2x');
  });

  it('resolves tall SKU suffixes', () => {
    assert.equal(normalizeSizeLower('st'), 's tall');
    assert.equal(normalizeSizeLower('lt'), 'l tall');
    assert.equal(normalizeSizeLower('xlt'), '1x tall');
    assert.equal(normalizeSizeLower('2xlt'), '2x tall');
  });

  it('returns null for null/undefined', () => {
    assert.equal(normalizeSizeLower(null), null);
    assert.equal(normalizeSizeLower(undefined), null);
  });
});

// ---------------------------------------------------------------------------
// getSizeModifier
// ---------------------------------------------------------------------------

describe('getSizeModifier', () => {
  it('returns modifier for tall sizes', () => {
    assert.equal(getSizeModifier('L Tall'), 'Tall');
    assert.equal(getSizeModifier('LT'), 'Tall');
    assert.equal(getSizeModifier('M Regular'), 'Regular');
  });

  it('returns null for plain sizes', () => {
    assert.equal(getSizeModifier('L'), null);
    assert.equal(getSizeModifier('10'), null);
    assert.equal(getSizeModifier('2X'), null);
  });

  it('returns null for null', () => {
    assert.equal(getSizeModifier(null), null);
  });
});

// ---------------------------------------------------------------------------
// extractSizeFromSku
// ---------------------------------------------------------------------------

describe('extractSizeFromSku', () => {
  it('extracts and normalizes size from standard SKUs', () => {
    assert.deepEqual(extractSizeFromSku('UNW-PNK-L'), { raw: 'L', normalized: 'L' });
    assert.deepEqual(extractSizeFromSku('RJL-PNK-8'), { raw: '8', normalized: '8' });
    assert.deepEqual(extractSizeFromSku('AJ-SND-XL'), { raw: 'XL', normalized: '1X' });
    assert.deepEqual(extractSizeFromSku('SHS-BLK-2XL'), { raw: '2XL', normalized: '2X' });
  });

  it('returns nulls for null/undefined/empty SKU', () => {
    assert.deepEqual(extractSizeFromSku(null), { raw: null, normalized: null });
    assert.deepEqual(extractSizeFromSku(undefined), { raw: null, normalized: null });
    assert.deepEqual(extractSizeFromSku(''), { raw: null, normalized: null });
  });
});

// ---------------------------------------------------------------------------
// getVariantSize
// ---------------------------------------------------------------------------

describe('getVariantSize', () => {
  it('finds size from explicit "Size" option', () => {
    const variant = { selectedOptions: [{ name: 'Color', value: 'Black' }, { name: 'Size', value: '1X' }] };
    assert.equal(getVariantSize(variant), '1x');
  });

  it('finds size from "Youth Size" option', () => {
    const variant = { selectedOptions: [{ name: 'Color', value: 'Pink' }, { name: 'Youth Size', value: '10' }] };
    assert.equal(getVariantSize(variant), '10');
  });

  it('falls back to value matching when option names are generic', () => {
    const variant = { selectedOptions: [{ name: 'Option 1', value: 'Black' }, { name: 'Option 2', value: '1X' }] };
    assert.equal(getVariantSize(variant), '1x');
  });

  it('handles numeric sizes in generic options', () => {
    const variant = { selectedOptions: [{ name: 'Option 1', value: 'Sandstone' }, { name: 'Option 2', value: '12' }] };
    assert.equal(getVariantSize(variant), '12');
  });

  it('normalizes aliases in generic options (XL→1x)', () => {
    const variant = { selectedOptions: [{ name: 'Option 1', value: 'Pink' }, { name: 'Option 2', value: 'XL' }] };
    // "xl" is in KNOWN_SIZES so it matches, then normalizeSizeLower("xl") → "1x"
    const result = getVariantSize(variant);
    assert.equal(result, '1x');
  });

  it('returns null when no size option found', () => {
    const variant = { selectedOptions: [{ name: 'Title', value: 'Default Title' }] };
    assert.equal(getVariantSize(variant), null);
  });

  it('handles empty selectedOptions', () => {
    assert.equal(getVariantSize({}), null);
    assert.equal(getVariantSize({ selectedOptions: [] }), null);
  });
});

// ---------------------------------------------------------------------------
// getVariantColor
// ---------------------------------------------------------------------------

describe('getVariantColor', () => {
  it('finds color from explicit "Color" option', () => {
    const variant = { selectedOptions: [{ name: 'Color', value: 'Black' }, { name: 'Size', value: 'L' }] };
    assert.equal(getVariantColor(variant), 'black');
  });

  it('finds color from "Colour" option (British spelling)', () => {
    const variant = { selectedOptions: [{ name: 'Colour', value: 'Pink' }, { name: 'Size', value: 'M' }] };
    assert.equal(getVariantColor(variant), 'pink');
  });

  it('falls back to non-size option when names are generic', () => {
    const variant = { selectedOptions: [{ name: 'Option 1', value: 'Sandstone' }, { name: 'Option 2', value: '1X' }] };
    assert.equal(getVariantColor(variant), 'sandstone');
  });

  it('skips numeric values (not colors)', () => {
    const variant = { selectedOptions: [{ name: 'Option 1', value: '12' }, { name: 'Option 2', value: 'Pink' }] };
    // '12' is a known size AND a digit, so it's skipped; 'Pink' is not a size, but we should check
    // Actually '12' has /^\d+$/ match so it gets skipped, and 'pink' isn't a known size
    assert.equal(getVariantColor(variant), 'pink');
  });

  it('returns null when no color can be determined', () => {
    const variant = { selectedOptions: [{ name: 'Size', value: 'L' }] };
    assert.equal(getVariantColor(variant), null);
  });

  it('handles empty selectedOptions', () => {
    assert.equal(getVariantColor({}), null);
    assert.equal(getVariantColor({ selectedOptions: [] }), null);
  });
});

// ---------------------------------------------------------------------------
// formatMeasurementDisplay
// ---------------------------------------------------------------------------

describe('formatMeasurementDisplay', () => {
  it('formats inches with double-quote', () => {
    assert.equal(formatMeasurementDisplay(30, 'inches'), '30"');
  });

  it('formats centimeters with cm suffix', () => {
    assert.equal(formatMeasurementDisplay(58, 'cm'), '58 cm');
  });
});
