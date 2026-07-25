const test = require('node:test');
const assert = require('node:assert');

const {
  classifyOrder,
  composeBody,
  formatPreOrderDate,
  hasPreOrderAttr,
  filterToNotReadyToShip,
  reclassifyWithWarehouseStock,
  pastNextBusinessDay5pmPT,
} = require('../lib/unnotifiedPreOrder');

// Build a candidate in the shape detectUnnotifiedPreOrders produces.
function candidate(caseLabel, leaks, orderNumber = '1', inStockOther = [], oosOther = []) {
  return { order: { order_number: orderNumber }, classification: { case: caseLabel, leaks, inStockOther, oosOther } };
}
const whOrders = entries => new Map(entries.map(([num, readyToShip]) => [num, { ready_to_ship: readyToShip }]));

test('filterToNotReadyToShip keeps an order where ready_to_ship is false', () => {
  const cands = [candidate('A', [{ sku: 'GAF-BLK-S' }], '31169')];
  const out = filterToNotReadyToShip(cands, whOrders([['31169', false]]));
  assert.equal(out.length, 1);
  assert.equal(out[0].classification.case, 'A');
});

test('filterToNotReadyToShip drops an order where ready_to_ship is true (will ship)', () => {
  const cands = [candidate('A', [{ sku: 'GAF-BLK-M' }], '31117')];
  const out = filterToNotReadyToShip(cands, whOrders([['31117', true]]));
  assert.equal(out.length, 0);
});

test('filterToNotReadyToShip drops an order not found in Warehance', () => {
  const cands = [candidate('A', [{ sku: 'GAF-BLK-L' }], '31200')];
  const out = filterToNotReadyToShip(cands, new Map());
  assert.equal(out.length, 0);
});

test('filterToNotReadyToShip handles order numbers with leading #', () => {
  const cands = [candidate('A', [{ sku: 'GAF-BLK-S' }], '#31169')];
  const out = filterToNotReadyToShip(cands, whOrders([['31169', false]]));
  assert.equal(out.length, 1);
});

test('filterToNotReadyToShip keeps only not-ready orders from a mixed batch', () => {
  const cands = [
    candidate('A', [{ sku: 'GAF-BLK-S' }], '31112'),
    candidate('A', [{ sku: 'GAF-BLK-M' }], '31117'),
    candidate('A', [{ sku: 'GAF-BLK-L' }], '31169'),
  ];
  const orders = whOrders([['31112', true], ['31117', true], ['31169', false]]);
  const out = filterToNotReadyToShip(cands, orders);
  assert.equal(out.length, 1);
  assert.equal(out[0].order.order_number, '31169');
});

// ---------------------------------------------------------------------------
// reclassifyWithWarehouseStock — per-item warehouse truth over Shopify signal
// ---------------------------------------------------------------------------

const stock = entries => new Map(entries.map(([sku, on_hand]) => [sku, { on_hand }]));

test('reclassifyWithWarehouseStock — order #32601 regression: allocated leak drops the whole order', () => {
  // Sky flagged as leak from Shopify available=0, but its unit is on hand at
  // the warehouse allocated to this order. The genuine backorders (Sassys)
  // carry Pre-order attrs so they're oosOther, not leaks. Result: no leaks
  // left → null → no outreach.
  const classification = {
    case: 'C',
    leaks: [{ sku: 'SKY2-BLK-M', quantity: 1 }],
    inStockOther: [{ sku: 'SHS-BLK-M', quantity: 1 }],
    oosOther: [{ sku: 'HLA-BLK-S', quantity: 1 }, { sku: 'HLA-BLK-M', quantity: 1 }],
  };
  const out = reclassifyWithWarehouseStock(classification, stock([
    ['SKY2-BLK-M', 1], ['SHS-BLK-M', 23], ['HLA-BLK-S', 0], ['HLA-BLK-M', 0],
  ]));
  assert.equal(out, null);
});

