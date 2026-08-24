/**
 * Warehouse allocation tools — read-only views of 3PL stock + per-order state.
 *
 * Tools:
 *   - get_order_allocation: per-order fulfillment state, holds, and per-line-item
 *     SKU stock. Use when investigating why a specific order is or isn't shipping.
 *   - inventory_allocation: per-SKU live breakdown (on_hand / allocated / available
 *     / backordered). Use when investigating SKU-level availability beyond the
 *     daily Shopify snapshot.
 *
 * Both wrap the public Warehance API via reports/lib/warehanceClient. Per-line-item
 * allocated quantities are not exposed by the public API, so the per-order view
 * reconstructs them via reports/lib/orderAllocation — the same helper the
 * unnotified-pre-order drafter uses, so a customer email and an operator
 * looking at the same order can never be told different things about it.
 *
 * What this tool must never do is answer "is this line reserved?" from the
 * SKU-level counters alone. `available` reads 0 BECAUSE the units are
 * allocated, possibly to this order, and `backordered` is one global number per
 * SKU that any single short order anywhere raises above zero. Reading those two
 * as a per-order verdict is what shipped a customer an email about an item
 * sitting reserved on the shelf (see orderAllocation.js).
 */

const { getHoldReasons, apiFetch, fetchUnfulfilledOrders } = require('../../../reports/lib/warehanceClient');
const { fetchAllocationIndex, isLineAllocated, orderFullyAllocated } = require('../../../reports/lib/orderAllocation');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Per-line status. `allocated` is the reconstructed per-order verdict and is
 * the only one that answers "is this customer waiting on this item"; the stock
 * counters beside it are context, not the verdict.
 */
function lineStatus(allocated, stock) {
  if (!stock) return 'unknown (no stock data)';
  if (allocated === true) return 'ALLOCATED to this order';
  if (allocated === false) {
    return (stock.on_hand ?? 0) > 0
      ? 'WAITING (stock on hand, allocated to earlier orders)'
      : 'WAITING (no stock on hand)';
  }
  return 'unknown (not in the open order book)';
}

// ---------------------------------------------------------------------------
// Tool: get_order_allocation
// ---------------------------------------------------------------------------

async function handleGetOrderAllocation({ order_number }) {
  if (!order_number) {
    return { content: [{ type: 'text', text: 'order_number is required.' }] };
  }

  const cleaned = String(order_number).replace('#', '');

  // The order is read out of the open order book rather than fetched on its
  // own, and that same book is reused to reconstruct allocation — so the
  // order's state and its per-line verdicts describe one moment rather than two.
  const orders = await fetchUnfulfilledOrders();
  const wh = orders.get(cleaned);

  if (!wh) {
    return {
      content: [{
        type: 'text',
        text: `Order #${cleaned} not found in the warehouse's open order book. Either it hasn't synced yet, was cancelled, or has already shipped (Warehance only retains active orders).`,
      }],
    };
  }

  const items = wh.order_items || [];
  const { index, stockBySku } = await fetchAllocationIndex(items.map(it => it.sku), { orders });
  const holds = getHoldReasons(wh);
  const fullyAllocated = orderFullyAllocated(wh);

  let md = `## Allocation for Order #${cleaned}\n\n`;
  md += `- Fulfillment status: \`${wh.fulfillment_status || 'unknown'}\`\n`;
  md += `- Ready to ship: ${wh.ready_to_ship ? 'yes' : 'no'}\n`;
  md += `- On hold: ${wh.has_hold ? `yes — ${holds.join(', ') || 'unspecified'}` : 'no'}\n`;
  if (fullyAllocated !== null) {
    md += `- Every item reserved for this order: ${fullyAllocated ? 'yes' : 'no'}\n`;
  }
  md += '\n';

  md += `### Line items (${items.length})\n\n`;
  md += `| SKU | Qty | Status | On hand | Allocated (SKU) | Available (SKU) | Backordered (SKU) |\n`;
  md += `|-----|-----|--------|---------|-----------------|-----------------|-------------------|\n`;

  for (const it of items) {
    const stock = stockBySku.get(it.sku);
    // The warehouse's own flag outranks the reconstruction when it says
    // everything is reserved.
    const allocated = fullyAllocated === true ? true : isLineAllocated(index, cleaned, it.sku);
    md += `| ${it.sku || '—'} | ${it.quantity ?? '—'} | ${lineStatus(allocated, stock)} | ${stock?.on_hand ?? '—'} | ${stock?.allocated ?? '—'} | ${stock?.available ?? '—'} | ${stock?.backordered ?? '—'} |\n`;
  }

  md += `\n_Status is per-ORDER: whether the warehouse has reserved that line for THIS order. The four stock columns are per-SKU totals across all orders and must not be read as this order's state — \`Available\` reads 0 whenever the units are reserved, including when they are reserved for this order, and \`Backordered\` counts any customer waiting on that SKU anywhere. Only a WAITING line is something this customer is waiting on._\n`;

  return { content: [{ type: 'text', text: md }] };
}

