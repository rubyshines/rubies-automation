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
 * allocated/backordered/shipped quantities are not exposed by the public API; we
 * cross-reference the order's line item SKUs against the SKU-level stock state.
 */

const { fetchOrderByNumber, getHoldReasons, apiFetch, fetchSkuStock, fetchSkuStockMany } = require('../../../reports/lib/warehanceClient');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function inferLineStatus(orderItem, stock) {
  if (!stock) return 'unknown (no stock data)';
  const qty = orderItem.quantity || 0;
  if ((stock.backordered ?? 0) > 0 && (stock.on_hand ?? 0) === 0) return 'BACKORDERED';
  if ((stock.available ?? 0) >= qty) return 'available';
  if ((stock.on_hand ?? 0) >= qty) return 'on_hand_but_allocated';
  return 'partial';
}

// ---------------------------------------------------------------------------
// Tool: get_order_allocation
// ---------------------------------------------------------------------------

async function handleGetOrderAllocation({ order_number }) {
  if (!order_number) {
    return { content: [{ type: 'text', text: 'order_number is required.' }] };
  }

  const cleaned = String(order_number).replace('#', '');
  const wh = await fetchOrderByNumber(cleaned);

  if (!wh) {
    return {
      content: [{
        type: 'text',
        text: `Order #${cleaned} not found at the warehouse. Either it hasn't synced yet, was cancelled, or has already shipped (Warehance only retains active orders).`,
      }],
    };
  }

  const items = wh.order_items || [];
  const stockMap = await fetchSkuStockMany(items.map(it => it.sku));
  const holds = getHoldReasons(wh);

  let md = `## Allocation for Order #${cleaned}\n\n`;
  md += `- Fulfillment status: \`${wh.fulfillment_status || 'unknown'}\`\n`;
  md += `- Ready to ship: ${wh.ready_to_ship ? 'yes' : 'no'}\n`;
  md += `- On hold: ${wh.has_hold ? `yes — ${holds.join(', ') || 'unspecified'}` : 'no'}\n\n`;

  md += `### Line items (${items.length})\n\n`;
  md += `| SKU | Qty | Status | On hand | Allocated | Available | Backordered |\n`;
  md += `|-----|-----|--------|---------|-----------|-----------|-------------|\n`;

  for (const it of items) {
    const stock = stockMap.get(it.sku);
    const status = inferLineStatus(it, stock);
    md += `| ${it.sku || '—'} | ${it.quantity ?? '—'} | ${status} | ${stock?.on_hand ?? '—'} | ${stock?.allocated ?? '—'} | ${stock?.available ?? '—'} | ${stock?.backordered ?? '—'} |\n`;
  }

  md += `\n_Per-item allocation is inferred from SKU-level stock — the public Warehance API doesn't expose per-line-item allocated/backordered counts. A SKU showing \`backordered > 0\` and \`on_hand = 0\` is the likely stuck item._\n`;

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
    description: 'Per-order warehouse allocation: fulfillment status, hold reasons, ready-to-ship flag, and per-line-item SKU stock state (on_hand / allocated / available / backordered). Use when investigating why a specific order is stuck, delayed, or backordered. Returns a markdown summary with one row per line item.',
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
