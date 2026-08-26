/**
 * Duplicate-shipment guard for create_invoice_order.
 *
 * Regression origin: ticket 3138 / order #32992. "Add the chest pads and invoice
 * the difference" was executed as a new draft order carrying the original
 * order's items at 100% off plus the pads at $27. The customer paid, the draft
 * completed into order #33003, and both orders held the same goods — nothing
 * placeholder-fulfills the source in this tool the way consolidate_orders and
 * split_shipment do. The correct tool (edit_order, add-only) was previewed first
 * and then dropped, so the fix is deterministic rather than another prompt rule.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const {
  findLiveOrderOverlap,
  liveOrderOverlapWarning,
  LIVE_ORDER_OVERLAP_MARKER,
} = require('../lib/orderUtils');

const order = (over) => ({
  name: '#32992',
  cancelledAt: null,
  displayFulfillmentStatus: 'UNFULFILLED',
  lineItems: [
    { sku: 'SKY2-BLK-16T', quantity: 1, currentQuantity: 1 },
    { sku: 'SPB-BLK-M', quantity: 2, currentQuantity: 2 },
  ],
  ...over,
});

test('flags free lines that are still on an unshipped order', () => {
  const hits = findLiveOrderOverlap([order()], ['SKY2-BLK-16T', 'SPB-BLK-M']);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].name, '#32992');
  assert.deepEqual(hits[0].skus.sort(), ['SKY2-BLK-16T', 'SPB-BLK-M']);
});

test('the live #32992 shape produces a warning carrying the gate marker', () => {
  const warning = liveOrderOverlapWarning(
    findLiveOrderOverlap([order()], ['SKY2-BLK-16T', 'SPB-BLK-M'])
  );
  assert.ok(warning.includes(LIVE_ORDER_OVERLAP_MARKER));
  assert.ok(warning.includes('#32992'));
  // Names the tool that should have been used — "this is wrong" alone strands
  // the operator.
  assert.ok(/edit_order/.test(warning));
});

test('the ordinary exchange is NOT flagged — source order already shipped', () => {
  // 22 of the 24 historical create_invoice_order calls look like this. A guard
  // that fires on them is a guard people learn to click past.
  const shipped = order({ displayFulfillmentStatus: 'FULFILLED' });
  assert.deepEqual(findLiveOrderOverlap([shipped], ['SKY2-BLK-16T']), []);
  assert.equal(liveOrderOverlapWarning([]), null);
});

test('a cancelled order is not live even when unfulfilled', () => {
  const cancelled = order({ cancelledAt: '2026-08-12T00:00:00Z' });
  assert.deepEqual(findLiveOrderOverlap([cancelled], ['SKY2-BLK-16T']), []);
});

test('a line edited off the order no longer counts as waiting', () => {
  // currentQuantity is what survives removals and refunds; quantity is what was
  // originally bought. Reading the wrong one would warn about goods the customer
  // is no longer getting.
  const edited = order({
    lineItems: [{ sku: 'SKY2-BLK-16T', quantity: 1, currentQuantity: 0 }],
  });
  assert.deepEqual(findLiveOrderOverlap([edited], ['SKY2-BLK-16T']), []);
});

test('falls back to quantity when currentQuantity is absent', () => {
  const legacy = order({ lineItems: [{ sku: 'SKY2-BLK-16T', quantity: 1 }] });
  assert.equal(findLiveOrderOverlap([legacy], ['SKY2-BLK-16T']).length, 1);
});

test('partially fulfilled orders are still checked', () => {
  // Deliberately over-warns: the specific line may already have gone out, but a
  // needless glance is cheaper than a duplicate parcel.
  const partial = order({ displayFulfillmentStatus: 'PARTIALLY_FULFILLED' });
  assert.equal(findLiveOrderOverlap([partial], ['SPB-BLK-M']).length, 1);
});

test('SKU comparison is case-insensitive', () => {
  assert.equal(findLiveOrderOverlap([order()], ['sky2-blk-16t']).length, 1);
});

test('only the overlapping SKUs are named, not the whole order', () => {
  const hits = findLiveOrderOverlap([order()], ['SPB-BLK-M']);
  assert.deepEqual(hits[0].skus, ['SPB-BLK-M']);
});

test('no exchange items, no lookup and no warning', () => {
  assert.deepEqual(findLiveOrderOverlap([order()], []), []);
  assert.deepEqual(findLiveOrderOverlap([order()], undefined), []);
});

test('reports every overlapping order, not just the first', () => {
  const second = order({ name: '#33100', lineItems: [{ sku: 'SPB-BLK-M', quantity: 1, currentQuantity: 1 }] });
  const hits = findLiveOrderOverlap([order(), second], ['SPB-BLK-M']);
  assert.deepEqual(hits.map(h => h.name), ['#32992', '#33100']);
});

test('tolerates malformed order rows without throwing', () => {
  assert.deepEqual(findLiveOrderOverlap([null, {}, { lineItems: null }], ['SKY2-BLK-16T']), []);
});
