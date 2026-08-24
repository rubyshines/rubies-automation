/**
 * Per-order line-item allocation — which items the warehouse has actually
 * reserved for a specific order.
 *
 * The question "is THIS customer waiting on THIS item?" has no direct answer in
 * the Warehance public API. The API gives stock per SKU (on_hand / allocated /
 * available / backordered) and demand per order (order_items), but never the
 * join between them: which orders hold the allocated units. Every consumer that
 * needed the join was inferring it from the SKU-level counters, and those
 * counters structurally cannot answer it:
 *
 *   `available` reads 0 precisely BECAUSE the units are allocated — possibly to
 *   the very order being asked about. Low availability is as consistent with
 *   "reserved for you" as with "we don't have it".
 *
 *   `backordered` is one global counter per SKU. A single short order anywhere
 *   sets it above zero for every other order holding that SKU, including the
 *   ones sitting fully allocated on the shelf.
 *
 * So the two are combined here instead, against the demand queue: Warehance
 * allocates open orders against on-hand stock oldest-first, so replaying that
 * walk reconstructs the join. For a SKU with N units on hand, sort every open
 * order holding it by order date and hand out units until they run out; an
 * order whose full open quantity fits is allocated, and everything from the
 * first short order onward is not (a partial allocation consumes the remainder,
 * so no later order can be covered).
 *
 * The reconstruction is checked against the counters it did not use: summing
 * the allocated quantities must reproduce Warehance's own `allocated`, and the
 * shortfall must reproduce `available === 0`. Live example (2026-08-24,
 * AJ-BLK-M): on_hand 19, allocated 19, available 0, backordered 1 — and 19
 * units of open demand spread over 7 orders, every one of them covered. The
 * SKU counters alone said "out of stock and backordered" about seven orders
 * whose units were all physically reserved.
 *
 * Whole-line, not partial: an order needing 5 with 3 units left is NOT
 * allocated, because the customer is still waiting on that line. That matches
 * Warehance's own per-order `has_unallocated_products` flag, which is the
 * authoritative cross-check callers should prefer whenever it is available —
 * when it reads false, every item on the order is reserved and no
 * reconstruction is needed at all.
 */

const { fetchUnfulfilledOrders, fetchSkuStockMany } = require('./warehanceClient');

// ---------------------------------------------------------------------------
// Pure reconstruction
// ---------------------------------------------------------------------------

/** Units still owed on a line: ordered minus already shipped. */
function openQuantity(item) {
  const ordered = Number(item?.quantity) || 0;
  const shipped = Number(item?.quantity_shipped) || 0;
  return Math.max(0, ordered - shipped);
}

function normalizeOrderNumber(orderNumber) {
  return String(orderNumber ?? '').replace('#', '').trim();
}

function allocationKey(orderNumber, sku) {
  return `${normalizeOrderNumber(orderNumber)}::${sku}`;
}

/**
 * Sort key for the allocation queue: order date first, then order number as a
 * deterministic tiebreak (several orders routinely share a date, and an
 * unstable sort there would make the same inputs yield different verdicts run
 * to run). Orders with no usable date sort LAST — an order the warehouse can't
 * date can't be shown to be ahead of anyone, and pushing it back can only ever
 * cost it an allocation it might have had, which is the safe direction here
 * (see the module note on which error is cheap).
 */
function queueSortKey(order) {
  const date = order.order_date || order.created_at || '';
  const num = parseInt(normalizeOrderNumber(order.order_number), 10);
  return {
    date: date ? String(date) : '￿',
    num: Number.isFinite(num) ? num : Number.MAX_SAFE_INTEGER,
  };
}

/**
 * Replay Warehance's oldest-first allocation walk over the open order book.
 *
 * @param {Iterable<object>} openOrders — Warehance order objects (unfulfilled /
 *   partially fulfilled / in progress). Cancelled orders and cancelled lines
 *   are ignored; they hold no stock.
 * @param {Map<string, object>} stockBySku — SKU → Warehance product record.
 *   Only SKUs present in this map are reconstructed; anything else is left
 *   unknown rather than guessed.
 * @returns {Map<string, {allocated: boolean, quantity: number, onHand: number,
 *   queuePosition: number}>} keyed by allocationKey(orderNumber, sku).
 *   `queuePosition` is the cumulative unit index this line ends at, which is
 *   what makes a verdict explainable ("unit 10 of 19 on hand").
 */
function buildAllocationIndex(openOrders, stockBySku) {
  const demandBySku = new Map();

  for (const order of (openOrders || [])) {
    if (!order || order.cancelled) continue;
    const orderNumber = normalizeOrderNumber(order.order_number);
    if (!orderNumber) continue;
    const sortKey = queueSortKey(order);
    // One order can carry the same SKU on several lines (a split line, a
    // re-add). That is ONE claim on stock for that order, so the lines are
    // summed before the walk. Treating them as separate queue entries both
    // double-counts the demand ahead of everyone else and, because they share
    // an index key, leaves the order holding only the last line's quantity —
    // an entry whose own numbers disagree with each other.
    for (const item of (order.order_items || [])) {
      if (!item?.sku || item.cancelled) continue;
      if (!stockBySku.has(item.sku)) continue;
      const quantity = openQuantity(item);
      if (quantity <= 0) continue;
      if (!demandBySku.has(item.sku)) demandBySku.set(item.sku, new Map());
      const bySku = demandBySku.get(item.sku);
      const existing = bySku.get(orderNumber);
      if (existing) existing.quantity += quantity;
      else bySku.set(orderNumber, { orderNumber, quantity, sortKey });
    }
  }

  const index = new Map();
  for (const [sku, byOrder] of demandBySku) {
    const rows = [...byOrder.values()];
    rows.sort((a, b) => (
      a.sortKey.date < b.sortKey.date ? -1
        : a.sortKey.date > b.sortKey.date ? 1
          : a.sortKey.num - b.sortKey.num
    ));
    const onHand = Number(stockBySku.get(sku)?.on_hand) || 0;
    let remaining = onHand;
    let queuePosition = 0;
    for (const row of rows) {
      queuePosition += row.quantity;
      const allocated = row.quantity <= remaining;
      // A short line takes whatever is left as a partial allocation, so nothing
      // behind it can be covered either.
      remaining = allocated ? remaining - row.quantity : 0;
      index.set(allocationKey(row.orderNumber, sku), {
        allocated,
        quantity: row.quantity,
        onHand,
        queuePosition,
      });
    }
  }
  return index;
}

