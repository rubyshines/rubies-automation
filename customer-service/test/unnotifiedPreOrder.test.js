/**
 * Unit tests for reports/lib/unnotifiedPreOrder.js — swap-alternative picking.
 *
 * Focus: pickAlternativesViaCompare tier precedence — youth/adult equivalent
 * size in the customer's own color (tier 0) beats sibling colors (tier 1)
 * beats other products (tier 2).
 *
 * Run: node --test customer-service/test/unnotifiedPreOrder.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// ---------------------------------------------------------------------------
// Stub heavy deps BEFORE requiring the module under test
// ---------------------------------------------------------------------------

function stubModule(resolvedPath, exports) {
  require.cache[resolvedPath] = {
    id: resolvedPath,
    filename: resolvedPath,
    loaded: true,
    exports,
  };
}

// Fixture catalog keyed by SKU — mirrors the MIA shape (Color + Youth Size options).
const VARIANTS = {
  'MIA-BLK-S': {
    productTitle: 'MIA HALTER BIKINI TOP',
    options: [{ name: 'Color', value: 'Black' }, { name: 'Youth Size', value: 'S' }],
  },
  'MIA-BLK-16': {
    productTitle: 'MIA HALTER BIKINI TOP',
    options: [{ name: 'Color', value: 'Black' }, { name: 'Youth Size', value: '16' }],
  },
  'MIA-BLK-L': {
    productTitle: 'MIA HALTER BIKINI TOP',
    options: [{ name: 'Color', value: 'Black' }, { name: 'Youth Size', value: 'L' }],
  },
};

// Per-test compare_products responses keyed by requested size, plus a call log.
let compareResponses = {};
let compareCalls = [];

stubModule(require.resolve('../lib/aiAdvisor'), {
  executeToolCall: async (tool, input) => {
    assert.equal(tool, 'compare_products');
    compareCalls.push(input);
    const resp = compareResponses[input.size];
    if (resp instanceof Error) throw resp;
    return resp || { source: { available_colors: [] }, alternatives: [] };
  },
});

stubModule(require.resolve('../lib/productCache'), {
  getVariantBySku: sku => VARIANTS[sku] || null,
  renderVariantForCustomer: () => null,
  loadFromSupabase: async () => {},
});

stubModule(require.resolve('../lib/sizingEngine'), {
  initCsConfig: async () => {},
  getProductNickname: () => 'Mia',
});

stubModule(require.resolve('../../shared/supabaseClient'), {
  getSupabaseClient: () => ({}),
});

stubModule(require.resolve('../lib/customerOutreach'), {
  seedOutboundDraft: async () => ({ ok: true }),
});

stubModule(path.resolve(__dirname, '../../reports/lib/warehanceClient.js'), {
  fetchOrderByNumber: async () => null,
});

const { pickAlternativesViaCompare } = require('../../reports/lib/unnotifiedPreOrder');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('pickAlternativesViaCompare', () => {
  beforeEach(() => {
    compareResponses = {};
    compareCalls = [];
  });

  it('offers the youth equivalent in the ordered color first (adult S → youth 14)', async () => {
    compareResponses['14'] = {
      source: { available_colors: [{ color: 'Black', inventory: 72 }, { color: 'Pink', inventory: 67 }] },
      alternatives: [],
    };
    compareResponses['S'] = {
      source: { available_colors: [{ color: 'Pink', inventory: 25 }] },
      alternatives: [{ product: 'Queeny' }],
    };
    const alts = await pickAlternativesViaCompare('MIA-BLK-S');
    assert.deepEqual(alts, [
      'the Mia in Black, size 14 (our youth size with the same fit as S)',
      'the Mia in Pink, size S',
    ]);
    assert.deepEqual(compareCalls, [
      { product: 'Mia', size: '14' },
      { product: 'Mia', size: 'S' },
    ]);
  });

  it('offers the adult equivalent for a youth leak (youth 16 → adult M)', async () => {
    compareResponses['M'] = {
      source: { available_colors: [{ color: 'Black', inventory: 16 }] },
      alternatives: [],
    };
    compareResponses['16'] = {
      source: { available_colors: [] },
      alternatives: [{ product: 'Queeny' }],
    };
    const alts = await pickAlternativesViaCompare('MIA-BLK-16');
    assert.deepEqual(alts, [
      'the Mia in Black, size M (our adult size with the same fit as 16)',
      'the Queeny, size 16',
    ]);
  });

  it('skips tier 0 when the size has no youth/adult equivalent (size L)', async () => {
    compareResponses['L'] = {
      source: { available_colors: [{ color: 'Pink', inventory: 5 }] },
      alternatives: [{ product: 'Queeny' }],
    };
    const alts = await pickAlternativesViaCompare('MIA-BLK-L');
    assert.deepEqual(alts, ['the Mia in Pink, size L', 'the Queeny, size L']);
    // Only the same-size lookup should have run — no equivalent-size call.
    assert.deepEqual(compareCalls, [{ product: 'Mia', size: 'L' }]);
  });

  it('falls through to same-size tiers when the equivalent is OOS in the ordered color', async () => {
    compareResponses['14'] = {
      source: { available_colors: [{ color: 'Pink', inventory: 67 }] }, // no Black
      alternatives: [],
    };
    compareResponses['S'] = {
      source: { available_colors: [{ color: 'Pink', inventory: 25 }] },
      alternatives: [{ product: 'Queeny' }],
    };
    const alts = await pickAlternativesViaCompare('MIA-BLK-S');
    assert.deepEqual(alts, ['the Mia in Pink, size S', 'the Queeny, size S']);
  });

  it('survives a tier-0 lookup failure and still returns same-size tiers', async () => {
    compareResponses['14'] = new Error('boom');
    compareResponses['S'] = {
      source: { available_colors: [{ color: 'Pink', inventory: 25 }] },
      alternatives: [],
    };
    const alts = await pickAlternativesViaCompare('MIA-BLK-S');
    assert.deepEqual(alts, ['the Mia in Pink, size S']);
  });

  it('caps at MAX_ALTERNATIVES with tier 0 taking a slot', async () => {
    compareResponses['14'] = {
      source: { available_colors: [{ color: 'Black', inventory: 72 }] },
      alternatives: [],
    };
    compareResponses['S'] = {
      source: { available_colors: [{ color: 'Pink', inventory: 25 }, { color: 'Sand', inventory: 9 }] },
      alternatives: [{ product: 'Queeny' }],
    };
    const alts = await pickAlternativesViaCompare('MIA-BLK-S');
    assert.equal(alts.length, 2);
    assert.match(alts[0], /size 14/);
    assert.equal(alts[1], 'the Mia in Pink, size S');
  });

  it('returns [] for an unknown SKU', async () => {
    const alts = await pickAlternativesViaCompare('NOPE-XXX-S');
    assert.deepEqual(alts, []);
  });
});
