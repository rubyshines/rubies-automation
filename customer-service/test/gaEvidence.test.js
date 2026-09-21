const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { readGaEvidence, describeGaEvidence } = require('../../b2b-outreach/lib/gaEvidence');
const { vetRank, SPECIALIST_SUBCATEGORIES } = require('../../b2b-outreach/lib/queueService');

// Real sentences from the 2026-09-11 discovery import. The point of the
// module is that it agrees with what a human reading the catalog concluded,
// so the fixtures are the profiles those decisions were made against.
const PINK_PUSSYCAT = 'Notably, they have dedicated sections for gender-affirming products including a "Gender Affirmation" category, "Pride & Gender" collection, and specific items like binders, packers, gaffs, padding, and breast forms/bras/garments.';
const JACK_AND_JILL = 'The store specializes in a comprehensive inventory of adult products including vibrators, dildos, anal toys, BDSM equipment, lingerie, and notably carries a dedicated "Transgender Products" category.';
const DOGHOUSE = 'Their clothing inventory includes underwear (jockstraps, briefs, thongs, union suits), binders, tops, bottoms, and accessories. While they carry binders (a gender-affirming product), there is no explicit messaging about trans inclusivity on their website.';
const BIRDIES = 'Birdies is an independently-owned lingerie boutique located in Kansas City, Missouri. The store explicitly welcomes all individuals and offers accommodations for those who need assistance.';

describe('readGaEvidence', () => {
  it('names the products a profile says the store stocks', () => {
    const ev = readGaEvidence(PINK_PUSSYCAT);
    assert.equal(ev.level, 'stocks');
    assert.deepEqual(ev.femme.sort(), ['breast forms', 'gaffs']);
    assert.deepEqual(ev.masc.sort(), ['binders', 'packers']);
    assert.equal(ev.quote, PINK_PUSSYCAT);
  });

  it('separates what we sell from what only proves they serve trans customers', () => {
    const ev = readGaEvidence(DOGHOUSE);
    assert.equal(ev.level, 'stocks');
    assert.deepEqual(ev.femme, []);
    assert.deepEqual(ev.masc, ['binders']);
  });

  it('a "Transgender Products" category is not a named product', () => {
    // The row a human dropped after finding the category was all sex toys.
    // A category name is a claim; a gaff is a product.
    const ev = readGaEvidence(JACK_AND_JILL);
    assert.equal(ev.level, 'audience');
    assert.deepEqual(ev.terms, []);
  });

  it('a welcoming lingerie boutique with no trans signal reads as none', () => {
    assert.equal(readGaEvidence(BIRDIES).level, 'none');
  });

  it('a product named inside a sentence about missing trans messaging still counts', () => {
    // Both negated sentences in the corpus negate the MESSAGING, never the
    // stock, so a blanket negation guard would demote two real stores.
    const ev = readGaEvidence('While they carry tucking and trans-related products, there is no explicit mission statement about gender-affirming retail.');
    assert.equal(ev.level, 'stocks');
    assert.deepEqual(ev.terms, ['tucking']);
  });

  it('quotes the sentence the product came from, not the first sentence', () => {
    const ev = readGaEvidence('The store opened in 1997 near the airport. They stock gaffs and breast forms.');
    assert.equal(ev.quote, 'They stock gaffs and breast forms.');
  });

  it('is empty and safe on missing or blank input', () => {
    for (const input of [null, undefined, '', '   ']) {
      const ev = readGaEvidence(input);
      assert.equal(ev.level, 'none');
      assert.deepEqual(ev.terms, []);
      assert.equal(ev.quote, null);
    }
  });

  it('describes each level in one line', () => {
    assert.equal(describeGaEvidence(readGaEvidence(PINK_PUSSYCAT)), 'stocks gaffs, breast forms, binders, packers');
    assert.equal(describeGaEvidence(readGaEvidence(JACK_AND_JILL)), 'speaks to trans customers, no product named');
    assert.equal(describeGaEvidence(readGaEvidence(BIRDIES)), 'no gender-affirming evidence');
    assert.equal(describeGaEvidence(null), 'no gender-affirming evidence');
  });
});

describe('vetRank', () => {
  const row = (level, subcategory, score) => ({
    ga_evidence: { level, femme: [], masc: [], terms: [], quote: null },
    discovery: { score, subcategory },
  });

  it('puts named stock above a specialist shop above everything else', () => {
    assert.equal(vetRank(row('stocks', 'adult-retail', 5)), 0);
    assert.equal(vetRank(row('audience', 'gender-affirming-boutique', 5)), 1);
    assert.equal(vetRank(row('audience', 'adult-retail', 10)), 2);
    assert.equal(vetRank(row('none', 'general-boutique', 10)), 2);
  });

  it('beats score: a score-5 store stocking gaffs outranks a score-10 boutique', () => {
    assert.ok(vetRank(row('stocks', 'adult-retail', 5)) < vetRank(row('none', 'general-boutique', 10)));
  });

  it('survives a row with no evidence or discovery block', () => {
    assert.equal(vetRank({}), 2);
    assert.equal(vetRank({ ga_evidence: null, discovery: null }), 2);
  });

  it('treats both specialist subcategories as the audience being the business', () => {
    for (const sub of SPECIALIST_SUBCATEGORIES) assert.equal(vetRank(row('none', sub, 1)), 1);
  });
});
