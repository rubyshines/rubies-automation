/**
 * Unit tests for lib/resolveLineItems.js — shared line-item resolver.
 *
 * Run: node --test customer-service/test/resolveLineItems.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// Stub productCache and shopify BEFORE requiring resolveLineItems
// ---------------------------------------------------------------------------

const productCachePath = require.resolve('../lib/productCache');
const shopifyPath = require.resolve('../lib/shopify');

// Fixture catalog — two products, two colors each, several sizes
const FIXTURE = {
  'gid://shopify/ProductVariant/100': {
    productTitle: 'THE CHARLIE NO-TUCK EXTRA CUTE SHAPING UNDERWEAR',
    variantTitle: 'Black / S',
    variantId: 'gid://shopify/ProductVariant/100',
    sku: 'rub0001-S',
    price: '29.00',
    inventoryQuantity: 25,
  },
  'gid://shopify/ProductVariant/101': {
    productTitle: 'THE CHARLIE NO-TUCK EXTRA CUTE SHAPING UNDERWEAR',
    variantTitle: 'Black / L',
    variantId: 'gid://shopify/ProductVariant/101',
    sku: 'rub0001-L',
    price: '29.00',
    inventoryQuantity: 10,
  },
  'gid://shopify/ProductVariant/102': {
    productTitle: 'THE CHARLIE NO-TUCK EXTRA CUTE SHAPING UNDERWEAR',
    variantTitle: 'Pink / S',
    variantId: 'gid://shopify/ProductVariant/102',
    sku: 'rub0001-PNK-S',
    price: '29.00',
    inventoryQuantity: 4,
  },
  'gid://shopify/ProductVariant/200': {
    productTitle: 'THE BROOKE SHAPING BRA',
    variantTitle: 'Black / M',
    variantId: 'gid://shopify/ProductVariant/200',
    sku: 'rub0002-M',
    price: '39.00',
    inventoryQuantity: 8,
  },
  'gid://shopify/ProductVariant/201': {
    productTitle: 'THE BROOKE SHAPING BRA',
    variantTitle: 'Black / 4X',
    variantId: 'gid://shopify/ProductVariant/201',
    sku: 'rub0002-BLK-4XL',
    price: '39.00',
    inventoryQuantity: 3,
  },
};

const SKU_INDEX = Object.fromEntries(
  Object.values(FIXTURE).map(v => [v.sku.toUpperCase(), v])
);

function stubGetVariantBySku(sku) {
  if (!sku) return null;
  return SKU_INDEX[sku.trim().toUpperCase()] || null;
}

// Segment-wise fuzzy fallback — mirrors productCache.getVariantBySkuFuzzy
// against the fixture. Applies a minimal size-alias map for the test cases.
const TEST_SIZE_ALIASES = { 'XL': '1X', 'XXL': '2X', '4XL': '4X' };
function normalizeTestSize(seg) {
  const up = String(seg || '').toUpperCase();
  return TEST_SIZE_ALIASES[up] || up;
}
function stubGetVariantBySkuFuzzy(sku) {
  if (!sku) return null;
  const segs = sku.trim().toUpperCase().split('-').filter(Boolean);
  if (segs.length < 2) return null;
  const candidates = [];
  for (const v of Object.values(FIXTURE)) {
    const vSegs = v.sku.trim().toUpperCase().split('-').filter(Boolean);
    if (vSegs.length !== segs.length) continue;
    let allMatch = true;
    for (let i = 0; i < segs.length; i++) {
      if (vSegs[i] === segs[i]) continue;
      if (normalizeTestSize(segs[i]) === normalizeTestSize(vSegs[i])) continue;
      allMatch = false;
      break;
    }
    if (allMatch) candidates.push(v);
  }
  return candidates.length === 1 ? candidates[0] : null;
}

function stubGetVariantById(gid) {
  return FIXTURE[gid] || null;
}

// Sibling lookup: same product + color, different size
function stubGetSiblingVariant(sku, targetSize) {
  const origin = stubGetVariantBySku(sku);
  if (!origin) return null;
  const originColor = origin.variantTitle.split('/')[0].trim().toLowerCase();
  const normalTarget = String(targetSize).trim().toLowerCase();
  for (const v of Object.values(FIXTURE)) {
    if (v.productTitle !== origin.productTitle) continue;
    const [color, size] = v.variantTitle.split('/').map(s => s.trim().toLowerCase());
    if (color !== originColor) continue;
    if (size === normalTarget) return v;
  }
  return null;
}

// Fuzzy search: returns first match by substring on productTitle + variantTitle
function stubSearchProducts(query) {
  const q = String(query).toLowerCase();
  const tokens = q.split(/\s+/).filter(Boolean);
  const scored = [];
  for (const v of Object.values(FIXTURE)) {
    const hay = `${v.productTitle} ${v.variantTitle}`.toLowerCase();
    const matched = tokens.filter(t => hay.includes(t)).length;
    if (matched > 0) scored.push({ v, matched });
  }
  scored.sort((a, b) => b.matched - a.matched);
  return scored.map(s => s.v);
}

require.cache[productCachePath] = {
  id: productCachePath,
  filename: productCachePath,
  loaded: true,
  exports: {
    searchProducts: stubSearchProducts,
    getVariantById: stubGetVariantById,
    getVariantBySku: stubGetVariantBySku,
    getVariantBySkuFuzzy: stubGetVariantBySkuFuzzy,
    getSiblingVariant: stubGetSiblingVariant,
  },
};

require.cache[shopifyPath] = {
  id: shopifyPath,
  filename: shopifyPath,
  loaded: true,
  exports: {
    normalizeGid: (id, type) => {
      if (typeof id === 'string' && id.startsWith('gid://')) return id;
      return `gid://shopify/${type}/${id}`;
    },
  },
};

const { resolveLineItems } = require('../lib/resolveLineItems');

// ---------------------------------------------------------------------------
// variant_id path
// ---------------------------------------------------------------------------

describe('resolveLineItems — variant_id', () => {
  it('resolves a cached variant_id to full variant info', async () => {
    const result = await resolveLineItems([
      { variant_id: 'gid://shopify/ProductVariant/100', quantity: 3 },
    ]);
    assert.ok(Array.isArray(result));
    assert.equal(result.length, 1);
    assert.equal(result[0].variantId, 'gid://shopify/ProductVariant/100');
    assert.equal(result[0].sku, 'rub0001-S');
    assert.equal(result[0].variantTitle, 'Black / S');
    assert.equal(result[0].quantity, 3);
    assert.equal(result[0].price, '29.00');
  });

  it('normalizes numeric variant_id to GID before lookup', async () => {
    const result = await resolveLineItems([{ variant_id: '100', quantity: 1 }]);
    assert.equal(result[0].variantId, 'gid://shopify/ProductVariant/100');
    assert.equal(result[0].sku, 'rub0001-S');
  });

  it('passes through unknown variant_id as opaque reference', async () => {
    const result = await resolveLineItems([
      { variant_id: 'gid://shopify/ProductVariant/99999', quantity: 2 },
    ]);
    assert.equal(result.length, 1);
    assert.equal(result[0].variantId, 'gid://shopify/ProductVariant/99999');
    assert.equal(result[0].productTitle, '(by ID)');
    assert.equal(result[0].sku, null);
    assert.equal(result[0].quantity, 2);
  });

  it('defaults quantity to 1 when omitted', async () => {
    const result = await resolveLineItems([
      { variant_id: 'gid://shopify/ProductVariant/100' },
    ]);
    assert.equal(result[0].quantity, 1);
  });
});

// ---------------------------------------------------------------------------
// sku path (exact match)
// ---------------------------------------------------------------------------

describe('resolveLineItems — sku', () => {
  it('resolves an exact SKU', async () => {
    const result = await resolveLineItems([{ sku: 'rub0001-S', quantity: 4 }]);
    assert.equal(result.length, 1);
    assert.equal(result[0].variantId, 'gid://shopify/ProductVariant/100');
    assert.equal(result[0].variantTitle, 'Black / S');
    assert.equal(result[0].quantity, 4);
  });

  it('is case-insensitive for SKU lookup', async () => {
    const result = await resolveLineItems([{ sku: 'RUB0001-L', quantity: 1 }]);
    assert.equal(result[0].variantId, 'gid://shopify/ProductVariant/101');
  });

  it('returns an error for unknown SKU', async () => {
    const result = await resolveLineItems([{ sku: 'does-not-exist', quantity: 1 }]);
    assert.ok(result.error, 'expected error object');
    assert.match(result.error, /not found in product catalog/);
  });

  it('falls back to segment-wise fuzzy match when exact SKU misses (size alias)', async () => {
    // Query "rub0002-BLK-4X" should resolve to stored "rub0002-BLK-4XL"
    // via the 4X ↔ 4XL size alias in the segment-wise resolver.
    const result = await resolveLineItems([{ sku: 'rub0002-BLK-4X', quantity: 1 }]);
    assert.ok(!result.error, `unexpected error: ${result.error}`);
    assert.equal(result[0].variantId, 'gid://shopify/ProductVariant/201');
    assert.equal(result[0].sku, 'rub0002-BLK-4XL');
  });
});

// ---------------------------------------------------------------------------
// sku + target_size path (size exchange, color preserved)
// ---------------------------------------------------------------------------

describe('resolveLineItems — sku + target_size', () => {
  it('finds a sibling variant with the same color in the target size', async () => {
    const result = await resolveLineItems([
      { sku: 'rub0001-S', target_size: 'L', quantity: 1 },
    ]);
    assert.equal(result.length, 1);
    assert.equal(result[0].variantId, 'gid://shopify/ProductVariant/101');
    assert.equal(result[0].variantTitle, 'Black / L');
  });

  it('preserves color — does not return Pink when Black is requested', async () => {
    // rub0001-S is Black. Target L with color preservation must pick Black/L, not Pink/S.
    const result = await resolveLineItems([
      { sku: 'rub0001-S', target_size: 'L', quantity: 1 },
    ]);
    assert.ok(!result.error);
    assert.ok(result[0].variantTitle.toLowerCase().startsWith('black'));
  });

  it('returns error when sibling size does not exist for the product', async () => {
    const result = await resolveLineItems([
      { sku: 'rub0001-S', target_size: '5X', quantity: 1 },
    ]);
    assert.ok(result.error);
    assert.match(result.error, /Could not find size/);
  });
});

// ---------------------------------------------------------------------------
// query fallback path
// ---------------------------------------------------------------------------

describe('resolveLineItems — query fallback', () => {
  it('resolves a query to the best fuzzy match', async () => {
    const result = await resolveLineItems([
      { query: 'Brooke Black M', quantity: 2 },
    ]);
    assert.equal(result.length, 1);
    assert.equal(result[0].variantId, 'gid://shopify/ProductVariant/200');
  });

  it('returns error when query matches nothing', async () => {
    const result = await resolveLineItems([
      { query: 'NonexistentProduct ZZZ', quantity: 1 },
    ]);
    assert.ok(result.error);
    assert.match(result.error, /No products found/);
  });
});

// ---------------------------------------------------------------------------
// Priority & validation
// ---------------------------------------------------------------------------

describe('resolveLineItems — priority & validation', () => {
  it('prefers variant_id over sku/query when multiple are provided', async () => {
    const result = await resolveLineItems([
      {
        variant_id: 'gid://shopify/ProductVariant/200',
        sku: 'rub0001-S',
        query: 'Charlie Pink',
        quantity: 1,
      },
    ]);
    assert.equal(result[0].variantId, 'gid://shopify/ProductVariant/200');
  });

  it('prefers sku+target_size over plain sku when both are provided', async () => {
    const result = await resolveLineItems([
      { sku: 'rub0001-S', target_size: 'L', quantity: 1 },
    ]);
    assert.equal(result[0].variantId, 'gid://shopify/ProductVariant/101');
  });

  it('returns error when item has no identifier at all', async () => {
    const result = await resolveLineItems([{ quantity: 1 }]);
    assert.ok(result.error);
    assert.match(result.error, /variant_id, sku, or query/);
  });

  it('resolves multiple items in order', async () => {
    const result = await resolveLineItems([
      { sku: 'rub0001-S', quantity: 2 },
      { sku: 'rub0002-M', quantity: 3 },
      { variant_id: 'gid://shopify/ProductVariant/101', quantity: 1 },
    ]);
    assert.equal(result.length, 3);
    assert.equal(result[0].variantId, 'gid://shopify/ProductVariant/100');
    assert.equal(result[1].variantId, 'gid://shopify/ProductVariant/200');
    assert.equal(result[2].variantId, 'gid://shopify/ProductVariant/101');
  });

  it('short-circuits on first error and reports it', async () => {
    const result = await resolveLineItems([
      { sku: 'rub0001-S', quantity: 1 },
      { sku: 'missing-sku', quantity: 1 },
      { sku: 'rub0002-M', quantity: 1 },
    ]);
    assert.ok(result.error);
    assert.match(result.error, /missing-sku/);
  });
});
