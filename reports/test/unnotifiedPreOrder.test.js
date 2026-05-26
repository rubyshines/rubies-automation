const test = require('node:test');
const assert = require('node:assert');

const {
  classifyOrder,
  composeBody,
  formatPreOrderDate,
  hasPreOrderAttr,
  filterToBackordered,
} = require('../lib/unnotifiedPreOrder');

// Build a candidate in the shape detectUnnotifiedPreOrders produces.
function candidate(caseLabel, leaks, inStockOther = [], oosOther = []) {
  return { order: { order_number: '1' }, classification: { case: caseLabel, leaks, inStockOther, oosOther } };
}
const stock = entries => new Map(entries.map(([sku, backordered]) => [sku, { backordered }]));

test('filterToBackordered keeps an order whose leak is genuinely backordered', () => {
  const cands = [candidate('A', [{ sku: 'GAF-BLK-S' }])];
  const out = filterToBackordered(cands, stock([['GAF-BLK-S', 1]]));
  assert.equal(out.length, 1);
  assert.equal(out[0].classification.leaks.length, 1);
  assert.equal(out[0].classification.case, 'A');
});

test('filterToBackordered drops a false positive (leak shows 0 available but has on-hand stock, not backordered)', () => {
  // The Naomi-M case: Shopify available 0 (fully committed) but warehouse can fill it.
  const cands = [candidate('A', [{ sku: 'GAF-BLK-M' }])];
  const out = filterToBackordered(cands, stock([['GAF-BLK-M', 0]]));
  assert.equal(out.length, 0);
});

test('filterToBackordered drops when the SKU has no warehouse stock record', () => {
  const cands = [candidate('A', [{ sku: 'MYSTERY' }])];
  const out = filterToBackordered(cands, new Map());
  assert.equal(out.length, 0);
});

test('filterToBackordered reclassifies a non-backordered leak as in-stock and recomputes the case', () => {
  // Two leaks: one truly backordered, one actually fillable → survives as Case B.
  const cands = [candidate('A', [{ sku: 'GAF-BLK-S' }, { sku: 'GAF-BLK-M' }])];
  const out = filterToBackordered(cands, stock([['GAF-BLK-S', 1], ['GAF-BLK-M', 0]]));
  assert.equal(out.length, 1);
  assert.equal(out[0].classification.leaks.length, 1);
  assert.equal(out[0].classification.leaks[0].sku, 'GAF-BLK-S');
  assert.equal(out[0].classification.inStockOther.length, 1);
  assert.equal(out[0].classification.case, 'B');
});

test('filterToBackordered demotes a non-backordered other-OOS item, flipping Case C to B', () => {
  // The "other OOS" item actually has stock → it becomes an in-stock item, so
  // the order is now leak + in-stock other (Case B), not leak-only (Case A).
  const cands = [candidate('C', [{ sku: 'GAF-BLK-S' }], [], [{ sku: 'GAF-BLK-L' }])];
  const out = filterToBackordered(cands, stock([['GAF-BLK-S', 1], ['GAF-BLK-L', 0]]));
  assert.equal(out.length, 1);
  assert.equal(out[0].classification.oosOther.length, 0);
  assert.equal(out[0].classification.inStockOther.length, 1);
  assert.equal(out[0].classification.case, 'B');
});

test('formatPreOrderDate buckets days into beginning/middle/end of month', () => {
  assert.equal(formatPreOrderDate('2026-07-05'), 'beginning of July, 2026');
  assert.equal(formatPreOrderDate('2026-07-15'), 'middle of July, 2026');
  assert.equal(formatPreOrderDate('2026-07-30'), 'end of July, 2026');
  assert.equal(formatPreOrderDate(null), null);
  assert.equal(formatPreOrderDate('not a date'), null);
});

test('hasPreOrderAttr matches Pre-order key case-insensitively', () => {
  assert.equal(hasPreOrderAttr([{ key: 'Pre-order', value: 'Target ...' }]), true);
  assert.equal(hasPreOrderAttr([{ key: 'pre-order', value: 'x' }]), true);
  assert.equal(hasPreOrderAttr([{ key: 'preorder', value: 'x' }]), true);
  assert.equal(hasPreOrderAttr([{ key: '_cs_bundle_id', value: '27324' }]), false);
  assert.equal(hasPreOrderAttr([]), false);
  assert.equal(hasPreOrderAttr(null), false);
});