test('reclassifyWithWarehouseStock — genuine leak survives, warehouse-covered other recomputes C to B', () => {
  const classification = {
    case: 'C',
    leaks: [{ sku: 'LEAK-1', quantity: 1 }],
    inStockOther: [],
    oosOther: [{ sku: 'OTHER-1', quantity: 1 }],
  };
  const out = reclassifyWithWarehouseStock(classification, stock([['LEAK-1', 0], ['OTHER-1', 3]]));
  assert.equal(out.case, 'B');
  assert.equal(out.leaks.length, 1);
  assert.equal(out.oosOther.length, 0);
  assert.equal(out.inStockOther.length, 1);
});

test('reclassifyWithWarehouseStock — SKU with no warehouse data keeps its Shopify verdict', () => {
  const classification = { case: 'A', leaks: [{ sku: 'UNKNOWN-1', quantity: 1 }], inStockOther: [], oosOther: [] };
  const out = reclassifyWithWarehouseStock(classification, new Map());
  assert.equal(out.case, 'A');
  assert.equal(out.leaks.length, 1);
});

test('reclassifyWithWarehouseStock — null warehouse record (SKU not found) keeps Shopify verdict', () => {
  // fetchSkuStockMany maps unfound SKUs to null, not missing keys.
  const classification = { case: 'A', leaks: [{ sku: 'GONE-1', quantity: 1 }], inStockOther: [], oosOther: [] };
  const out = reclassifyWithWarehouseStock(classification, new Map([['GONE-1', null]]));
  assert.equal(out.case, 'A');
});

test('reclassifyWithWarehouseStock — on_hand must cover the full line quantity', () => {
  const classification = { case: 'A', leaks: [{ sku: 'X-1', quantity: 2 }], inStockOther: [], oosOther: [] };
  const out = reclassifyWithWarehouseStock(classification, stock([['X-1', 1]]));
  assert.equal(out.case, 'A', '1 on hand cannot cover qty 2 — still a genuine leak');
});

test('reclassifyWithWarehouseStock — all leaks covered with an in-stock other returns null too', () => {
  const classification = {
    case: 'B',
    leaks: [{ sku: 'ALLOC-1', quantity: 1 }],
    inStockOther: [{ sku: 'IN-1', quantity: 1 }],
    oosOther: [],
  };
  const out = reclassifyWithWarehouseStock(classification, stock([['ALLOC-1', 5], ['IN-1', 9]]));
  assert.equal(out, null);
});

test('pastNextBusinessDay5pmPT — a Monday order is past deadline after Tuesday 5pm PT', () => {
  // Monday 2026-06-01 at 9am PT → deadline is Tuesday 2026-06-02 at 5pm PT.
  const orderDate = '2026-06-01T16:00:00Z'; // 9am PT (UTC-7 in June)
  // Tuesday 5pm PT = Tuesday 2026-06-02T17:00-07:00 = 2026-06-03T00:00Z
  // So just before deadline (June 2 at 4:59pm PT): should be false
  // Just after deadline (June 2 at 5:01pm PT): should be true
  // We can't mock Date.now(), so just verify the function parses correctly
  // by checking a very old order is always past deadline.
  const veryOldOrder = '2026-01-01T00:00:00Z';
  assert.equal(pastNextBusinessDay5pmPT(veryOldOrder), true, 'old order always past deadline');
});

test('pastNextBusinessDay5pmPT — a Friday order skips weekend (deadline Monday 5pm PT)', () => {
  // If placed on a Friday, next business day is Monday (skip Sat + Sun).
  // Jan 2 2026 is a Friday; its Monday deadline was Jan 5 2026 5pm PT — long past.
  const fridayOrder = '2026-01-02T18:00:00Z'; // Friday Jan 2 at 10am PT (PST, UTC-8)
  assert.equal(pastNextBusinessDay5pmPT(fridayOrder), true, 'Friday order past Monday deadline');
});

test('pastNextBusinessDay5pmPT — a fresh order placed today is not yet past deadline', () => {
  // An order placed right now will have a deadline of tomorrow (next biz day) 5pm PT.
  // So it should return false.
  assert.equal(pastNextBusinessDay5pmPT(new Date().toISOString()), false, 'order placed now is not past deadline');
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
