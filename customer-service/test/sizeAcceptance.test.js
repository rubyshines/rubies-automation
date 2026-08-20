/**
 * sizeAcceptance — categorizing garment sizes and reading partner size answers.
 *
 * The boundary under test is kids 11 / kids 12: size 12 is the same waist
 * measurement as adult XS (25.5-26.5"), so 12 and everything above it belongs
 * with the adult sizes, and 11 and below belongs with the kids sizes.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  SMALLER,
  LARGER,
  SMALLER_LABEL,
  LARGER_LABEL,
  categorizeSize,
  categorizeSku,
  shipmentSizeCategories,
  partnerAcceptsCategories,
  parseSizeAcceptance,
  formatSizeAcceptance,
} = require('../lib/sizeAcceptance');

describe('categorizeSize', () => {
  test('kids 4 through 11 are smaller', () => {
    for (const s of ['4', '6', '7', '8', '9', '10', '11']) {
      assert.strictEqual(categorizeSize(s), SMALLER, `size ${s}`);
    }
  });

  test('kids 12 through 16 are larger — 12 is where the adult scale starts', () => {
    for (const s of ['12', '13', '14', '16']) {
      assert.strictEqual(categorizeSize(s), LARGER, `size ${s}`);
    }
  });

  test('every adult letter size is larger, including XXS', () => {
    // XXS is dimensionally a kids 10, but only adult-only product lines
    // (Cheeky, Ava, Sassy, Evey) offer it, so an XXS garment is an adult
    // garment for a small adult.
    for (const s of ['XXS', 'XXS+', 'XS', 'XS+', 'S', 'M', 'L', '1X', '2X', '3X', '4X']) {
      assert.strictEqual(categorizeSize(s), LARGER, `size ${s}`);
    }
  });

  test('normalizes aliases and modifiers before categorizing', () => {
    assert.strictEqual(categorizeSize('XL'), LARGER);   // → 1X
    assert.strictEqual(categorizeSize('2XL'), LARGER);  // → 2X
    assert.strictEqual(categorizeSize('L Tall'), LARGER);
    assert.strictEqual(categorizeSize('small'), LARGER);
    assert.strictEqual(categorizeSize('xs'), LARGER);
  });

  test('returns null for anything that is not a RUBIES size', () => {
    for (const s of [null, undefined, '', 'One Size', '99', 'blue', '3']) {
      assert.strictEqual(categorizeSize(s), null, `input ${JSON.stringify(s)}`);
    }
  });
});

describe('categorizeSku', () => {
  test('reads the size off the last SKU segment', () => {
    assert.strictEqual(categorizeSku('RJL-PNK-8'), SMALLER);
    assert.strictEqual(categorizeSku('UNW-PNK-L'), LARGER);
    assert.strictEqual(categorizeSku('MIA-BLK-XL'), LARGER); // XL spells the 1X
    assert.strictEqual(categorizeSku(null), null);
  });
});

describe('shipmentSizeCategories', () => {
  test('collapses a mixed box to the distinct categories present', () => {
    const cats = shipmentSizeCategories(['6', '8', 'L']);
    assert.deepStrictEqual([...cats].sort(), [LARGER, SMALLER]);
  });

  test('drops unrecognized sizes rather than guessing a category', () => {
    const cats = shipmentSizeCategories(['8', 'One Size', null]);
    assert.deepStrictEqual([...cats], [SMALLER]);
  });

  test('no sizes yields an empty set, not a default', () => {
    assert.strictEqual(shipmentSizeCategories([]).size, 0);
    assert.strictEqual(shipmentSizeCategories(undefined).size, 0);
  });
});

describe('partnerAcceptsCategories', () => {
  const both = { accepts_smaller_sizes: true, accepts_larger_sizes: true };
  const adultsOnly = { accepts_smaller_sizes: false, accepts_larger_sizes: true };
  const kidsOnly = { accepts_smaller_sizes: true, accepts_larger_sizes: false };

  test('a partner must accept every category in the box', () => {
    const mixed = shipmentSizeCategories(['6', 'L']);
    assert.strictEqual(partnerAcceptsCategories(both, mixed), true);
    assert.strictEqual(partnerAcceptsCategories(adultsOnly, mixed), false);
    assert.strictEqual(partnerAcceptsCategories(kidsOnly, mixed), false);
  });

  test('single-category boxes match the partner that serves them', () => {
    const kids = shipmentSizeCategories(['6']);
    const adult = shipmentSizeCategories(['L']);
    assert.strictEqual(partnerAcceptsCategories(adultsOnly, kids), false);
    assert.strictEqual(partnerAcceptsCategories(adultsOnly, adult), true);
    assert.strictEqual(partnerAcceptsCategories(kidsOnly, kids), true);
    assert.strictEqual(partnerAcceptsCategories(kidsOnly, adult), false);
  });

  test('unknown sizes leave every partner eligible', () => {
    // The filter must never empty the country just because we could not read
    // a size — that would silently downgrade a real routing to "donate locally".
    const none = shipmentSizeCategories([]);
    assert.strictEqual(partnerAcceptsCategories(adultsOnly, none), true);
    assert.strictEqual(partnerAcceptsCategories(kidsOnly, none), true);
  });
});

describe('parseSizeAcceptance', () => {
  test('reads the current form options', () => {
    assert.deepStrictEqual(parseSizeAcceptance(SMALLER_LABEL),
      { accepts_smaller_sizes: true, accepts_larger_sizes: false });
    assert.deepStrictEqual(parseSizeAcceptance(LARGER_LABEL),
      { accepts_smaller_sizes: false, accepts_larger_sizes: true });
    assert.deepStrictEqual(parseSizeAcceptance(`${SMALLER_LABEL}, ${LARGER_LABEL}`),
      { accepts_smaller_sizes: true, accepts_larger_sizes: true });
  });

  test('both current labels survive being joined, despite containing commas', () => {
    // The larger label has its own comma ("12-16, XXS-4X"), so a naive split
    // on "," would shred it. Guarding the substring match instead.
    const joined = `${SMALLER_LABEL}, ${LARGER_LABEL}`;
    assert.ok(joined.split(',').length > 2, 'fixture should contain the tricky comma');
    assert.deepStrictEqual(parseSizeAcceptance(joined),
      { accepts_smaller_sizes: true, accepts_larger_sizes: true });
  });

  describe('legacy survey answers still in the sheet', () => {
    test('the full three-box answer maps to both', () => {
      assert.deepStrictEqual(
        parseSizeAcceptance('Youth sizes 4-8, Youth sizes 10-16, Adult sizes XS - 4X'),
        { accepts_smaller_sizes: true, accepts_larger_sizes: true });
    });

    test('"Youth 10-16 + Adult" maps to larger only', () => {
      // Overlaps the smaller category at exactly one size (10) and the org
      // declined 4-8, so we read it as teen-and-adult. Decided 2026-08-20.
      assert.deepStrictEqual(
        parseSizeAcceptance('Youth sizes 10-16, Adult sizes XS - 4X'),
        { accepts_smaller_sizes: false, accepts_larger_sizes: true });
    });

    test('adult-only maps to larger only', () => {
      assert.deepStrictEqual(parseSizeAcceptance('Adult sizes XS - 4X'),
        { accepts_smaller_sizes: false, accepts_larger_sizes: true });
    });

    test('"All sizes" maps to both', () => {
      assert.deepStrictEqual(parseSizeAcceptance('All sizes'),
        { accepts_smaller_sizes: true, accepts_larger_sizes: true });
    });
  });

  test('blank or missing answers accept nothing, so they surface rather than defaulting', () => {
    for (const input of [null, undefined, '', '   ']) {
      assert.deepStrictEqual(parseSizeAcceptance(input),
        { accepts_smaller_sizes: false, accepts_larger_sizes: false });
    }
  });
});

describe('formatSizeAcceptance', () => {
  test('renders each combination for the website and console', () => {
    assert.strictEqual(
      formatSizeAcceptance({ accepts_smaller_sizes: true, accepts_larger_sizes: true }),
      'Kids sizes 4-11, teen and adult sizes 12-16, XXS-4X');
    assert.strictEqual(
      formatSizeAcceptance({ accepts_smaller_sizes: true, accepts_larger_sizes: false }),
      SMALLER_LABEL);
    assert.strictEqual(
      formatSizeAcceptance({ accepts_smaller_sizes: false, accepts_larger_sizes: true }),
      LARGER_LABEL);
    assert.strictEqual(
      formatSizeAcceptance({ accepts_smaller_sizes: false, accepts_larger_sizes: false }), '');
  });

  test('round-trips through the parser', () => {
    for (const partner of [
      { accepts_smaller_sizes: true, accepts_larger_sizes: true },
      { accepts_smaller_sizes: true, accepts_larger_sizes: false },
      { accepts_smaller_sizes: false, accepts_larger_sizes: true },
    ]) {
      assert.deepStrictEqual(parseSizeAcceptance(formatSizeAcceptance(partner)), partner);
    }
  });

  test('tolerates a null partner', () => {
    assert.strictEqual(formatSizeAcceptance(null), '');
  });
});
