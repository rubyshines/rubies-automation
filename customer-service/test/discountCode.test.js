/**
 * Tests for the create_discount_code and revoke_discount_code MCP tools.
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

// --- revoke_discount_code stub state ---
let lookupResult = null;      // what findDiscountCodeByCode resolves to
let lookupError = null;       // set to an Error to simulate a failed lookup
let deleteCalls = [];
let deactivateCalls = [];
// findRedeemCode is only called by the post-delete verification poll. Each
// entry is consumed per call, so a test can simulate "still present, then gone".
let redeemCodeLookups = [];

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
    findDiscountCodeByCode: async () => {
      if (lookupError) throw lookupError;
      return lookupResult;
    },
    findRedeemCode: async (discountGid, code) => {
      deleteCalls.push({ verify: code });
      return redeemCodeLookups.length ? redeemCodeLookups.shift() : null;
    },
    deleteRedeemCodes: async (discountGid, ids) => {
      deleteCalls.push({ discountGid, ids });
      return { jobId: 'gid://shopify/Job/1', done: false };
    },
    deactivateDiscountCode: async (gid) => {
      deactivateCalls.push(gid);
      return { id: gid, status: 'EXPIRED' };
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
const revokeTool = tools.find(t => t.name === 'revoke_discount_code');

beforeEach(() => {
  createCalls = [];
  createImpl = null;
  addCodeCalls = [];
  addCodeImpl = null;
  existingBuckets = {};
  findCalls = [];
  mockProducts = [];
  randomCallCount = 0;
  lookupResult = null;
  lookupError = null;
  deleteCalls = [];
  deactivateCalls = [];
  redeemCodeLookups = [];
});

// A code sitting in a large shared pool (e.g. the bulk birthday "free AJs"
// discount) — the case where deleting the parent discount would break
// everyone else's code.
function poolCode(overrides = {}) {
  return {
    discountGid: 'gid://shopify/DiscountCodeNode/672906215509',
    redeemCodeId: 'gid://shopify/DiscountRedeemCode/4595137413205',
    code: 'FREEAJS-1OSRJP2O',
    type: 'DiscountCodeBasic',
    title: 'Birthday Free AJs',
    status: 'ACTIVE',
    summary: '$32 off AJ SHAPING UNDERWEAR',
    startsAt: '2026-01-01T00:00:00Z',
    endsAt: null,
    usageLimit: 1,
    codeUsageCount: 0,
    discountUsageCount: 663,
    codesCount: 1228,
    ...overrides,
  };
}

// A one-off free-product comp: the discount owns exactly one code.
function soloCode(overrides = {}) {
  return {
    discountGid: 'gid://shopify/DiscountCodeNode/1717548613910',
    redeemCodeId: 'gid://shopify/DiscountRedeemCode/999',
    code: '1CEB84F9C9',
    type: 'DiscountCodeBasic',
    title: 'Free SASSY NO-TUCK SHAPING UNDERWEAR',
    status: 'ACTIVE',
    summary: '$32 off SASSY NO-TUCK SHAPING UNDERWEAR',
    startsAt: '2026-07-29T00:00:00Z',
    endsAt: null,
    usageLimit: 1,
    codeUsageCount: 0,
    discountUsageCount: 0,
    codesCount: 1,
    ...overrides,
  };
}

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

describe('revoke_discount_code — lookup / preview (phase 1)', () => {
  it('reports the parent discount and the sibling codes that stay valid', async () => {
    lookupResult = poolCode();
    const res = await revokeTool.handler({ code: 'FREEAJS-1OSRJP2O' });
    const text = res.content[0].text;
    assert.match(text, /Discount Code Lookup/);
    assert.match(text, /FREEAJS-1OSRJP2O/);
    assert.match(text, /Birthday Free AJs/);
    assert.match(text, /1227 belong to other customers/);
    assert.match(text, /Delete only `FREEAJS-1OSRJP2O`/);
    assert.match(text, /Leave the other 1227 code\(s\) on that discount working/);
    // Phase 1 never mutates
    assert.equal(deleteCalls.length, 0);
    assert.equal(deactivateCalls.length, 0);
  });

  it('says a single-code discount will be deactivated instead of code-deleted', async () => {
    lookupResult = soloCode();
    const res = await revokeTool.handler({ code: '1CEB84F9C9' });
    const text = res.content[0].text;
    assert.match(text, /this code IS the discount/);
    assert.match(text, /Deactivate the discount "Free SASSY NO-TUCK SHAPING UNDERWEAR"/);
    assert.equal(deactivateCalls.length, 0);
  });

  it('diagnoses an expired code', async () => {
    lookupResult = poolCode({ status: 'EXPIRED', endsAt: '2026-06-30T04:00:00Z' });
    const res = await revokeTool.handler({ code: 'FREEAJS-1OSRJP2O' });
    assert.match(res.content[0].text, /Why it may not be working/);
    assert.match(res.content[0].text, /Expired on .*ET/);
  });

  it('diagnoses a code that is already spent against its usage limit', async () => {
    lookupResult = poolCode({ codeUsageCount: 1, usageLimit: 1 });
    const res = await revokeTool.handler({ code: 'FREEAJS-1OSRJP2O' });
    const text = res.content[0].text;
    assert.match(text, /Already redeemed 1 time\(s\) against a limit of 1/);
    assert.match(text, /Not undo the 1 order\(s\) already placed/);
  });

  it('diagnoses a scheduled code that has not started', async () => {
    lookupResult = poolCode({ status: 'SCHEDULED', startsAt: '2026-12-01T05:00:00Z' });
    assert.match((await revokeTool.handler({ code: 'X' })).content[0].text, /Not active yet — starts/);
  });

  it('explains a miss without guessing at a similar code', async () => {
    lookupResult = null;
    const res = await revokeTool.handler({ code: 'FREEAJS-1OSRJP2O' });
    const text = res.content[0].text;
    assert.match(text, /No discount code `FREEAJS-1OSRJP2O` exists in Shopify/);
    assert.match(text, /Transcription slip/);
    assert.equal(deleteCalls.length, 0);
  });

  it('requires a code', async () => {
    const res = await revokeTool.handler({ code: '   ' });
    assert.equal(res.isError, true);
  });

  it('surfaces a lookup failure as an error instead of revoking blind', async () => {
    lookupError = new Error('Shopify API error (500)');
    const res = await revokeTool.handler({ code: 'ABC', confirmed: true });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Discount lookup failed/);
    assert.equal(deleteCalls.length, 0);
    assert.equal(deactivateCalls.length, 0);
  });
});

describe('revoke_discount_code — execution (phase 2)', () => {
  it('deletes only the one redeem code from a shared pool', async () => {
    lookupResult = poolCode();
    const res = await revokeTool.handler({ code: 'FREEAJS-1OSRJP2O', confirmed: true });
    const mutation = deleteCalls.find(c => c.ids);
    assert.deepEqual(mutation.ids, ['gid://shopify/DiscountRedeemCode/4595137413205']);
    assert.equal(mutation.discountGid, 'gid://shopify/DiscountCodeNode/672906215509');
    assert.equal(deactivateCalls.length, 0, 'must never touch the parent discount');
    const text = res.content[0].text;
    assert.match(text, /Discount Code Revoked/);
    assert.match(text, /the other 1227 code\(s\) on that discount still work/);
  });

  it('deactivates the discount when it owns exactly one code', async () => {
    lookupResult = soloCode();
    const res = await revokeTool.handler({ code: '1CEB84F9C9', confirmed: true });
    assert.deepEqual(deactivateCalls, ['gid://shopify/DiscountCodeNode/1717548613910']);
    assert.equal(deleteCalls.filter(c => c.ids).length, 0);
    const text = res.content[0].text;
    assert.match(text, /Discount Code Revoked/);
    assert.match(text, /no longer redeemable/);
    assert.match(text, /never redeemed/);
  });

  it('notes prior redemptions rather than implying the order was reversed', async () => {
    lookupResult = soloCode({ codeUsageCount: 1 });
    const res = await revokeTool.handler({ code: '1CEB84F9C9', confirmed: true });
    assert.match(res.content[0].text, /already been used 1 time\(s\)\. Those orders stand\./);
  });

  it('verifies removal after the async delete rather than trusting the job', async () => {
    lookupResult = poolCode();
    // Present on the first poll, gone on the second.
    redeemCodeLookups = [{ id: 'gid://shopify/DiscountRedeemCode/4595137413205', code: 'FREEAJS-1OSRJP2O' }];
    const res = await revokeTool.handler({ code: 'FREEAJS-1OSRJP2O', confirmed: true });
    assert.equal(deleteCalls.filter(c => c.verify).length, 2, 'polls until the code is gone');
    assert.match(res.content[0].text, /Discount Code Revoked/);
  });

  it('reports an in-flight deletion honestly when it has not landed', async () => {
    lookupResult = poolCode();
    const stillThere = { id: 'gid://shopify/DiscountRedeemCode/4595137413205', code: 'FREEAJS-1OSRJP2O' };
    redeemCodeLookups = [stillThere, stillThere, stillThere, stillThere, stillThere];
    const res = await revokeTool.handler({ code: 'FREEAJS-1OSRJP2O', confirmed: true });
    const text = res.content[0].text;
    assert.match(text, /Revocation Submitted/);
    assert.match(text, /had not finished when checked/);
  });

  it('refuses to act when the individual code row cannot be resolved', async () => {
    lookupResult = poolCode({ redeemCodeId: null });
    const res = await revokeTool.handler({ code: 'FREEAJS-1OSRJP2O', confirmed: true });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /could not resolve/);
    assert.equal(deleteCalls.filter(c => c.ids).length, 0);
    assert.equal(deactivateCalls.length, 0);
  });
});
