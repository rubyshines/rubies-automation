/**
 * Unit tests for lib/tools/setPrices.js — set_product_prices with price,
 * compare-at, and clear-compare-at operations.
 *
 * Run: node --test customer-service/test/setPrices.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// Stub productCache, shopify, resolveLineItems, supabase BEFORE requiring
// ---------------------------------------------------------------------------

const productCachePath = require.resolve('../lib/productCache');
const shopifyPath = require.resolve('../lib/shopify');
const resolvePath = require.resolve('../lib/resolveLineItems');
const supabasePath = require.resolve('../../shared/supabaseClient');

function variant(id, sku, color, size, price) {
  return {
    id: `gid://shopify/ProductVariant/${id}`,
    title: `${color} / ${size}`,
    sku,
    price: String(price),
    inventoryQuantity: 5,
    selectedOptions: [{ name: 'Color', value: color }, { name: 'Size', value: size }],
  };
}

let CATALOG;
let LIVE;              // productId -> { variantId -> { price, compareAtPrice } }
let updateCalls;
let supabaseUpdates;
let historyInserts;
let livePricingCalls;

function resetFixture() {
  CATALOG = [
    {
      id: 'gid://shopify/Product/1',
      title: 'THE AJ SHAPING UNDERWEAR',
      variants: [
        variant(101, 'AJ-BLK-S', 'Black', 'S', 32),
        variant(102, 'AJ-BLK-M', 'Black', 'M', 32),
        variant(103, 'AJ-PNK-S', 'Pink', 'S', 32),
        variant(104, 'AJ-BLK-6', 'Black', '6', 28),
      ],
    },
    {
      id: 'gid://shopify/Product/2',
      title: 'THE RUBY SHAPING BIKINI BOTTOM',
      variants: [
        variant(201, 'RUBY-BLK-M', 'Black', 'M', 40),
        variant(202, 'RUBY-BLK-L', 'Black', 'L', 40),
      ],
    },
  ];
  LIVE = {
    'gid://shopify/Product/1': {
      'gid://shopify/ProductVariant/101': { price: '32.00', compareAtPrice: '28.00' },
      'gid://shopify/ProductVariant/102': { price: '32.00', compareAtPrice: '28.00' },
      'gid://shopify/ProductVariant/103': { price: '32.00', compareAtPrice: '28.00' },
      'gid://shopify/ProductVariant/104': { price: '28.00', compareAtPrice: '28.00' },
    },
    'gid://shopify/Product/2': {
      'gid://shopify/ProductVariant/201': { price: '40.00', compareAtPrice: null },
      'gid://shopify/ProductVariant/202': { price: '40.00', compareAtPrice: null },
    },
  };
  updateCalls = [];
  supabaseUpdates = [];
  historyInserts = [];
  livePricingCalls = [];
}
resetFixture();

require.cache[productCachePath] = {
  id: productCachePath, filename: productCachePath, loaded: true,
  exports: {
    getProducts: () => CATALOG,
    loadFromSupabase: async () => {},
  },
};

require.cache[shopifyPath] = {
  id: shopifyPath, filename: shopifyPath, loaded: true,
  exports: {
    fetchVariantPricing: async (productId) => {
      livePricingCalls.push(productId);
      const live = LIVE[productId];
      if (!live) return null;
      const product = CATALOG.find(p => p.id === productId);
      return {
        id: productId,
        title: product.title,
        status: 'ACTIVE',
        variants: product.variants.map(v => ({ id: v.id, sku: v.sku, ...live[v.id] })),
      };
    },
    updateVariantPrices: async (productId, variants) => {
      updateCalls.push({ productId, variants });
      return variants;
    },
  },
};

require.cache[resolvePath] = {
  id: resolvePath, filename: resolvePath, loaded: true,
  exports: {
    resolveLineItems: async (items) => {
      const item = items[0];
      for (const p of CATALOG) {
        if (item.sku) {
          const v = p.variants.find(x => x.sku === item.sku);
          if (v) return [{ variantId: v.id }];
        }
        if (item.query && p.title.toLowerCase().includes(item.query.toLowerCase())) {
          return [{ variantId: p.variants[0].id }];
        }
      }
      return { error: `nothing matched ${item.sku || item.query}` };
    },
  },
};

require.cache[supabasePath] = {
  id: supabasePath, filename: supabasePath, loaded: true,
  exports: {
    getSupabaseClient: () => ({
      from(table) {
        return {
          update(values) {
            return {
              eq: async (col, val) => {
                supabaseUpdates.push({ table, values, col, val });
                return { error: null };
              },
            };
          },
          insert: async (rows) => {
            historyInserts.push({ table, rows });
            return { error: null };
          },
        };
      },
    }),
  },
};

const tools = require('../lib/tools/setPrices');
const { parseItemOps, planChange } = tools;
const setPrices = tools.find(t => t.name === 'set_product_prices');

const origError = console.error;
console.error = () => {}; // silence the preview/commit echo

async function preview(items) {
  const res = await setPrices.handler({ items });
  return res.content[0].text;
}

function tokenOf(text) {
  const m = text.match(/confirmation_token="([a-f0-9]+)"/);
  return m ? m[1] : null;
}

async function commit(token) {
  const res = await setPrices.handler({ confirmation_token: token });
  return res.content[0].text;
}

describe('parseItemOps', () => {
  it('requires at least one operation', () => {
    assert.match(parseItemOps({ sku: 'X' }, 0).error, /at least one of price, compare_at_price, clear_compare_at/);
  });

  it('refuses compare_at_price together with clear_compare_at', () => {
    assert.match(parseItemOps({ compare_at_price: 30, clear_compare_at: true }, 2).error, /Item 3: compare_at_price and clear_compare_at cannot both be set/);
  });

  it('rejects a non-numeric or negative compare-at', () => {
    assert.match(parseItemOps({ compare_at_price: 'thirty' }, 0).error, /invalid compare_at_price/);
    assert.match(parseItemOps({ compare_at_price: -1 }, 0).error, /invalid compare_at_price/);
    assert.match(parseItemOps({ price: NaN }, 0).error, /invalid price/);
  });

  it('maps the three operations, rounding to cents', () => {
    assert.deepEqual(parseItemOps({ price: 29.999 }, 0), { price: 30 });
    assert.deepEqual(parseItemOps({ compare_at_price: 32.004 }, 0), { compareAt: 32 });
    assert.deepEqual(parseItemOps({ clear_compare_at: true }, 0), { compareAt: null });
    assert.deepEqual(parseItemOps({ price: 34, compare_at_price: 34 }, 0), { price: 34, compareAt: 34 });
  });
});

describe('planChange', () => {
  it('a price-only change leaves compare-at as it is', () => {
    const plan = planChange({ price: '32.00', compareAtPrice: '28.00' }, { newPrice: 34 });
    assert.equal(plan.priceChanged, true);
    assert.equal(plan.compareAtChanged, false);
    assert.equal(plan.newCompareAt, 28);
  });

  it('clearing an unset compare-at is not a change', () => {
    const plan = planChange({ price: '40.00', compareAtPrice: null }, { newCompareAt: null });
    assert.equal(plan.changed, false);
  });

  it('setting compare-at equal to its current value is not a change', () => {
    const plan = planChange({ price: '28.00', compareAtPrice: '28.00' }, { newCompareAt: 28 });
    assert.equal(plan.changed, false);
  });
});

describe('set_product_prices preview', () => {
  beforeEach(resetFixture);

  it('a compare-at change previews "compare-at $28.00 → $32.00" without touching the price', async () => {
    const text = await preview([{ query: 'aj', compare_at_price: 32 }]);
    assert.match(text, /Awaiting Confirmation/);
    // three stale adult sizes move 28 → 32; the youth size 6 at $28/$28 becomes
    // a sale at compare-at 32, which is allowed and counts as a change too.
    assert.match(text, /Updating 4 variants across 1 product/);
    assert.match(text, /Compare-at: \$28\.00 → \$32\.00/);
    assert.doesNotMatch(text, /Price:/);
  });

  it('a clear previews "compare-at → cleared"', async () => {
    const text = await preview([{ sku: 'AJ-BLK-S', clear_compare_at: true }]);
    assert.match(text, /Updating 1 variant across 1 product/);
    assert.match(text, /Compare-at: \$28\.00 → cleared/);
    assert.match(text, /Scope: size S Black/);
  });

  it('a price change previews "Price: $32.00 → $34.00" and needs the compare-at fixed in the same item', async () => {
    const refused = await preview([{ query: 'aj', price: 34 }]);
    assert.match(refused, /No updates applied/);
    assert.match(refused, /refused — compare-at \$28\.00 would sit below the price \$34\.00 on 4 variants/);
    assert.match(refused, /Add compare_at_price \(at least \$34\.00\) or clear_compare_at: true/);

    const text = await preview([{ query: 'aj', price: 34, compare_at_price: 34 }]);
    assert.match(text, /Updating 4 variants across 1 product/);
    assert.match(text, /Price: \$32\.00 \/ \$28\.00 → \$34\.00/);
    assert.match(text, /Compare-at: \$28\.00 → \$34\.00/);
  });

  it('refuses a compare-at below the resulting price and names the fix', async () => {
    const text = await preview([{ query: 'ruby', compare_at_price: 35 }]);
    assert.match(text, /No updates applied/);
    assert.match(text, /compare-at \$35\.00 would sit below the price \$40\.00 on 2 variants of "THE RUBY SHAPING BIKINI BOTTOM" \(e\.g\. RUBY-BLK-M — Black \/ M\)/);
    assert.match(text, /Set compare_at_price to at least \$40\.00, or pass clear_compare_at: true/);
    assert.equal(tokenOf(text), null);
  });

  it('allows compare-at equal to the price and above it', async () => {
    const equal = await preview([{ query: 'ruby', compare_at_price: 40 }]);
    assert.match(equal, /Compare-at: none → \$40\.00/);
    const sale = await preview([{ query: 'ruby', compare_at_price: 45 }]);
    assert.match(sale, /Compare-at: none → \$45\.00/);
  });

  it('reads the current compare-at live from Shopify, once per product', async () => {
    await preview([{ sku: 'AJ-BLK-S', compare_at_price: 32 }, { sku: 'AJ-BLK-M', compare_at_price: 32 }]);
    assert.deepEqual(livePricingCalls, ['gid://shopify/Product/1']);
  });

  it('reports nothing to change when every target already matches', async () => {
    const text = await preview([{ sku: 'AJ-BLK-6', compare_at_price: 28 }]);
    assert.match(text, /already at the requested prices — nothing to change/);
    assert.equal(tokenOf(text), null);
  });

  it('a mixed item list surfaces per-item errors as warnings on the preview', async () => {
    const text = await preview([{ sku: 'AJ-BLK-S', compare_at_price: 32 }, { sku: 'NOPE-1' , price: 10 }]);
    assert.match(text, /Updating 1 variant/);
    assert.match(text, /Warnings:\nItem 2: nothing matched NOPE-1/);
  });
});

describe('set_product_prices commit', () => {
  beforeEach(resetFixture);

  it('sends compareAtPrice only, as a number, for a compare-at change', async () => {
    const token = tokenOf(await preview([{ query: 'aj', compare_at_price: 32 }]));
    const text = await commit(token);
    assert.equal(updateCalls.length, 1);
    assert.equal(updateCalls[0].productId, 'gid://shopify/Product/1');
    assert.deepEqual(updateCalls[0].variants, [
      { id: 'gid://shopify/ProductVariant/101', compareAtPrice: 32 },
      { id: 'gid://shopify/ProductVariant/102', compareAtPrice: 32 },
      { id: 'gid://shopify/ProductVariant/103', compareAtPrice: 32 },
      { id: 'gid://shopify/ProductVariant/104', compareAtPrice: 32 },
    ]);
    // no retail price moved, so nothing reaches Supabase
    assert.equal(supabaseUpdates.length, 0);
    assert.equal(historyInserts.length, 0);
    assert.match(text, /4 variants changed \(0 price, 4 compare-at\)/);
    assert.match(text, /THE AJ SHAPING UNDERWEAR\*\* — 4 variants: compare-at \$32\.00/);
    // cache reflects the new compare-at
    assert.equal(CATALOG[0].variants[0].compareAtPrice, '32');
  });

  it('sends compareAtPrice: null for a clear', async () => {
    const token = tokenOf(await preview([{ sku: 'AJ-BLK-S', clear_compare_at: true }]));
    const text = await commit(token);
    assert.deepEqual(updateCalls[0].variants, [{ id: 'gid://shopify/ProductVariant/101', compareAtPrice: null }]);
    assert.match(text, /1 variant: compare-at cleared/);
    assert.equal(CATALOG[0].variants[0].compareAtPrice, null);
  });

  it('a price + compare-at change sends both and syncs only the price to Supabase', async () => {
    const token = tokenOf(await preview([{ sku: 'AJ-BLK-S', price: 34, compare_at_price: 34 }]));
    const text = await commit(token);
    assert.deepEqual(updateCalls[0].variants, [{ id: 'gid://shopify/ProductVariant/101', price: 34, compareAtPrice: 34 }]);
    assert.deepEqual(supabaseUpdates, [{
      table: 'product_variants', values: { price: 34 }, col: 'shopify_variant_id', val: 'gid://shopify/ProductVariant/101',
    }]);
    assert.equal(historyInserts.length, 1);
    assert.equal(historyInserts[0].rows[0].previous_price, 32);
    assert.equal(historyInserts[0].rows[0].price, 34);
    assert.match(text, /1 variant changed \(1 price, 1 compare-at\)/);
    assert.match(text, /price \$34\.00, compare-at \$34\.00/);
    assert.equal(CATALOG[0].variants[0].price, '34');
  });

  it('skips variants whose value already matches inside a group', async () => {
    // Size 6 already has compare-at 28; set compare-at 28 on the whole
    // product would be refused (below 32), so use price 28 + compare-at 28
    // on the youth size only, which is a no-op, alongside a real change.
    const token = tokenOf(await preview([
      { sku: 'AJ-BLK-6', compare_at_price: 28 },
      { sku: 'AJ-BLK-S', compare_at_price: 32 },
    ]));
    await commit(token);
    assert.equal(updateCalls.length, 1);
    assert.deepEqual(updateCalls[0].variants, [{ id: 'gid://shopify/ProductVariant/101', compareAtPrice: 32 }]);
  });

  it('an unknown token is refused', async () => {
    const text = await commit('deadbeef0000');
    assert.match(text, /Unknown or expired confirmation_token/);
    assert.equal(updateCalls.length, 0);
  });
});

process.on('exit', () => { console.error = origError; });