test('classifyOrder Case A — only leak items', () => {
  const li = { sku: 'HLA-BLK-L', title: 'THE SASSY', variant_title: 'Black / L', unit_price: 35, custom_attributes: [] };
  const variantStateBySku = new Map([['HLA-BLK-L', { sku: 'HLA-BLK-L', inventory_quantity: 0, pre_order_date: '2026-07-30' }]]);
  const c = classifyOrder([li], variantStateBySku);
  assert.equal(c.case, 'A');
  assert.equal(c.leaks.length, 1);
  assert.equal(c.inStockOther.length, 0);
});

test('classifyOrder Case B — leak + in-stock other', () => {
  const lis = [
    { sku: 'HLA-SND-M', title: 'SASSY', variant_title: 'Sandstone / M', unit_price: 35, custom_attributes: [] },
    { sku: 'CKY-BLK-M', title: 'CHEEKY', variant_title: 'Black / M', unit_price: 35, custom_attributes: [] },
  ];
  const variantStateBySku = new Map([
    ['HLA-SND-M', { sku: 'HLA-SND-M', inventory_quantity: 0, pre_order_date: '2026-07-30' }],
    ['CKY-BLK-M', { sku: 'CKY-BLK-M', inventory_quantity: 90, pre_order_date: null }],
  ]);
  const c = classifyOrder(lis, variantStateBySku);
  assert.equal(c.case, 'B');
  assert.equal(c.leaks.length, 1);
  assert.equal(c.inStockOther.length, 1);
});

test('classifyOrder Case C — leak + known-pre-order other (not a leak but OOS)', () => {
  const lis = [
    { sku: 'A', title: 'A', unit_price: 35, custom_attributes: [] },
    { sku: 'B', title: 'B', unit_price: 35, custom_attributes: [{ key: 'Pre-order', value: 'soon' }] },
  ];
  const variantStateBySku = new Map([
    ['A', { sku: 'A', inventory_quantity: 0 }],
    ['B', { sku: 'B', inventory_quantity: 0 }],
  ]);
  const c = classifyOrder(lis, variantStateBySku);
  assert.equal(c.case, 'C');
  assert.equal(c.leaks.length, 1);
  assert.equal(c.oosOther.length, 1);
});

test('classifyOrder Case A when both items are leaks (no other paid items)', () => {
  const lis = [
    { sku: 'A', title: 'A', unit_price: 35, custom_attributes: [] },
    { sku: 'B', title: 'B', unit_price: 35, custom_attributes: [] },
  ];
  const variantStateBySku = new Map([
    ['A', { sku: 'A', inventory_quantity: 0 }],
    ['B', { sku: 'B', inventory_quantity: 0 }],
  ]);
  const c = classifyOrder(lis, variantStateBySku);
  assert.equal(c.case, 'A');
  assert.equal(c.leaks.length, 2);
});

test('classifyOrder skips items that already carry Pre-order customAttribute', () => {
  const lis = [
    { sku: 'X', title: 'X', unit_price: 35, custom_attributes: [{ key: 'Pre-order', value: 'soon' }] },
  ];
  const variantStateBySku = new Map([['X', { sku: 'X', inventory_quantity: 0 }]]);
  const c = classifyOrder(lis, variantStateBySku);
  assert.equal(c, null);
});

test('classifyOrder skips items with no SKU (e.g. Tip line items)', () => {
  const lis = [
    { sku: null, title: 'Tip', unit_price: 5, custom_attributes: [] },
    { sku: 'HLA-BLK-L', title: 'SASSY', variant_title: 'Black/L', unit_price: 35, custom_attributes: [] },
  ];
  const variantStateBySku = new Map([
    ['HLA-BLK-L', { sku: 'HLA-BLK-L', inventory_quantity: 0, pre_order_date: '2026-07-30' }],
  ]);
  const c = classifyOrder(lis, variantStateBySku);
  assert.equal(c.case, 'A');
  assert.equal(c.leaks.length, 1);
});

test('classifyOrder skips items whose SKU has no variant record (deleted/discontinued)', () => {
  const lis = [
    { sku: 'GONE-SKU', title: 'Discontinued', unit_price: 20, custom_attributes: [] },
    { sku: 'HLA-BLK-L', title: 'SASSY', variant_title: 'Black/L', unit_price: 35, custom_attributes: [] },
  ];
  const variantStateBySku = new Map([
    ['HLA-BLK-L', { sku: 'HLA-BLK-L', inventory_quantity: 0, pre_order_date: '2026-07-30' }],
  ]);
  const c = classifyOrder(lis, variantStateBySku);
  // GONE-SKU is dropped; HLA-BLK-L is the only paid item and is OOS → Case A.
  assert.equal(c.case, 'A');
  assert.equal(c.leaks.length, 1);
});

