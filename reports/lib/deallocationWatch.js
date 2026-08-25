/**
 * De-allocation watch — orders that LOST a warehouse allocation.
 *
 * Two different events put a customer in the same place, waiting on an item
 * nobody told them about, and only one of them is detectable at order time:
 *
 *   Disclosure gap (common). The order was placed through a channel that never
 *   stamps the `Pre-order` line attribute — the Shopify Shop App bypasses our
 *   theme, so the Pre-Order Now app never runs. The line was never allocated,
 *   because the stock was never there. Visible from the moment Warehance ingests
 *   the order, which is why the drafter's hour-old gate and 14-day window work.
 *
 *   De-allocation (rare). The line WAS allocated. A stock count came up short
 *   and the warehouse handed the unit back, or gave it to an older order. The
 *   customer went from "reserved, about to ship" to "waiting" without touching
 *   anything, days or weeks after they bought. There is nothing to see at order
 *   time, and the drafter's staleness gate is measured from the ORDER date, so
 *   the event routinely lands after the window has already closed.
 *
 * This module watches for the second. The signal is a TRANSITION — allocated on
 * the last observation, not allocated now — so it needs somewhere to keep the
 * last observation. That is `order_line_allocation_state`.
 *
 * Deliberately NOT watching Warehance's own order-level
 * `has_unallocated_products`, which would be one field on a bulk read we already
 * make: it reads true on 161 of 179 open orders (measured 2026-08-25), because a
 * single unallocated line sets it for the whole order. On the order that
 * surfaced this (#32951) it had been true since the day of purchase — the Evey
 * sports bra on the same order has never had stock — so the one flip we needed
 * to see was permanently masked by a line the customer already knew about. The
 * question is per-line and so is the state.
 *
 * Cadence is deliberately slower than the leak sweep (hourly, against 10
 * minutes). It reads the whole open order book plus the whole product catalog
 * every tick, and unlike a fresh Shop App order — where the customer just bought
 * and we want to reach them before expectations set — a de-allocation lands on
 * someone who has already been waiting days, so an hour of latency costs nothing.
 *
 * The stock side is a bulk catalog read, NOT one search per SKU: 152 concurrent
 * per-SKU searches tripped Warehance's per-minute rate limit outright (2026-08-25).
 * fetchSkuStockMany switches to the paginated catalog read above a threshold, so
 * the cost stops scaling with how many SKUs are on the open book.
 *
 * Entry point:
 *   observeAllocations({ write }) -> { flipped, observed, seeded, skipped }
 *     `flipped` is the set of order numbers that lost an allocation since the
 *     last observation. On the very first run every line is new, so nothing
 *     flips and the table is seeded — that is the correct behaviour, not a miss.
 */

const path = require('path');
if (!process.env.SUPABASE_URL) {
  require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
}

const { getSupabaseClient } = require('../../shared/supabaseClient');
const { fetchUnfulfilledOrders, fetchSkuStockMany } = require('./warehanceClient');
const { buildAllocationIndex, verifyAgainstCounters, allocationKey } = require('./orderAllocation');

/** Hourly. See the module note on why this is slower than the leak sweep. */
const WATCH_MS = 60 * 60 * 1000;

/**
 * Rows for orders that have left the open book (shipped, cancelled) stop being
 * refreshed. Dropping them keeps the table proportional to open orders rather
 * than to all orders ever. Generous, because a re-opened order that comes back
 * inside the window keeps its history and so can still report a flip.
 */
const FORGET_AFTER_DAYS = 45;

const TABLE = 'order_line_allocation_state';

// ---------------------------------------------------------------------------
// Pure diff
// ---------------------------------------------------------------------------

/**
 * Compare the freshly reconstructed index against the last stored observation.
 *
 * @param {Map<string, {allocated: boolean, onHand: number, quantity: number}>} index
 *   keyed by allocationKey(orderNumber, sku) — the current reconstruction.
 * @param {Map<string, {allocated: boolean, on_hand: number}>} previous
 *   keyed the same way — the last stored observation.
 * @param {Set<string>} trustedSkus — SKUs whose reconstruction ties back to
 *   Warehance's own counters. A SKU outside this set is observed and stored but
 *   never allowed to raise a flip; see the note in observeAllocations.
 * @returns {{flips: Array<{orderNumber, sku, onHandBefore, onHandAfter}>}}
 */
