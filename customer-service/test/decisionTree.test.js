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
const mockSupabaseData = { partners: [], sizeMatches: [] };
require.cache[supabaseModulePath] = {
  id: supabaseModulePath,
  filename: supabaseModulePath,
  loaded: true,
  exports: {
    getSupabaseClient: () => ({
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => Promise.resolve({ data: mockSupabaseData.partners }),
          }),
        }),
      }),
      rpc: () => Promise.resolve({ data: mockSupabaseData.sizeMatches }),
    }),
    upsert: () => Promise.resolve(),
  },
};

// Now require decisionTree — it will get the mocked supabaseClient
const {
  walkTree,
  checkSafetyOverride,
  prescribeCustomerIdentification,
  prescribeOrderIdentification,
  prescribeActionClassification,
  prescribeSizingResolution,
  prescribeOrderCreation,
  prescribeDonationRouting,
  checkPositiveFeedback,
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
} = require('../lib/decisionTree');

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

  it('classifies accessories', () => {
    assert.equal(classifyProduct('RUBIES SHAPING CHEST PADS'), 'accessory');
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
  });

  describe('refund', () => {
    it('asks what went wrong on first refund request', async () => {
      const intake = makeIntake({
        items: [makeItem({ issue: 'refund_request' })],
        _refundAskedOnce: false,
      });
      const classified = [makeClassified({ action: 'refund' })];
      const ctx = makeContext({ targetOrder: makeOrder() });
      const result = await prescribeSizingResolution(classified, intake, ctx);
      assert.equal(result.items[0].state, 'AWAITING_DECISION');
      assert.ok(result.items[0].response_text.includes("what didn't work out"));
      assert.equal(intake._refundAskedOnce, true);
    });

    it('confirms refund on second request (insists)', async () => {
      const intake = makeIntake({
        items: [makeItem({ issue: 'refund_request' })],
        _refundAskedOnce: true,
      });
      const classified = [makeClassified({ action: 'refund' })];
      const ctx = makeContext({ targetOrder: makeOrder() });
      const result = await prescribeSizingResolution(classified, intake, ctx);
      assert.equal(result.items[0].state, 'REFUND_CONFIRMED');
      assert.equal(result.items[0].refund_confirmed, true);
    });
  });

  describe('defect', () => {
    it('asks photo + replacement for repeat purchaser', async () => {
      const orderHistory = [
        { lineItems: [{ title: 'THE AJ NO-TUCK SHAPING UNDERWEAR', variantTitle: '10' }] },
        { lineItems: [{ title: 'THE AJ NO-TUCK SHAPING UNDERWEAR', variantTitle: '10' }] },
      ];
      const intake = makeIntake({ items: [makeItem({ issue: 'defect' })] });
      const classified = [makeClassified({ action: 'defect' })];
      const result = await prescribeSizingResolution(classified, intake, makeContext({ orderHistory }));
      assert.equal(result.items[0].state, 'AWAITING_PHOTO');
      assert.equal(result.items[0].defect_likely_genuine, true);
      assert.equal(result.items[0].skip_donation, true);
    });

    it('asks photo + measurement for single purchaser', async () => {
      const intake = makeIntake({ items: [makeItem({ issue: 'defect' })] });
      const classified = [makeClassified({ action: 'defect' })];
      const result = await prescribeSizingResolution(classified, intake, makeContext());
      assert.equal(result.items[0].state, 'AWAITING_MEASUREMENT_AND_PHOTO');
      assert.equal(result.items[0].defect_likely_genuine, false);
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
});

// ============================================================================
// Phase 7: Positive Feedback
// ============================================================================

describe('checkPositiveFeedback', () => {
  it('detects "love rubies"', () => {
    const result = checkPositiveFeedback('I love rubies so much');
    assert.equal(result.detected, true);
  });

  it('detects "amazing"', () => {
    const result = checkPositiveFeedback('your products are amazing');
    assert.equal(result.detected, true);
  });

  it('returns null for normal message', () => {
    assert.equal(checkPositiveFeedback('The size was too big'), null);
  });

  it('returns null for empty/null', () => {
    assert.equal(checkPositiveFeedback(null), null);
    assert.equal(checkPositiveFeedback(''), null);
  });
});

// ============================================================================
// walkTree Integration Tests
// ============================================================================

describe('walkTree', () => {
  it('returns safety_override when safety signal detected', async () => {
    const intake = makeIntake({ _latestMessage: 'I am not safe at home' });
    const result = await walkTree(intake, makeContext());
    assert.equal(result.status, 'safety_override');
    assert.ok(result.response_parts.length > 0);
    assert.equal(result.response_parts[0].priority, 0);
    // Should short-circuit — no other phases
    assert.ok(!result.phases_completed.includes('identify_customer'));
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
});
