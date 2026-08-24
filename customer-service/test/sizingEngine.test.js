/**
 * Unit tests for sizingEngine.js — the deterministic sizing utilities the
 * advisor's tools sit on: nicknames, product classification, size lists and
 * adjacency, grading deltas, chart category, one-piece fit.
 *
 * The legacy decision tree that used to live in the same file (walkTree and the
 * prescribe*() phases) was deleted 2026-08-24 along with the ~1,500 lines of
 * tests that drove it. Those tests asserted reply wording no customer has seen
 * since the advisor took over; what they incidentally covered of the LIVE
 * utilities was moved onto those utilities directly rather than deleted with the
 * caller. See the analyzeOnepieceFit block at the bottom.
 *
 * Run: node --test customer-service/test/sizingEngine.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// Mock Supabase BEFORE requiring decisionTree (it destructures at import time)
// ---------------------------------------------------------------------------
const supabaseModulePath = require.resolve('../../shared/supabaseClient');
const mockSupabaseData = { partners: [], sizeMatches: [], routings: [], routingsError: false, heightRows: [], sizeChartQueries: 0 };

// Mock product CS config data (normally loaded from product_cs_config table)
const mockCsConfig = [
  { product_handle: 'the-aj-no-tuck-shaping-underwear', nickname: 'AJ', category: 'underwear_bottom', keywords: ['aj'], delta_wording: 'bottom', sizes_override: null, style_switch: null },
  { product_handle: 'the-ava-seamless-shaping-bra', nickname: 'Ava', category: 'underwear_top', keywords: ['ava'], delta_wording: 'bra', sizes_override: null, style_switch: null },
  { product_handle: 'the-brooke-shaping-bra', nickname: 'Brooke', category: 'underwear_top', keywords: ['brooke'], delta_wording: 'bra', sizes_override: null, style_switch: null },
  { product_handle: 'the-charlie-no-tuck-extra-cute-shaping-underwear', nickname: 'Charlie', category: 'underwear_bottom', keywords: ['charlie'], delta_wording: 'bottom', sizes_override: null, style_switch: null },
  { product_handle: 'the-cheeky-no-tuck-shaping-bikini-bottom', nickname: 'Cheeky', category: 'swim_bottom', keywords: ['cheeky'], delta_wording: 'bottom', sizes_override: null, style_switch: { isTarget: true, forCategories: ['swim_bottom'], recommendFor: { tightLegs: true, ageGroups: ['youth', 'adult'], sizedIn: 'adult', everyday: true } } },
  { product_handle: 'the-flo-shaping-dance-underwear', nickname: 'Flo', category: 'underwear_bottom', keywords: ['flo'], delta_wording: 'bottom', sizes_override: null, style_switch: { isTarget: true, forCategories: ['underwear_bottom'], recommendFor: { tightLegs: true, ageGroups: ['youth'], sizedIn: 'youth', everyday: true } } },
  { product_handle: 'the-mia-halter-bikini-top', nickname: 'Mia', category: 'swim_top', keywords: ['mia'], delta_wording: 'bikini_top', sizes_override: null, style_switch: null },
  { product_handle: 'the-ruby-no-tuck-shaping-bikini-bottom', nickname: 'Ruby', category: 'swim_bottom', keywords: ['ruby'], delta_wording: 'bottom', sizes_override: null, style_switch: null },
  { product_handle: 'the-sassy-no-tuck-shaping-underwear', nickname: 'Sassy', category: 'underwear_bottom', keywords: ['sassy'], delta_wording: 'bottom', sizes_override: null, style_switch: { isTarget: true, forCategories: ['underwear_bottom'], recommendFor: { tightLegs: true, ageGroups: ['adult'], sizedIn: 'adult', everyday: true } } },
  { product_handle: 'the-serena-no-tuck-shaping-shorty-short', nickname: 'Serena', category: 'swim_bottom', keywords: ['serena'], delta_wording: 'bottom', sizes_override: null, style_switch: null },
  { product_handle: 'the-sky-no-tuck-shaping-one-piece', nickname: 'Sky', category: 'onepiece', keywords: ['sky', 'one-piece'], delta_wording: 'bottom', sizes_override: null, style_switch: null },
  { product_handle: 'the-stella-high-waisted-shaping-bikini-bottom', nickname: 'Stella', category: 'swim_bottom', keywords: ['stella'], delta_wording: 'bottom', sizes_override: null, style_switch: null },
  { product_handle: 'the-sunny-queeny-tankini', nickname: 'Queeny', category: 'swim_top', keywords: ['queeny', 'sunny', 'tankini'], delta_wording: 'top', sizes_override: null, style_switch: null },
  { product_handle: 'the-naomi-gaff-extra-strength-shaping-underwear', nickname: 'Naomi', category: 'underwear_bottom', keywords: ['naomi', 'gaff'], delta_wording: 'bottom', sizes_override: ['XS', 'S', 'M', 'L', '1X', '2X'], style_switch: { isTarget: true, forCategories: ['underwear_bottom'], recommendFor: { tightLegs: true, ageGroups: ['adult'], sizedIn: 'adult', everyday: false } } },
  { product_handle: 'rubies-shaping-chest-pads', nickname: 'Chest Pads', category: 'chest_pads', keywords: ['pad'], delta_wording: null, sizes_override: null, style_switch: null },
  // Production has a generic legacy row whose 'no-tuck' keyword appears in most
  // product titles. Its absence from this fixture is why the classification bug
  // went uncaught: without it nothing competes with the specific keywords.
  { product_handle: 'notuck-shaping-underwear', nickname: 'No-Tuck Underwear', category: 'underwear_bottom', keywords: ['no-tuck'], delta_wording: 'bottom', sizes_override: null, style_switch: null },
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
        if (table === 'size_charts') {
          // lookupHeightVariant chains .eq() calls and awaits the builder, so
          // this is a thenable that filters on whatever was asked for. The
          // counter pins the round-trip count: the search walks the whole size
          // list, and doing that a size at a time would be ten queries.
          mockSupabaseData.sizeChartQueries = (mockSupabaseData.sizeChartQueries || 0) + 1;
          const filters = {};
          const chain = {
            select: () => chain,
            eq: (col, val) => { filters[col] = val; return chain; },
            then: (resolve) => resolve({
              data: (mockSupabaseData.heightRows || [])
                .filter(r => !filters.size_label || r.size_label === filters.size_label),
              error: null,
            }),
          };
          return chain;
        }
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
  parseSizeVariant,
  getSizeModifier,
  getChartCategory,
  analyzeOnepieceFit,
  getSeparatesText,
  initCsConfig,
  PRODUCT_SIZE_OVERRIDES,
  _activeProducts,
} = require('../lib/sizingEngine');
// Donation routing moved out of sizingEngine long ago and was only re-exported
// from it. With the legacy tree gone the re-export went too, so these tests now
// name the module that actually owns the logic.
const { prescribeDonationRouting } = require('../lib/donationRouting');

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
// Export contract for the advisor's analyze_onepiece_fit tool — these were
// missing from module.exports, so the tool threw TypeError when invoked.
// ---------------------------------------------------------------------------

describe('advisor tool export contract', () => {
  // These were missing from the exports once before and the tool threw
  // TypeError when invoked. Nothing imports them at module load, so only a
  // customer hitting that branch would have found out.
  it('exports everything the live callers destructure', () => {
    const se = require('../lib/sizingEngine');
    // aiAdvisor: analyze_onepiece_fit + the sizing tools + prompt assembly.
    for (const name of [
      'analyzeOnepieceFit', 'getSeparatesText', 'getChartCategory',
      'normalizeSize', 'getSizeList', 'getAdjacentSizes',
      'getGradingDelta', 'getCumulativeDelta', 'formatDelta',
      'getProductNickname', 'pluralizeNickname', 'classifyProduct',
      'initCsConfig',
    ]) {
      assert.equal(typeof se[name], 'function', `${name} must stay exported`);
    }
    for (const name of ['PRODUCT_NICKNAMES', 'PRODUCT_CATEGORIES', 'PRODUCT_SIZE_OVERRIDES', '_activeProducts', 'KEYWORD_MATCH_COUNT', 'KID_LABELS']) {
      assert.ok(se[name], `${name} must stay exported`);
    }
  });

  it('no longer exports the deleted decision tree', () => {
    // Deleting the tree is only finished if nothing can quietly re-import it.
    const se = require('../lib/sizingEngine');
    for (const name of [
      'walkTree', 'checkSafetyOverride', 'prescribeCustomerIdentification',
      'prescribeOrderIdentification', 'prescribeActionClassification',
      'prescribeSizingResolution', 'prescribeOrderCreation', 'prescribePrePurchaseSizing',
    ]) {
      assert.equal(se[name], undefined, `${name} was deleted and must not come back`);
    }
  });
});

describe('generic keyword must not outrank a specific product', () => {
  // 'no-tuck' is in the AJ, Ruby, Sassy, Cheeky and Naomi titles; 'ruby' is in
  // one. Ranking by keyword LENGTH got this backwards, since 'no-tuck' (7)
  // beats 'ruby' (4), so a Ruby bikini complaint classified as underwear and
  // would have been offered underwear styles as the fix.
  it('classifies free-text and prefixed titles by the specific product', () => {
    for (const input of [
      'RUBY NO-TUCK SHAPING BIKINI BOTTOM',
      'THE RUBY NO-TUCK SHAPING BIKINI BOTTOM',
      'my ruby no-tuck bikini bottom',
      'the no-tuck ruby',
    ]) {
      assert.equal(classifyProduct(input), 'swim_bottom', input);
      assert.equal(getProductNickname(input), 'Ruby', input);
    }
  });

  it('keeps the right category when the nickname is already right', () => {
    // The nastiest shape: right name, wrong category.
    assert.equal(getProductNickname('THE CHEEKY NO-TUCK SHAPING BIKINI BOTTOM'), 'Cheeky');
    assert.equal(classifyProduct('THE CHEEKY NO-TUCK SHAPING BIKINI BOTTOM'), 'swim_bottom');
  });

  it('still resolves the generic product when nothing more specific matches', () => {
    assert.equal(getProductNickname('NO-TUCK SHAPING UNDERWEAR'), 'No-Tuck Underwear');
    assert.equal(classifyProduct('NO-TUCK SHAPING UNDERWEAR'), 'underwear_bottom');
  });

  it('does not misroute the one-piece, whose title also contains no-tuck', () => {
    assert.equal(classifyProduct('SKY NO-TUCK SHAPING ONE-PIECE'), 'onepiece');
  });
});

// ============================================================================
// One-piece fit — the LIVE path behind the advisor's analyze_onepiece_fit tool
// ============================================================================
// Migrated here when the legacy decision tree was deleted (2026-08-24). The tree
// carried the only behavioural exercise of this function, and it reached it
// sideways: those tests asserted the tree's reply wording, which no customer has
// seen since the advisor took over. analyzeOnepieceFit itself is live, called by
// a customer-facing tool, and had nothing but a `typeof === 'function'` check.
// So the coverage moves onto the function rather than being deleted with the
// caller — which is what the parked cleanup meant by "migrating assertions".

describe('analyzeOnepieceFit', () => {
  const ONEPIECE = 'THE SKY NO-TUCK SHAPING ONE-PIECE';
  const row = (size_label, notes, min_inches, max_inches) => ({ size_label, notes, min_inches, max_inches });

  it('exact: the height fits a variant at the waist size they already need', async () => {
    mockSupabaseData.heightRows = [row('M', 'Regular', 60, 66), row('M', 'Tall', 66, 72)];
    const r = await analyzeOnepieceFit('onepiece_adult', 'M', 63, ONEPIECE, true);
    assert.equal(r.type, 'exact');
    assert.equal(r.size, 'M');
    assert.equal(r.variant, 'Regular');
  });

  it('exact: prefers Tall when the height lands in the Tall band', async () => {
    mockSupabaseData.heightRows = [row('M', 'Regular', 60, 66), row('M', 'Tall', 66, 72)];
    const r = await analyzeOnepieceFit('onepiece_adult', 'M', 70, ONEPIECE, true);
    assert.equal(r.type, 'exact');
    assert.equal(r.variant, 'Tall');
  });

  it('wiggle: falls to an adjacent size and reports the waist trade-off', async () => {
    // Nothing fits at M; the height only works at L, one size away.
    mockSupabaseData.heightRows = [row('M', 'Regular', 50, 55), row('L', 'Tall', 66, 72)];
    const r = await analyzeOnepieceFit('onepiece_adult', 'M', 70, ONEPIECE, true);
    assert.equal(r.type, 'wiggle');
    assert.equal(r.size, 'L');
    assert.equal(r.variant, 'Tall');
    assert.equal(r.waistSize, 'M');
    assert.equal(r.moreOrLess, 'more', 'going up a size gives MORE room in the waist');
    assert.ok(r.unit.endsWith('"'), 'inches for a North American customer');
  });

  it('wiggle: going DOWN a size reports less room, and metric when asked', async () => {
    mockSupabaseData.heightRows = [row('M', 'Regular', 50, 55), row('S', 'Regular', 58, 63)];
    const r = await analyzeOnepieceFit('onepiece_adult', 'M', 60, ONEPIECE, false);
    assert.equal(r.type, 'wiggle');
    assert.equal(r.size, 'S');
    assert.equal(r.moreOrLess, 'less');
    assert.ok(r.unit.endsWith('cm'), 'centimetres outside North America');
  });

  it('height_outside_range: no variant at the waist size or either neighbour', async () => {
    mockSupabaseData.heightRows = [row('M', 'Regular', 60, 66), row('L', 'Regular', 62, 68)];
    const r = await analyzeOnepieceFit('onepiece_adult', 'M', 78, ONEPIECE, true);
    assert.equal(r.type, 'height_outside_range');
  });

  it('height_outside_range: an empty chart never invents a fit', async () => {
    mockSupabaseData.heightRows = [];
    const r = await analyzeOnepieceFit('onepiece_adult', 'M', 63, ONEPIECE, true);
    assert.equal(r.type, 'height_outside_range');
  });

  // The separates branch was UNREACHABLE until 2026-08-24: it needs a height
  // match two or more sizes away, and lookupHeightVariant only ever looked at
  // ±1, so every such customer fell through to height_outside_range — whose
  // message tells them their height is outside our charts. That was false, and
  // false at the size extremes specifically, because the adult bands barely move
  // with size. Measured over the full waist-by-height grid: 24 of 90 combinations
  // returned the false statement, and the fix changed exactly those 24, leaving
  // every exact and wiggle answer untouched.
  it('separates: a match two sizes away is a fit mismatch, NOT an out-of-range height', async () => {
    // The live shape: a 2X customer at 63". The Regular band two sizes down
    // covers her exactly; nothing at 2X, 1X or 3X does.
    mockSupabaseData.heightRows = [
      row('L', 'Regular', 62, 66),
      row('1X', 'Regular', 66, 69), row('2X', 'Regular', 66, 69), row('3X', 'Regular', 66, 69),
    ];
    const r = await analyzeOnepieceFit('onepiece_adult', '2X', 63, ONEPIECE, true);
    assert.equal(r.type, 'separates', 'her height is in our chart, just at another size');
    assert.equal(r.waistSize, '2X');
    assert.equal(r.heightSize, 'L');
    assert.equal(r.sizeDiff, 2);
    assert.equal(r.variant, 'Regular');
  });

  it('separates: reaches a match far down the list rather than giving up', async () => {
    mockSupabaseData.heightRows = [row('XS', 'Regular', 62, 66)];
    const r = await analyzeOnepieceFit('onepiece_adult', '4X', 64, ONEPIECE, true);
    assert.equal(r.type, 'separates');
    assert.equal(r.heightSize, 'XS');
    assert.ok(r.sizeDiff >= 2, `expected a far match, got ${r.sizeDiff}`);
  });

  it('separates does not swallow the adjacent case — one away is still wiggle', async () => {
    // The boundary between the two branches, in both directions.
    mockSupabaseData.heightRows = [row('L', 'Tall', 66, 70)];
    assert.equal((await analyzeOnepieceFit('onepiece_adult', 'M', 68, ONEPIECE, true)).type, 'wiggle');
    assert.equal((await analyzeOnepieceFit('onepiece_adult', '1X', 68, ONEPIECE, true)).type, 'wiggle');
    assert.equal((await analyzeOnepieceFit('onepiece_adult', 'S', 68, ONEPIECE, true)).type, 'separates');
  });

  it('height_outside_range now means outside EVERY band, at any size', async () => {
    // 61" is below the floor of every band, so no size can serve it. This is the
    // only case where telling the customer their height is out of range is true.
    mockSupabaseData.heightRows = [
      row('S', 'Regular', 62, 66), row('M', 'Regular', 62, 66), row('L', 'Tall', 66, 70),
    ];
    assert.equal((await analyzeOnepieceFit('onepiece_adult', 'M', 61, ONEPIECE, true)).type, 'height_outside_range');
    assert.equal((await analyzeOnepieceFit('onepiece_adult', 'M', 74, ONEPIECE, true)).type, 'height_outside_range');
  });

  it('prefers the smaller size when two are equally far', async () => {
    // What the old ±1 version did (it pushed idx-1 before idx+1). Preserved so
    // the fix could not quietly change an answer it was not meant to touch.
    mockSupabaseData.heightRows = [row('S', 'Regular', 62, 66), row('L', 'Regular', 62, 66)];
    const r = await analyzeOnepieceFit('onepiece_adult', 'M', 64, ONEPIECE, true);
    assert.equal(r.size, 'S');
    assert.equal(r.moreOrLess, 'less');
  });

  it('reads the height chart once, however far it has to search', async () => {
    // Searching a size at a time would have meant up to ten sequential round
    // trips on a tool the advisor calls mid-conversation.
    mockSupabaseData.heightRows = [row('XS', 'Regular', 62, 66)];
    mockSupabaseData.sizeChartQueries = 0;
    await analyzeOnepieceFit('onepiece_adult', '4X', 64, ONEPIECE, true);
    assert.equal(mockSupabaseData.sizeChartQueries, 1);
  });
});

describe('getSeparatesText', () => {
  it('names both measurements on a mismatch, height alone otherwise', () => {
    assert.match(getSeparatesText('mismatch', 'your', false), /waist and height/);
    assert.match(getSeparatesText('height_outside_range', 'your', false), /your height/);
    assert.ok(!/waist and height/.test(getSeparatesText('height_outside_range', 'your', false)));
  });

  it('only asks the question when this is an exchange', () => {
    assert.match(getSeparatesText('mismatch', 'your', true), /Would you like to explore that option instead\?$/);
    assert.ok(!/\?$/.test(getSeparatesText('mismatch', 'your', false)));
  });

  it('carries the third-party phrasing through verbatim', () => {
    // The caller passes "your daughter's" for a parent buying for someone else,
    // so the sentence must not hardcode a pronoun.
    assert.match(getSeparatesText('mismatch', "your daughter's", false), /your daughter's waist and height/);
  });

  it('customer-facing copy carries no em dash', () => {
    for (const reason of ['mismatch', 'height_outside_range']) {
      assert.ok(!getSeparatesText(reason, 'your', true).includes('—'), reason);
    }
  });
});
