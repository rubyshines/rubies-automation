/**
 * Tests for the create_discount_code MCP tool.
 *
 * Run: node --test customer-service/test/discountCode.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const shopifyPath = require.resolve('../lib/shopify');
const productCachePath = require.resolve('../lib/productCache');

let createCalls = [];
let createImpl = null; // tests can override; default below
let addCodeCalls = [];
let addCodeImpl = null; // tests can override; default succeeds
let existingBuckets = {}; // title -> node returned by findDiscountNodeByTitle
let findCalls = [];
let mockProducts = [];
let randomCallCount = 0;

const defaultCreateImpl = async (input) => {
  return {
    id: 'gid://shopify/DiscountCodeNode/123456789',
    codeDiscount: { title: input.title, status: 'ACTIVE' },
  };
};

require.cache[shopifyPath] = {
  id: shopifyPath, filename: shopifyPath, loaded: true,
  exports: {
    createDiscountCode: async (input) => {
      createCalls.push(input);
      const impl = createImpl || defaultCreateImpl;
      return impl(input);
    },
    findDiscountNodeByTitle: async (title) => {
      findCalls.push(title);
      return existingBuckets[title] || null;
    },
    addCodeToPriceRule: async (priceRuleId, code) => {
      addCodeCalls.push({ priceRuleId, code });
      const impl = addCodeImpl || (async () => ({ id: 1, code }));
      return impl(priceRuleId, code);
    },
    randomDiscountCode: () => {
      randomCallCount++;
      // Distinct codes across retries so the assertion can verify a fresh code
      return `DEADBEEF${String(randomCallCount).padStart(2, '0')}`;
    },
    getAdminUrl: (gid) => {
      const numericId = gid.split('/').pop();
      if (gid.includes('/DiscountCodeNode/')) {
        return `https://admin.shopify.com/store/test-store/discounts/${numericId}`;
      }
      return `https://admin.shopify.com/store/test-store/orders/${numericId}`;
    },
  },
};

require.cache[productCachePath] = {
  id: productCachePath, filename: productCachePath, loaded: true,
  exports: {
    searchProducts: () => mockProducts,
  },
};

const tools = require('../lib/tools/discountCode');
const tool = tools.find(t => t.name === 'create_discount_code');

beforeEach(() => {
  createCalls = [];
  createImpl = null;
  addCodeCalls = [];
  addCodeImpl = null;
  existingBuckets = {};
  findCalls = [];
  mockProducts = [];
  randomCallCount = 0;
});

describe('create_discount_code — percent mode, bucket missing', () => {
  it('default 10% creates the "Thank You 10" bucket with the first code', async () => {
    const res = await tool.handler({ mode: 'percent' });
    assert.deepEqual(findCalls, ['Thank You 10']);
    assert.equal(addCodeCalls.length, 0);
    assert.equal(createCalls.length, 1);
    const input = createCalls[0];
    assert.equal(input.title, 'Thank You 10');
    assert.equal(input.code, 'DEADBEEF01');
    assert.equal(input.usageLimit, 1);
    assert.equal(input.appliesOncePerCustomer, false);
    assert.deepEqual(input.combinesWith, {
      productDiscounts: true,
      orderDiscounts: true,
      shippingDiscounts: true,
    });
    assert.equal(input.customerSelection.all, true);
    assert.equal(input.customerGets.value.percentage, 0.1);
    assert.deepEqual(
      input.customerGets.items.collections.add,
      ['gid://shopify/Collection/515636363542']
    );
    assert.match(res.content[0].text, /Discount Code Created/);
    assert.match(res.content[0].text, /DEADBEEF01/);
    assert.match(res.content[0].text, /admin\.shopify\.com\/store\/test-store\/discounts\/123456789/);
  });

  it('explicit percent_off 5 creates a "Thank You 5" bucket', async () => {
    await tool.handler({ mode: 'percent', percent_off: 5 });
    assert.equal(createCalls.length, 1);
    assert.equal(createCalls[0].customerGets.value.percentage, 0.05);
    assert.equal(createCalls[0].title, 'Thank You 5');
  });
});

describe('create_discount_code — percent mode, bucket exists', () => {
  it('appends a code to the existing bucket instead of creating a discount', async () => {
    existingBuckets['Thank You 10'] = {
      id: 'gid://shopify/DiscountCodeNode/555000111',
      numericId: '555000111',
      codesCount: 7,
    };
    const res = await tool.handler({ mode: 'percent' });
    assert.equal(createCalls.length, 0);
    assert.equal(addCodeCalls.length, 1);
    assert.equal(addCodeCalls[0].priceRuleId, '555000111');
    assert.equal(addCodeCalls[0].code, 'DEADBEEF01');
    assert.match(res.content[0].text, /Discount Code Created/);
    assert.match(res.content[0].text, /DEADBEEF01/);
    // Admin link points at the bucket discount
    assert.match(res.content[0].text, /discounts\/555000111/);
  });

  it('confirmed >10% appends to its own level bucket', async () => {
    existingBuckets['Thank You 25'] = {
      id: 'gid://shopify/DiscountCodeNode/777000222',
      numericId: '777000222',
      codesCount: 2,
    };
    const res = await tool.handler({
      mode: 'percent',
      confirmed: true,
      _discount_data: { mode: 'percent', percent_off: 25 },
    });
    assert.equal(createCalls.length, 0);
    assert.equal(addCodeCalls.length, 1);
    assert.equal(addCodeCalls[0].priceRuleId, '777000222');
    assert.match(res.content[0].text, /25% off the Discounts collection/);
  });

  it('retries with a fresh code when the bucket add reports a collision', async () => {
    existingBuckets['Thank You 10'] = {
      id: 'gid://shopify/DiscountCodeNode/555000111',
      numericId: '555000111',
      codesCount: 7,
    };
    let attempt = 0;
    addCodeImpl = async () => {
      attempt++;
      if (attempt === 1) throw new Error('addCodeToPriceRule (422): {"code":["has already been taken"]}');
      return { id: 2 };
    };
    const res = await tool.handler({ mode: 'percent' });
    assert.equal(attempt, 2);
    assert.notEqual(addCodeCalls[0].code, addCodeCalls[1].code);
    assert.match(res.content[0].text, /Discount Code Created/);
  });
});

describe('create_discount_code — percent mode, two-phase', () => {
  it('percent_off 25 without confirmed returns preview', async () => {
    const res = await tool.handler({ mode: 'percent', percent_off: 25 });
    assert.equal(createCalls.length, 0);
    assert.equal(addCodeCalls.length, 0);
    assert.match(res.content[0].text, /Awaiting Confirmation/);
    assert.match(res.content[0].text, /25% off the Discounts collection/);
    assert.match(res.content[0].text, /confirmed=true/);
    assert.match(res.content[0].text, /"percent_off":25/);
  });

  it('percent_off 25 with confirmed + _discount_data creates code (no bucket yet)', async () => {
    const res = await tool.handler({
      mode: 'percent',
      confirmed: true,
      _discount_data: { mode: 'percent', percent_off: 25 },
    });
    assert.equal(createCalls.length, 1);
    assert.equal(createCalls[0].title, 'Thank You 25');
    assert.equal(createCalls[0].customerGets.value.percentage, 0.25);
    assert.match(res.content[0].text, /Discount Code Created/);
  });

  it('rejects out-of-range percent_off', async () => {
    const r1 = await tool.handler({ mode: 'percent', percent_off: 0 });
    assert.equal(r1.isError, true);
    const r2 = await tool.handler({ mode: 'percent', percent_off: 150 });
    assert.equal(r2.isError, true);
    assert.equal(createCalls.length, 0);
    assert.equal(addCodeCalls.length, 0);
  });

  it('surfaces non-collision userErrors from Shopify mutation as tool error', async () => {
    createImpl = async () => { throw new Error('Discount value out of range'); };
    const res = await tool.handler({ mode: 'percent', percent_off: 10 });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Failed to create discount/);
    assert.match(res.content[0].text, /Discount value out of range/);
  });
});

describe('create_discount_code — free_product mode', () => {
  it('without confirmed returns preview with max-variant-price calculation', async () => {
    mockProducts = [
      { productId: 'gid://shopify/Product/100', productTitle: 'THE BROOKE SHAPING BRA', sku: 'BB-WHT-12', price: '36.00' },
      { productId: 'gid://shopify/Product/100', productTitle: 'THE BROOKE SHAPING BRA', sku: 'BB-BLK-2X', price: '42.00' },
      { productId: 'gid://shopify/Product/100', productTitle: 'THE BROOKE SHAPING BRA', sku: 'BB-SND-M', price: '39.00' },
    ];
    const res = await tool.handler({ mode: 'free_product', product_query: 'Brooke 2X' });
    assert.equal(createCalls.length, 0);
    assert.match(res.content[0].text, /Awaiting Confirmation/);
    assert.match(res.content[0].text, /THE BROOKE SHAPING BRA/);
    // max price was 42.00
    assert.match(res.content[0].text, /\$42\.00 off/);
    assert.match(res.content[0].text, /confirmed=true/);
  });

  it('errors when product_query missing', async () => {
    const res = await tool.handler({ mode: 'free_product' });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /product_query is required/);
    assert.equal(createCalls.length, 0);
  });

  it('errors when product not found', async () => {
    mockProducts = [];
    const res = await tool.handler({ mode: 'free_product', product_query: 'Nonexistent' });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /No product found/);
  });

  it('with confirmed creates a standalone discount scoped to product with fixed amount', async () => {
    const res = await tool.handler({
      mode: 'free_product',
      confirmed: true,
      _discount_data: {
        mode: 'free_product',
        amount: 42,
        product_id: 'gid://shopify/Product/100',
        product_title: 'THE BROOKE SHAPING BRA',
      },
    });
    assert.equal(createCalls.length, 1);
    assert.equal(addCodeCalls.length, 0);
    const input = createCalls[0];
    assert.equal(input.title, 'Free THE BROOKE SHAPING BRA');
    assert.equal(input.customerGets.value.discountAmount.amount, '42.00');
    assert.equal(input.customerGets.value.discountAmount.appliesOnEachItem, true);
    assert.deepEqual(
      input.customerGets.items.products.productsToAdd,
      ['gid://shopify/Product/100']
    );
    assert.match(res.content[0].text, /Discount Code Created/);
  });
});

describe('create_discount_code — generated code format', () => {
  it('uses 10-char hex code with no prefix', async () => {
    await tool.handler({ mode: 'percent', percent_off: 10 });
    assert.match(createCalls[0].code, /^[A-F0-9]{10}$/i);
  });

  it('rejects unknown modes', async () => {
    const res = await tool.handler({ mode: 'wat' });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Invalid mode/);
  });
});

describe('create_discount_code — collision retry (bucket creation path)', () => {
  it('retries with a fresh code when Shopify reports the code is taken', async () => {
    let attempt = 0;
    createImpl = async (input) => {
      attempt++;
      if (attempt === 1) throw new Error('Shopify user errors: [{"field":["code"],"message":"has already been taken"}]');
      return { id: 'gid://shopify/DiscountCodeNode/999', codeDiscount: { title: input.title, status: 'ACTIVE' } };
    };
    const res = await tool.handler({ mode: 'percent', percent_off: 10 });
    assert.equal(attempt, 2);
    assert.equal(createCalls.length, 2);
    // Each attempt used a different code
    assert.notEqual(createCalls[0].code, createCalls[1].code);
    assert.match(res.content[0].text, /Discount Code Created/);
  });

  it('does NOT retry on non-collision errors', async () => {
    let attempt = 0;
    createImpl = async () => {
      attempt++;
      throw new Error('Discount value out of range');
    };
    const res = await tool.handler({ mode: 'percent', percent_off: 10 });
    assert.equal(attempt, 1);
    assert.equal(res.isError, true);
  });

  it('gives up after 3 failed retries', async () => {
    let attempt = 0;
    createImpl = async () => {
      attempt++;
      throw new Error('Shopify user errors: [{"message":"has already been taken"}]');
    };
    const res = await tool.handler({ mode: 'percent', percent_off: 10 });
    assert.equal(attempt, 3);
    assert.equal(res.isError, true);
  });
});
