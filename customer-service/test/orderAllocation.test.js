/**
 * Unit tests for reports/lib/orderAllocation.js — reconstructing which orders
 * hold a SKU's allocated units.
 *
 * The bug these pin: per-order allocation was being read off two SKU-GLOBAL
 * counters (`available < qty AND backordered > 0`). Both are totals across
 * every order holding the SKU, so they cannot answer a per-order question —
 * `available` reads 0 because the units are reserved (possibly for the order
 * being asked about) and `backordered` is raised above zero by any one short
 * order anywhere. The #33009 case below is the live reproduction.
 *
 * Run: node --test customer-service/test/orderAllocation.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  openQuantity,
  buildAllocationIndex,
  isLineAllocated,
  orderFullyAllocated,
  verifyAgainstCounters,
  sellableUnits,
} = require('../../reports/lib/orderAllocation');

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function order(number, date, items, extra = {}) {
  return {
    order_number: `#${number}`,
    order_date: `${date}T00:00:00Z`,
    order_items: items.map(i => ({
      sku: i.sku,
      quantity: i.qty,
      quantity_shipped: i.shipped || 0,
      cancelled: i.cancelled || false,
    })),
    ...extra,
  };
}

function stock(entries) {
  return new Map(Object.entries(entries));
}

// ---------------------------------------------------------------------------
// The live case: #33009, 2026-08-24
// ---------------------------------------------------------------------------

describe('buildAllocationIndex — the #33009 reproduction', () => {
  // AJ-BLK-M as Warehance actually reported it: 19 on hand, all 19 allocated,
  // available 0, backordered 1 — against 20 units of open demand across 7
  // orders, with #33009 fourth in line at unit 11. Nineteen units go out
  // oldest-first and the last order is one short, which is exactly the
  // backordered 1. (#32310 carries the SKU on two lines, 2 + 1: one order, one
  // three-unit claim.)
  const AJ_ORDERS = [
    order(32310, '2026-07-10', [{ sku: 'AJ-BLK-M', qty: 2 }, { sku: 'AJ-BLK-M', qty: 1 }]),
    order(32809, '2026-08-01', [{ sku: 'AJ-BLK-M', qty: 2 }]),
    order(32951, '2026-08-08', [{ sku: 'AJ-BLK-M', qty: 5 }]),
    order(33009, '2026-08-11', [{ sku: 'AJ-BLK-M', qty: 1 }, { sku: 'SPB-BLK-M', qty: 1 }]),
    order(33220, '2026-08-21', [{ sku: 'AJ-BLK-M', qty: 2 }]),
    order(33234, '2026-08-22', [{ sku: 'AJ-BLK-M', qty: 1 }]),
    order(33295, '2026-08-24', [{ sku: 'AJ-BLK-M', qty: 6 }]),
  ];
  const AJ_STOCK = stock({
    'AJ-BLK-M': { on_hand: 19, allocated: 19, available: 0, backordered: 1 },
    'SPB-BLK-M': { on_hand: 0, allocated: 0, available: 0, backordered: 14 },
  });

  it('calls the AJ reserved for #33009 despite available 0 and backordered 1', () => {
    const index = buildAllocationIndex(AJ_ORDERS, AJ_STOCK);
    assert.equal(isLineAllocated(index, '33009', 'AJ-BLK-M'), true);
    // The old test would have said the opposite, on both halves passing.
    const wh = AJ_STOCK.get('AJ-BLK-M');
    assert.ok(wh.available < 1 && wh.backordered > 0, 'the old SKU-global test still reads OOS here');
  });

  it('still calls the genuinely empty SKU on the same order waiting', () => {
    const index = buildAllocationIndex(AJ_ORDERS, AJ_STOCK);
    assert.equal(isLineAllocated(index, '33009', 'SPB-BLK-M'), false);
  });

  it('reports the queue position that makes the verdict explainable', () => {
    const index = buildAllocationIndex(AJ_ORDERS, AJ_STOCK);
    const entry = index.get('33009::AJ-BLK-M');
    assert.equal(entry.queuePosition, 11); // 3 + 2 + 5 + 1
    assert.equal(entry.onHand, 19);
  });

  // The strong check: total demand plus on-hand stock must reproduce BOTH
  // counters exactly, on the real numbers. Scoped to AJ-BLK-M because that is
  // the SKU whose full queue this fixture carries — the Evey's 14 backordered
  // units are spread over 12 orders, only one of which is modelled here, so
  // checking it would only be asserting what the fixture leaves out.
  it('reproduces Warehance\'s own allocated and backordered counts', () => {
    const index = buildAllocationIndex(AJ_ORDERS, AJ_STOCK);
    const ajOnly = new Map([['AJ-BLK-M', AJ_STOCK.get('AJ-BLK-M')]]);
    assert.deepEqual(verifyAgainstCounters(index, ajOnly), []);
  });

  // #32310 carries AJ-BLK-M on two lines. Counted separately they double up in
  // the queue ahead of everyone else, and because both share an index key the
  // order ends up holding only the last line's quantity — an entry whose
  // quantity and queue position contradict each other. Found by running the
  // reconstruction against live data, where it showed up as the counter check
  // failing.
  it('sums a SKU split across several lines of one order into a single claim', () => {
    const index = buildAllocationIndex(AJ_ORDERS, AJ_STOCK);
    const entry = index.get('32310::AJ-BLK-M');
    assert.equal(entry.quantity, 3);
    assert.equal(entry.queuePosition, 3);
  });

  it('leaves the order that straddles the cutoff waiting', () => {
    const index = buildAllocationIndex(AJ_ORDERS, AJ_STOCK);
    assert.equal(isLineAllocated(index, '33234', 'AJ-BLK-M'), true); // unit 14 of 19
    assert.equal(isLineAllocated(index, '33295', 'AJ-BLK-M'), false); // needs 6, 5 left
  });
});

// ---------------------------------------------------------------------------
// The live case: #33550, 2026-09-09 — a non-sellable unit inside on_hand
// ---------------------------------------------------------------------------

describe('buildAllocationIndex — the #33550 reproduction', () => {
  // SHS-BLK-L as Warehance reported it after a stock count came up short:
  // on_hand 1, allocated 0, available 0, backordered 3, non_sellable 1. Two
  // orders waiting on three units. Walking over on_hand handed the one
  // non-sellable unit to the older order and called it reserved, so the
  // pre-order drafter never contacted #33550 while the newer #33574 was
  // drafted — and Warehance's own has_unallocated_products said both were
  // waiting.
  const ORDERS = [
    order(33550, '2026-09-05', [{ sku: 'SHS-BLK-L', qty: 1 }]),
    order(33574, '2026-09-06', [{ sku: 'SHS-BLK-L', qty: 2 }]),
  ];
  const STOCK = stock({
    'SHS-BLK-L': { on_hand: 1, allocated: 0, available: 0, backordered: 3 },
  });

  it('does not hand a non-sellable unit to the oldest order', () => {
    const index = buildAllocationIndex(ORDERS, STOCK);
    assert.equal(isLineAllocated(index, '33550', 'SHS-BLK-L'), false);
    assert.equal(isLineAllocated(index, '33574', 'SHS-BLK-L'), false);
  });

  it('carries the sellable pool it walked, with on_hand kept for diagnosis', () => {
    const entry = buildAllocationIndex(ORDERS, STOCK).get('33550::SHS-BLK-L');
    assert.equal(entry.sellable, 0);
    assert.equal(entry.onHand, 1);
  });

  // On on_hand this SKU was a "split" mismatch (expected allocated 1, reported
  // 0) at shortfall 0 — the shape the 2026-08-25 filter deliberately trusted.
  // Against the sellable pool the counters reproduce exactly, so the mismatch
  // was never a de-allocation signature; it was this.
  it('reproduces both counters once the pool excludes the non-sellable unit', () => {
    assert.deepEqual(verifyAgainstCounters(buildAllocationIndex(ORDERS, STOCK), STOCK), []);
  });

  it('still hands out the sellable units when only some of on_hand is sellable', () => {
    // MIA-BLK-M, live the same day: on_hand 3, allocated 2, available 0 — one
    // unit in the non-sellable bin. Two orders covered, a third is not.
    const orders = [
      order(100, '2026-01-01', [{ sku: 'MIA-BLK-M', qty: 1 }]),
      order(200, '2026-02-01', [{ sku: 'MIA-BLK-M', qty: 1 }]),
      order(300, '2026-03-01', [{ sku: 'MIA-BLK-M', qty: 1 }]),
    ];
    const st = stock({ 'MIA-BLK-M': { on_hand: 3, allocated: 2, available: 0, backordered: 1 } });
    const index = buildAllocationIndex(orders, st);
    assert.equal(isLineAllocated(index, '100', 'MIA-BLK-M'), true);
    assert.equal(isLineAllocated(index, '200', 'MIA-BLK-M'), true);
    assert.equal(isLineAllocated(index, '300', 'MIA-BLK-M'), false);
    assert.deepEqual(verifyAgainstCounters(index, st), []);
  });
});

describe('sellableUnits', () => {
  it('is allocated + available, never on_hand, when the counters are present', () => {
    assert.equal(sellableUnits({ on_hand: 343, allocated: 7, available: 309 }), 316);
    assert.equal(sellableUnits({ on_hand: 1, allocated: 0, available: 0 }), 0);
  });

  it('falls back to on_hand only when the record carries no counters to split', () => {
    assert.equal(sellableUnits({ on_hand: 4 }), 4);
    assert.equal(sellableUnits({ on_hand: 4, allocated: 1 }), 4);
    assert.equal(sellableUnits(null), 0);
  });
});

// ---------------------------------------------------------------------------
// Queue mechanics
// ---------------------------------------------------------------------------

describe('buildAllocationIndex — queue mechanics', () => {
  it('allocates oldest-first and cuts off when stock runs out', () => {
    const orders = [
      order(100, '2026-01-01', [{ sku: 'X', qty: 3 }]),
      order(200, '2026-02-01', [{ sku: 'X', qty: 2 }]),
      order(300, '2026-03-01', [{ sku: 'X', qty: 1 }]),
    ];
    const index = buildAllocationIndex(orders, stock({ X: { on_hand: 5, allocated: 5, available: 0 } }));
    assert.equal(isLineAllocated(index, '100', 'X'), true);
    assert.equal(isLineAllocated(index, '200', 'X'), true);
    assert.equal(isLineAllocated(index, '300', 'X'), false);
  });

  // A line the warehouse can only part-fill leaves the customer waiting, and
  // consumes the remainder — so nothing behind it can be covered either. Without
  // this, a small later order would jump a big earlier one and read as reserved.
  it('a partially covered line is waiting, and starves everything behind it', () => {
    const orders = [
      order(100, '2026-01-01', [{ sku: 'X', qty: 5 }]),
      order(200, '2026-02-01', [{ sku: 'X', qty: 1 }]),
    ];
    const index = buildAllocationIndex(orders, stock({ X: { on_hand: 3, allocated: 3, available: 0 } }));
    assert.equal(isLineAllocated(index, '100', 'X'), false);
    assert.equal(isLineAllocated(index, '200', 'X'), false);
  });

  it('counts only the unshipped remainder of a partially shipped line', () => {
    assert.equal(openQuantity({ quantity: 5, quantity_shipped: 3 }), 2);
    assert.equal(openQuantity({ quantity: 2, quantity_shipped: 2 }), 0);
    assert.equal(openQuantity({ quantity: 1, quantity_shipped: 4 }), 0);
    const orders = [
      order(100, '2026-01-01', [{ sku: 'X', qty: 5, shipped: 4 }]),
      order(200, '2026-02-01', [{ sku: 'X', qty: 1 }]),
    ];
    const index = buildAllocationIndex(orders, stock({ X: { on_hand: 2, allocated: 2, available: 0 } }));
    assert.equal(isLineAllocated(index, '100', 'X'), true);
    assert.equal(isLineAllocated(index, '200', 'X'), true);
  });

  it('ignores cancelled orders and cancelled lines — they hold no stock', () => {
    const orders = [
      order(100, '2026-01-01', [{ sku: 'X', qty: 5 }], { cancelled: true }),
      order(150, '2026-01-15', [{ sku: 'X', qty: 5, cancelled: true }]),
      order(200, '2026-02-01', [{ sku: 'X', qty: 1 }]),
    ];
    const index = buildAllocationIndex(orders, stock({ X: { on_hand: 1, allocated: 1, available: 0 } }));
    assert.equal(isLineAllocated(index, '200', 'X'), true);
    assert.equal(isLineAllocated(index, '100', 'X'), null);
  });

  // Several orders routinely share a date. Without a deterministic tiebreak the
  // same inputs would produce different verdicts run to run.
  it('breaks same-date ties by order number, stably', () => {
    const orders = [
      order(300, '2026-01-01', [{ sku: 'X', qty: 1 }]),
      order(100, '2026-01-01', [{ sku: 'X', qty: 1 }]),
      order(200, '2026-01-01', [{ sku: 'X', qty: 1 }]),
    ];
    for (const shuffled of [orders, [...orders].reverse()]) {
      const index = buildAllocationIndex(shuffled, stock({ X: { on_hand: 2, allocated: 2, available: 0 } }));
      assert.equal(isLineAllocated(index, '100', 'X'), true);
      assert.equal(isLineAllocated(index, '200', 'X'), true);
      assert.equal(isLineAllocated(index, '300', 'X'), false);
    }
  });

  it('returns null rather than guessing for a SKU with no stock record', () => {
    const orders = [order(100, '2026-01-01', [{ sku: 'X', qty: 1 }, { sku: 'Y', qty: 1 }])];
    const index = buildAllocationIndex(orders, stock({ X: { on_hand: 5, allocated: 1, available: 4 } }));
    assert.equal(isLineAllocated(index, '100', 'X'), true);
    assert.equal(isLineAllocated(index, '100', 'Y'), null);
  });

  it('matches order numbers with or without the leading #', () => {
    const orders = [order(100, '2026-01-01', [{ sku: 'X', qty: 1 }])];
    const index = buildAllocationIndex(orders, stock({ X: { on_hand: 5, allocated: 1, available: 4 } }));
    assert.equal(isLineAllocated(index, '#100', 'X'), true);
    assert.equal(isLineAllocated(index, 100, 'X'), true);
  });

  it('flags an under-counted queue as safe (positive shortfall)', () => {
    const orders = [order(100, '2026-01-01', [{ sku: 'X', qty: 1 }])];
    // Warehance accounts for 7 units of demand; our book only found 1, so we
    // are missing orders. That can only make later orders look reserved.
    const stockBySku = stock({ X: { on_hand: 9, allocated: 7, available: 2, backordered: 0 } });
    const [m] = verifyAgainstCounters(buildAllocationIndex(orders, stockBySku), stockBySku);
    assert.equal(m.sku, 'X');
    assert.equal(m.demand, 1);
    assert.equal(m.shortfall, 6);
  });

  it('flags an over-counted queue as dangerous (negative shortfall)', () => {
    const orders = [
      order(100, '2026-01-01', [{ sku: 'X', qty: 5 }]),
      order(200, '2026-02-01', [{ sku: 'X', qty: 5 }]),
    ];
    // Warehance sees only 4 units of demand; we found 10. Phantom demand ahead
    // of an order is what makes a reserved item read as waiting.
    const stockBySku = stock({ X: { on_hand: 9, allocated: 4, available: 5, backordered: 0 } });
    const [m] = verifyAgainstCounters(buildAllocationIndex(orders, stockBySku), stockBySku);
    assert.equal(m.demand, 10);
    assert.equal(m.shortfall, -6);
  });

  it('stays silent when demand and stock reproduce both counters', () => {
    const orders = [
      order(100, '2026-01-01', [{ sku: 'X', qty: 5 }]),
      order(200, '2026-02-01', [{ sku: 'X', qty: 5 }]),
    ];
    const stockBySku = stock({ X: { on_hand: 7, allocated: 7, available: 0, backordered: 3 } });
    assert.deepEqual(verifyAgainstCounters(buildAllocationIndex(orders, stockBySku), stockBySku), []);
  });
});

// ---------------------------------------------------------------------------
// The warehouse's own flag
// ---------------------------------------------------------------------------

describe('orderFullyAllocated', () => {
  it('reads the warehouse flag in both directions', () => {
    assert.equal(orderFullyAllocated({ not_ready_to_ship_types: { has_unallocated_products: false } }), true);
    assert.equal(orderFullyAllocated({ not_ready_to_ship_types: { has_unallocated_products: true } }), false);
  });

  it('returns null when the order does not carry the flag', () => {
    assert.equal(orderFullyAllocated({}), null);
    assert.equal(orderFullyAllocated({ not_ready_to_ship_types: {} }), null);
    assert.equal(orderFullyAllocated(null), null);
  });
});
