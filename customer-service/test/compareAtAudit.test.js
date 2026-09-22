/**
 * Unit tests for lib/tools/compareAtAudit.js — the compare-at audit report.
 *
 * Run: node --test customer-service/test/compareAtAudit.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const shopifyPath = require.resolve('../lib/shopify');

let FIXTURE = [];

require.cache[shopifyPath] = {
  id: shopifyPath, filename: shopifyPath, loaded: true,
  exports: {
    fetchAllVariantPricing: async () => FIXTURE,
  },
};

const tools = require('../lib/tools/compareAtAudit');
const { buildCompareAtReport, formatCompareAtReport } = tools;
const audit = tools.find(t => t.name === 'audit_compare_at_prices');

function v(id, sku, color, size, price, compareAtPrice) {
  return {
    id: `gid://shopify/ProductVariant/${id}`,
    title: `${color} / ${size}`,
    sku,
    price: String(price),
    compareAtPrice: compareAtPrice === null ? null : String(compareAtPrice),
    selectedOptions: [{ name: 'Color', value: color }, { name: 'Size', value: size }],
  };
}

const PRODUCTS = [
  {
    id: 'gid://shopify/Product/1', title: 'THE AJ SHAPING UNDERWEAR', status: 'ACTIVE',
    variants: [
      v(101, 'AJ-BLK-S', 'Black', 'S', 32, 28),
      v(102, 'AJ-BLK-M', 'Black', 'M', 32, 28),
      v(103, 'AJ-PNK-S', 'Pink', 'S', 32, 28),
      v(104, 'AJ-BLK-6', 'Black', '6', 28, 28),
    ],
  },
  {
    id: 'gid://shopify/Product/2', title: 'THE RUBY SHAPING BIKINI BOTTOM', status: 'ACTIVE',
    variants: [
      v(201, 'RUBY-BLK-M', 'Black', 'M', 40, null),
      v(202, 'RUBY-BLK-L', 'Black', 'L', 40, 50),
      v(203, 'RUBY-BLK-XL', 'Black', 'XL', 40, 38),
      v(204, 'RUBY-BLK-2XL', 'Black', '2XL', 40, 0),
    ],
  },
  {
    id: 'gid://shopify/Product/3', title: 'OLD THING', status: 'ARCHIVED',
    variants: [v(301, 'OLD-1', 'Black', 'S', 20, 10)],
  },
  {
    id: 'gid://shopify/Product/4', title: 'CLEAN PRODUCT', status: 'ACTIVE',
    variants: [v(401, 'CLN-1', 'Black', 'S', 20, null), v(402, 'CLN-2', 'Black', 'M', 20, 20)],
  },
];

describe('buildCompareAtReport', () => {
  it('lists only variants whose compare-at differs, grouped and sorted by product', () => {
    const report = buildCompareAtReport(PRODUCTS);
    assert.deepEqual(report.products.map(p => p.title), ['THE AJ SHAPING UNDERWEAR', 'THE RUBY SHAPING BIKINI BOTTOM']);
    const aj = report.products[0];
    assert.equal(aj.stale, 3);
    assert.equal(aj.sale, 0);
    assert.equal(aj.variantCount, 4);
    assert.deepEqual(aj.rows.map(r => r.sku), ['AJ-BLK-S', 'AJ-BLK-M', 'AJ-PNK-S']);
    assert.deepEqual(aj.rows[0], {
      variantId: 'gid://shopify/ProductVariant/101', sku: 'AJ-BLK-S', size: 's', color: 'black',
      price: 32, compareAt: 28, gap: -4, direction: 'stale',
    });
  });

  it('classifies above-price as sale and below as stale', () => {
    const ruby = buildCompareAtReport(PRODUCTS).products[1];
    assert.deepEqual(ruby.rows.map(r => [r.sku, r.direction, r.gap]), [
      ['RUBY-BLK-L', 'sale', 10],
      ['RUBY-BLK-XL', 'stale', -2],
      ['RUBY-BLK-2XL', 'stale', -40],
    ]);
    assert.equal(ruby.stale, 2);
    assert.equal(ruby.sale, 1);
  });

  it('totals count every variant checked, skipping archived products by default', () => {
    const { totals } = buildCompareAtReport(PRODUCTS);
    assert.deepEqual(totals, { products: 2, differing: 6, stale: 5, sale: 1, equal: 2, unset: 2, variants: 10 });
    const withArchived = buildCompareAtReport(PRODUCTS, { includeArchived: true });
    assert.equal(withArchived.totals.products, 3);
    assert.equal(withArchived.totals.variants, 11);
  });
});

describe('formatCompareAtReport', () => {
  it('compresses a product whose differing variants all share the same numbers', () => {
    const text = formatCompareAtReport(buildCompareAtReport(PRODUCTS));
    assert.match(text, /6 variants differ across 2 products \(5 stale, 1 on sale\)/);
    assert.match(text, /Of 10 variants checked, 2 have compare-at equal to price and 2 have none/);
    assert.match(text, /\*\*THE AJ SHAPING UNDERWEAR\*\* \[ACTIVE\] — 3 stale of 4 variants\n  3 variants: price \$32\.00, compare-at \$28\.00 \(\$4\.00 below, stale\)\n  Sizes: S, M\n  Colours: Black, Pink/);
  });

  it('lists each variant when the numbers differ within a product', () => {
    const text = formatCompareAtReport(buildCompareAtReport(PRODUCTS));
    assert.match(text, /\*\*THE RUBY SHAPING BIKINI BOTTOM\*\* \[ACTIVE\] — 2 stale, 1 on sale of 4 variants/);
    assert.match(text, /RUBY-BLK-L \(Black \/ L\): price \$40\.00, compare-at \$50\.00 \(\$10\.00 above, sale\)/);
    assert.match(text, /RUBY-BLK-XL \(Black \/ 1X\): price \$40\.00, compare-at \$38\.00 \(\$2\.00 below, stale\)/);
    assert.match(text, /RUBY-BLK-2XL \(Black \/ 2X\): price \$40\.00, compare-at \$0\.00 \(zero, should be cleared\)/);
  });

  it('says so when there is nothing to fix', () => {
    const text = formatCompareAtReport(buildCompareAtReport([PRODUCTS[3]]));
    assert.match(text, /0 variants differ across 0 products/);
    assert.match(text, /Nothing to fix/);
  });
});

describe('audit_compare_at_prices tool', () => {
  it('reads from Shopify and honours include_archived', async () => {
    FIXTURE = PRODUCTS;
    const res = await audit.handler({});
    assert.match(res.content[0].text, /across 2 products/);
    const all = await audit.handler({ include_archived: true });
    assert.match(all.content[0].text, /across 3 products/);
    assert.match(all.content[0].text, /\*\*OLD THING\*\* \[ARCHIVED\]/);
  });
});
