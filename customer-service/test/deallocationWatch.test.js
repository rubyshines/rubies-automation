/**
 * Unit tests for the de-allocation watch.
 *
 * The detection question is a TRANSITION — allocated last time, not allocated
 * now — so every test here is about a pair of observations, not a state. The
 * failure modes worth pinning are all about firing when nothing happened:
 * a first observation, a line that was already waiting, and a SKU whose
 * reconstruction we do not trust.
 *
 * Run: node --test customer-service/test/deallocationWatch.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { diffAllocations } = require('../../reports/lib/deallocationWatch');
const { buildAllocationIndex, allocationKey } = require('../../reports/lib/orderAllocation');

/** Shorthand for a current-reconstruction index entry. */
function idx(entries) {
  return new Map(entries.map(([order, sku, allocated, onHand = 5]) =>
    [allocationKey(order, sku), { allocated, onHand, quantity: 1 }]));
}

/** Shorthand for a stored previous-observation map. */
function prev(entries) {
  return new Map(entries.map(([order, sku, allocated, onHand = 5]) =>
    [allocationKey(order, sku), { allocated, on_hand: onHand }]));
}

const ALL_TRUSTED = new Set(['SHS-BLK-M', 'AJ-BLK-M', 'SPB-BLK-M']);

describe('diffAllocations — fires on a genuine de-allocation', () => {
  it('reports a line that was allocated and is now waiting', () => {
    const flips = diffAllocations(
      idx([['32951', 'SHS-BLK-M', false, 1]]),
      prev([['32951', 'SHS-BLK-M', true, 9]]),
      ALL_TRUSTED,
    );
    assert.equal(flips.length, 1);
    assert.equal(flips[0].orderNumber, '32951');
    assert.equal(flips[0].sku, 'SHS-BLK-M');
    // Carried for diagnosis: the pair says stock vanished rather than the queue
    // reshuffling ahead of this order.
    assert.equal(flips[0].onHandBefore, 9);
    assert.equal(flips[0].onHandAfter, 1);
  });

  it('reports each de-allocated line separately on a multi-line order', () => {
    const flips = diffAllocations(
      idx([['32951', 'SHS-BLK-M', false], ['32951', 'AJ-BLK-M', false]]),
      prev([['32951', 'SHS-BLK-M', true], ['32951', 'AJ-BLK-M', true]]),
      ALL_TRUSTED,
    );
    assert.equal(flips.length, 2);
    assert.deepEqual(flips.map(f => f.sku).sort(), ['AJ-BLK-M', 'SHS-BLK-M']);
  });
});

describe('diffAllocations — does not fire when nothing transitioned', () => {
  // The failure that would make the first deploy email every waiting customer in
  // the book at once. A line we have never observed has no "before", so it is
  // seeded and never reported.
  it('never fires on a line with no prior observation', () => {
    const flips = diffAllocations(
      idx([['32951', 'SHS-BLK-M', false]]),
      prev([]),
      ALL_TRUSTED,
    );
    assert.deepEqual(flips, []);
  });

  it('never fires on a line that was already waiting', () => {
    const flips = diffAllocations(
      idx([['32951', 'SPB-BLK-M', false]]),
      prev([['32951', 'SPB-BLK-M', false]]),
      ALL_TRUSTED,
    );
    assert.deepEqual(flips, []);
  });

  it('never fires on a line that stayed allocated', () => {
    const flips = diffAllocations(
      idx([['32951', 'AJ-BLK-M', true]]),
      prev([['32951', 'AJ-BLK-M', true]]),
      ALL_TRUSTED,
    );
    assert.deepEqual(flips, []);
  });

  it('never fires on the improving direction (waiting -> allocated)', () => {
    const flips = diffAllocations(
      idx([['32951', 'SHS-BLK-M', true]]),
      prev([['32951', 'SHS-BLK-M', false]]),
      ALL_TRUSTED,
    );
    assert.deepEqual(flips, []);
  });
});

