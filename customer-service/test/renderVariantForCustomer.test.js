/**
 * Unit tests for productCache.renderVariantForCustomer / formatVariantReference.
 *
 * The helper renders a customer-friendly product reference from a SKU. These
 * tests exercise formatVariantReference (the pure function) directly with
 * synthetic product/variant shapes — no Supabase or cache state required.
 *
 * Run: node --test customer-service/test/renderVariantForCustomer.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { _formatVariantReferenceForTesting: format } = require('../lib/productCache');

describe('formatVariantReference — short name from handle', () => {
  it('drops a leading "the-" segment', () => {
    const out = format(
      { handle: 'the-sassy-no-tuck-shaping-underwear', title: 'THE SASSY NO-TUCK SHAPING UNDERWEAR' },
      { title: 'Sandstone / S' }
    );
    assert.equal(out, 'the Sassy in Sandstone, size S');
  });

  it('handles handles without a leading "the-"', () => {
    const out = format(
      { handle: 'magical-shaping-chest-pads', title: 'Magical Shaping Chest Pads' },
      { title: 'M' }
    );
    assert.equal(out, 'the Magical, size M');
  });

  it('keeps short acronyms uppercase (e.g. AJ)', () => {
    const out = format(
      { handle: 'the-aj-shaping-underwear', title: 'THE AJ NO-TUCK SHAPING UNDERWEAR' },
      { title: 'Black / 2X' }
    );
    assert.equal(out, 'the AJ in Black, size 2X');
  });

  it('title-cases longer names (e.g. NAOMI -> Naomi)', () => {
    const out = format(
      { handle: 'the-naomi-gaff-extra-strength-shaping-underwear', title: 'THE NAOMI GAFF...' },
      { title: 'Black / 2X' }
    );
    assert.equal(out, 'the Naomi in Black, size 2X');
  });

  it('falls back to product title when handle is missing', () => {
    const out = format(
      { handle: '', title: 'Some Product' },
      { title: 'Black / S' }
    );
    assert.equal(out, 'the Some Product in Black, size S');
  });
});

describe('formatVariantReference — variant title parsing', () => {
  it('parses "Color / Size" format', () => {
    const out = format(
      { handle: 'the-aj-shaping-underwear' },
      { title: 'Black / S' }
    );
    assert.equal(out, 'the AJ in Black, size S');
  });

  it('parses size-only variant title', () => {
    const out = format(
      { handle: 'magical-shaping-chest-pads' },
      { title: 'L' }
    );
    assert.equal(out, 'the Magical, size L');
  });

  it('preserves multi-token sizes like "2X Tall"', () => {
    const out = format(
      { handle: 'the-sky-shaping-one-piece' },
      { title: 'Black / 2X Tall' }
    );
    assert.equal(out, 'the Sky in Black, size 2X Tall');
  });

  it('handles three-segment variants by joining trailing parts as size', () => {
    const out = format(
      { handle: 'the-aj-shaping-underwear' },
      { title: 'Black / Tall / M' }
    );
    assert.equal(out, 'the AJ in Black, size Tall / M');
  });

  it('falls back to bare product name when variant has "Default Title"', () => {
    const out = format(
      { handle: 'progress-pride-flag' },
      { title: 'Default Title' }
    );
    assert.equal(out, 'the Progress');
  });

  it('falls back to bare product name when variant title is missing', () => {
    const out = format(
      { handle: 'progress-pride-flag' },
      { title: '' }
    );
    assert.equal(out, 'the Progress');
  });

  it('trims whitespace in color and size segments', () => {
    const out = format(
      { handle: 'the-ruby-no-tuck-shaping-bikini-bottom' },
      { title: '  Black  /  L  ' }
    );
    assert.equal(out, 'the Ruby in Black, size L');
  });
});
