/**
 * Unit tests for lib/preOrderAttrs.js — Pre-order line-item attribute stamping
 * for order-creation tools (exchange, create, invoice, split shipment).
 *
 * Run: node --test customer-service/test/preOrderAttrs.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// Stub productCache BEFORE requiring preOrderAttrs
// ---------------------------------------------------------------------------

const productCachePath = require.resolve('../lib/productCache');

const FIXTURE_BY_SKU = {
  'CKY-BLK-L': { sku: 'CKY-BLK-L', inventoryQuantity: 0, preOrderDate: '2026-08-28' },
  'RUBY-BLK-L': { sku: 'RUBY-BLK-L', inventoryQuantity: 12, preOrderDate: null },
  'HLA-SND-M': { sku: 'HLA-SND-M', inventoryQuantity: -2, preOrderDate: null },
};

require.cache[productCachePath] = {
  id: productCachePath,
  filename: productCachePath,
  loaded: true,
  exports: {
    getVariantBySku: sku => FIXTURE_BY_SKU[sku] || null,
  },
};

const {
  PRE_ORDER_ATTR_KEY,
  PRE_ORDER_FALLBACK_VALUE,
  formatPreOrderDate,
  preOrderAttrValue,
  preOrderLineAttributes,
} = require('../lib/preOrderAttrs');

describe('formatPreOrderDate', () => {
  it('maps day-of-month to beginning/middle/end', () => {
    assert.equal(formatPreOrderDate('2026-08-05'), 'beginning of August, 2026');
    assert.equal(formatPreOrderDate('2026-08-15'), 'middle of August, 2026');
    assert.equal(formatPreOrderDate('2026-08-28'), 'end of August, 2026');
  });

  it('returns null for missing or invalid dates', () => {
    assert.equal(formatPreOrderDate(null), null);
    assert.equal(formatPreOrderDate('not-a-date'), null);
  });
});

describe('preOrderAttrValue', () => {
  it('matches the Pre-Order Now app format when the variant has a restock date', () => {
    assert.equal(preOrderAttrValue('CKY-BLK-L'), 'Target availability end of August, 2026.');
  });

  it('falls back to the generic value without a date or an unknown SKU', () => {
    assert.equal(preOrderAttrValue('HLA-SND-M'), PRE_ORDER_FALLBACK_VALUE);
    assert.equal(preOrderAttrValue('NOPE-XX-1'), PRE_ORDER_FALLBACK_VALUE);
    assert.equal(preOrderAttrValue(null), PRE_ORDER_FALLBACK_VALUE);
  });

  it('an operator-stated target date wins over the variant\'s own date', () => {
    assert.equal(preOrderAttrValue('CKY-BLK-L', { targetDate: '2026-11-30' }), 'Target availability end of November, 2026.');
  });

  it('an operator-stated target date dates a line whose variant has none', () => {
    assert.equal(preOrderAttrValue('HLA-SND-M', { targetDate: '2026-11-05' }), 'Target availability beginning of November, 2026.');
    assert.equal(preOrderAttrValue(null, { targetDate: '2026-11-15' }), 'Target availability middle of November, 2026.');
  });

  it('an unparseable target date throws rather than degrading to the fallback', () => {
    assert.throws(() => preOrderAttrValue('CKY-BLK-L', { targetDate: 'end of Nov' }), /Invalid pre-order target date/);
    assert.throws(() => preOrderAttrValue('CKY-BLK-L', { targetDate: '2026-13-40' }), /Invalid pre-order target date/);
  });

  it('an empty target date is the same as none', () => {
    assert.equal(preOrderAttrValue('CKY-BLK-L', { targetDate: '' }), 'Target availability end of August, 2026.');
    assert.equal(preOrderAttrValue('HLA-SND-M', { targetDate: null }), PRE_ORDER_FALLBACK_VALUE);
  });
});

describe('preOrderLineAttributes', () => {
  it('stamps an out-of-stock line with the app-identical attribute', () => {
    const attrs = preOrderLineAttributes({ sku: 'CKY-BLK-L', inventoryQuantity: 0, quantity: 1 });
    assert.deepEqual(attrs, [
      { key: PRE_ORDER_ATTR_KEY, value: 'Target availability end of August, 2026.' },
    ]);
  });

  it('stamps when stock cannot cover the requested quantity (partial stock)', () => {
    const attrs = preOrderLineAttributes({ sku: 'RUBY-BLK-L', inventoryQuantity: 1, quantity: 2 });
    assert.deepEqual(attrs, [{ key: PRE_ORDER_ATTR_KEY, value: PRE_ORDER_FALLBACK_VALUE }]);
  });

  it('returns null when stock covers the line', () => {
    assert.equal(preOrderLineAttributes({ sku: 'RUBY-BLK-L', inventoryQuantity: 12, quantity: 1 }), null);
  });

  it('returns null when inventory is unknown (custom/by-ID items) — never guess', () => {
    assert.equal(preOrderLineAttributes({ sku: null, inventoryQuantity: null, quantity: 1 }), null);
    assert.equal(preOrderLineAttributes({ sku: 'CKY-BLK-L', inventoryQuantity: undefined }), null);
  });

  it('defaults quantity to 1', () => {
    const attrs = preOrderLineAttributes({ sku: 'HLA-SND-M', inventoryQuantity: -2 });
    assert.deepEqual(attrs, [{ key: PRE_ORDER_ATTR_KEY, value: PRE_ORDER_FALLBACK_VALUE }]);
  });

  it('the stamped key matches the daily sweep detection regex', () => {
    // Same pattern as hasPreOrderAttr in reports/lib/unnotifiedPreOrder.js
    // (not imported — its module chain pulls in aiAdvisor/Supabase clients).
    const attrs = preOrderLineAttributes({ sku: 'CKY-BLK-L', inventoryQuantity: 0, quantity: 1 });
    assert.equal(/^pre-?order$/i.test(attrs[0].key), true);
  });
});