test('classifyOrder ignores freebie SKUs and zero-price items', () => {
  const lis = [
    { sku: 'HLA-BLK-L', title: 'SASSY', variant_title: 'Black/L', unit_price: 35, custom_attributes: [] },
    { sku: 'MESSAGECARD', title: 'Free message card', unit_price: 0, custom_attributes: [] },
  ];
  const variantStateBySku = new Map([
    ['HLA-BLK-L', { sku: 'HLA-BLK-L', inventory_quantity: 0, pre_order_date: '2026-07-30' }],
    ['MESSAGECARD', { sku: 'MESSAGECARD', inventory_quantity: 0 }],
  ]);
  const c = classifyOrder(lis, variantStateBySku);
  assert.equal(c.case, 'A');
});

test('composeBody Case A — out-of-sync framing, ETA, no em dashes, no "weren\'t flagged"', () => {
  const c = {
    case: 'A',
    leaks: [{ sku: 'HLA-BLK-L', title: 'THE SASSY', variant_title: 'Black / L', _variant: { pre_order_date: '2026-07-30' } }],
    inStockOther: [],
    oosOther: [],
  };
  const body = composeBody({ orderNumber: '30675', classification: c });
  assert.match(body, /#30675/);
  assert.match(body, /end of July, 2026/);
  assert.match(body, /inventory got out of sync/);
  assert.match(body, /Hold the order/);
  assert.match(body, /Cancel the order and refund/);
  assert.equal(body.includes('—'), false, 'no em dashes in customer copy');
  assert.equal(body.includes("weren't flagged"), false, 'avoid jargon framing');
});

test('composeBody Case B includes split-shipment option', () => {
  const c = {
    case: 'B',
    leaks: [{ sku: 'HLA-SND-M', title: 'SASSY', variant_title: 'Sandstone / M', _variant: { pre_order_date: '2026-07-30' } }],
    inStockOther: [{ sku: 'CKY-BLK-M', title: 'CHEEKY' }],
    oosOther: [],
  };
  const body = composeBody({ orderNumber: '30662', classification: c });
  assert.match(body, /Ship the in-stock items right away/);
  assert.match(body, /Refund just the pre-order items/);
  assert.match(body, /inventory got out of sync/);
});

test('composeBody plural agreement when multiple leak items', () => {
  const c = {
    case: 'A',
    leaks: [
      { sku: 'X', title: 'X', _variant: { pre_order_date: '2026-07-30' } },
      { sku: 'Y', title: 'Y', _variant: { pre_order_date: '2026-07-30' } },
    ],
    inStockOther: [],
    oosOther: [],
  };
  const body = composeBody({ orderNumber: '1', classification: c });
  assert.match(body, /you ordered are on pre-order/);
});

test('composeBody falls back gracefully when no ETA known', () => {
  const c = {
    case: 'A',
    leaks: [{ sku: 'X', title: 'Item', _variant: { pre_order_date: null } }],
    inStockOther: [],
    oosOther: [],
  };
  const body = composeBody({ orderNumber: '1', classification: c });
  assert.match(body, /don't have a firm restock date yet/);
});

test('composeBody includes swap bullet with same-product + cross-product alternatives', () => {
  const c = {
    case: 'A',
    leaks: [{ sku: 'HLA-BLK-L', title: 'SASSY', _variant: { pre_order_date: '2026-07-30' } }],
    inStockOther: [],
    oosOther: [],
  };
  const body = composeBody({
    orderNumber: '30675',
    classification: c,
    alternatives: ['the Sassy in Pink, size L', 'the Cheeky in Black, size L'],
  });
  assert.match(body, /Swap for the Sassy in Pink, size L or the Cheeky in Black, size L/);
  assert.match(body, /\(both in stock\)/);
});

test('composeBody omits swap bullet when no alternatives', () => {
  const c = {
    case: 'A',
    leaks: [{ sku: 'X', title: 'Item', _variant: { pre_order_date: '2026-07-30' } }],
    inStockOther: [],
    oosOther: [],
  };
  const body = composeBody({ orderNumber: '1', classification: c, alternatives: [] });
  assert.equal(body.includes('Swap for'), false);
});

test('composeBody adds delay acknowledgement when order is older than threshold', () => {
  const c = {
    case: 'A',
    leaks: [{ sku: 'X', title: 'Item', _variant: { pre_order_date: '2026-07-30' } }],
    inStockOther: [],
    oosOther: [],
  };
  const recent = composeBody({ orderNumber: '1', classification: c, daysSinceOrder: 1 });
  const stale = composeBody({ orderNumber: '1', classification: c, daysSinceOrder: 7 });
  assert.equal(recent.includes('apologies for the delay'), false);
  assert.match(stale, /apologies for the delay reaching out/);
  assert.match(stale, /I only just caught this/);
});
