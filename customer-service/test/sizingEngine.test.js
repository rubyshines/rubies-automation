/**
 * Unit tests for decisionTree.js — pure deterministic exchange logic.
 *
 * Run: node --test customer-service/test/decisionTree.test.js
 *   or: npm run test:decision-tree
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// Mock Supabase BEFORE requiring decisionTree (it destructures at import time)
// ---------------------------------------------------------------------------
const supabaseModulePath = require.resolve('../../shared/supabaseClient');
const mockSupabaseData = { partners: [], sizeMatches: [], routings: [], routingsError: false };

// Mock product CS config data (normally loaded from product_cs_config table)
const mockCsConfig = [
  { product_handle: 'the-aj-no-tuck-shaping-underwear', nickname: 'AJ', category: 'underwear_bottom', keywords: ['aj'], delta_wording: 'bottom', sizes_override: null, style_switch: null },
  { product_handle: 'the-ava-seamless-shaping-bra', nickname: 'Ava', category: 'underwear_top', keywords: ['ava'], delta_wording: 'bra', sizes_override: null, style_switch: null },
  { product_handle: 'the-brooke-shaping-bra', nickname: 'Brooke', category: 'underwear_top', keywords: ['brooke'], delta_wording: 'bra', sizes_override: null, style_switch: null },
  { product_handle: 'the-charlie-no-tuck-extra-cute-shaping-underwear', nickname: 'Charlie', category: 'underwear_bottom', keywords: ['charlie'], delta_wording: 'bottom', sizes_override: null, style_switch: null },
  { product_handle: 'the-cheeky-no-tuck-shaping-bikini-bottom', nickname: 'Cheeky', category: 'swim_bottom', keywords: ['cheeky'], delta_wording: 'bottom', sizes_override: null, style_switch: null },
  { product_handle: 'the-flo-shaping-dance-underwear', nickname: 'Flo', category: 'underwear_bottom', keywords: ['flo'], delta_wording: 'bottom', sizes_override: null, style_switch: null },
  { product_handle: 'the-mia-halter-bikini-top', nickname: 'Mia', category: 'swim_top', keywords: ['mia'], delta_wording: 'bikini_top', sizes_override: null, style_switch: null },
  { product_handle: 'the-ruby-no-tuck-shaping-bikini-bottom', nickname: 'Ruby', category: 'swim_bottom', keywords: ['ruby'], delta_wording: 'bottom', sizes_override: null, style_switch: null },
  { product_handle: 'the-sassy-no-tuck-shaping-underwear', nickname: 'Sassy', category: 'underwear_bottom', keywords: ['sassy'], delta_wording: 'bottom', sizes_override: null, style_switch: { isTarget: true, forCategories: ['underwear_bottom'] } },
  { product_handle: 'the-serena-no-tuck-shaping-shorty-short', nickname: 'Serena', category: 'swim_bottom', keywords: ['serena'], delta_wording: 'bottom', sizes_override: null, style_switch: null },
  { product_handle: 'the-sky-no-tuck-shaping-one-piece', nickname: 'Sky', category: 'onepiece', keywords: ['sky', 'one-piece'], delta_wording: 'bottom', sizes_override: null, style_switch: null },
  { product_handle: 'the-stella-high-waisted-shaping-bikini-bottom', nickname: 'Stella', category: 'swim_bottom', keywords: ['stella'], delta_wording: 'bottom', sizes_override: null, style_switch: null },
  { product_handle: 'the-sunny-queeny-tankini', nickname: 'Queeny', category: 'swim_top', keywords: ['queeny', 'sunny', 'tankini'], delta_wording: 'top', sizes_override: null, style_switch: null },
  { product_handle: 'the-naomi-gaff-extra-strength-shaping-underwear', nickname: 'Naomi', category: 'underwear_bottom', keywords: ['naomi', 'gaff'], delta_wording: 'bottom', sizes_override: ['XS', 'S', 'M', 'L', '1X', '2X'], style_switch: { isTarget: true, forCategories: ['underwear_bottom'] } },
  { product_handle: 'rubies-shaping-chest-pads', nickname: 'Chest Pads', category: 'chest_pads', keywords: ['pad'], delta_wording: null, sizes_override: null, style_switch: null },
  { product_handle: 'rubies-gift-card', nickname: 'Gift Card', category: 'accessory', keywords: ['gift card'], delta_wording: null, sizes_override: null, style_switch: null },
  { product_handle: 'progress-pride-pins', nickname: 'Pride Pins', category: 'accessory', keywords: ['pins'], delta_wording: null, sizes_override: null, style_switch: null },
];
require.cache[supabaseModulePath] = {
  id: supabaseModulePath,
  filename: supabaseModulePath,
  loaded: true,
  exports: {
    getSupabaseClient: () => ({
      from: (table) => {
        if (table === 'donation_routings') {
          // Chain used by fetchRecentPartnerLoads via fetchAllPaginated:
          // select().gte().not().order().range()
          const chain = {
            select: () => chain,
            gte: () => chain,
            not: () => chain,
            order: () => chain,
            range: () => (mockSupabaseData.routingsError
              ? Promise.resolve({ data: null, error: { message: 'mock routings error' } })
              : Promise.resolve({ data: mockSupabaseData.routings, error: null })),
          };
          return chain;
        }
        return {
          select: () => ({
            eq: () => ({
              eq: () => Promise.resolve({ data: mockSupabaseData.partners }),
            }),
          }),
        };
      },
      rpc: (fn) => {
        if (fn === 'get_cs_product_config') return Promise.resolve({ data: mockCsConfig, error: null });
        return Promise.resolve({ data: mockSupabaseData.sizeMatches });
      },
    }),
    fetchAllPaginated: async (buildQuery) => {
      const { data, error } = await buildQuery().range(0, 999);
      if (error) throw new Error(`fetchAllPaginated: ${error.message}`);
      return data || [];
    },
    upsert: () => Promise.resolve(),
  },
};

// Now require sizingEngine — it will get the mocked supabaseClient
const {
  walkTree,
  checkSafetyOverride,
  prescribeCustomerIdentification,
  prescribeOrderIdentification,
  prescribeActionClassification,
  prescribeSizingResolution,
  prescribeOrderCreation,
  prescribeDonationRouting,
  getProductNickname,
  pluralizeNickname,
  PRODUCT_NICKNAMES,
  classifyProduct,
  PRODUCT_CATEGORIES,
  normalizeSize,
  getSizeList,
  getAdjacentSizes,
  getGradingDelta,
  formatDelta,
  getCumulativeDelta,
  getIntermediateSizes,
  parseSizeVariant,
  getSizeModifier,
  getChartCategory,
  prescribePrePurchaseSizing,
  initCsConfig,
  PRODUCT_SIZE_OVERRIDES,
  _activeProducts,
} = require('../lib/sizingEngine');

// ---------------------------------------------------------------------------
// Initialize CS config from mock Supabase before tests run
// ---------------------------------------------------------------------------
before(async () => {
  await initCsConfig();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeIntake(overrides = {}) {
  return {
    name: null,
    pronouns: 'they/them',
    pronoun_reason: 'default',
    buying_for: 'self',
    third_party_label: null,
    email_mismatch: false,
    conversation_email: null,
    order_email: null,
    order_number: null,
    message_type: 'exchange',
    items: [],
    resolution_sizes: [],
    measurement: null,
    _latestMessage: '',
    _refundAskedOnce: false,
    ...overrides,
  };
}

function makeContext(overrides = {}) {
  return {
    customer: { email: 'test@example.com', defaultAddress: null },
    targetOrder: null,
    fulfilled: [],
    exchanges: [],
    all: [],
    customerCountry: 'US',
    isNorthAmerica: true,
    orderHistory: [],
    ...overrides,
  };
}

function makeOrder(overrides = {}) {
  return {
    name: '#1001',
    createdAt: new Date(Date.now() - 7 * 86400000).toISOString(),
    lineItems: [],
    ...overrides,
  };
}

function makeItem(overrides = {}) {
  return {
    product: 'THE AJ NO-TUCK SHAPING UNDERWEAR',
    size: '10',
    issue: 'close_fit_tight',
    resolved_size: null,
    desired_size: null,
    ...overrides,
  };
}

// Classified item (output of phase 3, input to phase 4)
function makeClassified(overrides = {}) {
  return {
    product: 'THE AJ NO-TUCK SHAPING UNDERWEAR',
    size: '10',
    action: 'sizing_exchange',
    direction: 'up',
    audit: 'test',
    ...overrides,
  };
}

// ============================================================================
// Size Utilities
// ============================================================================

describe('normalizeSize', () => {
  it('returns null for null/undefined/empty', () => {
    assert.equal(normalizeSize(null), null);
    assert.equal(normalizeSize(undefined), null);
    assert.equal(normalizeSize(''), null);
  });

  it('uppercases and trims', () => {
    assert.equal(normalizeSize(' xs '), 'XS');
    assert.equal(normalizeSize('m'), 'M');
  });

  it('resolves XL alias to 1X', () => {
    assert.equal(normalizeSize('XL'), '1X');
    assert.equal(normalizeSize('xl'), '1X');
  });

  it('resolves XXL alias to 2X', () => {
    assert.equal(normalizeSize('XXL'), '2X');
  });

  it('resolves 3XL/4XL/5XL aliases', () => {
    assert.equal(normalizeSize('3XL'), '3X');
    assert.equal(normalizeSize('4XL'), '4X');
    assert.equal(normalizeSize('5XL'), '5X');
  });

  it('passes through numeric sizes unchanged', () => {
    assert.equal(normalizeSize('10'), '10');
    assert.equal(normalizeSize('16'), '16');
  });

  it('passes through already-normalized letter sizes', () => {
    assert.equal(normalizeSize('XXS+'), 'XXS+');
    assert.equal(normalizeSize('1X'), '1X');
  });

  it('handles number input', () => {
    assert.equal(normalizeSize(10), '10');
  });
});

describe('getSizeList', () => {
  it('returns NUMERIC_SIZES for numeric size', () => {
    const list = getSizeList('10');
    assert.equal(list[0], '4');
    assert.equal(list[list.length - 1], '16');
  });

  it('returns LETTER_SIZES for letter size', () => {
    const list = getSizeList('M');
    assert.equal(list[0], 'XXS');
    assert.equal(list[list.length - 1], '4X');
  });

  it('resolves aliases before lookup', () => {
    const list = getSizeList('XL');
    // XL → 1X → letter sizes
    assert.ok(list.includes('1X'));
    assert.ok(!list.includes('10'));
  });

  it('returns null for unknown size', () => {
    assert.equal(getSizeList('XXXL'), null);
  });

  it('returns null for null', () => {
    assert.equal(getSizeList(null), null);
  });
});

describe('getAdjacentSizes', () => {
  it('returns 2 sizes up from 10', () => {
    assert.deepEqual(getAdjacentSizes('10', 'up', 2), ['11', '12']);
  });

  it('returns 2 sizes down from M', () => {
    assert.deepEqual(getAdjacentSizes('M', 'down', 2), ['S', 'XS+']);
  });

  it('returns fewer if at boundary', () => {
    assert.deepEqual(getAdjacentSizes('3X', 'up', 2), ['4X']);
  });

  it('returns empty at top boundary going up', () => {
    assert.deepEqual(getAdjacentSizes('4X', 'up'), []);
  });

  it('returns empty at bottom boundary going down', () => {
    assert.deepEqual(getAdjacentSizes('4', 'down'), []);
  });

  it('resolves aliases', () => {
    // XL → 1X, one up → 2X
    assert.deepEqual(getAdjacentSizes('XL', 'up', 1), ['2X']);
  });

  it('defaults to count of 2', () => {
    const result = getAdjacentSizes('S', 'up');
    assert.equal(result.length, 2);
    assert.deepEqual(result, ['M', 'L']);
  });

  it('returns empty for unknown size', () => {
    assert.deepEqual(getAdjacentSizes('ZZZ', 'up'), []);
  });
});

// ============================================================================
// Product Classification
// ============================================================================

describe('classifyProduct', () => {
  it('classifies swim bottoms', () => {
    assert.equal(classifyProduct('THE RUBY NO-TUCK SHAPING BIKINI BOTTOM'), 'swim_bottom');
    assert.equal(classifyProduct('THE STELLA HIGH WAISTED SHAPING BIKINI BOTTOM'), 'swim_bottom');
    assert.equal(classifyProduct('THE CHEEKY NO-TUCK SHAPING BIKINI BOTTOM'), 'swim_bottom');
    assert.equal(classifyProduct('THE SERENA NO-TUCK SHAPING SHORTY SHORT'), 'swim_bottom');
  });

  it('classifies swim tops', () => {
    assert.equal(classifyProduct('THE MIA HALTER BIKINI TOP'), 'swim_top');
    assert.equal(classifyProduct('THE SUNNY QUEENY TANKINI'), 'swim_top');
  });

  it('classifies underwear bottoms', () => {
    assert.equal(classifyProduct('THE AJ NO-TUCK SHAPING UNDERWEAR'), 'underwear_bottom');
    assert.equal(classifyProduct('THE CHARLIE NO-TUCK EXTRA CUTE SHAPING UNDERWEAR'), 'underwear_bottom');
    assert.equal(classifyProduct('THE SASSY NO-TUCK SHAPING UNDERWEAR'), 'underwear_bottom');
    assert.equal(classifyProduct('THE FLO SHAPING DANCE UNDERWEAR'), 'underwear_bottom');
  });

  it('classifies underwear tops', () => {
    assert.equal(classifyProduct('THE BROOKE SHAPING BRA'), 'underwear_top');
    assert.equal(classifyProduct('THE AVA SEAMLESS SHAPING BRA'), 'underwear_top');
  });

  it('classifies onepiece', () => {
    assert.equal(classifyProduct('THE SKY NO-TUCK SHAPING ONE-PIECE'), 'onepiece');
  });

  it('classifies chest pads', () => {
    assert.equal(classifyProduct('RUBIES SHAPING CHEST PADS'), 'chest_pads');
    assert.equal(classifyProduct('MAGICAL SHAPING GEL CHEST PADS'), 'chest_pads');
  });

  it('classifies accessories', () => {
    assert.equal(classifyProduct('RUBIES GIFT CARD'), 'accessory');
  });

  it('returns null for unknown products', () => {
    assert.equal(classifyProduct('MYSTERY PRODUCT'), null);
    assert.equal(classifyProduct(null), null);
  });

  it('is case insensitive', () => {
    assert.equal(classifyProduct('the aj no-tuck shaping underwear'), 'underwear_bottom');
    assert.equal(classifyProduct('THE RUBY NO-TUCK SHAPING BIKINI BOTTOM'), 'swim_bottom');
  });
});

// ============================================================================
// Size Lists — Category-Based
// ============================================================================

describe('getAdjacentSizes — category-based (even/odd split)', () => {
  // Use any product from each category — the category determines behavior, not the product name

  // ── underwear_bottom: even numeric only, letter no plus ──

  it('underwear_bottom: numeric 10 up → 12, 14 (even only)', () => {
    assert.deepEqual(getAdjacentSizes('10', 'up', 2, 'THE AJ NO-TUCK SHAPING UNDERWEAR'), ['12', '14']);
  });

  it('underwear_bottom: numeric 10 down → 8, 6 (even only)', () => {
    assert.deepEqual(getAdjacentSizes('10', 'down', 2, 'THE CHARLIE NO-TUCK EXTRA CUTE SHAPING UNDERWEAR'), ['8', '6']);
  });

  it('underwear_bottom: numeric 4 down → empty (boundary)', () => {
    assert.deepEqual(getAdjacentSizes('4', 'down', 1, 'THE AJ NO-TUCK SHAPING UNDERWEAR'), []);
  });

  it('underwear_bottom: numeric 16 up → empty (boundary)', () => {
    assert.deepEqual(getAdjacentSizes('16', 'up', 1, 'THE AJ NO-TUCK SHAPING UNDERWEAR'), []);
  });

  it('underwear_bottom: letter XS up → S, M (no plus sizes)', () => {
    assert.deepEqual(getAdjacentSizes('XS', 'up', 2, 'THE SASSY NO-TUCK SHAPING UNDERWEAR'), ['S', 'M']);
  });

  it('underwear_bottom: letter S down → XS, XXS (no plus sizes)', () => {
    assert.deepEqual(getAdjacentSizes('S', 'down', 2, 'THE SASSY NO-TUCK SHAPING UNDERWEAR'), ['XS', 'XXS']);
  });

  // ── underwear_top: even numeric only, letter no plus ──

  it('underwear_top: numeric 10 up → 12, 14 (even only)', () => {
    assert.deepEqual(getAdjacentSizes('10', 'up', 2, 'THE BROOKE SHAPING BRA'), ['12', '14']);
  });

  it('underwear_top: letter XS up → S, M (no plus sizes)', () => {
    assert.deepEqual(getAdjacentSizes('XS', 'up', 2, 'THE AVA SEAMLESS SHAPING BRA'), ['S', 'M']);
  });

  // ── swim_bottom: even+odd numeric, letter with plus ──

  it('swim_bottom: numeric 11 up → 12, 13 (full range)', () => {
    assert.deepEqual(getAdjacentSizes('11', 'up', 2, 'THE RUBY NO-TUCK SHAPING BIKINI BOTTOM'), ['12', '13']);
  });

  it('swim_bottom: numeric 10 down → 9, 8 (full range)', () => {
    assert.deepEqual(getAdjacentSizes('10', 'down', 2, 'THE STELLA HIGH WAISTED SHAPING BIKINI BOTTOM'), ['9', '8']);
  });

  it('swim_bottom: numeric 4 down → empty (boundary)', () => {
    assert.deepEqual(getAdjacentSizes('4', 'down', 1, 'THE RUBY NO-TUCK SHAPING BIKINI BOTTOM'), []);
  });

  it('swim_bottom: letter XS up → XS+, S (with plus sizes)', () => {
    assert.deepEqual(getAdjacentSizes('XS', 'up', 2, 'THE CHEEKY NO-TUCK SHAPING BIKINI BOTTOM'), ['XS+', 'S']);
  });

  it('swim_bottom: letter S down → XS+, XS (with plus sizes)', () => {
    assert.deepEqual(getAdjacentSizes('S', 'down', 2, 'THE RUBY NO-TUCK SHAPING BIKINI BOTTOM'), ['XS+', 'XS']);
  });

  it('swim_bottom: letter XXS up → XXS+, XS (with plus sizes)', () => {
    assert.deepEqual(getAdjacentSizes('XXS', 'up', 2, 'THE CHEEKY NO-TUCK SHAPING BIKINI BOTTOM'), ['XXS+', 'XS']);
  });

  // ── swim_top: even numeric only, letter no plus ──

  it('swim_top: numeric 10 up → 12, 14 (even only)', () => {
    assert.deepEqual(getAdjacentSizes('10', 'up', 2, 'THE MIA HALTER BIKINI TOP'), ['12', '14']);
  });

  it('swim_top: letter XS up → S, M (no plus sizes)', () => {
    assert.deepEqual(getAdjacentSizes('XS', 'up', 2, 'THE SUNNY QUEENY TANKINI'), ['S', 'M']);
  });

  // ── onepiece: even+odd numeric, letter with plus ──

  it('onepiece: numeric 11 up → 12, 13 (full range)', () => {
    assert.deepEqual(getAdjacentSizes('11', 'up', 2, 'THE SKY NO-TUCK SHAPING ONE-PIECE'), ['12', '13']);
  });

  it('onepiece: letter XS up → XS+, S (with plus sizes)', () => {
    assert.deepEqual(getAdjacentSizes('XS', 'up', 2, 'THE SKY NO-TUCK SHAPING ONE-PIECE'), ['XS+', 'S']);
  });

  // ── chest_pads: only S, M, L ──

  it('chest_pads: S up → M, L', () => {
    assert.deepEqual(getAdjacentSizes('S', 'up', 2, 'RUBIES SHAPING CHEST PADS'), ['M', 'L']);
  });

  it('chest_pads: M up → L', () => {
    assert.deepEqual(getAdjacentSizes('M', 'up', 1, 'RUBIES SHAPING CHEST PADS'), ['L']);
  });

  it('chest_pads: M down → S', () => {
    assert.deepEqual(getAdjacentSizes('M', 'down', 1, 'MAGICAL SHAPING GEL CHEST PADS'), ['S']);
  });

  it('chest_pads: L up → empty (boundary)', () => {
    assert.deepEqual(getAdjacentSizes('L', 'up', 1, 'RUBIES SHAPING CHEST PADS'), []);
  });

  it('chest_pads: S down → empty (boundary)', () => {
    assert.deepEqual(getAdjacentSizes('S', 'down', 1, 'RUBIES SHAPING CHEST PADS'), []);
  });

  // ── No product name → falls back to full list (backward compat) ──

  it('no product: numeric 10 up → 11, 12 (full list)', () => {
    assert.deepEqual(getAdjacentSizes('10', 'up', 2), ['11', '12']);
  });

  it('no product: letter M down → S, XS+ (full list)', () => {
    assert.deepEqual(getAdjacentSizes('M', 'down', 2), ['S', 'XS+']);
  });
});

describe('getSizeList — category-based', () => {
  it('underwear_bottom: even numeric (no odd sizes)', () => {
    const list = getSizeList('10', 'THE AJ NO-TUCK SHAPING UNDERWEAR');
    assert.ok(list.includes('8'));
    assert.ok(list.includes('12'));
    assert.ok(!list.includes('9'));
    assert.ok(!list.includes('11'));
  });

  it('underwear_bottom: letter no plus', () => {
    const list = getSizeList('S', 'THE SASSY NO-TUCK SHAPING UNDERWEAR');
    assert.ok(list.includes('XXS'));
    assert.ok(!list.includes('XXS+'));
    assert.ok(!list.includes('XS+'));
  });

  it('swim_bottom: full numeric (even + odd)', () => {
    const list = getSizeList('10', 'THE RUBY NO-TUCK SHAPING BIKINI BOTTOM');
    assert.ok(list.includes('9'));
    assert.ok(list.includes('11'));
    assert.ok(list.includes('8'));
  });

  it('swim_bottom: letter with plus', () => {
    const list = getSizeList('S', 'THE CHEEKY NO-TUCK SHAPING BIKINI BOTTOM');
    assert.ok(list.includes('XXS+'));
    assert.ok(list.includes('XS+'));
  });

  it('swim_top: even numeric only', () => {
    const list = getSizeList('10', 'THE MIA HALTER BIKINI TOP');
    assert.ok(!list.includes('9'));
    assert.ok(!list.includes('11'));
  });

  it('onepiece: full numeric', () => {
    const list = getSizeList('10', 'THE SKY NO-TUCK SHAPING ONE-PIECE');
    assert.ok(list.includes('9'));
    assert.ok(list.includes('11'));
  });

  it('onepiece: letter with plus', () => {
    const list = getSizeList('S', 'THE SKY NO-TUCK SHAPING ONE-PIECE');
    assert.ok(list.includes('XS+'));
  });

  it('chest_pads: only S, M, L', () => {
    const list = getSizeList('M', 'RUBIES SHAPING CHEST PADS');
    assert.deepEqual(list, ['S', 'M', 'L']);
  });

  it('no product: full numeric list', () => {
    const list = getSizeList('10');
    assert.equal(list.length, 11);
  });

  it('no product: full letter list', () => {
    const list = getSizeList('S');
    assert.equal(list.length, 11);
  });
});

describe('getGradingDelta', () => {
  it('returns 2" for full-size step (both even)', () => {
    const d = getGradingDelta('10', '12');
    assert.equal(d.inches, 2);
    assert.equal(d.cm, 5);
    assert.equal(d.note, 'full-size step');
  });

  it('returns 1" for half-size step (odd source)', () => {
    const d = getGradingDelta('10', '11');
    assert.equal(d.inches, 1);
    assert.equal(d.cm, 2.5);
    assert.equal(d.note, 'half-size step');
  });

  it('returns 1" for half-size step (odd target)', () => {
    const d = getGradingDelta('XS', 'XS+');
    assert.equal(d.inches, 1);
    assert.equal(d.cm, 2.5);
  });

  it('returns 2" for full-size step in letter sizes', () => {
    const d = getGradingDelta('S', 'M');
    assert.equal(d.inches, 2);
    assert.equal(d.cm, 5);
  });
});

describe('getCumulativeDelta', () => {
  it('returns 0 for same size', () => {
    assert.deepEqual(getCumulativeDelta('M', 'M'), { inches: 0, cm: 0 });
  });

  it('returns 2" for one full step (S → M)', () => {
    assert.deepEqual(getCumulativeDelta('S', 'M'), { inches: 2, cm: 5 });
  });

  it('accumulates across half + full steps (10 → 12)', () => {
    // 10→11 is 1" (half), 11→12 is 1" (half)
    const d = getCumulativeDelta('10', '12');
    assert.equal(d.inches, 2);
    assert.equal(d.cm, 5);
  });

  it('accumulates multiple steps (S → 1X)', () => {
    // S→M 2", M→L 2", L→1X 2" = 6"
    const d = getCumulativeDelta('S', '1X');
    assert.equal(d.inches, 6);
    assert.equal(d.cm, 15);
  });

  it('returns null for sizes in different systems', () => {
    assert.equal(getCumulativeDelta('10', 'M'), null);
  });

  it('returns null for unknown size', () => {
    assert.equal(getCumulativeDelta('ZZZ', 'M'), null);
  });

  it('works going down', () => {
    const d = getCumulativeDelta('M', 'S');
    assert.equal(d.inches, 2);
    assert.equal(d.cm, 5);
  });
});

describe('formatDelta', () => {
  it('formats bottom delta with waist wording', () => {
    const result = formatDelta('10', '12', 'up', true, 'bottom');
    assert.ok(result.includes('fabric around the waist'));
    assert.ok(result.includes('12'));
  });

  it('formats bra delta with band wording', () => {
    const result = formatDelta('S', 'M', 'up', true, 'bra');
    assert.ok(result.includes('bra band will be'));
    assert.ok(result.includes('longer'));
  });

  it('formats bikini top delta', () => {
    const result = formatDelta('S', 'M', 'up', true, 'bikini_top');
    assert.ok(result.includes('bikini top band will be'));
  });

  it('formats top delta with torso wording', () => {
    const result = formatDelta('S', 'M', 'up', true, 'top');
    assert.ok(result.includes('fabric around the torso'));
  });

  it('uses cm when useInches is false', () => {
    const result = formatDelta('S', 'M', 'up', false, 'bottom');
    assert.ok(result.includes('cm'));
    assert.ok(!result.includes('"'));
  });

  it('uses minus sign for down direction', () => {
    const result = formatDelta('M', 'S', 'down', true, 'bottom');
    assert.ok(result.includes('-'));
  });
});

// ============================================================================
// Product Utilities
// ============================================================================

describe('getProductNickname', () => {
  it('returns exact match', () => {
    assert.equal(getProductNickname('THE AJ NO-TUCK SHAPING UNDERWEAR'), 'AJ');
  });

  it('is case insensitive', () => {
    assert.equal(getProductNickname('the aj no-tuck shaping underwear'), 'AJ');
  });

  it('returns "item" for null/undefined', () => {
    assert.equal(getProductNickname(null), 'item');
    assert.equal(getProductNickname(undefined), 'item');
  });

  it('matches via THE [NAME] pattern for product name changes', () => {
    // "THE AJ SHAPING UNDERWEAR" — different from exact key but same product
    assert.equal(getProductNickname('THE AJ SHAPING UNDERWEAR'), 'AJ');
  });

  it('returns full title for unknown products', () => {
    assert.equal(getProductNickname('Mystery Product'), 'Mystery Product');
  });

  it('handles Gift Card', () => {
    assert.equal(getProductNickname('RUBIES GIFT CARD'), 'Gift Card');
  });

  it('handles Chest Pads', () => {
    assert.equal(getProductNickname('RUBIES SHAPING CHEST PADS'), 'Chest Pads');
  });
});

describe('pluralizeNickname', () => {
  it('adds s for qty > 1', () => {
    assert.equal(pluralizeNickname('AJ', 2), 'AJs');
  });

  it('returns unchanged for qty 1', () => {
    assert.equal(pluralizeNickname('AJ', 1), 'AJ');
  });

  it('does not double-pluralize (ends with s)', () => {
    assert.equal(pluralizeNickname('Chest Pads', 2), 'Chest Pads');
  });

  it('returns null for null input', () => {
    assert.equal(pluralizeNickname(null, 2), null);
  });
});

// ============================================================================
// Phase 0: Safety Override
// ============================================================================

describe('checkSafetyOverride', () => {
  it('returns override:true for "not safe"', () => {
    const result = checkSafetyOverride({ _latestMessage: 'I am not safe at home' });
    assert.equal(result.override, true);
    assert.equal(result.action, 'immediate_refund');
  });

  it('returns override:true for "abusive"', () => {
    const result = checkSafetyOverride({ _latestMessage: 'my partner is abusive' });
    assert.equal(result.override, true);
  });

  it('returns override:true for "hiding"', () => {
    const result = checkSafetyOverride({ _latestMessage: 'I need to hide them, hiding them from' });
    assert.equal(result.override, true);
  });

  it('returns override:false for normal message', () => {
    const result = checkSafetyOverride({ _latestMessage: 'The size is too big' });
    assert.equal(result.override, false);
  });

  it('returns override:false for empty/missing message', () => {
    assert.equal(checkSafetyOverride({}).override, false);
    assert.equal(checkSafetyOverride({ _latestMessage: '' }).override, false);
  });
});

// ============================================================================
// Phase 1: Customer Identification
// ============================================================================

describe('prescribeCustomerIdentification', () => {
  it('adds name_warning when no name given', () => {
    const result = prescribeCustomerIdentification(makeIntake(), makeContext());
    assert.ok(result.actions.some(a => a.type === 'name_warning'));
    assert.ok(result.audit.some(a => a.includes('dead name risk')));
  });

  it('records explicit name without warning', () => {
    const result = prescribeCustomerIdentification(makeIntake({ name: 'Alex' }), makeContext());
    assert.ok(!result.actions.some(a => a.type === 'name_warning'));
    assert.ok(result.audit.some(a => a.includes('Alex')));
  });

  it('defaults pronouns to they/them in audit', () => {
    const result = prescribeCustomerIdentification(makeIntake(), makeContext());
    assert.ok(result.audit.some(a => a.includes('they/them')));
  });

  it('adds third_party_adapt for third-party buying', () => {
    const intake = makeIntake({ buying_for: 'third_party', third_party_label: 'partner' });
    const result = prescribeCustomerIdentification(intake, makeContext());
    assert.ok(result.actions.some(a => a.type === 'third_party_adapt'));
  });

  it('adds kid_sensitivity for daughter', () => {
    const intake = makeIntake({ buying_for: 'third_party', third_party_label: 'daughter' });
    const result = prescribeCustomerIdentification(intake, makeContext());
    assert.ok(result.actions.some(a => a.type === 'kid_sensitivity'));
  });

  it('flags email mismatch', () => {
    const intake = makeIntake({
      email_mismatch: true,
      conversation_email: 'a@test.com',
      order_email: 'b@test.com',
    });
    const result = prescribeCustomerIdentification(intake, makeContext());
    assert.ok(result.actions.some(a => a.type === 'email_mismatch'));
  });

  it('asks for info when customer not found', () => {
    const result = prescribeCustomerIdentification(makeIntake(), makeContext({ customer: null }));
    assert.ok(result.actions.some(a => a.type === 'ask_info'));
    assert.deepEqual(result.still_needed, ['customer_identification']);
  });
});

// ============================================================================
// Phase 2: Order Identification
// ============================================================================

describe('prescribeOrderIdentification', () => {
  it('auto-selects when only one fulfilled order', () => {
    const order = makeOrder();
    const result = prescribeOrderIdentification(
      makeIntake(),
      makeContext({ fulfilled: [order] }),
    );
    assert.ok(!result.actions.some(a => a.type === 'ask_order'));
    assert.ok(result.audit.some(a => a.includes('Auto-selected')));
  });

  it('asks which order when multiple fulfilled', () => {
    const result = prescribeOrderIdentification(
      makeIntake(),
      makeContext({ fulfilled: [makeOrder(), makeOrder({ name: '#1002' })] }),
    );
    assert.ok(result.actions.some(a => a.type === 'ask_order'));
    assert.ok(result.still_needed.includes('order_number'));
  });

  it('asks for order number when none fulfilled', () => {
    const result = prescribeOrderIdentification(makeIntake(), makeContext({ fulfilled: [] }));
    assert.ok(result.actions.some(a => a.type === 'ask_order'));
  });

  it('records order in audit when order_number given', () => {
    const result = prescribeOrderIdentification(
      makeIntake({ order_number: '1001' }),
      makeContext(),
    );
    assert.ok(result.audit.some(a => a.includes('#1001')));
  });

  it('order age: within 60 days = OK', () => {
    const order = makeOrder({ createdAt: new Date(Date.now() - 30 * 86400000).toISOString() });
    const result = prescribeOrderIdentification(
      makeIntake({ order_number: '1001' }),
      makeContext({ targetOrder: order }),
    );
    assert.ok(!result.actions.some(a => a.type === 'gentle_exception'));
    assert.ok(result.audit.some(a => a.includes('within 60-day')));
  });

  it('order age: 61-180 days = gentle exception', () => {
    const order = makeOrder({ createdAt: new Date(Date.now() - 90 * 86400000).toISOString() });
    const result = prescribeOrderIdentification(
      makeIntake({ order_number: '1001' }),
      makeContext({ targetOrder: order }),
    );
    assert.ok(result.actions.some(a => a.type === 'gentle_exception'));
  });

  it('order age: 181-365 days = case by case', () => {
    const order = makeOrder({ createdAt: new Date(Date.now() - 200 * 86400000).toISOString() });
    const result = prescribeOrderIdentification(
      makeIntake({ order_number: '1001' }),
      makeContext({ targetOrder: order }),
    );
    assert.ok(result.actions.some(a => a.type === 'case_by_case'));
  });

  it('order age: >365 days = escalate', () => {
    const order = makeOrder({ createdAt: new Date(Date.now() - 400 * 86400000).toISOString() });
    const result = prescribeOrderIdentification(
      makeIntake({ order_number: '1001' }),
      makeContext({ targetOrder: order }),
    );
    assert.ok(result.actions.some(a => a.type === 'escalate'));
  });

  it('asks for items when none specified', () => {
    const result = prescribeOrderIdentification(makeIntake({ items: [] }), makeContext());
    assert.ok(result.actions.some(a => a.type === 'ask_items'));
    assert.ok(result.still_needed.includes('items'));
  });
});

// ============================================================================
// Phase 3: Action Classification
// ============================================================================

describe('prescribeActionClassification', () => {
  it('classifies defect', () => {
    const intake = makeIntake({ items: [makeItem({ issue: 'defect' })] });
    const result = prescribeActionClassification(intake);
    assert.equal(result.items[0].action, 'defect');
  });

  it('classifies already confirmed exchange', () => {
    const intake = makeIntake({ items: [makeItem({ resolved_size: 'M' })] });
    const result = prescribeActionClassification(intake);
    assert.equal(result.items[0].action, 'exchange_confirmed');
  });

  it('classifies close_fit_tight as sizing_exchange up', () => {
    const intake = makeIntake({ items: [makeItem({ issue: 'close_fit_tight' })] });
    const result = prescribeActionClassification(intake);
    assert.equal(result.items[0].action, 'sizing_exchange');
    assert.equal(result.items[0].direction, 'up');
  });

  it('classifies close_fit_loose as sizing_exchange down', () => {
    const intake = makeIntake({ items: [makeItem({ issue: 'close_fit_loose' })] });
    const result = prescribeActionClassification(intake);
    assert.equal(result.items[0].action, 'sizing_exchange');
    assert.equal(result.items[0].direction, 'down');
  });

  it('classifies too_tight as sizing_exchange up', () => {
    const intake = makeIntake({ items: [makeItem({ issue: 'too_tight' })] });
    const result = prescribeActionClassification(intake);
    assert.equal(result.items[0].action, 'sizing_exchange');
    assert.equal(result.items[0].direction, 'up');
  });

  it('classifies too_loose as sizing_exchange down', () => {
    const intake = makeIntake({ items: [makeItem({ issue: 'too_loose' })] });
    const result = prescribeActionClassification(intake);
    assert.equal(result.items[0].action, 'sizing_exchange');
    assert.equal(result.items[0].direction, 'down');
  });

  it('classifies way_off as measurement needed', () => {
    const intake = makeIntake({ items: [makeItem({ issue: 'way_off' })] });
    const result = prescribeActionClassification(intake);
    assert.equal(result.items[0].action, 'sizing_exchange_measurement');
  });

  it('classifies expectation_mismatch for bottoms', () => {
    const intake = makeIntake({ items: [makeItem({ issue: 'expectation_mismatch' })] });
    const result = prescribeActionClassification(intake);
    assert.equal(result.items[0].action, 'expectation_mismatch');
  });

  it('classifies expectation_mismatch for tops as fit_direction_unclear', () => {
    const intake = makeIntake({
      items: [makeItem({ issue: 'expectation_mismatch', product: 'THE BROOKE SHAPING BRA' })],
    });
    const result = prescribeActionClassification(intake);
    assert.equal(result.items[0].action, 'fit_direction_unclear');
  });

  it('classifies tight_legs as style_switch', () => {
    const intake = makeIntake({ items: [makeItem({ issue: 'tight_legs' })] });
    const result = prescribeActionClassification(intake);
    assert.equal(result.items[0].action, 'style_switch');
  });

  it('classifies refund_request as refund', () => {
    const intake = makeIntake({ items: [makeItem({ issue: 'refund_request' })] });
    const result = prescribeActionClassification(intake);
    assert.equal(result.items[0].action, 'refund');
  });

  it('classifies refund from message_type', () => {
    const intake = makeIntake({ message_type: 'refund', items: [makeItem({ issue: 'none' })] });
    const result = prescribeActionClassification(intake);
    assert.equal(result.items[0].action, 'refund');
  });

  it('classifies doesnt_fit as fit_direction_unclear', () => {
    const intake = makeIntake({ items: [makeItem({ issue: 'doesnt_fit' })] });
    const result = prescribeActionClassification(intake);
    assert.equal(result.items[0].action, 'fit_direction_unclear');
  });

  it('classifies product_not_working as probe_needed', () => {
    const intake = makeIntake({ items: [makeItem({ issue: 'product_not_working' })] });
    const result = prescribeActionClassification(intake);
    assert.equal(result.items[0].action, 'probe_needed');
  });

  it('classifies unknown issue as needs_clarification', () => {
    const intake = makeIntake({ items: [makeItem({ issue: 'something_random' })] });
    const result = prescribeActionClassification(intake);
    assert.equal(result.items[0].action, 'needs_clarification');
  });
});

// ============================================================================
// Phase 4: Sizing Resolution
// ============================================================================

describe('prescribeSizingResolution', () => {
  describe('sizing_exchange: auto-confirm path', () => {
    it('auto-confirms "a bit tight" one size up', async () => {
      const intake = makeIntake({
        items: [makeItem({ issue: 'close_fit_tight', size: '10' })],
        _latestMessage: 'it is a bit tight around the waist',
      });
      const classified = [makeClassified({ direction: 'up' })];
      const result = await prescribeSizingResolution(classified, intake, makeContext());
      assert.equal(result.items[0].state, 'CONFIRMED');
      // AJ is underwear (even sizes), so next up from 10 is 12
      assert.equal(intake.items[0].resolved_size, '12');
    });

    it('auto-confirms "next size" one size up', async () => {
      const intake = makeIntake({
        items: [makeItem({ issue: 'close_fit_tight', size: 'M' })],
        _latestMessage: 'can I get the next size up',
      });
      const classified = [makeClassified({ product: 'THE AJ NO-TUCK SHAPING UNDERWEAR', size: 'M', direction: 'up' })];
      const result = await prescribeSizingResolution(classified, intake, makeContext());
      assert.equal(result.items[0].state, 'CONFIRMED');
      assert.equal(intake.items[0].resolved_size, 'L');
    });
  });

  describe('sizing_exchange: options path', () => {
    it('offers options for "too tight" without "a bit"', async () => {
      const intake = makeIntake({
        items: [makeItem({ issue: 'too_tight', size: '10' })],
        _latestMessage: 'the waist is too tight',
      });
      const classified = [makeClassified({ direction: 'up' })];
      const result = await prescribeSizingResolution(classified, intake, makeContext());
      assert.equal(result.items[0].state, 'AWAITING_SIZE_CONFIRMATION');
      assert.ok(result.items[0].options);
      assert.ok(result.items[0].options.length >= 1);
    });

    it('includes fabric delta in inches for North America', async () => {
      const intake = makeIntake({
        items: [makeItem({ issue: 'too_tight', size: '10' })],
        _latestMessage: 'too tight',
      });
      const classified = [makeClassified({ direction: 'up' })];
      const result = await prescribeSizingResolution(classified, intake, makeContext({ isNorthAmerica: true }));
      // Options should mention inches (via " character)
      assert.ok(result.items[0].options[0].formatted.includes('"'));
    });

    it('includes fabric delta in cm for non-North America', async () => {
      const intake = makeIntake({
        items: [makeItem({ issue: 'too_tight', size: '10' })],
        _latestMessage: 'too tight',
      });
      const classified = [makeClassified({ direction: 'up' })];
      const result = await prescribeSizingResolution(classified, intake, makeContext({ isNorthAmerica: false }));
      assert.ok(result.items[0].options[0].formatted.includes('cm'));
    });

    it('uses bra band wording for bra products', async () => {
      const intake = makeIntake({
        items: [makeItem({ issue: 'too_tight', size: 'M', product: 'THE BROOKE SHAPING BRA' })],
        _latestMessage: 'too tight',
      });
      const classified = [makeClassified({ product: 'THE BROOKE SHAPING BRA', size: 'M', direction: 'up' })];
      const result = await prescribeSizingResolution(classified, intake, makeContext());
      assert.ok(result.items[0].options[0].formatted.includes('bra band'));
    });

    it('uses torso wording for top products', async () => {
      const intake = makeIntake({
        items: [makeItem({ issue: 'too_tight', size: 'M', product: 'THE SUNNY QUEENY TANKINI' })],
        _latestMessage: 'too tight',
      });
      const classified = [makeClassified({ product: 'THE SUNNY QUEENY TANKINI', size: 'M', direction: 'up' })];
      const result = await prescribeSizingResolution(classified, intake, makeContext());
      assert.ok(result.items[0].options[0].formatted.includes('torso'));
    });
  });

  describe('sizing_exchange: desired_size', () => {
    it('auto-confirms when desired_size delta <= 2 inches', async () => {
      const intake = makeIntake({
        items: [makeItem({ size: 'S', desired_size: 'M' })],
      });
      const classified = [makeClassified({ size: 'S', direction: 'up' })];
      const result = await prescribeSizingResolution(classified, intake, makeContext());
      assert.equal(result.items[0].state, 'CONFIRMED');
      assert.equal(intake.items[0].resolved_size, 'M');
    });

    it('asks confirmation when desired_size delta > 2 inches', async () => {
      const intake = makeIntake({
        items: [makeItem({ size: 'S', desired_size: '1X' })],
      });
      const classified = [makeClassified({ size: 'S', direction: 'up' })];
      const result = await prescribeSizingResolution(classified, intake, makeContext());
      assert.equal(result.items[0].state, 'AWAITING_SIZE_CONFIRMATION');
      assert.ok(result.items[0].response_text.includes('1X'));
    });
  });

  describe('sizing_exchange: boundary crossover', () => {
    it('youth 16 going up → adult L with confirmation (lower confidence)', async () => {
      const intake = makeIntake({
        items: [makeItem({ issue: 'too_tight', size: '16' })],
        _latestMessage: 'too tight',
      });
      const classified = [makeClassified({ size: '16', direction: 'up' })];
      const result = await prescribeSizingResolution(classified, intake, makeContext());
      assert.equal(result.items[0].state, 'AWAITING_SIZE_CONFIRMATION');
      assert.ok(result.items[0].response_text.includes('adult sizing'));
    });

    it('youth 16 going up → auto-confirm with "a bit"', async () => {
      const intake = makeIntake({
        items: [makeItem({ issue: 'close_fit_tight', size: '16' })],
        _latestMessage: 'a bit tight',
      });
      const classified = [makeClassified({ size: '16', direction: 'up' })];
      const result = await prescribeSizingResolution(classified, intake, makeContext());
      assert.equal(result.items[0].state, 'CONFIRMED');
      assert.equal(intake.items[0].resolved_size, 'L');
    });

    it('adult XXS going down → youth 16', async () => {
      const intake = makeIntake({
        items: [makeItem({ issue: 'too_loose', size: 'XXS' })],
        _latestMessage: 'too loose',
      });
      const classified = [makeClassified({ size: 'XXS', direction: 'down' })];
      const result = await prescribeSizingResolution(classified, intake, makeContext());
      assert.equal(result.items[0].state, 'AWAITING_SIZE_CONFIRMATION');
      assert.ok(result.items[0].response_text.includes('youth sizing'));
    });

    it('at bottom boundary (size 4 down) → asks for measurement', async () => {
      const intake = makeIntake({
        items: [makeItem({ issue: 'too_loose', size: '4' })],
        _latestMessage: 'too loose',
      });
      const classified = [makeClassified({ size: '4', direction: 'down' })];
      const result = await prescribeSizingResolution(classified, intake, makeContext());
      assert.equal(result.items[0].state, 'AWAITING_MEASUREMENT');
      assert.ok(result.items[0].response_text.includes('smallest'));
    });
  });

  describe('sizing_exchange_measurement', () => {
    it('asks for measurement when none provided', async () => {
      const intake = makeIntake({
        items: [makeItem({ issue: 'way_off' })],
      });
      const classified = [makeClassified({ action: 'sizing_exchange_measurement', size: '10' })];
      const result = await prescribeSizingResolution(classified, intake, makeContext());
      assert.equal(result.items[0].state, 'AWAITING_MEASUREMENT');
      assert.ok(result.items[0].response_text.includes('measurement'));
    });
  });

  describe('style_switch', () => {
    it('recommends Cheeky for swim product', async () => {
      const intake = makeIntake({
        items: [makeItem({ issue: 'tight_legs', product: 'THE RUBY NO-TUCK SHAPING BIKINI BOTTOM', size: 'M' })],
      });
      const classified = [makeClassified({ action: 'style_switch', product: 'THE RUBY NO-TUCK SHAPING BIKINI BOTTOM', size: 'M' })];
      const result = await prescribeSizingResolution(classified, intake, makeContext());
      assert.equal(result.items[0].state, 'AWAITING_STYLE_CONFIRMATION');
      assert.ok(result.items[0].response_text.includes('Cheeky'));
    });

    it('recommends Flo for kids product (numeric size)', async () => {
      const intake = makeIntake({
        items: [makeItem({ issue: 'tight_legs', size: '10' })],
      });
      const classified = [makeClassified({ action: 'style_switch', size: '10' })];
      const result = await prescribeSizingResolution(classified, intake, makeContext());
      assert.equal(result.items[0].state, 'AWAITING_STYLE_CONFIRMATION');
      assert.ok(result.items[0].response_text.includes('Flo'));
    });

    it('recommends Sassy for adult underwear (letter size)', async () => {
      const intake = makeIntake({
        items: [makeItem({ issue: 'tight_legs', size: 'M' })],
      });
      const classified = [makeClassified({ action: 'style_switch', size: 'M' })];
      const result = await prescribeSizingResolution(classified, intake, makeContext());
      assert.equal(result.items[0].state, 'AWAITING_STYLE_CONFIRMATION');
      assert.ok(result.items[0].response_text.includes('Sassy'));
    });

    it('recommends Sassy for size 16 (youth/adult boundary)', async () => {
      const intake = makeIntake({
        items: [makeItem({ issue: 'tight_legs', size: '16', product: 'THE FLO SHAPING DANCE UNDERWEAR' })],
        _latestMessage: 'The Flo size 16 is too tight on the legs.',
      });
      const classified = [makeClassified({ action: 'style_switch', product: 'THE FLO SHAPING DANCE UNDERWEAR', size: '16' })];
      const result = await prescribeSizingResolution(classified, intake, makeContext());
      assert.equal(result.items[0].state, 'AWAITING_STYLE_CONFIRMATION');
      assert.ok(result.items[0].response_text.includes('Sassy'), 'Size 16 should recommend Sassy (adult), not Flo');
      assert.ok(!result.items[0].response_text.includes('Flo'), 'Size 16 should not recommend Flo (youth)');
    });

    it('suggests sizing up when already on widest leg product (Sassy)', async () => {
      const intake = makeIntake({
        items: [makeItem({ issue: 'tight_legs', size: 'L', product: 'THE SASSY NO-TUCK SHAPING UNDERWEAR' })],
        _latestMessage: 'The Sassy is too tight around the legs.',
      });
      const classified = [makeClassified({ action: 'style_switch', product: 'THE SASSY NO-TUCK SHAPING UNDERWEAR', size: 'L' })];
      const result = await prescribeSizingResolution(classified, intake, makeContext());
      assert.equal(result.items[0].state, 'AWAITING_SIZE_CONFIRMATION');
      assert.ok(result.items[0].response_text.includes('widest leg opening'));
      assert.ok(result.items[0].response_text.includes('Sizing up'));
    });

    it('asks for waist measurement when waist not mentioned', async () => {
      const intake = makeIntake({
        items: [makeItem({ issue: 'tight_legs', size: '10' })],
        _latestMessage: 'The leg holes are too tight on her thighs.',
      });
      const classified = [makeClassified({ action: 'style_switch', size: '10' })];
      const result = await prescribeSizingResolution(classified, intake, makeContext());
      assert.ok(result.items[0].response_text.includes('measurement'), 'Should ask for waist measurement when waist not mentioned');
    });

    it('skips measurement ask when waist confirmed fine', async () => {
      const intake = makeIntake({
        items: [makeItem({ issue: 'tight_legs', size: '10' })],
        _latestMessage: 'The waist fits fine but the legs are too tight.',
      });
      const classified = [makeClassified({ action: 'style_switch', size: '10' })];
      const result = await prescribeSizingResolution(classified, intake, makeContext());
      assert.ok(!result.items[0].response_text.includes('measurement'), 'Should not ask for measurement when waist confirmed fine');
    });
  });

  describe('refund', () => {
    it('probes what went wrong on initial refund request', async () => {
      const intake = makeIntake({
        items: [makeItem({ issue: 'refund_request' })],
      });
      const classified = [makeClassified({ action: 'refund' })];
      const ctx = makeContext({ targetOrder: makeOrder() });
      const result = await prescribeSizingResolution(classified, intake, ctx);
      assert.equal(result.items[0].state, 'AWAITING_CLARIFICATION');
      assert.ok(result.items[0].response_text.includes('what didn'));
      assert.ok(intake._returnProbed['THE AJ NO-TUCK SHAPING UNDERWEAR']);
    });

    it('offers exchange after probing', async () => {
      const intake = makeIntake({
        items: [makeItem({ issue: 'refund_request' })],
        _returnProbed: { 'THE AJ NO-TUCK SHAPING UNDERWEAR': true },
      });
      const classified = [makeClassified({ action: 'refund' })];
      const ctx = makeContext({ targetOrder: makeOrder() });
      const result = await prescribeSizingResolution(classified, intake, ctx);
      assert.equal(result.items[0].state, 'AWAITING_DECISION');
      assert.ok(result.items[0].response_text.includes('swap'));
      assert.ok(intake._exchangeOffered['THE AJ NO-TUCK SHAPING UNDERWEAR']);
    });

    it('confirms refund when exchange already offered', async () => {
      const intake = makeIntake({
        items: [makeItem({ issue: 'refund_request' })],
        _returnProbed: { 'THE AJ NO-TUCK SHAPING UNDERWEAR': true },
        _exchangeOffered: { 'THE AJ NO-TUCK SHAPING UNDERWEAR': true },
      });
      const classified = [makeClassified({ action: 'refund' })];
      const ctx = makeContext({ targetOrder: makeOrder() });
      const result = await prescribeSizingResolution(classified, intake, ctx);
      assert.equal(result.items[0].state, 'REFUND_CONFIRMED');
      assert.equal(result.items[0].refund_confirmed, true);
    });
  });

  describe('defect', () => {
    it('routes to human with apology and photo request', async () => {
      const intake = makeIntake({ items: [makeItem({ issue: 'defect' })] });
      const classified = [makeClassified({ action: 'defect' })];
      const result = await prescribeSizingResolution(classified, intake, makeContext());
      assert.equal(result.items[0].state, 'ESCALATE_TO_HUMAN');
      assert.equal(result.items[0].route_to_human, true);
      assert.equal(result.items[0].skip_donation, true);
      assert.ok(result.items[0].response_text.includes('photo'));
      assert.ok(result.items[0].response_text.includes('sorry'));
    });
  });

  describe('fit_direction_unclear', () => {
    it('asks about waist for bottom product', async () => {
      const intake = makeIntake({ items: [makeItem({ issue: 'doesnt_fit' })] });
      const classified = [makeClassified({ action: 'fit_direction_unclear' })];
      const result = await prescribeSizingResolution(classified, intake, makeContext());
      assert.equal(result.items[0].state, 'AWAITING_CLARIFICATION');
      assert.ok(result.items[0].response_text.includes('waist'));
    });

    it('asks about top for bra product', async () => {
      const intake = makeIntake({
        items: [makeItem({ issue: 'doesnt_fit', product: 'THE BROOKE SHAPING BRA' })],
      });
      const classified = [makeClassified({ action: 'fit_direction_unclear', product: 'THE BROOKE SHAPING BRA' })];
      const result = await prescribeSizingResolution(classified, intake, makeContext());
      assert.ok(result.items[0].response_text.includes('up top'));
    });

    it('asks onepiece-specific question for Sky', async () => {
      const intake = makeIntake({
        items: [makeItem({ issue: 'doesnt_fit', product: 'THE SKY NO-TUCK SHAPING ONE-PIECE' })],
      });
      const classified = [makeClassified({ action: 'fit_direction_unclear', product: 'THE SKY NO-TUCK SHAPING ONE-PIECE' })];
      const result = await prescribeSizingResolution(classified, intake, makeContext());
      assert.ok(result.items[0].response_text.includes('bottom'));
      assert.ok(result.items[0].response_text.includes('top'));
    });
  });

  describe('expectation_mismatch', () => {
    it('explains shaping vs tucking for bottoms', async () => {
      const intake = makeIntake({
        items: [makeItem({ issue: 'expectation_mismatch' })],
      });
      const classified = [makeClassified({ action: 'expectation_mismatch' })];
      const result = await prescribeSizingResolution(classified, intake, makeContext());
      assert.equal(result.items[0].state, 'AWAITING_DECISION');
      assert.ok(result.items[0].response_text.includes('shaping'));
      assert.ok(result.items[0].response_text.includes('tucking'));
    });
  });

  describe('third-party adaptation', () => {
    it('adapts wording for third-party buying', async () => {
      const intake = makeIntake({
        buying_for: 'third_party',
        third_party_label: 'daughter',
        items: [makeItem({ issue: 'product_not_working' })],
      });
      const classified = [makeClassified({ action: 'probe_needed' })];
      const result = await prescribeSizingResolution(classified, intake, makeContext());
      assert.ok(result.items[0].response_text.includes('daughter'));
    });
  });

  describe('exchange_confirmed', () => {
    it('state CONFIRMED with no response needed', async () => {
      const intake = makeIntake({
        items: [makeItem({ resolved_size: 'M' })],
      });
      const classified = [makeClassified({ action: 'exchange_confirmed' })];
      const result = await prescribeSizingResolution(classified, intake, makeContext());
      assert.equal(result.items[0].state, 'CONFIRMED');
      assert.equal(result.items[0].response_text, null);
    });
  });
});

// ============================================================================
// Phase 5: Order Creation
// ============================================================================

describe('prescribeOrderCreation', () => {
  it('returns null when no items have resolved_size', () => {
    const intake = makeIntake({ items: [makeItem()] });
    assert.equal(prescribeOrderCreation(intake), null);
  });

  it('returns order creation for resolved items', () => {
    const intake = makeIntake({
      items: [makeItem({ resolved_size: '12' })],
    });
    const result = prescribeOrderCreation(intake);
    assert.equal(result.phase, 'create_order');
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].from_size, '10');
    assert.equal(result.items[0].to_size, '12');
  });

  it('includes only resolved items, skips unresolved', () => {
    const intake = makeIntake({
      items: [
        makeItem({ resolved_size: '12' }),
        makeItem({ product: 'THE BROOKE SHAPING BRA', size: 'M', resolved_size: null }),
      ],
    });
    const result = prescribeOrderCreation(intake);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].product, 'THE AJ NO-TUCK SHAPING UNDERWEAR');
  });
});

// ============================================================================
// Phase 6: Donation Routing
// ============================================================================

describe('prescribeDonationRouting', () => {
  it('skips for all-defect items', async () => {
    const intake = makeIntake({ items: [makeItem({ issue: 'defect' })] });
    const result = await prescribeDonationRouting(intake, makeContext());
    assert.equal(result.skip, true);
  });

  it('asks for country when missing', async () => {
    const intake = makeIntake({ items: [makeItem({ issue: 'close_fit_tight' })] });
    const result = await prescribeDonationRouting(intake, makeContext({ customerCountry: null }));
    assert.ok(result.response_text.includes('shipping address'));
  });

  it('suggests local donation for single item when partners exist', async () => {
    mockSupabaseData.partners = [{ id: 1, name: 'Test Org', donations_routed: 0 }];
    const intake = makeIntake({ items: [makeItem({ issue: 'close_fit_tight' })] });
    const ctx = makeContext({
      targetOrder: makeOrder({ lineItems: [{ title: 'THE AJ NO-TUCK SHAPING UNDERWEAR', quantity: 1 }] }),
    });
    const result = await prescribeDonationRouting(intake, ctx);
    assert.equal(result.type, 'local_single');
  });

  it('suggests local donation when no partners in country', async () => {
    mockSupabaseData.partners = [];
    const intake = makeIntake({ items: [makeItem({ issue: 'close_fit_tight' })] });
    const ctx = makeContext({
      targetOrder: makeOrder({
        lineItems: [
          { title: 'THE AJ NO-TUCK SHAPING UNDERWEAR', quantity: 3 },
        ],
      }),
    });
    const result = await prescribeDonationRouting(intake, ctx);
    assert.equal(result.type, 'local_no_partner');
  });

  it('balances by trailing-window item volume from donation_routings, not lifetime counters', async () => {
    // X looks idle by lifetime counter (0) but heavy in the window (20 items);
    // Y looks busy by counter (99) but has nothing recent. Windowed loads must
    // favor Y. rng=0.5 lands on Y under windowed loads (weights 1/21 vs 1) and
    // would land on X under counter-based loads (weights 1 vs 1/100).
    mockSupabaseData.partners = [
      { id: 1, name: 'Partner X', city: 'X City', donations_routed: 0 },
      { id: 2, name: 'Partner Y', city: 'Y City', donations_routed: 99 },
    ];
    mockSupabaseData.routings = [
      { partner_id: 1, items_count: 12 },
      { partner_id: 1, items_count: 8 },
    ];
    mockSupabaseData.routingsError = false;
    const intake = makeIntake({ items: [makeItem({ issue: 'close_fit_tight' })] });
    const ctx = makeContext({
      targetOrder: makeOrder({ lineItems: [{ title: 'THE AJ NO-TUCK SHAPING UNDERWEAR', quantity: 3 }] }),
    });
    ctx._rng = () => 0.5;
    const result = await prescribeDonationRouting(intake, ctx);
    assert.equal(result.type, 'partner');
    assert.equal(result.partner.name, 'Partner Y');
    assert.ok(result.audit.includes('0 items routed in last 90d'));
  });

  it('falls back to lifetime counters when the routings log is unreadable', async () => {
    mockSupabaseData.partners = [
      { id: 1, name: 'Partner X', city: 'X City', donations_routed: 50 },
      { id: 2, name: 'Partner Y', city: 'Y City', donations_routed: 0 },
    ];
    mockSupabaseData.routings = [];
    mockSupabaseData.routingsError = true;
    const intake = makeIntake({ items: [makeItem({ issue: 'close_fit_tight' })] });
    const ctx = makeContext({
      targetOrder: makeOrder({ lineItems: [{ title: 'THE AJ NO-TUCK SHAPING UNDERWEAR', quantity: 3 }] }),
    });
    ctx._rng = () => 0.5; // weights 1/51 vs 1 → lands on Y
    const result = await prescribeDonationRouting(intake, ctx);
    assert.equal(result.partner.name, 'Partner Y');
    mockSupabaseData.routingsError = false;
  });

  it('renders the partner description verbatim and the wash reminder on its own line', async () => {
    mockSupabaseData.partners = [{
      id: 1,
      name: 'Test Org',
      mailing_address: 'RUBIES Returns\nc/o Test Org\n1 Main St\nBoston, MA\n02101',
      description: 'We have bins around the space with affirming items, free of charge.',
      donations_routed: 0,
    }];
    const intake = makeIntake({ items: [makeItem({ issue: 'close_fit_tight' })] });
    const ctx = makeContext({
      targetOrder: makeOrder({
        lineItems: [{ title: 'THE AJ NO-TUCK SHAPING UNDERWEAR', quantity: 3 }],
      }),
    });
    const result = await prescribeDonationRouting(intake, ctx);
    assert.equal(result.type, 'partner');
    // Description shown as authored — not spliced after "They" and lowercased.
    assert.ok(result.response_text.includes('We have bins around the space with affirming items, free of charge.'));
    assert.ok(!result.response_text.includes('They we have bins'));
    // Canonical lead-in appears between the program explanation and the address.
    assert.ok(result.response_text.includes('We are working with LGBTQ+ organizations that accept donations for distribution in their gender affirming clothing programs.'));
    assert.ok(result.response_text.includes('With this in mind can you please send the items you are returning to:'));
    // Wash reminder carries the worn/tried-on vs new-with-tags distinction.
    assert.ok(result.response_text.includes('Please wash any items that have been worn or tried on before they are returned.'));
    assert.ok(result.response_text.includes('Anything still new with tags can be sent as is.'));
  });
});

describe('pickWeightedByLoad', () => {
  const { pickWeightedByLoad } = require('../lib/donationRouting');
  // Candidates in distance order: A load 0 (w=1), B load 1 (w=0.5), C load 3
  // (w=0.25). Total weight 1.75; buckets: A [0,1), B [1,1.5), C [1.5,1.75).
  const candidates = [
    { name: 'A', load: 0 },
    { name: 'B', load: 1 },
    { name: 'C', load: 3 },
  ];
  const getLoad = c => c.load;

  it('lands in the correct bucket for each rng value', () => {
    assert.equal(pickWeightedByLoad(candidates, getLoad, () => 0.5).name, 'A');   // 0.875
    assert.equal(pickWeightedByLoad(candidates, getLoad, () => 0.6).name, 'B');   // 1.05
    assert.equal(pickWeightedByLoad(candidates, getLoad, () => 0.99).name, 'C');  // 1.7325
  });

  it('never fully excludes a loaded candidate', () => {
    // rng just under 1 always resolves to the last candidate — a heavily
    // loaded partner still has a nonzero share (the anti-blackout property).
    const heavy = [{ name: 'new', load: 0 }, { name: 'old', load: 1000 }];
    assert.equal(pickWeightedByLoad(heavy, getLoad, () => 0.9999).name, 'old');
  });

  it('handles a single candidate and missing loads', () => {
    assert.equal(pickWeightedByLoad([{ name: 'only' }], () => undefined).name, 'only');
  });
});

// Phase 7: Positive Feedback — now handled by AI parser (intake._positiveFeedback)
// No deterministic tests needed — the AI parser sets the flag

// ============================================================================
// walkTree Integration Tests
// ============================================================================

describe('walkTree', () => {
  it('returns safety_override when AI parser detects safety concern', async () => {
    const intake = makeIntake({ _safety_concern: true });
    const result = await walkTree(intake, makeContext());
    assert.equal(result.status, 'safety_override');
    assert.ok(result.response_parts.length > 0);
    assert.equal(result.response_parts[0].priority, 0);
    // Should short-circuit — no other phases
    assert.ok(!result.phases_completed.includes('identify_customer'));
  });

  it('does not trigger safety_override when no safety concern', async () => {
    const intake = makeIntake({ _latestMessage: 'The size is too big' });
    const result = await walkTree(intake, makeContext({ fulfilled: [makeOrder()] }));
    assert.notEqual(result.status, 'safety_override');
    assert.ok(result.phases_completed.includes('safety_check'));
  });

  it('returns gathering status when no items', async () => {
    const intake = makeIntake();
    const ctx = makeContext({
      fulfilled: [makeOrder()],
    });
    const result = await walkTree(intake, ctx);
    assert.equal(result.status, 'gathering');
  });

  it('full happy path: a bit tight → auto-confirm → ready', async () => {
    const intake = makeIntake({
      name: 'Alex',
      items: [makeItem({ issue: 'close_fit_tight', size: '10' })],
      _latestMessage: 'it is a bit tight',
    });
    const order = makeOrder({
      lineItems: [{ title: 'THE AJ NO-TUCK SHAPING UNDERWEAR', variantTitle: '10', quantity: 1 }],
    });
    const ctx = makeContext({
      targetOrder: order,
      fulfilled: [order],
    });

    // Mock partners for donation routing
    mockSupabaseData.partners = [];

    const result = await walkTree(intake, ctx);
    assert.equal(result.status, 'ready');
    assert.ok(result.phases_completed.includes('safety_check'));
    assert.ok(result.phases_completed.includes('identify_customer'));
    // AJ is underwear (even sizes: 4,6,8,10,12,14,16), so next up from 10 is 12
    assert.equal(intake.items[0].resolved_size, '12');
  });

  it('"a bit short" in message does not trigger isABit for sizing confidence', async () => {
    const intake = makeIntake({
      items: [makeItem({ issue: 'close_fit_tight', size: 'M', product: 'THE SKY NO-TUCK SHAPING ONE-PIECE' })],
      _latestMessage: 'It\'s too tight around the waist but also a bit short in the torso',
    });
    const order = makeOrder({
      lineItems: [{ title: 'THE SKY NO-TUCK SHAPING ONE-PIECE', variantTitle: 'M Tall', sku: 'SKY2-BLK-MT', quantity: 1 }],
    });
    const ctx = makeContext({ targetOrder: order, fulfilled: [order] });
    mockSupabaseData.partners = [];
    const result = await walkTree(intake, ctx);
    // Should NOT auto-confirm — "a bit short" is not "a bit tight"
    assert.notEqual(result.status, 'ready');
    const itemAction = result.response_parts.find(p => p.type === 'item_action');
    assert.ok(itemAction);
    assert.notEqual(itemAction.state, 'CONFIRMED');
  });

  it('sorts response_parts by priority', async () => {
    const intake = makeIntake({
      items: [makeItem({ issue: 'too_tight', size: '10' })],
      _latestMessage: 'I love rubies! but it is too tight',
    });
    const order = makeOrder({
      lineItems: [{ title: 'THE AJ NO-TUCK SHAPING UNDERWEAR', variantTitle: '10', quantity: 1 }],
    });
    const ctx = makeContext({
      targetOrder: order,
      fulfilled: [order],
    });
    mockSupabaseData.partners = [];

    const result = await walkTree(intake, ctx);
    // Check that parts are sorted by priority
    for (let i = 1; i < result.response_parts.length; i++) {
      assert.ok(
        result.response_parts[i].priority >= result.response_parts[i - 1].priority,
        `Part ${i} priority ${result.response_parts[i].priority} should be >= part ${i - 1} priority ${result.response_parts[i - 1].priority}`,
      );
    }
  });

  // ── End-to-end scenario tests ──
  // These test the full chain: intake → all phases → status + response_parts + still_needed

  it('swim bottom: desired size → presents half-step options, holds for confirmation, includes measurement ask', async () => {
    const intake = makeIntake({
      items: [makeItem({ product: 'THE RUBY NO-TUCK SHAPING BIKINI BOTTOM', size: '11', issue: 'close_fit_loose', desired_size: '10' })],
      _latestMessage: 'too big, can I get a 10',
    });
    const order = makeOrder({
      lineItems: [{ title: 'THE RUBY NO-TUCK SHAPING BIKINI BOTTOM', variantTitle: 'Black / 11', quantity: 2, sku: 'RUBY-BLK-11' }],
    });
    mockSupabaseData.partners = [];
    const result = await walkTree(intake, makeContext({ targetOrder: order, fulfilled: [order] }));
    // Should NOT be ready — waiting for size confirmation
    assert.equal(result.status, 'needs_info');
    assert.equal(intake.items[0].resolved_size, null);
    // Should have item_action with options
    const itemAction = result.response_parts.find(p => p.type === 'item_action');
    assert.ok(itemAction);
    assert.equal(itemAction.state, 'AWAITING_SIZE_CONFIRMATION');
    assert.ok(itemAction.options);
    assert.ok(itemAction.options.length <= 2);
    // Options should reference the current size
    assert.ok(itemAction.options[0].formatted.includes('compared to the 11'));
    // Should include measurement ask
    assert.ok(itemAction.text.includes('measurement'));
  });

  it('underwear: desired size → auto-confirms with measurement note + delta, creates order', async () => {
    mockSupabaseData.sizeMatches = [{ size_label: 'M' }];
    const intake = makeIntake({
      name: 'Vera',
      items: [makeItem({ product: 'THE SASSY NO-TUCK SHAPING UNDERWEAR', size: 'M', issue: 'close_fit_tight', desired_size: 'L' })],
      measurement: { value: 31, unit: 'inches', body_part: 'waist' },
      _latestMessage: 'too tight, waist is 31 inches, want a large',
    });
    const order = makeOrder({
      lineItems: [{ title: 'THE SASSY NO-TUCK SHAPING UNDERWEAR', variantTitle: 'Pink / M', quantity: 1, sku: 'HLA-PNK-M' }],
    });
    mockSupabaseData.partners = [];
    const result = await walkTree(intake, makeContext({ targetOrder: order, fulfilled: [order] }));
    assert.equal(result.status, 'ready');
    assert.equal(intake.items[0].resolved_size, 'L');
    // Should have measurement note in response parts
    const measureNote = result.response_parts.find(p => p.type === 'item_action' && p.text?.includes('sizing chart'));
    assert.ok(measureNote, 'Should include measurement note');
    assert.ok(measureNote.text.includes('exceptions'));
    assert.ok(measureNote.text.includes('compared to the M'));
    mockSupabaseData.sizeMatches = [];
  });

  it('swim + underwear mixed order: exchanging underwear does NOT flag swim items', async () => {
    const intake = makeIntake({
      name: 'Vera',
      items: [makeItem({ product: 'THE SASSY NO-TUCK SHAPING UNDERWEAR', size: 'M', issue: 'close_fit_tight' })],
      _latestMessage: 'a bit tight',
    });
    const order = makeOrder({
      lineItems: [
        { title: 'THE SASSY NO-TUCK SHAPING UNDERWEAR', variantTitle: 'Pink / M', quantity: 1, sku: 'HLA-PNK-M' },
        { title: 'THE CHEEKY NO-TUCK SHAPING BIKINI BOTTOM', variantTitle: 'Black / M', quantity: 1, sku: 'CKY-BLK-M' },
        { title: 'THE RUBY NO-TUCK SHAPING BIKINI BOTTOM', variantTitle: 'Black / M', quantity: 1, sku: 'RUBY-BLK-M' },
      ],
    });
    mockSupabaseData.partners = [];
    const result = await walkTree(intake, makeContext({ targetOrder: order, fulfilled: [order] }));
    // Should auto-confirm (underwear, "a bit tight")
    assert.equal(result.status, 'ready');
    // Should NOT have multi-item flags (swim ≠ underwear body group)
    const multiFlags = result.response_parts.filter(p => p.type === 'multi_item_flag');
    assert.equal(multiFlags.length, 0);
  });

  it('swim order with multiple swim products: flags other swim items and holds order', async () => {
    const intake = makeIntake({
      name: 'Test',
      items: [makeItem({ product: 'THE RUBY NO-TUCK SHAPING BIKINI BOTTOM', size: 'M', issue: 'close_fit_tight', resolved_size: 'L' })],
      _latestMessage: 'a bit tight',
      resolution_sizes: [{ product: 'THE RUBY NO-TUCK SHAPING BIKINI BOTTOM', from_size: 'M', to_size: 'L' }],
    });
    const order = makeOrder({
      lineItems: [
        { title: 'THE RUBY NO-TUCK SHAPING BIKINI BOTTOM', variantTitle: 'Black / M', quantity: 1, sku: 'RUBY-BLK-M' },
        { title: 'THE STELLA HIGH WAISTED SHAPING BIKINI BOTTOM', variantTitle: 'Black / M', quantity: 1, sku: 'STL-BLK-M' },
      ],
    });
    mockSupabaseData.partners = [];
    const result = await walkTree(intake, makeContext({ targetOrder: order, fulfilled: [order] }));
    // Multi-item flag should fire (both swim bottoms)
    const multiFlags = result.response_parts.filter(p => p.type === 'multi_item_flag');
    assert.ok(multiFlags.length > 0, 'Should flag Stella');
    // Should hold order — needs_info, not ready
    assert.equal(result.status, 'needs_info');
  });

  it('one-piece return: probes with measurement offer and alternative mention', async () => {
    const intake = makeIntake({
      items: [makeItem({ product: 'THE SKY NO-TUCK SHAPING ONE-PIECE', size: 'L', issue: 'refund_request' })],
      _latestMessage: 'want to return the one-piece, not comfortable',
    });
    const order = makeOrder({
      lineItems: [
        { title: 'THE SKY NO-TUCK SHAPING ONE-PIECE', variantTitle: 'Black / L', quantity: 1, sku: 'SKY2-BLK-L' },
        { title: 'THE RUBY NO-TUCK SHAPING BIKINI BOTTOM', variantTitle: 'Black / L', quantity: 1, sku: 'RUBY-BLK-L' },
      ],
    });
    const result = await walkTree(intake, makeContext({ targetOrder: order, fulfilled: [order] }));
    assert.equal(result.status, 'needs_info');
    // Should probe — not offer swap yet
    const itemAction = result.response_parts.find(p => p.type === 'item_action');
    assert.equal(itemAction.state, 'AWAITING_CLARIFICATION');
    assert.ok(itemAction.text.includes('one-piece'));
    assert.ok(itemAction.text.includes('height'));
    assert.ok(itemAction.text.includes('alternative'));
    // Should NOT flag the Ruby (one-piece ≠ swim_bottom body group)
    const multiFlags = result.response_parts.filter(p => p.type === 'multi_item_flag');
    assert.equal(multiFlags.length, 0);
  });

  it('one-piece doesnt fit → asks two-part question (waist + top)', async () => {
    const intake = makeIntake({
      items: [makeItem({ product: 'THE SKY NO-TUCK SHAPING ONE-PIECE', size: 'M', issue: 'doesnt_fit' })],
      _latestMessage: 'the one-piece doesnt fit right',
    });
    const order = makeOrder({
      lineItems: [{ title: 'THE SKY NO-TUCK SHAPING ONE-PIECE', variantTitle: 'Black / M', quantity: 1, sku: 'SKY2-BLK-M' }],
    });
    const result = await walkTree(intake, makeContext({ targetOrder: order, fulfilled: [order] }));
    assert.equal(result.status, 'needs_info');
    const itemAction = result.response_parts.find(p => p.type === 'item_action');
    assert.ok(itemAction.text.includes('waist'));
    assert.ok(itemAction.text.includes('top'));
  });

  it('one-piece too_short → asks for height + waist', async () => {
    const intake = makeIntake({
      items: [makeItem({ product: 'THE SKY NO-TUCK SHAPING ONE-PIECE', size: 'L', issue: 'too_short' })],
      _latestMessage: 'the one-piece is too short',
    });
    const order = makeOrder({
      lineItems: [{ title: 'THE SKY NO-TUCK SHAPING ONE-PIECE', variantTitle: 'Black / L', quantity: 1, sku: 'SKY2-BLK-L' }],
    });
    const result = await walkTree(intake, makeContext({ targetOrder: order, fulfilled: [order] }));
    assert.equal(result.status, 'needs_info');
    const itemAction = result.response_parts.find(p => p.type === 'item_action');
    assert.equal(itemAction.state, 'AWAITING_MEASUREMENT');
    assert.ok(itemAction.text.includes('height'));
    assert.ok(itemAction.text.includes('belly'));
  });
});

// ============================================================================
// Config-driven products (Naomi)
// ============================================================================

describe('Config-driven products', () => {
  it('Naomi is loaded as active product', () => {
    const naomi = _activeProducts['the-naomi-gaff-extra-strength-shaping-underwear'];
    assert.ok(naomi, 'Naomi should be in active products');
    assert.equal(naomi.nickname, 'Naomi');
  });

  it('Naomi nickname is registered', () => {
    assert.equal(getProductNickname('THE NAOMI GAFF EXTRA STRENGTH SHAPING UNDERWEAR'), 'Naomi');
  });

  it('Naomi is classified as underwear_bottom', () => {
    assert.equal(classifyProduct('THE NAOMI GAFF EXTRA STRENGTH SHAPING UNDERWEAR'), 'underwear_bottom');
  });

  it('classifyProduct matches "gaff" keyword too', () => {
    assert.equal(classifyProduct('Some gaff product'), 'underwear_bottom');
  });

  it('Naomi has size override XS–2X', () => {
    assert.ok(PRODUCT_SIZE_OVERRIDES.naomi, 'Should have naomi override');
    assert.deepEqual(PRODUCT_SIZE_OVERRIDES.naomi, ['XS', 'S', 'M', 'L', '1X', '2X']);
  });

  it('getSizeList returns Naomi range for Naomi product', () => {
    const list = getSizeList('M', 'THE NAOMI GAFF EXTRA STRENGTH SHAPING UNDERWEAR');
    assert.deepEqual(list, ['XS', 'S', 'M', 'L', '1X', '2X']);
  });

  it('getSizeList returns null for size outside Naomi range', () => {
    const list = getSizeList('XXS', 'THE NAOMI GAFF EXTRA STRENGTH SHAPING UNDERWEAR');
    assert.equal(list, null);
  });

  it('getAdjacentSizes respects Naomi boundary at 2X going up', () => {
    const result = getAdjacentSizes('2X', 'up', 2, 'THE NAOMI GAFF EXTRA STRENGTH SHAPING UNDERWEAR');
    assert.deepEqual(result, []);
  });

  it('getAdjacentSizes respects Naomi boundary at XS going down', () => {
    const result = getAdjacentSizes('XS', 'down', 2, 'THE NAOMI GAFF EXTRA STRENGTH SHAPING UNDERWEAR');
    assert.deepEqual(result, []);
  });

  it('getAdjacentSizes works within Naomi range', () => {
    const result = getAdjacentSizes('M', 'up', 2, 'THE NAOMI GAFF EXTRA STRENGTH SHAPING UNDERWEAR');
    assert.deepEqual(result, ['L', '1X']);
  });

  it('auto-confirms "a bit tight" for Naomi within range', async () => {
    const intake = makeIntake({
      items: [makeItem({ product: 'THE NAOMI GAFF EXTRA STRENGTH SHAPING UNDERWEAR', size: 'M', issue: 'close_fit_tight' })],
      _latestMessage: 'it is a bit tight',
    });
    const classified = [makeClassified({ product: 'THE NAOMI GAFF EXTRA STRENGTH SHAPING UNDERWEAR', size: 'M', direction: 'up' })];
    const result = await prescribeSizingResolution(classified, intake, makeContext());
    assert.equal(result.items[0].state, 'CONFIRMED');
    assert.equal(intake.items[0].resolved_size, 'L');
  });

  it('hits boundary for Naomi at 2X going up', async () => {
    const intake = makeIntake({
      items: [makeItem({ product: 'THE NAOMI GAFF EXTRA STRENGTH SHAPING UNDERWEAR', size: '2X', issue: 'too_tight' })],
      _latestMessage: 'too tight',
    });
    const classified = [makeClassified({ product: 'THE NAOMI GAFF EXTRA STRENGTH SHAPING UNDERWEAR', size: '2X', direction: 'up' })];
    const result = await prescribeSizingResolution(classified, intake, makeContext());
    // At boundary — should request measurement since no sizes available
    assert.equal(result.items[0].state, 'AWAITING_MEASUREMENT');
  });

  it('style switch for adult underwear recommends Sassy', async () => {
    const intake = makeIntake({
      items: [makeItem({ issue: 'tight_legs', size: 'M' })],
    });
    const classified = [makeClassified({ action: 'style_switch', size: 'M' })];
    const result = await prescribeSizingResolution(classified, intake, makeContext());
    assert.ok(result.items[0].response_text.includes('Sassy'));
  });
});

// ============================================================================
// Tier 4b: Swimwear — half-step sizing
// ============================================================================

describe('Half-step products (swim/onepiece) — desired size', () => {
  it('swim bottom: always presents options even for adjacent size (11→10)', async () => {
    const intake = makeIntake({
      items: [makeItem({ product: 'THE RUBY NO-TUCK SHAPING BIKINI BOTTOM', size: '11', issue: 'close_fit_loose', desired_size: '10' })],
      _latestMessage: 'too big, can I get a 10',
    });
    const classified = [makeClassified({ product: 'THE RUBY NO-TUCK SHAPING BIKINI BOTTOM', size: '11', direction: 'down' })];
    const result = await prescribeSizingResolution(classified, intake, makeContext());
    assert.equal(result.items[0].state, 'AWAITING_SIZE_CONFIRMATION');
    assert.ok(result.items[0].options.length <= 2);
  });

  it('swim bottom: caps options at 2 max (9→7 shows 8 and 7, not 6)', async () => {
    const intake = makeIntake({
      items: [makeItem({ product: 'THE SERENA NO-TUCK SHAPING SHORTY SHORT', size: '9', issue: 'too_loose', desired_size: '7' })],
      _latestMessage: 'too loose, want size 7',
    });
    const classified = [makeClassified({ product: 'THE SERENA NO-TUCK SHAPING SHORTY SHORT', size: '9', direction: 'down' })];
    const result = await prescribeSizingResolution(classified, intake, makeContext());
    assert.equal(result.items[0].options.length, 2);
    assert.equal(result.items[0].options[0].size, '8');
    assert.equal(result.items[0].options[1].size, '7');
  });

  it('swim bottom: bridge text when requested size is not first option', async () => {
    const intake = makeIntake({
      items: [makeItem({ product: 'THE RUBY NO-TUCK SHAPING BIKINI BOTTOM', size: '9', issue: 'too_loose', desired_size: '7' })],
      _latestMessage: 'too loose, want 7',
    });
    const classified = [makeClassified({ product: 'THE RUBY NO-TUCK SHAPING BIKINI BOTTOM', size: '9', direction: 'down' })];
    const result = await prescribeSizingResolution(classified, intake, makeContext());
    assert.ok(result.items[0].response_text.includes('half sizes'));
    assert.ok(result.items[0].response_text.includes('7'));
  });

  it('swim bottom: includes measurement ask for uncertain issue (too_loose)', async () => {
    const intake = makeIntake({
      items: [makeItem({ product: 'THE RUBY NO-TUCK SHAPING BIKINI BOTTOM', size: '11', issue: 'close_fit_loose', desired_size: '10' })],
      _latestMessage: 'too big',
    });
    const classified = [makeClassified({ product: 'THE RUBY NO-TUCK SHAPING BIKINI BOTTOM', size: '11', direction: 'down' })];
    const result = await prescribeSizingResolution(classified, intake, makeContext());
    assert.ok(result.items[0].response_text.includes('measurement'));
  });

  it('swim bottom: skips measurement ask when measurement already provided', async () => {
    const intake = makeIntake({
      items: [makeItem({ product: 'THE RUBY NO-TUCK SHAPING BIKINI BOTTOM', size: '11', issue: 'close_fit_loose', desired_size: '10' })],
      _latestMessage: 'too big, waist is 24 inches',
      measurement: { value: 24, unit: 'inches', body_part: 'waist' },
    });
    const classified = [makeClassified({ product: 'THE RUBY NO-TUCK SHAPING BIKINI BOTTOM', size: '11', direction: 'down' })];
    const result = await prescribeSizingResolution(classified, intake, makeContext());
    assert.ok(!result.items[0].response_text.includes('send me'));
  });

  it('underwear: auto-confirms desired size (no half-steps)', async () => {
    const intake = makeIntake({
      items: [makeItem({ product: 'THE AJ NO-TUCK SHAPING UNDERWEAR', size: 'M', issue: 'close_fit_tight', desired_size: 'L' })],
    });
    const classified = [makeClassified({ product: 'THE AJ NO-TUCK SHAPING UNDERWEAR', size: 'M', direction: 'up' })];
    const result = await prescribeSizingResolution(classified, intake, makeContext());
    assert.equal(result.items[0].state, 'CONFIRMED');
    assert.equal(intake.items[0].resolved_size, 'L');
  });

  it('underwear: auto-confirm includes delta FYI with reference size', async () => {
    const intake = makeIntake({
      items: [makeItem({ product: 'THE SASSY NO-TUCK SHAPING UNDERWEAR', size: 'M', issue: 'close_fit_tight', desired_size: 'L' })],
    });
    const classified = [makeClassified({ product: 'THE SASSY NO-TUCK SHAPING UNDERWEAR', size: 'M', direction: 'up' })];
    const result = await prescribeSizingResolution(classified, intake, makeContext());
    assert.ok(result.items[0].response_text.includes('compared to the M'));
  });

  it('options include "compared to" reference size', async () => {
    const intake = makeIntake({
      items: [makeItem({ product: 'THE CHEEKY NO-TUCK SHAPING BIKINI BOTTOM', size: 'M', issue: 'too_tight', desired_size: 'L' })],
      _latestMessage: 'too tight want L',
    });
    const classified = [makeClassified({ product: 'THE CHEEKY NO-TUCK SHAPING BIKINI BOTTOM', size: 'M', direction: 'up' })];
    const result = await prescribeSizingResolution(classified, intake, makeContext());
    assert.ok(result.items[0].options[0].formatted.includes('compared to the M'));
  });
});

describe('Measurement cross-reference with desired size', () => {
  it('notes when chart matches current size (exceptions phrasing)', async () => {
    mockSupabaseData.sizeMatches = [{ size_label: 'M' }];
    const intake = makeIntake({
      items: [makeItem({ product: 'THE SASSY NO-TUCK SHAPING UNDERWEAR', size: 'M', issue: 'close_fit_tight', desired_size: 'L' })],
      measurement: { value: 31, unit: 'inches', body_part: 'waist' },
    });
    const classified = [makeClassified({ product: 'THE SASSY NO-TUCK SHAPING UNDERWEAR', size: 'M', direction: 'up' })];
    const result = await prescribeSizingResolution(classified, intake, makeContext());
    assert.ok(result.items[0].response_text.includes('sizing chart puts you in the M range'));
    assert.ok(result.items[0].response_text.includes('exceptions'));
    mockSupabaseData.sizeMatches = [];
  });

  it('notes when chart agrees with requested size', async () => {
    mockSupabaseData.sizeMatches = [{ size_label: 'L' }];
    const intake = makeIntake({
      items: [makeItem({ product: 'THE SASSY NO-TUCK SHAPING UNDERWEAR', size: 'M', issue: 'close_fit_tight', desired_size: 'L' })],
      measurement: { value: 33, unit: 'inches', body_part: 'waist' },
    });
    const classified = [makeClassified({ product: 'THE SASSY NO-TUCK SHAPING UNDERWEAR', size: 'M', direction: 'up' })];
    const result = await prescribeSizingResolution(classified, intake, makeContext());
    assert.ok(result.items[0].response_text.includes('looks like a good fit'));
    mockSupabaseData.sizeMatches = [];
  });
});

// ============================================================================
// Tier 4c: One-piece — height variant
// ============================================================================

describe('One-piece height variant (too_short / too_long)', () => {
  it('classifies too_short as height_variant_check', () => {
    const intake = makeIntake({
      items: [makeItem({ product: 'THE SKY NO-TUCK SHAPING ONE-PIECE', size: 'L', issue: 'too_short' })],
    });
    const result = prescribeActionClassification(intake);
    assert.equal(result.items[0].action, 'height_variant_check');
    assert.equal(result.items[0].heightDirection, 'tall');
  });

  it('classifies too_long as height_variant_check', () => {
    const intake = makeIntake({
      items: [makeItem({ product: 'THE SKY NO-TUCK SHAPING ONE-PIECE', size: 'L', issue: 'too_long' })],
    });
    const result = prescribeActionClassification(intake);
    assert.equal(result.items[0].action, 'height_variant_check');
    assert.equal(result.items[0].heightDirection, 'regular');
  });

  it('asks for height + waist when no measurements', async () => {
    const intake = makeIntake({
      items: [makeItem({ product: 'THE SKY NO-TUCK SHAPING ONE-PIECE', size: 'L', issue: 'too_short' })],
    });
    const classified = [makeClassified({ product: 'THE SKY NO-TUCK SHAPING ONE-PIECE', size: 'L', action: 'height_variant_check', heightDirection: 'tall' })];
    const result = await prescribeSizingResolution(classified, intake, makeContext());
    assert.equal(result.items[0].state, 'AWAITING_MEASUREMENT');
    assert.ok(result.items[0].response_text.includes('height'));
    assert.ok(result.items[0].response_text.includes('belly'));
  });

  it('one-piece "too tight" options include height ask', async () => {
    const intake = makeIntake({
      items: [makeItem({ product: 'THE SKY NO-TUCK SHAPING ONE-PIECE', size: 'M', issue: 'too_tight' })],
      _latestMessage: 'too tight',
    });
    const classified = [makeClassified({ product: 'THE SKY NO-TUCK SHAPING ONE-PIECE', size: 'M', direction: 'up' })];
    const result = await prescribeSizingResolution(classified, intake, makeContext());
    assert.ok(result.items[0].response_text.includes('height'));
  });

  it('one-piece "way off" measurement ask includes height', async () => {
    const intake = makeIntake({
      items: [makeItem({ product: 'THE SKY NO-TUCK SHAPING ONE-PIECE', size: 'M', issue: 'way_off' })],
    });
    const classified = [makeClassified({ product: 'THE SKY NO-TUCK SHAPING ONE-PIECE', size: 'M', action: 'sizing_exchange_measurement' })];
    const result = await prescribeSizingResolution(classified, intake, makeContext());
    assert.ok(result.items[0].response_text.includes('height'));
  });
});

describe('parseSizeVariant and getSizeModifier', () => {
  it('parses LT as L + Tall', () => {
    const { base, modifier } = parseSizeVariant('LT');
    assert.equal(base, 'L');
    assert.equal(modifier, 'Tall');
  });

  it('parses MT as M + Tall', () => {
    const { base, modifier } = parseSizeVariant('MT');
    assert.equal(base, 'M');
    assert.equal(modifier, 'Tall');
  });

  it('parses "L Tall" as L + Tall', () => {
    const { base, modifier } = parseSizeVariant('L Tall');
    assert.equal(base, 'L');
    assert.equal(modifier, 'Tall');
  });

  it('parses "M Regular" as M + Regular', () => {
    const { base, modifier } = parseSizeVariant('M Regular');
    assert.equal(base, 'M');
    assert.equal(modifier, 'Regular');
  });

  it('parses plain "L" as L + null', () => {
    const { base, modifier } = parseSizeVariant('L');
    assert.equal(base, 'L');
    assert.equal(modifier, null);
  });

  it('normalizeSize strips variant modifier', () => {
    assert.equal(normalizeSize('LT'), 'L');
    assert.equal(normalizeSize('MT'), 'M');
    assert.equal(normalizeSize('L Tall'), 'L');
  });

  it('getSizeModifier returns modifier', () => {
    assert.equal(getSizeModifier('LT'), 'Tall');
    assert.equal(getSizeModifier('L Tall'), 'Tall');
    assert.equal(getSizeModifier('L'), null);
  });
});

// ============================================================================
// Multi-item flags — body groups and order hold
// ============================================================================

describe('Multi-item flags — body group separation', () => {
  it('does NOT flag swim bottom when exchanging underwear bottom', () => {
    const intake = makeIntake({
      items: [makeItem({ product: 'THE SASSY NO-TUCK SHAPING UNDERWEAR', size: 'M', issue: 'close_fit_tight' })],
    });
    const order = makeOrder({
      lineItems: [
        { title: 'THE SASSY NO-TUCK SHAPING UNDERWEAR', variantTitle: 'Pink / M', quantity: 1, sku: 'HLA-PNK-M' },
        { title: 'THE RUBY NO-TUCK SHAPING BIKINI BOTTOM', variantTitle: 'Black / M', quantity: 1, sku: 'RUBY-BLK-M' },
      ],
    });
    const result = prescribeOrderIdentification(intake, makeContext({ targetOrder: order }));
    const multiFlags = result.actions.filter(a => a.type === 'multi_item_flag');
    assert.equal(multiFlags.length, 0);
  });

  it('flags same-category product (swim bottom with swim bottom)', () => {
    const intake = makeIntake({
      items: [makeItem({ product: 'THE RUBY NO-TUCK SHAPING BIKINI BOTTOM', size: 'M', issue: 'close_fit_tight' })],
    });
    const order = makeOrder({
      lineItems: [
        { title: 'THE RUBY NO-TUCK SHAPING BIKINI BOTTOM', variantTitle: 'Black / M', quantity: 1, sku: 'RUBY-BLK-M' },
        { title: 'THE CHEEKY NO-TUCK SHAPING BIKINI BOTTOM', variantTitle: 'Black / M', quantity: 1, sku: 'CKY-BLK-M' },
      ],
    });
    const result = prescribeOrderIdentification(intake, makeContext({ targetOrder: order }));
    const multiFlags = result.actions.filter(a => a.type === 'multi_item_flag');
    assert.equal(multiFlags.length, 1);
    assert.ok(multiFlags[0].text.includes('Cheeky'));
  });

  it('does NOT flag one-piece when exchanging swim bottom', () => {
    const intake = makeIntake({
      items: [makeItem({ product: 'THE RUBY NO-TUCK SHAPING BIKINI BOTTOM', size: 'L', issue: 'close_fit_tight' })],
    });
    const order = makeOrder({
      lineItems: [
        { title: 'THE RUBY NO-TUCK SHAPING BIKINI BOTTOM', variantTitle: 'Black / L', quantity: 1, sku: 'RUBY-BLK-L' },
        { title: 'THE SKY NO-TUCK SHAPING ONE-PIECE', variantTitle: 'Black / L', quantity: 1, sku: 'SKY2-BLK-L' },
      ],
    });
    const result = prescribeOrderIdentification(intake, makeContext({ targetOrder: order }));
    const multiFlags = result.actions.filter(a => a.type === 'multi_item_flag');
    assert.equal(multiFlags.length, 0);
  });

  it('suppresses flags when _crossProductComparison is set', () => {
    const intake = makeIntake({
      items: [makeItem({ product: 'THE RUBY NO-TUCK SHAPING BIKINI BOTTOM', size: 'M', issue: 'close_fit_tight' })],
      _crossProductComparison: true,
    });
    const order = makeOrder({
      lineItems: [
        { title: 'THE RUBY NO-TUCK SHAPING BIKINI BOTTOM', variantTitle: 'Black / M', quantity: 1, sku: 'RUBY-BLK-M' },
        { title: 'THE CHEEKY NO-TUCK SHAPING BIKINI BOTTOM', variantTitle: 'Black / M', quantity: 1, sku: 'CKY-BLK-M' },
      ],
    });
    const result = prescribeOrderIdentification(intake, makeContext({ targetOrder: order }));
    const multiFlags = result.actions.filter(a => a.type === 'multi_item_flag');
    assert.equal(multiFlags.length, 0);
  });
});

describe('Multi-item flag holds order creation', () => {
  it('status is needs_info when multi-item flags are pending', async () => {
    const intake = makeIntake({
      name: 'Test',
      items: [makeItem({ product: 'THE RUBY NO-TUCK SHAPING BIKINI BOTTOM', size: 'M', issue: 'close_fit_tight', resolved_size: 'L' })],
      _latestMessage: 'a bit tight',
      resolution_sizes: [{ product: 'THE RUBY NO-TUCK SHAPING BIKINI BOTTOM', from_size: 'M', to_size: 'L' }],
    });
    const order = makeOrder({
      lineItems: [
        { title: 'THE RUBY NO-TUCK SHAPING BIKINI BOTTOM', variantTitle: 'Black / M', quantity: 1, sku: 'RUBY-BLK-M' },
        { title: 'THE CHEEKY NO-TUCK SHAPING BIKINI BOTTOM', variantTitle: 'Black / M', quantity: 1, sku: 'CKY-BLK-M' },
      ],
    });
    mockSupabaseData.partners = [];
    const result = await walkTree(intake, makeContext({ targetOrder: order, fulfilled: [order] }));
    assert.equal(result.status, 'needs_info');
  });

  it('status is ready when _multiItemAnswered is set', async () => {
    const intake = makeIntake({
      name: 'Test',
      items: [makeItem({ product: 'THE RUBY NO-TUCK SHAPING BIKINI BOTTOM', size: 'M', issue: 'close_fit_tight', resolved_size: 'L' })],
      _latestMessage: 'a bit tight',
      _multiItemAnswered: true,
      resolution_sizes: [{ product: 'THE RUBY NO-TUCK SHAPING BIKINI BOTTOM', from_size: 'M', to_size: 'L' }],
    });
    const order = makeOrder({
      lineItems: [
        { title: 'THE RUBY NO-TUCK SHAPING BIKINI BOTTOM', variantTitle: 'Black / M', quantity: 1, sku: 'RUBY-BLK-M' },
        { title: 'THE CHEEKY NO-TUCK SHAPING BIKINI BOTTOM', variantTitle: 'Black / M', quantity: 1, sku: 'CKY-BLK-M' },
      ],
    });
    mockSupabaseData.partners = [];
    const result = await walkTree(intake, makeContext({ targetOrder: order, fulfilled: [order] }));
    assert.equal(result.status, 'ready');
  });
});

// ============================================================================
// Refund probe before swap
// ============================================================================

describe('One-piece return probe', () => {
  it('probes with measurement offer for one-piece return', async () => {
    const intake = makeIntake({
      items: [makeItem({ product: 'THE SKY NO-TUCK SHAPING ONE-PIECE', size: 'L', issue: 'refund_request' })],
    });
    const classified = [makeClassified({ product: 'THE SKY NO-TUCK SHAPING ONE-PIECE', size: 'L', action: 'refund' })];
    const ctx = makeContext({ targetOrder: makeOrder() });
    const result = await prescribeSizingResolution(classified, intake, ctx);
    assert.equal(result.items[0].state, 'AWAITING_CLARIFICATION');
    assert.ok(result.items[0].response_text.includes('one-piece'));
    assert.ok(result.items[0].response_text.includes('height'));
    assert.ok(result.items[0].response_text.includes('alternative'));
  });
});

// ============================================================================
// Nickname-based isSameProduct matching
// ============================================================================

describe('isSameProduct — nickname matching', () => {
  it('matches intake "Serena Shorty Shorts" to order "THE SERENA NO-TUCK SHAPING SHORTY SHORT"', () => {
    const intake = makeIntake({
      items: [makeItem({ product: 'Serena Shorty Shorts', size: '9', issue: 'close_fit_loose' })],
    });
    const order = makeOrder({
      lineItems: [
        { title: 'THE SERENA NO-TUCK SHAPING SHORTY SHORT', variantTitle: 'Pink / 9', quantity: 1, sku: 'SHS-PNK-9' },
      ],
    });
    const result = prescribeOrderIdentification(intake, makeContext({ targetOrder: order }));
    const multiFlags = result.actions.filter(a => a.type === 'multi_item_flag');
    assert.equal(multiFlags.length, 0, 'Should not flag the same product as multi-item');
  });
});

// ---------------------------------------------------------------------------
// Clarification upgrade — regex-based issue upgrade when parser returns no items
// (Logic lives in aiAdvisor.js but is pure regex, testable standalone)
// ---------------------------------------------------------------------------
describe('clarification upgrade regex', () => {
  // Replicate the regex logic from aiAdvisor.js
  function applyClarification(messageText, items) {
    const msgLower = (messageText || '').toLowerCase();
    let clarifiedIssue = null;
    if (/too tight|too small|too snug|waist.*tight|tight.*waist/.test(msgLower)) clarifiedIssue = 'close_fit_tight';
    else if (/too loose|too big|too large|waist.*loose|loose.*waist|baggy|bunching/.test(msgLower)) clarifiedIssue = 'close_fit_loose';
    else if (/a bit tight|slightly tight|little tight/.test(msgLower)) clarifiedIssue = 'close_fit_tight';
    else if (/a bit loose|slightly loose|little loose/.test(msgLower)) clarifiedIssue = 'close_fit_loose';
    if (clarifiedIssue) {
      const vagueIssues = new Set(['doesnt_fit', 'product_not_working', 'unclear', 'none']);
      for (const item of items) {
        if (!item.resolved_size && vagueIssues.has(item.issue)) {
          item.issue = clarifiedIssue;
        }
      }
    }
    return items;
  }

  it('upgrades doesnt_fit to close_fit_tight on "too tight"', () => {
    const items = [{ product: 'AJ', issue: 'doesnt_fit', resolved_size: null }];
    applyClarification('It\'s too tight around the waist', items);
    assert.equal(items[0].issue, 'close_fit_tight');
  });

  it('upgrades doesnt_fit to close_fit_loose on "too loose"', () => {
    const items = [{ product: 'AJ', issue: 'doesnt_fit', resolved_size: null }];
    applyClarification('It\'s too loose', items);
    assert.equal(items[0].issue, 'close_fit_loose');
  });

  it('does not downgrade close_fit_tight to something else', () => {
    const items = [{ product: 'AJ', issue: 'close_fit_tight', resolved_size: null }];
    applyClarification('actually it is too loose', items);
    // close_fit_tight is not in vagueIssues, so it should not change
    assert.equal(items[0].issue, 'close_fit_tight');
  });

  it('does not upgrade already-resolved items', () => {
    const items = [{ product: 'AJ', issue: 'doesnt_fit', resolved_size: 'L' }];
    applyClarification('too tight', items);
    assert.equal(items[0].issue, 'doesnt_fit');
  });

  it('upgrades on "a bit tight" and "slightly loose"', () => {
    const items1 = [{ product: 'AJ', issue: 'doesnt_fit', resolved_size: null }];
    applyClarification('a bit tight', items1);
    assert.equal(items1[0].issue, 'close_fit_tight');

    const items2 = [{ product: 'AJ', issue: 'doesnt_fit', resolved_size: null }];
    applyClarification('slightly loose around the waist', items2);
    assert.equal(items2[0].issue, 'close_fit_loose');
  });

  it('handles baggy and bunching as close_fit_loose', () => {
    const items = [{ product: 'AJ', issue: 'product_not_working', resolved_size: null }];
    applyClarification('it\'s baggy and bunching in the front', items);
    assert.equal(items[0].issue, 'close_fit_loose');
  });
});

// ---------------------------------------------------------------------------
// Body group ambiguity check
// (Logic lives in aiAdvisor.js — replicate here for unit testing)
// ---------------------------------------------------------------------------
describe('body group ambiguity check', () => {
  function checkBodyGroupAmbiguity(products) {
    const ACCESSORY_CATEGORIES = new Set(['accessory', 'chest_pads', null, undefined]);
    const nonAccessory = products.filter(p => !ACCESSORY_CATEGORIES.has(p.category));
    if (nonAccessory.length <= 1) return false;
    const bodyGroups = new Set();
    for (const p of nonAccessory) {
      const cat = p.category || '';
      if (cat.includes('top') || cat.includes('bra')) bodyGroups.add('top');
      else if (cat === 'onepiece') bodyGroups.add('onepiece');
      else bodyGroups.add('bottom');
    }
    return bodyGroups.size > 1;
  }

  it('returns true for mixed tops + bottoms', () => {
    assert.ok(checkBodyGroupAmbiguity([
      { category: 'underwear_bottom' },
      { category: 'underwear_top' },
    ]));
  });

  it('returns false for all bottoms (underwear + swim)', () => {
    assert.ok(!checkBodyGroupAmbiguity([
      { category: 'underwear_bottom' },
      { category: 'swim_bottom' },
    ]));
  });

  it('returns false for single item', () => {
    assert.ok(!checkBodyGroupAmbiguity([
      { category: 'underwear_bottom' },
    ]));
  });

  it('ignores accessories', () => {
    assert.ok(!checkBodyGroupAmbiguity([
      { category: 'underwear_bottom' },
      { category: 'accessory' },
    ]));
  });

  it('returns true for bottoms + onepiece', () => {
    assert.ok(checkBodyGroupAmbiguity([
      { category: 'underwear_bottom' },
      { category: 'onepiece' },
    ]));
  });

  it('returns true for tops + bottoms + accessories', () => {
    assert.ok(checkBodyGroupAmbiguity([
      { category: 'swim_top' },
      { category: 'underwear_bottom' },
      { category: 'chest_pads' },
    ]));
  });
});

// ---------------------------------------------------------------------------
// getChartCategory helper
// ---------------------------------------------------------------------------
describe('getChartCategory', () => {
  it('returns kids_underwear_bottoms for AJ with isKids=true', () => {
    const { chartCategory, measureType } = getChartCategory('AJ', true);
    assert.equal(chartCategory, 'kids_underwear_bottoms');
    assert.equal(measureType, 'waist');
  });

  it('returns adult_underwear_bottoms for Sassy with isKids=false', () => {
    const { chartCategory, measureType } = getChartCategory('Sassy', false);
    assert.equal(chartCategory, 'adult_underwear_bottoms');
    assert.equal(measureType, 'waist');
  });

  it('returns kids_tops for Brooke Bra with isKids=true', () => {
    const { chartCategory, measureType } = getChartCategory('THE BROOKE SHAPING BRA', true);
    assert.equal(chartCategory, 'kids_tops');
    assert.equal(measureType, 'chest');
  });

  it('returns adult_swimwear_bottoms for Ruby with isKids=false', () => {
    const { chartCategory, measureType } = getChartCategory('Ruby', false);
    assert.equal(chartCategory, 'adult_swimwear_bottoms');
    assert.equal(measureType, 'waist');
  });

  it('returns kids_onepiece for Sky with isKids=true', () => {
    const { chartCategory, measureType } = getChartCategory('Sky One-Piece', true);
    assert.equal(chartCategory, 'kids_onepiece');
    assert.equal(measureType, 'waist');
  });
});

// ---------------------------------------------------------------------------
// Pre-purchase sizing
// ---------------------------------------------------------------------------
describe('prescribePrePurchaseSizing', () => {
  it('asks for measurement when none provided', async () => {
    const intake = makeIntake({
      items: [makeItem({ product: 'AJ', issue: 'none', size: null })],
      buying_for: 'self',
    });
    const result = await prescribePrePurchaseSizing(intake, { isNorthAmerica: true });
    assert.equal(result.items[0].state, 'NEEDS_MEASUREMENT');
    assert.ok(result.items[0].response_text.includes('measurement'));
    assert.ok(result.still_needed.length > 0);
  });

  it('asks which product when no items', async () => {
    const intake = makeIntake({ items: [] });
    const result = await prescribePrePurchaseSizing(intake, { isNorthAmerica: true });
    assert.equal(result.items[0].state, 'NEEDS_PRODUCT');
    assert.ok(result.items[0].response_text.includes('Which product'));
  });

  it('recommends size from measurement (kids underwear)', async () => {
    mockSupabaseData.sizeMatches = [{ size_label: '10' }];
    const intake = makeIntake({
      items: [makeItem({ product: 'AJ', issue: 'none', size: null })],
      measurement: { value: 25, unit: 'inches', body_part: 'waist' },
      buying_for: 'third_party',
      third_party_label: 'daughter',
    });
    const result = await prescribePrePurchaseSizing(intake, { isNorthAmerica: true });
    assert.equal(result.items[0].state, 'SIZE_RECOMMENDATION');
    assert.equal(result.items[0].recommendedSize, '10');
    assert.ok(result.items[0].response_text.includes('10'));
    assert.ok(result.items[0].response_text.includes('AJ'));
    assert.equal(result.still_needed.length, 0);
  });

  it('recommends size from measurement (adult underwear)', async () => {
    mockSupabaseData.sizeMatches = [{ size_label: 'L' }];
    const intake = makeIntake({
      items: [makeItem({ product: 'Sassy', issue: 'none', size: null })],
      measurement: { value: 34, unit: 'inches', body_part: 'waist' },
      buying_for: 'self',
    });
    const result = await prescribePrePurchaseSizing(intake, { isNorthAmerica: true });
    assert.equal(result.items[0].state, 'SIZE_RECOMMENDATION');
    assert.equal(result.items[0].recommendedSize, 'L');
  });

  it('uses third_party_label in response text', async () => {
    mockSupabaseData.sizeMatches = [{ size_label: '10' }];
    const intake = makeIntake({
      items: [makeItem({ product: 'AJ', issue: 'none', size: null })],
      measurement: { value: 25, unit: 'inches', body_part: 'waist' },
      buying_for: 'third_party',
      third_party_label: 'daughter',
    });
    const result = await prescribePrePurchaseSizing(intake, { isNorthAmerica: true });
    assert.ok(result.items[0].response_text.includes("your daughter's"));
  });

  it('asks for height for one-piece when only waist provided', async () => {
    const intake = makeIntake({
      items: [makeItem({ product: 'Sky One-Piece', issue: 'none', size: null })],
      measurement: { value: 30, unit: 'inches', body_part: 'waist' },
      buying_for: 'self',
    });
    const result = await prescribePrePurchaseSizing(intake, { isNorthAmerica: true });
    assert.equal(result.items[0].state, 'NEEDS_MEASUREMENT');
    assert.ok(result.items[0].response_text.includes('height'));
  });

  it('handles multiple products in one inquiry', async () => {
    mockSupabaseData.sizeMatches = [{ size_label: 'M' }];
    const intake = makeIntake({
      items: [
        makeItem({ product: 'AJ', issue: 'none', size: null }),
        makeItem({ product: 'Ruby', issue: 'none', size: null }),
      ],
      measurement: { value: 34, unit: 'inches', body_part: 'waist' },
      buying_for: 'self',
    });
    const result = await prescribePrePurchaseSizing(intake, { isNorthAmerica: true });
    assert.equal(result.items.length, 2);
    assert.equal(result.items[0].state, 'SIZE_RECOMMENDATION');
    assert.equal(result.items[1].state, 'SIZE_RECOMMENDATION');
  });

  it('walkTree routes to pre-purchase when context.isPrePurchase', async () => {
    mockSupabaseData.sizeMatches = [{ size_label: '10' }];
    const intake = makeIntake({
      items: [makeItem({ product: 'AJ', issue: 'none', size: null })],
      measurement: { value: 25, unit: 'inches', body_part: 'waist' },
      buying_for: 'third_party',
      third_party_label: 'daughter',
    });
    const ctx = makeContext({ isPrePurchase: true });
    const result = await walkTree(intake, ctx);
    assert.ok(result.phases_completed.includes('pre_purchase_sizing'));
    const action = result.response_parts.find(p => p.type === 'item_action');
    assert.equal(action.state, 'SIZE_RECOMMENDATION');
    assert.ok(action.text.includes('10'));
  });
});

// ---------------------------------------------------------------------------
// Export contract for the advisor's analyze_onepiece_fit tool — these were
// missing from module.exports, so the tool threw TypeError when invoked.
// ---------------------------------------------------------------------------

describe('advisor tool export contract', () => {
  it('exports analyzeOnepieceFit and getSeparatesText (used by aiAdvisor analyze_onepiece_fit)', () => {
    const se = require('../lib/sizingEngine');
    assert.equal(typeof se.analyzeOnepieceFit, 'function');
    assert.equal(typeof se.getSeparatesText, 'function');
  });
});
