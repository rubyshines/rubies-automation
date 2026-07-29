/**
 * Unit tests for reports/lib/unnotifiedPreOrder.js — swap-alternative picking
 * and the done-for-you swap flow.
 *
 * Focus: findEquivalentSwap (identical-fit youth/adult equivalent, same color,
 * same price, in stock), pickAlternativesViaCompare tier precedence, and the
 * composeBody swap-done variant.
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
    sku: 'MIA-BLK-S',
    productTitle: 'MIA HALTER BIKINI TOP',
    price: 42,
    options: [{ name: 'Color', value: 'Black' }, { name: 'Youth Size', value: 'S' }],
  },
  'MIA-BLK-14': {
    sku: 'MIA-BLK-14',
    productTitle: 'MIA HALTER BIKINI TOP',
    price: 42,
    options: [{ name: 'Color', value: 'Black' }, { name: 'Youth Size', value: '14' }],
  },
  'MIA-BLK-16': {
    sku: 'MIA-BLK-16',
    productTitle: 'MIA HALTER BIKINI TOP',
    price: 42,
    options: [{ name: 'Color', value: 'Black' }, { name: 'Youth Size', value: '16' }],
  },
  'MIA-BLK-M': {
    sku: 'MIA-BLK-M',
    productTitle: 'MIA HALTER BIKINI TOP',
    price: 42,
    options: [{ name: 'Color', value: 'Black' }, { name: 'Youth Size', value: 'M' }],
  },
  'MIA-BLK-L': {
    sku: 'MIA-BLK-L',
    productTitle: 'MIA HALTER BIKINI TOP',
    price: 42,
    options: [{ name: 'Color', value: 'Black' }, { name: 'Youth Size', value: 'L' }],
  },
  // Price-mismatch product: youth tier priced lower than adult.
  'TIER-BLK-S': {
    sku: 'TIER-BLK-S',
    productTitle: 'TIERED PRICE TOP',
    price: 42,
    options: [{ name: 'Color', value: 'Black' }, { name: 'Size', value: 'S' }],
  },
  'TIER-BLK-14': {
    sku: 'TIER-BLK-14',
    productTitle: 'TIERED PRICE TOP',
    price: 36,
    options: [{ name: 'Color', value: 'Black' }, { name: 'Size', value: '14' }],
  },
  // Plus size: the SKU segment spells it XL, the customer's order says 1X.
  'MIA-BLK-XL': {
    sku: 'MIA-BLK-XL',
    productTitle: 'MIA HALTER BIKINI TOP',
    price: 42,
    options: [{ name: 'Color', value: 'Black' }, { name: 'Size', value: '1X' }],
  },
  'MIA-BLK-2XL': {
    sku: 'MIA-BLK-2XL',
    productTitle: 'MIA HALTER BIKINI TOP',
    price: 42,
    options: [{ name: 'Color', value: 'Black' }, { name: 'Size', value: '2X' }],
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
  renderVariantForCustomer: sku => {
    const v = VARIANTS[sku];
    if (!v) return null;
    const color = v.options[0].value;
    const size = v.options[1].value;
    return `the Mia in ${color}, size ${size}`;
  },
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

const {
  pickAlternativesViaCompare,
  findEquivalentSwap,
  composeBody,
} = require('../../reports/lib/unnotifiedPreOrder');

// ---------------------------------------------------------------------------
// findEquivalentSwap
// ---------------------------------------------------------------------------

describe('findEquivalentSwap', () => {
  beforeEach(() => {
    compareResponses = {};
    compareCalls = [];
  });

  it('finds the youth equivalent in the ordered color (adult S → youth 14)', async () => {
    compareResponses['14'] = {
      source: { available_colors: [{ color: 'Black', inventory: 72 }, { color: 'Pink', inventory: 67 }] },
      alternatives: [],
    };
    const swap = await findEquivalentSwap('MIA-BLK-S');
    assert.deepEqual(swap, {
      fromSku: 'MIA-BLK-S',
      toSku: 'MIA-BLK-14',
      nickname: 'Mia',
      color: 'Black',
      fromSize: 'S',
      toSize: '14',
      chart: 'youth',
      rendered: 'the Mia in Black, size 14 (our youth size with the same fit as S)',
    });
  });

  it('finds the adult equivalent for a youth leak (youth 16 → adult M)', async () => {
    compareResponses['M'] = {
      source: { available_colors: [{ color: 'Black', inventory: 16 }] },
      alternatives: [],
    };
    const swap = await findEquivalentSwap('MIA-BLK-16');
    assert.equal(swap.toSku, 'MIA-BLK-M');
    assert.equal(swap.chart, 'adult');
  });

  it('returns null when the size has no youth/adult equivalent (size L)', async () => {
    const swap = await findEquivalentSwap('MIA-BLK-L');
    assert.equal(swap, null);
    assert.deepEqual(compareCalls, []); // no lookup even attempted
  });

  it('returns null when the equivalent is priced differently', async () => {
    compareResponses['14'] = {
      source: { available_colors: [{ color: 'Black', inventory: 10 }] },
      alternatives: [],
    };
    const swap = await findEquivalentSwap('TIER-BLK-S');
    assert.equal(swap, null);
    assert.deepEqual(compareCalls, []); // price gate fires before the lookup
  });

  it('returns null when the equivalent is OOS in the ordered color', async () => {
    compareResponses['14'] = {
      source: { available_colors: [{ color: 'Pink', inventory: 67 }] }, // no Black
      alternatives: [],
    };
    const swap = await findEquivalentSwap('MIA-BLK-S');
    assert.equal(swap, null);
  });

  it('returns null when the lookup throws', async () => {
    compareResponses['14'] = new Error('boom');
    const swap = await findEquivalentSwap('MIA-BLK-S');
    assert.equal(swap, null);
  });
});

// ---------------------------------------------------------------------------
// pickAlternativesViaCompare
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

  it('skips tier 0 when the size has no youth/adult equivalent (size L)', async () => {
    compareResponses['L'] = {
      source: { available_colors: [{ color: 'Pink', inventory: 5 }] },
      alternatives: [{ product: 'Queeny' }],
    };
    const alts = await pickAlternativesViaCompare('MIA-BLK-L');
    assert.deepEqual(alts, ['the Mia in Pink, size L', 'the Queeny, size L']);
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

  it('returns [] for an unknown SKU', async () => {
    const alts = await pickAlternativesViaCompare('NOPE-XXX-S');
    assert.deepEqual(alts, []);
  });

  // RUBIES plus sizes are always written 1X/2X/3X/4X to a customer. SKUs spell
  // the same size XL/2XL for the warehouse. Rendering the raw SKU segment
  // offered "the Mia in Pink, size XL" on an order whose own line read 1X
  // (2026-07-29).
  it('renders plus sizes as 1X, never the SKU spelling XL', async () => {
    compareResponses['1X'] = {
      source: { available_colors: [{ color: 'Pink', inventory: 12 }] },
      alternatives: [{ product: 'Queeny' }],
    };
    compareResponses['XL'] = compareResponses['1X'];
    const alts = await pickAlternativesViaCompare('MIA-BLK-XL');
    assert.deepEqual(alts, ['the Mia in Pink, size 1X', 'the Queeny, size 1X']);
    for (const a of alts) {
      assert.doesNotMatch(a, /\bXL\b/, `plus size leaked the SKU spelling: ${a}`);
    }
  });

  it('renders 2XL SKUs as 2X', async () => {
    compareResponses['2X'] = {
      source: { available_colors: [{ color: 'Pink', inventory: 4 }] },
      alternatives: [],
    };
    compareResponses['2XL'] = compareResponses['2X'];
    const alts = await pickAlternativesViaCompare('MIA-BLK-2XL');
    assert.deepEqual(alts, ['the Mia in Pink, size 2X']);
  });

  it('leaves non-plus sizes untouched', async () => {
    compareResponses['L'] = {
      source: { available_colors: [{ color: 'Pink', inventory: 5 }] },
      alternatives: [],
    };
    const alts = await pickAlternativesViaCompare('MIA-BLK-L');
    assert.deepEqual(alts, ['the Mia in Pink, size L']);
  });
});

// ---------------------------------------------------------------------------
// composeBody — swap-done variant
// ---------------------------------------------------------------------------

describe('composeBody with autoSwaps', () => {
  const classification = {
    case: 'B',
    leaks: [{ sku: 'MIA-BLK-S', _variant: { pre_order_date: '2026-10-15' } }],
    inStockOther: [{ sku: 'RUBY-BLK-M' }],
    oosOther: [],
  };
  const autoSwaps = [{
    fromSku: 'MIA-BLK-S',
    toSku: 'MIA-BLK-14',
    nickname: 'Mia',
    color: 'Black',
    fromSize: 'S',
    toSize: '14',
    chart: 'youth',
    rendered: 'the Mia in Black, size 14 (our youth size with the same fit as S)',
  }];

  it('states the swap as done, no options and no opt-out', () => {
    const body = composeBody({ orderNumber: '32563', classification, autoSwaps, daysSinceOrder: 1 });
    assert.match(body, /size 14 on our youth size chart is the exact same fit as the S, and it's in stock/);
    assert.match(body, /I went ahead and swapped your Mia to Black, size 14/);
    assert.match(body, /your full order can now ship right away/);
    // A straight swap needs no menu: no wait-for-original offer, no
    // color/style opt-out, no price talk, fit equivalence stated exactly once.
    assert.doesNotMatch(body, /wait/i);
    assert.doesNotMatch(body, /prefer a different/i);
    assert.doesNotMatch(body, /just reply/i);
    assert.doesNotMatch(body, /price/i);
    assert.equal((body.match(/same fit/gi) || []).length, 1);
    assert.doesNotMatch(body, /Here's what I can do/);
    assert.doesNotMatch(body, /Swap for/);
    assert.doesNotMatch(body, /—/); // no em dashes in customer copy
  });

  it('keeps the options email when autoSwaps is empty', () => {
    const body = composeBody({ orderNumber: '32563', classification, alternatives: ['the Mia in Pink, size S'], daysSinceOrder: 1 });
    assert.match(body, /Here's what I can do/);
    assert.match(body, /Swap for the Mia in Pink, size S/);
  });
});
