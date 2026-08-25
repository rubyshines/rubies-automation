/**
 * Unit tests for productCache.renderVariantForCustomer / formatVariantReference.
 *
 * The helper renders a customer-friendly product reference from a SKU. These
 * tests exercise formatVariantReference (the pure function) directly with
 * synthetic product/variant shapes — no Supabase or cache state required.
 *
 * The `nickname` field is the curated short name loaded from
 * `product_cs_config.nickname` by loadFromSupabase. The handle is deliberately
 * NOT a naming input: every product below carries a handle whose first segment
 * is not its name, which is the ordinary case in this catalog, not an edge one.
 *
 * Run: node --test customer-service/test/renderVariantForCustomer.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { _formatVariantReferenceForTesting: format } = require('../lib/productCache');

describe('formatVariantReference — short name', () => {
  it('uses the curated nickname', () => {
    const out = format(
      { handle: 'the-sassy-no-tuck-shaping-underwear', title: 'THE SASSY NO-TUCK SHAPING UNDERWEAR', nickname: 'Sassy' },
      { title: 'Sandstone / S' }
    );
    assert.equal(out, 'the Sassy in Sandstone, size S');
  });

  it('keeps short acronyms as curated (e.g. AJ)', () => {
    const out = format(
      { handle: 'the-aj-shaping-underwear', title: 'THE AJ NO-TUCK SHAPING UNDERWEAR', nickname: 'AJ' },
      { title: 'Black / 2X' }
    );
    assert.equal(out, 'the AJ in Black, size 2X');
  });

  it('keeps multi-word nicknames intact', () => {
    const out = format(
      { handle: 'magical-shaping-chest-pads', title: 'MAGICAL SHAPING CHEST PADS', nickname: 'Magical Chest Pads' },
      { title: 'M' }
    );
    assert.equal(out, 'the Magical Chest Pads, size M');
  });

  // The regression this file exists for. Each of these handles' first non-"the"
  // segment is a real English word that reads as a plausible product name, so a
  // handle-derived name is wrong in the way nobody notices: "the Shaping in
  // Black, size M" went out to a customer for a product called the Serena.
  it('never derives the name from the handle', () => {
    const cases = [
      // [handle, nickname, wrong name the old handle rule produced]
      ['the-shaping-shorty-shorts', 'Serena', 'Shaping'],
      ['the-extra-cute-shaping-underwear', 'Charlie', 'Extra'],
      ['high-waisted-shaping-bikini-bottom', 'Stella', 'High'],
      ['notuck-shaping-underwear', 'No-Tuck Underwear', 'Notuck'],
      ['rubies-bikini-set', 'Bikini Set', 'Rubies'],
      ['progress-pride-flag', 'Pride Flag', 'Progress'],
    ];
    for (const [handle, nickname, wrong] of cases) {
      const out = format({ handle, title: 'IRRELEVANT', nickname }, { title: 'Black / M' });
      assert.equal(out, `the ${nickname} in Black, size M`, `handle ${handle}`);
      assert.ok(!out.includes(wrong), `${handle} rendered the handle-derived name "${wrong}"`);
    }
  });

  // Three products share the "rubies-" prefix and three share "progress-", so
  // the old rule could not even tell them apart — it named all six with two
  // strings. A naming rule that collapses distinct products is worse than a
  // verbose one.
  it('distinguishes products that share a handle prefix', () => {
    const rendered = [
      ['rubies-bikini-set', 'Bikini Set'],
      ['rubies-matching-underwear-set', 'Matching Set'],
      ['rubies-shaping-bundle', 'Shaping Bundle'],
    ].map(([handle, nickname]) => format({ handle, title: 'X', nickname }, { title: 'Default Title' }));
    assert.equal(new Set(rendered).size, 3, `collapsed to: ${rendered.join(' | ')}`);
  });

  it('falls back to the product title when there is no curated nickname', () => {
    const out = format(
      { handle: 'rubies-gift-card', title: 'RUBIES Gift Card', nickname: null },
      { title: 'Black / S' }
    );
    assert.equal(out, 'the RUBIES Gift Card in Black, size S');
  });

  it('strips a leading THE from the title fallback', () => {
    const out = format(
      { handle: 'whatever-slug', title: 'THE SOME PRODUCT', nickname: null },
      { title: 'Black / S' }
    );
    assert.equal(out, 'the SOME PRODUCT in Black, size S');
  });
});

describe('formatVariantReference — variant title parsing', () => {
  const AJ = { handle: 'the-aj-shaping-underwear', title: 'THE AJ', nickname: 'AJ' };

  it('parses "Color / Size" format', () => {
    assert.equal(format(AJ, { title: 'Black / S' }), 'the AJ in Black, size S');
  });

  it('parses size-only variant title', () => {
    const pads = { handle: 'magical-shaping-chest-pads', title: 'MAGICAL', nickname: 'Magical Chest Pads' };
    assert.equal(format(pads, { title: 'L' }), 'the Magical Chest Pads, size L');
  });

  it('preserves multi-token sizes like "2X Tall"', () => {
    const sky = { handle: 'the-sky-shaping-one-piece', title: 'THE SKY', nickname: 'Sky' };
    assert.equal(format(sky, { title: 'Black / 2X Tall' }), 'the Sky in Black, size 2X Tall');
  });

  it('handles three-segment variants by joining trailing parts as size', () => {
    assert.equal(format(AJ, { title: 'Black / Tall / M' }), 'the AJ in Black, size Tall / M');
  });

  it('falls back to bare product name when variant has "Default Title"', () => {
    const flag = { handle: 'progress-pride-flag', title: 'PROGRESS PRIDE FLAG', nickname: 'Pride Flag' };
    assert.equal(format(flag, { title: 'Default Title' }), 'the Pride Flag');
  });

  it('falls back to bare product name when variant title is missing', () => {
    const flag = { handle: 'progress-pride-flag', title: 'PROGRESS PRIDE FLAG', nickname: 'Pride Flag' };
    assert.equal(format(flag, { title: '' }), 'the Pride Flag');
  });

  it('trims whitespace in color and size segments', () => {
    const ruby = { handle: 'the-ruby-no-tuck-shaping-bikini-bottom', title: 'THE RUBY', nickname: 'Ruby' };
    assert.equal(format(ruby, { title: '  Black  /  L  ' }), 'the Ruby in Black, size L');
  });
});
