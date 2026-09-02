const test = require('node:test');
const assert = require('node:assert');

const { lineMultiset, coversAllLines, matchReplacements } =
  require('../../reports/lib/replacementDetection');

// ---------------------------------------------------------------------------
// coversAllLines
// ---------------------------------------------------------------------------

test('coversAllLines: identical line sets cover', () => {
  const lines = [{ sku: 'BB-BLK-M', quantity: 1 }, { sku: 'SKY2-BLK-16T', quantity: 1 }];
  assert.strictEqual(coversAllLines(lines, [...lines]), true);
});

test('coversAllLines: superset covers (reship with an extra freebie)', () => {
  const orig = [{ sku: 'BB-BLK-M', quantity: 1 }];
  const cand = [{ sku: 'BB-BLK-M', quantity: 1 }, { sku: 'MPAD-SND-M', quantity: 1 }];
  assert.strictEqual(coversAllLines(orig, cand), true);
});

test('coversAllLines: missing SKU does not cover (a size exchange is not a reship)', () => {
  const orig = [{ sku: 'BB-BLK-M', quantity: 1 }];
  const cand = [{ sku: 'BB-BLK-L', quantity: 1 }];
  assert.strictEqual(coversAllLines(orig, cand), false);
});

test('coversAllLines: lower quantity does not cover', () => {
  const orig = [{ sku: 'BB-BLK-M', quantity: 2 }];
  const cand = [{ sku: 'BB-BLK-M', quantity: 1 }];
  assert.strictEqual(coversAllLines(orig, cand), false);
});

test('coversAllLines: quantity split across duplicate lines still covers', () => {
  const orig = [{ sku: 'BB-BLK-M', quantity: 2 }];
  const cand = [{ sku: 'BB-BLK-M', quantity: 1 }, { sku: 'BB-BLK-M', quantity: 1 }];
  assert.strictEqual(coversAllLines(orig, cand), true);
});

test('coversAllLines: an original with no SKU data never claims coverage', () => {
  assert.strictEqual(coversAllLines([], [{ sku: 'BB-BLK-M', quantity: 1 }]), false);
  assert.strictEqual(coversAllLines([{ sku: null, quantity: 1 }], [{ sku: 'BB-BLK-M', quantity: 1 }]), false);
});

test('lineMultiset: aggregates duplicate SKUs and skips missing ones', () => {
  const m = lineMultiset([
    { sku: 'A', quantity: 1 }, { sku: 'A', quantity: 2 }, { sku: null, quantity: 5 },
  ]);
  assert.strictEqual(m.get('A'), 3);
  assert.strictEqual(m.size, 1);
});

// ---------------------------------------------------------------------------
// matchReplacements
// ---------------------------------------------------------------------------

const STUCK = {
  order_number: 32853,
  shopify_order_id: 'gid://shopify/Order/1',
  customer_email: 'jessie@example.com',
  created_at: '2026-08-03T18:38:46+00:00',
};
const LINES = {
  'gid://shopify/Order/1': [
    { sku: 'BB-BLK-M', quantity: 1 },
    { sku: 'MPAD-SND-M', quantity: 1 },
    { sku: 'SKY2-BLK-16T', quantity: 1 },
  ],
};

function candidate(overrides = {}) {
  return {
    order_number: 33312,
    shopify_order_id: 'gid://shopify/Order/2',
    customer_email: 'jessie@example.com',
    created_at: '2026-08-25T17:11:16+00:00',
    total_price: 0,
    fulfillment_status: 'FULFILLED',
    cancelled_at: null,
    ...overrides,
  };
}

function linesFor(cand, lines = LINES['gid://shopify/Order/1']) {
  return { ...LINES, [cand.shopify_order_id]: lines };
}

test('matchReplacements: $0 same-SKU newer order resolves (the #32853 case)', () => {
  const cand = candidate();
  const res = matchReplacements({
    stuckOrders: [STUCK], candidateOrders: [cand], linesByShopifyId: linesFor(cand),
  });
  assert.strictEqual(res.length, 1);
  assert.strictEqual(res[0].order_number, 32853);
  assert.strictEqual(res[0].action, 'resolve');
  assert.strictEqual(res[0].replacement.order_number, 33312);
  assert.strictEqual(res[0].replacement.kind, 'reshipped_free');
});