describe('diffAllocations — untrusted SKUs cannot raise a flip', () => {
  // A SKU whose reconstruction disagrees with Warehance's own counters is one
  // where our demand queue is wrong, which is precisely the condition that can
  // push an order down the queue and fabricate a de-allocation. It is still
  // stored (so the next run sees no phantom transition) but never fires.
  it('suppresses a flip on a SKU excluded by the counter check', () => {
    const flips = diffAllocations(
      idx([['32951', 'SHS-BLK-M', false]]),
      prev([['32951', 'SHS-BLK-M', true]]),
      new Set(['AJ-BLK-M']), // SHS-BLK-M not trusted
    );
    assert.deepEqual(flips, []);
  });

  it('still fires on trusted SKUs in the same batch', () => {
    const flips = diffAllocations(
      idx([['32951', 'SHS-BLK-M', false], ['33000', 'AJ-BLK-M', false]]),
      prev([['32951', 'SHS-BLK-M', true], ['33000', 'AJ-BLK-M', true]]),
      new Set(['AJ-BLK-M']),
    );
    assert.equal(flips.length, 1);
    assert.equal(flips[0].sku, 'AJ-BLK-M');
  });
});

describe('de-allocation as the reconstruction actually produces it', () => {
  // End to end over buildAllocationIndex rather than hand-built index entries,
  // because the thing being detected is a property of that walk. #32951's real
  // shape: one unit on hand, one order ahead in the queue. Before the recount
  // there were two units and both orders were covered.
  const order = (num, date, sku, qty) => ({
    order_number: num,
    order_date: date,
    order_items: [{ sku, quantity: qty, quantity_shipped: 0, cancelled: false }],
  });

  it('a stock drop de-allocates the later order and leaves the earlier one', () => {
    const orders = [
      order('32601', '2026-07-23T00:00:00Z', 'SHS-BLK-M', 1),
      order('32951', '2026-08-08T00:00:00Z', 'SHS-BLK-M', 1),
    ];
    const before = buildAllocationIndex(orders, new Map([['SHS-BLK-M', { on_hand: 2 }]]));
    const after = buildAllocationIndex(orders, new Map([['SHS-BLK-M', { on_hand: 1 }]]));

    // Sanity on the fixture itself: both covered before, only the older after.
    assert.equal(before.get(allocationKey('32951', 'SHS-BLK-M')).allocated, true);
    assert.equal(after.get(allocationKey('32601', 'SHS-BLK-M')).allocated, true);
    assert.equal(after.get(allocationKey('32951', 'SHS-BLK-M')).allocated, false);

    const stored = new Map([...before].map(([k, v]) => [k, { allocated: v.allocated, on_hand: v.onHand }]));
    const flips = diffAllocations(after, stored, new Set(['SHS-BLK-M']));
    assert.equal(flips.length, 1);
    assert.equal(flips[0].orderNumber, '32951');
    assert.equal(flips[0].onHandBefore, 2);
    assert.equal(flips[0].onHandAfter, 1);
  });
});

describe('untrustedFromMismatches — only over-counted demand disqualifies', () => {
  const { untrustedFromMismatches } = require('../../reports/lib/deallocationWatch');

  // The regression. All three SKUs excluded by the first version of this filter
  // had shortfall 0 — the demand queue was exactly right — and disagreed only on
  // how the warehouse SPLIT it: one unit on hand, allocated to nobody. That is
  // the de-allocation signature, so filtering on "any mismatch" was blind
  // precisely where the watch needs to see.
  it('trusts a split-only disagreement (unit on hand, allocated to nobody)', () => {
    const out = untrustedFromMismatches([
      { sku: 'SHS-BLK-M', demand: 5, onHand: 1, expectedAllocated: 1, reportedAllocated: 0, expectedBackordered: 4, reportedBackordered: 5, shortfall: 0 },
    ]);
    assert.equal(out.size, 0);
  });

  it('distrusts over-counted demand, which can fabricate a de-allocation', () => {
    const out = untrustedFromMismatches([
      { sku: 'AJ-BLK-M', demand: 20, onHand: 19, reportedAllocated: 19, reportedBackordered: 0, shortfall: -1 },
    ]);
    assert.deepEqual([...out], ['AJ-BLK-M']);
  });

  it('trusts under-counted demand, which can only suppress an email', () => {
    const out = untrustedFromMismatches([
      { sku: 'MIA-BLK-M', demand: 2, onHand: 6, reportedAllocated: 3, reportedBackordered: 0, shortfall: 1 },
    ]);
    assert.equal(out.size, 0);
  });

  it('handles an empty mismatch list', () => {
    assert.equal(untrustedFromMismatches([]).size, 0);
    assert.equal(untrustedFromMismatches(undefined).size, 0);
  });
});