// ---------------------------------------------------------------------------
// Tool: inventory_allocation
// ---------------------------------------------------------------------------

async function handleInventoryAllocation({ sku, product_handle }) {
  const search = sku || product_handle;
  if (!search) {
    return { content: [{ type: 'text', text: 'Provide either sku or product_handle.' }] };
  }

  const json = await apiFetch(`/products?search_value=${encodeURIComponent(search)}`);
  const products = json.data?.products || [];

  if (!products.length) {
    return { content: [{ type: 'text', text: `No matching SKUs found at the warehouse for \`${search}\`.` }] };
  }

  const filtered = sku
    ? products.filter(p => (p.sku || '').toLowerCase() === sku.toLowerCase())
    : products;

  const rows = (filtered.length ? filtered : products).sort((a, b) => (a.sku || '').localeCompare(b.sku || ''));

  let md = `## Warehouse Allocation — \`${search}\` (${rows.length} SKU${rows.length === 1 ? '' : 's'})\n\n`;
  md += `| SKU | On hand | Allocated | Available | Backordered |\n`;
  md += `|-----|---------|-----------|-----------|-------------|\n`;

  for (const p of rows) {
    const flag = (p.backordered ?? 0) > 0 ? ' ⚠' : '';
    md += `| ${p.sku || '—'}${flag} | ${p.on_hand ?? '—'} | ${p.allocated ?? '—'} | ${p.available ?? '—'} | ${p.backordered ?? '—'} |\n`;
  }

  const backordered = rows.filter(p => (p.backordered ?? 0) > 0);
  if (backordered.length) {
    md += `\n**Backordered:** ${backordered.map(p => `${p.sku} (${p.backordered})`).join(', ')}\n`;
  }

  return { content: [{ type: 'text', text: md }] };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

const tools = [
  {
    name: 'get_order_allocation',
    description: 'Per-order warehouse allocation: fulfillment status, hold reasons, ready-to-ship flag, and — per line item — whether the warehouse has RESERVED that item for this specific order or the customer is still waiting on it. Use when investigating why a specific order is stuck, delayed, or backordered, and to answer "is this customer actually waiting on this item?". The per-SKU stock columns it also returns are totals across all orders: a line can read Available 0 and Backordered 5 while being fully reserved for this order, so never read those columns as this order\'s state — read the Status column.',
    inputSchema: {
      type: 'object',
      properties: {
        order_number: {
          type: 'string',
          description: 'Shopify order number (e.g. "30393" or "#30393").',
        },
      },
      required: ['order_number'],
    },
    handler: handleGetOrderAllocation,
  },
  {
    name: 'inventory_allocation',
    description: 'Live per-SKU warehouse stock breakdown: on_hand, allocated, available, backordered. Complements get_inventory_snapshot (which is the daily Shopify-side snapshot) — use this when the question is about physical 3PL state or what is actually available to ship right now. Pass either sku (exact match) or product_handle (prefix match).',
    inputSchema: {
      type: 'object',
      properties: {
        sku: {
          type: 'string',
          description: 'Exact SKU to look up (e.g. "RUB-AJ-BLK-XS").',
        },
        product_handle: {
          type: 'string',
          description: 'Product handle prefix to look up all variants (e.g. "AJ" matches all AJ SKUs).',
        },
      },
      required: [],
    },
    handler: handleInventoryAllocation,
  },
];

module.exports = tools;