test('matchReplacements: paid same-SKU newer order only tags', () => {
  const cand = candidate({ total_price: 134 });
  const res = matchReplacements({
    stuckOrders: [STUCK], candidateOrders: [cand], linesByShopifyId: linesFor(cand),
  });
  assert.strictEqual(res.length, 1);
  assert.strictEqual(res[0].action, 'tag');
  assert.strictEqual(res[0].replacement.kind, 'paid_lookalike');
});

test('matchReplacements: an order placed BEFORE the stuck one never matches', () => {
  const cand = candidate({ created_at: '2026-08-01T00:00:00+00:00' });
  const res = matchReplacements({
    stuckOrders: [STUCK], candidateOrders: [cand], linesByShopifyId: linesFor(cand),
  });
  assert.strictEqual(res.length, 0);
});

test('matchReplacements: a different customer never matches', () => {
  const cand = candidate({ customer_email: 'other@example.com' });
  const res = matchReplacements({
    stuckOrders: [STUCK], candidateOrders: [cand], linesByShopifyId: linesFor(cand),
  });
  assert.strictEqual(res.length, 0);
});

test('matchReplacements: email match is case-insensitive', () => {
  const cand = candidate({ customer_email: 'Jessie@Example.com' });
  const res = matchReplacements({
    stuckOrders: [STUCK], candidateOrders: [cand], linesByShopifyId: linesFor(cand),
  });
  assert.strictEqual(res.length, 1);
  assert.strictEqual(res[0].action, 'resolve');
});

test('matchReplacements: a cancelled candidate never matches', () => {
  const cand = candidate({ cancelled_at: '2026-08-26T00:00:00+00:00' });
  const res = matchReplacements({
    stuckOrders: [STUCK], candidateOrders: [cand], linesByShopifyId: linesFor(cand),
  });
  assert.strictEqual(res.length, 0);
});

test('matchReplacements: a paid candidate that is itself a stuck alert never tags (two delayed purchases)', () => {
  const cand = candidate({ total_price: 134 });
  const res = matchReplacements({
    stuckOrders: [STUCK], candidateOrders: [cand], linesByShopifyId: linesFor(cand),
    alertNums: new Set([32853, 33312]),
  });
  assert.strictEqual(res.length, 0);
});

test('matchReplacements: a $0 reship that is itself delayed still resolves the original', () => {
  const cand = candidate();
  const res = matchReplacements({
    stuckOrders: [STUCK], candidateOrders: [cand], linesByShopifyId: linesFor(cand),
    alertNums: new Set([32853, 33312]),
  });
  assert.strictEqual(res.length, 1);
  assert.strictEqual(res[0].action, 'resolve');
});

test('matchReplacements: multiple $0 matches pick the earliest reship', () => {
  const first = candidate({ order_number: 33300, shopify_order_id: 'gid://shopify/Order/3', created_at: '2026-08-20T00:00:00+00:00' });
  const second = candidate();
  const lines = { ...linesFor(first), ...linesFor(second) };
  const res = matchReplacements({
    stuckOrders: [STUCK], candidateOrders: [second, first], linesByShopifyId: lines,
  });
  assert.strictEqual(res.length, 1);
  assert.strictEqual(res[0].replacement.order_number, 33300);
});

test('matchReplacements: $0 match wins over a paid lookalike', () => {
  const free = candidate();
  const paid = candidate({ order_number: 33400, shopify_order_id: 'gid://shopify/Order/4', total_price: 134 });
  const lines = { ...linesFor(free), ...linesFor(paid) };
  const res = matchReplacements({
    stuckOrders: [STUCK], candidateOrders: [paid, free], linesByShopifyId: lines,
  });
  assert.strictEqual(res.length, 1);
  assert.strictEqual(res[0].action, 'resolve');
  assert.strictEqual(res[0].replacement.order_number, 33312);
});

test('matchReplacements: partial-SKU candidate does not match', () => {
  const cand = candidate();
  const lines = linesFor(cand, [{ sku: 'BB-BLK-M', quantity: 1 }]);
  const res = matchReplacements({
    stuckOrders: [STUCK], candidateOrders: [cand], linesByShopifyId: lines,
  });
  assert.strictEqual(res.length, 0);
});

test('matchReplacements: stuck order with no line data produces no match', () => {
  const cand = candidate();
  const res = matchReplacements({
    stuckOrders: [{ ...STUCK, shopify_order_id: 'gid://shopify/Order/none' }],
    candidateOrders: [cand],
    linesByShopifyId: linesFor(cand),
  });
  assert.strictEqual(res.length, 0);
});