function diffAllocations(index, previous, trustedSkus) {
  const flips = [];
  for (const [key, current] of index) {
    const before = previous.get(key);
    // No prior observation: this line is new to us. Seed it, never fire on it —
    // otherwise the first run after deploy reports every waiting line in the
    // book as a fresh de-allocation.
    if (!before) continue;
    if (before.allocated !== true) continue;
    if (current.allocated !== false) continue;
    const sku = key.slice(key.indexOf('::') + 2);
    if (!trustedSkus.has(sku)) continue;
    flips.push({
      orderNumber: key.slice(0, key.indexOf('::')),
      sku,
      onHandBefore: before.on_hand ?? null,
      onHandAfter: current.onHand ?? null,
    });
  }
  return flips;
}

/**
 * Which SKUs may not raise a flip, from verifyAgainstCounters' output.
 *
 * ONLY over-counted demand disqualifies. See the note at the call site: a filter
 * on any mismatch at all was measured to exclude exactly the SKUs this watch
 * exists for, because a de-allocated unit shows up as a SPLIT disagreement
 * (on_hand > 0, allocated 0) at shortfall 0.
 */
function untrustedFromMismatches(mismatches) {
  return new Set((mismatches || []).filter(m => m.shortfall < 0).map(m => m.sku));
}

// ---------------------------------------------------------------------------
// Live observation
// ---------------------------------------------------------------------------

async function loadPreviousState(supabase, orderNumbers) {
  const previous = new Map();
  if (!orderNumbers.length) return previous;
  const nums = [...new Set(orderNumbers.map(n => parseInt(String(n).replace('#', ''), 10)))]
    .filter(Number.isFinite);
  for (let i = 0; i < nums.length; i += 200) {
    const batch = nums.slice(i, i + 200);
    const { data, error } = await supabase
      .from(TABLE)
      .select('order_number, sku, allocated, on_hand')
      .in('order_number', batch);
    if (error) throw new Error(`${TABLE} lookup failed: ${error.message}`);
    for (const r of (data || [])) previous.set(allocationKey(r.order_number, r.sku), r);
  }
  return previous;
}

async function persistState(supabase, index) {
  const now = new Date().toISOString();
  const rows = [];
  for (const [key, entry] of index) {
    const sep = key.indexOf('::');
    const orderNumber = parseInt(key.slice(0, sep), 10);
    if (!Number.isFinite(orderNumber)) continue;
    rows.push({
      order_number: orderNumber,
      sku: key.slice(sep + 2),
      allocated: entry.allocated,
      on_hand: entry.onHand ?? null,
      quantity: entry.quantity ?? null,
      last_seen_at: now,
    });
  }
  // Upsert on the natural key rather than delete+insert: two observers running
  // concurrently must not be able to produce duplicate or missing rows, and
  // first_seen_at has to survive (it is the only record of how long a line has
  // been in its current state).
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await supabase
      .from(TABLE)
      .upsert(rows.slice(i, i + 500), { onConflict: 'order_number,sku' });
    if (error) throw new Error(`${TABLE} upsert failed: ${error.message}`);
  }
  return rows.length;
}

