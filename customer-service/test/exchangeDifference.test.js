/**
 * exchange_difference tool — wiring test. Stubs Shopify (order lookup + refund
 * calc), the new-item resolver, and the discount registry so we can assert the
 * end-to-end plan (discounts applied, real return credit, net, recommended
 * action) without any network. exchangeMath stays real (it's pure).
 */
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

// --- install stubs BEFORE requiring the tool ---------------------------------
function stub(relFromLib, exportsObj) {
  const resolved = require.resolve(path.join(__dirname, '..', 'lib', relFromLib));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}
function stubAbs(relFromRepo, exportsObj) {
  const resolved = require.resolve(path.join(__dirname, '..', '..', relFromRepo));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

const NEW_ITEMS_RESOLVED = {
  'RUBY-BLK-10': { sku: 'RUBY-BLK-10', price: 44, quantity: 1, variantId: 'gid://v/r10', productTitle: 'The Ruby', variantTitle: 'Black / 10' },
  'RUBY-BLK-11': { sku: 'RUBY-BLK-11', price: 44, quantity: 2, variantId: 'gid://v/r11', productTitle: 'The Ruby', variantTitle: 'Black / 11' },
  'AJ-BLK-10': { sku: 'AJ-BLK-10', price: 28, quantity: 1, variantId: 'gid://v/aj10', productTitle: 'The AJ', variantTitle: 'Black / 10' },
};

stub('resolveLineItems', {
  resolveLineItems: async (items) => items.map((it) => ({ ...NEW_ITEMS_RESOLVED[it.sku], quantity: it.quantity })),
});
stub('shopify', {
  normalizeGid: (id) => id,
  getOrderByNumber: async () => ({
    id: 'gid://shopify/Order/29649',
    name: '#29649',
    customer: { id: 'gid://shopify/Customer/8065558413590', email: 'eitan@grinspun.com' },
    lineItems: [
      { id: 'li-flo', sku: 'FLO-SND-12', quantity: 1 },
      { id: 'li-aj', sku: 'AJ-SND-12', quantity: 3 },
      { sku: 'NOID-SKU', quantity: 1 }, // line item missing id (regression guard)
    ],
  }),
  // suggestedRefund subtotal = what they actually paid: Flo $28.79 + 3x AJ $23.12
  calculateRefund: async () => ({ subtotalSet: { shopMoney: { amount: '98.15' } } }),
});
stubAbs('promotions/discounts', {
  listRegistry: async () => [
    { kind: 'volume', status: 'active', sku_prefixes: ['AJ'], tiers: [{ threshold: 3, percentage: 10 }, { threshold: 5, percentage: 15 }] },
    { kind: 'volume', status: 'active', sku_prefixes: ['RUBY'], tiers: [{ threshold: 2, percentage: 10 }] },
  ],
});

const tools = require('../lib/tools/exchangeDifference');
const exchangeDifference = tools.find((t) => t.name === 'exchange_difference');

const EITAN_RETURN = [{ sku: 'FLO-SND-12', quantity: 1 }, { sku: 'AJ-SND-12', quantity: 3 }];
const EITAN_NEW = [{ sku: 'RUBY-BLK-10', quantity: 1 }, { sku: 'RUBY-BLK-11', quantity: 2 }, { sku: 'AJ-BLK-10', quantity: 1 }];

test('Eitan: Ruby 2+ discount applied, real credit from refund calc, net = 48.65', async () => {
  const res = await exchangeDifference.handler({
    return_order_number: '#29649', return_items: EITAN_RETURN, new_items: EITAN_NEW, invoice_requested: true,
  });
  const p = res._plan;
  assert.equal(p.returnCredit, 98.15, 'credit comes from Shopify refund calc');
  assert.equal(p.newSubtotal, 146.80, 'Ruby qty 3 → 10% off; lone AJ full price');
  assert.equal(p.net, 48.65);
  assert.equal(p.direction, 'invoice');
  assert.equal(p.recommended, 'invoice', 'operator asked to invoice → invoice');
  // the text preview hands the agent paid_items carrying the discount
  assert.match(res.content[0].text, /discount_percent/);
  // and the real customer id, so the agent never fabricates one from the email
  assert.equal(p.customerId, 'gid://shopify/Customer/8065558413590');
  assert.match(res.content[0].text, /customer_id="gid:\/\/shopify\/Customer\/8065558413590"/);
});

test('Same items + net>0 but invoice NOT requested → free_exchange (we absorb)', async () => {
  const res = await exchangeDifference.handler({
    return_order_number: '#29649', return_items: EITAN_RETURN, new_items: EITAN_NEW, invoice_requested: false,
  });
  assert.equal(res._plan.recommended, 'free_exchange');
});

// Regression: a returned line item with no resolvable id must error clearly,
// NOT pass lineItemId:null to Shopify's refund calc (the live #29649 bug).
test('return item without a line-item id → clear error, no Shopify call with null', async () => {
  const res = await exchangeDifference.handler({
    return_order_number: '#29649',
    return_items: [{ sku: 'NOID-SKU', quantity: 1 }],
    new_items: [{ sku: 'AJ-BLK-10', quantity: 1 }],
    invoice_requested: true,
  });
  assert.match(res.content[0].text, /Could not resolve line-item IDs/);
  assert.equal(res._plan, undefined, 'no plan produced when ids are missing');
});
