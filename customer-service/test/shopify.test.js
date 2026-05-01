/**
 * Unit tests for small pure helpers exported from lib/shopify.js.
 *
 * Run: node --test customer-service/test/shopify.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { isTipLineItem } = require('../lib/shopify');

describe('isTipLineItem', () => {
  it('matches a Shopify-shaped tip line item', () => {
    assert.equal(isTipLineItem({ title: 'Tip', sku: null, variant: null, quantity: 1 }), true);
  });

  it('matches a Supabase-shaped tip line item', () => {
    assert.equal(isTipLineItem({ title: 'Tip', sku: null, shopify_variant_id: null, quantity: 1 }), true);
  });

  it('is case-insensitive on the title', () => {
    assert.equal(isTipLineItem({ title: 'tip', sku: null, variant: null }), true);
    assert.equal(isTipLineItem({ title: ' TIP ', sku: null, variant: null }), true);
  });

  it('rejects real products even when title contains "tip"', () => {
    assert.equal(isTipLineItem({ title: 'THE SASSY NO-TUCK', sku: 'HLA-SND-S', variant: { id: 'gid://shopify/ProductVariant/1' } }), false);
    assert.equal(isTipLineItem({ title: 'Tip-toe Tank', sku: 'TIPTOE-S', variant: { id: 'gid://shopify/ProductVariant/2' } }), false);
  });

  it('rejects items with a SKU even if titled "Tip"', () => {
    assert.equal(isTipLineItem({ title: 'Tip', sku: 'TIP-PRODUCT', variant: null }), false);
  });

  it('rejects items with a variant id even if titled "Tip"', () => {
    assert.equal(isTipLineItem({ title: 'Tip', sku: null, variant: { id: 'gid://shopify/ProductVariant/9' } }), false);
    assert.equal(isTipLineItem({ title: 'Tip', sku: null, shopify_variant_id: 'gid://shopify/ProductVariant/9' }), false);
  });

  it('handles null / undefined safely', () => {
    assert.equal(isTipLineItem(null), false);
    assert.equal(isTipLineItem(undefined), false);
    assert.equal(isTipLineItem({}), false);
  });
});