async function forgetStaleRows(supabase) {
  const cutoff = new Date(Date.now() - FORGET_AFTER_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { error } = await supabase.from(TABLE).delete().lt('last_seen_at', cutoff);
  if (error) throw new Error(`${TABLE} cleanup failed: ${error.message}`);
}

/**
 * One observation tick: reconstruct per-line allocation across the whole open
 * order book, diff against the last observation, persist the new one.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.write=true] — false observes and diffs without touching
 *   the table, so a dry run can report what WOULD flip without consuming the
 *   transition (storing it would make the next real run see no change).
 * @param {Map<string, object>} [opts.orders] — an already-fetched open order
 *   book, so a caller that needs it too keeps the whole answer on one read.
 * @returns {Promise<{flipped: Set<string>, flips: Array, observed: number,
 *   untrustedSkus: string[], orders: Map}>}
 */
/**
 * Is the state table there yet?
 *
 * Probed BEFORE the warehouse reads, not after. Reconstructing the open book
 * costs one stock call per distinct SKU (152 as of 2026-08-25), and the table is
 * created by hand in the Supabase SQL editor — so there is a window after deploy
 * and before the migration where every tick would otherwise pay that full cost
 * to fail on the last step, once an hour, indefinitely.
 */
async function tableReady(supabase) {
  const { error } = await supabase.from(TABLE).select('order_number').limit(1);
  return !error;
}

async function observeAllocations({ write = true, supabase = null, orders = null } = {}) {
  const sb = supabase || getSupabaseClient();

  if (!(await tableReady(sb))) {
    return {
      flipped: new Set(),
      flips: [],
      observed: 0,
      untrustedSkus: [],
      orders: orders || new Map(),
      skipped: `${TABLE} does not exist — run customer-service/order-line-allocation-state-schema.sql`,
    };
  }

  const openOrders = orders || await fetchUnfulfilledOrders();

  const skus = new Set();
  for (const o of openOrders.values()) {
    if (!o || o.cancelled) continue;
    for (const item of (o.order_items || [])) {
      if (item?.sku && !item.cancelled) skus.add(item.sku);
    }
  }
  const stockBySku = await fetchSkuStockMany([...skus]);
  const index = buildAllocationIndex(openOrders.values(), stockBySku);

  // Only OVER-COUNTED DEMAND disqualifies a SKU, not any mismatch at all.
  // Over-counting (shortfall < 0) pushes orders down the queue and can turn a
  // still-reserved line into a fabricated de-allocation, which is the one error
  // that emails a customer about an item sitting on the shelf with their name on
  // it. Under-counting can only ever report a waiting item as reserved, whose
  // cost is a quiet missed email.
  //
  // Excluding every mismatch instead was measured to exclude exactly the SKUs
  // this watch exists for (2026-08-25: HLA-BLK-XL, SHS-BLK-M, HLA-PNK-M — the
  // Serena among them). All three had shortfall 0, meaning the demand queue was
  // exactly right, and disagreed only on the SPLIT: on_hand 1 with
  // reportedAllocated 0, a unit physically present that the warehouse has given
  // to nobody. That is the de-allocation signature, so the strict filter was
  // blind precisely where it needed to see.
  //
  // Disqualified SKUs are still observed and stored — dropping them would make
  // the NEXT run see a phantom transition — they are just not allowed to flip.
  const untrustedSkus = untrustedFromMismatches(verifyAgainstCounters(index, stockBySku));
  const trustedSkus = new Set([...skus].filter(s => !untrustedSkus.has(s)));

  const previous = await loadPreviousState(sb, [...openOrders.keys()]);
  const flips = diffAllocations(index, previous, trustedSkus);

  if (write) {
    await persistState(sb, index);
    await forgetStaleRows(sb);
  }

  return {
    flipped: new Set(flips.map(f => f.orderNumber)),
    flips,
    observed: index.size,
    untrustedSkus: [...untrustedSkus],
    orders: openOrders,
  };
}

// ---------------------------------------------------------------------------
// Standalone CLI
// ---------------------------------------------------------------------------
//
//   node reports/lib/deallocationWatch.js            observe, report, no writes
//   node reports/lib/deallocationWatch.js --write    observe and store
//
// Note the dry run deliberately does NOT store: a transition is consumed by
// being recorded, so a dry run that persisted would hide the flip from the next
// real tick.

if (require.main === module) {
  (async () => {
    const write = process.argv.includes('--write');
    console.log(`De-allocation watch — ${write ? 'LIVE (will store observations)' : 'dry run (no writes)'}\n`);
    const { flipped, flips, observed, untrustedSkus, skipped } = await observeAllocations({ write });
    if (skipped) { console.log(`SKIPPED: ${skipped}`); return; }
    console.log(`observed ${observed} order lines across the open book`);
    if (untrustedSkus.length) {
      console.log(`\n${untrustedSkus.length} SKU(s) excluded from flip detection (reconstruction disagrees with Warehance counters):`);
      for (const s of untrustedSkus) console.log(`  ${s}`);
    }
    if (!flipped.size) { console.log('\nNo de-allocations since the last observation.'); return; }
    console.log(`\n${flips.length} de-allocation(s) across ${flipped.size} order(s):`);
    for (const f of flips) {
      console.log(`  #${f.orderNumber}  ${f.sku}  on_hand ${f.onHandBefore} -> ${f.onHandAfter}`);
    }
  })().catch(err => {
    console.error('FAILED:', err.message);
    process.exit(1);
  });
}

module.exports = {
  observeAllocations,
  diffAllocations,
  untrustedFromMismatches,
  tableReady,
  WATCH_MS,
  FORGET_AFTER_DAYS,
  TABLE,
};