/**
 * Allocation verdict for one line item.
 * @returns {boolean|null} true = reserved for this order, false = still short,
 *   null = not reconstructed (SKU absent from the stock lookup, or the order is
 *   not in the open book). Callers must decide what unknown means for them
 *   rather than having a default folded in here.
 */
function isLineAllocated(index, orderNumber, sku) {
  const entry = index.get(allocationKey(orderNumber, sku));
  return entry ? entry.allocated : null;
}

/**
 * Warehance's own verdict that every product on an order is reserved. This
 * beats the reconstruction whenever it is present — it is the warehouse
 * reporting its own state rather than us replaying it.
 * @returns {boolean|null} null when the order doesn't carry the flag.
 */
function orderFullyAllocated(whOrder) {
  const types = whOrder?.not_ready_to_ship_types;
  if (!types || typeof types.has_unallocated_products !== 'boolean') return null;
  return types.has_unallocated_products === false;
}

/**
 * Consistency check on the demand queue, against the two counters the walk did
 * not consume. Warehance hands out units until they run out, so total open
 * demand and on-hand stock fully determine both counters:
 *
 *   allocated   === min(demand, on_hand)
 *   backordered === max(0, demand - on_hand)
 *
 * If the queue we assembled reproduces those, it is the same demand the
 * warehouse is looking at, and the per-order verdicts sit on solid ground. If it
 * doesn't, the order book was incomplete or something outside it holds stock.
 *
 * Note this checks TOTAL demand, not the whole-line verdicts — Warehance
 * part-fills the order that straddles the cutoff, where we call the whole line
 * waiting, so summing `allocated: true` quantities is expected to come up short
 * by up to one line and is not evidence of anything.
 *
 * Direction matters, and callers should care about only one of them.
 * Over-counted demand (`shortfall < 0`) is the dangerous one: it pushes orders
 * DOWN the queue and can report a reserved item as still waiting, which is the
 * bug this whole module replaced. Under-counting can only report a waiting item
 * as reserved, whose cost is a quiet missed email rather than a wrong one.
 */
function verifyAgainstCounters(index, stockBySku) {
  const demandBySku = new Map();
  for (const [key, entry] of index) {
    const sku = key.slice(key.indexOf('::') + 2);
    demandBySku.set(sku, (demandBySku.get(sku) || 0) + entry.quantity);
  }
  const mismatches = [];
  for (const [sku, stock] of stockBySku) {
    if (!stock) continue;
    const demand = demandBySku.get(sku) || 0;
    const onHand = Number(stock.on_hand) || 0;
    const reportedAllocated = Number(stock.allocated) || 0;
    const reportedBackordered = Number(stock.backordered) || 0;
    const expectedAllocated = Math.min(demand, onHand);
    const expectedBackordered = Math.max(0, demand - onHand);
    if (expectedAllocated !== reportedAllocated || expectedBackordered !== reportedBackordered) {
      mismatches.push({
        sku,
        demand,
        onHand,
        expectedAllocated,
        reportedAllocated,
        expectedBackordered,
        reportedBackordered,
        // Positive = we found less demand than the warehouse sees (safe).
        // Negative = we found more (can wrongly report a reserved item waiting).
        shortfall: (reportedAllocated + reportedBackordered) - demand,
      });
    }
  }
  return mismatches;
}

// ---------------------------------------------------------------------------
// Live fetch
// ---------------------------------------------------------------------------

/**
 * Build the allocation index for a set of SKUs against the live open order book.
 *
 * Deliberately one bulk order fetch rather than a per-order one: the demand
 * queue and the order snapshots have to come from the same read, or an order
 * can be counted in one and missing from the other. Callers get the order map
 * back so they reuse those snapshots instead of re-fetching.
 *
 * @param {string[]} skus — SKUs to reconstruct.
 * @param {object} [opts]
 * @param {Map<string, object>} [opts.orders] — an already-fetched open order
 *   book, for callers that need to inspect an order before they know which SKUs
 *   to reconstruct. Reusing it keeps the whole answer on one read.
 * @returns {Promise<{index: Map, orders: Map<string, object>, stockBySku: Map,
 *   mismatches: Array}>}
 */
async function fetchAllocationIndex(skus, { orders = null } = {}) {
  const unique = [...new Set((skus || []).filter(Boolean))];
  const [resolvedOrders, stockBySku] = await Promise.all([
    orders || fetchUnfulfilledOrders(),
    fetchSkuStockMany(unique),
  ]);
  const index = buildAllocationIndex(resolvedOrders.values(), stockBySku);
  return {
    index,
    orders: resolvedOrders,
    stockBySku,
    mismatches: verifyAgainstCounters(index, stockBySku),
  };
}

module.exports = {
  openQuantity,
  allocationKey,
  buildAllocationIndex,
  isLineAllocated,
  orderFullyAllocated,
  verifyAgainstCounters,
  fetchAllocationIndex,
};
