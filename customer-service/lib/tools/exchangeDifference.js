/**
 * exchange_difference — read-only planning tool for exchanges where the items
 * differ and a price difference may be owed (either direction).
 *
 * Does ALL the math in one call so the agent never thrashes:
 *   - resolves the new items to current catalog prices
 *   - applies the live automatic discounts (volume + active sale), highest-wins
 *     per line (Shopify does NOT apply automatic discounts to API draft orders)
 *   - values the returned items at what the customer ACTUALLY paid, via Shopify's
 *     suggestedRefund (original discounts/proration baked in)
 *   - returns the signed net difference + the recommended action
 *
 * No writes. The agent executes the recommended action with the existing tools.
 */

const { getOrderByNumber, calculateRefund, normalizeGid } = require('../shopify');
const { resolveLineItems } = require('../resolveLineItems');
const { listRegistry } = require('../../../promotions/discounts');
const {
  computeExchangeDifference,
  recommendExchangeAction,
  itemSetsIdentical,
} = require('../exchangeMath');

function saleIsActive(row, now) {
  if (!row || row.status !== 'active') return false;
  const start = row.starts_at ? new Date(row.starts_at) : null;
  const end = row.ends_at ? new Date(row.ends_at) : null;
  if (start && now < start) return false;
  if (end && now > end) return false;
  return true;
}

async function loadActiveDiscounts(now) {
  const rows = await listRegistry();
  const volumeDiscounts = rows.filter((r) => r.kind === 'volume' && r.status === 'active');
  const sale = rows.find((r) => r.kind === 'sale' && saleIsActive(r, now)) || null;
  return { volumeDiscounts, sale };
}

const tools = [
  {
    name: 'exchange_difference',
    description: [
      'Plan an exchange where the customer is returning items and getting DIFFERENT items, and a price difference may apply.',
      'Read-only: computes the discounted price of the new items (applying live volume/sale discounts the way the storefront would), values the returned items at what was actually paid, and returns the signed net difference plus a recommended action.',
      'Call this FIRST for any non-straight-swap exchange, then execute the recommended_action.',
      'Set invoice_requested=true ONLY when the operator explicitly asked to invoice/charge the difference. A refund (net<0) is always recommended regardless.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        return_order_number: { type: 'string', description: 'Original order the items are being returned from (e.g. "#29649").' },
        return_items: {
          type: 'array',
          description: 'Items being returned. Match the original order line items by SKU.',
          items: {
            type: 'object',
            properties: {
              sku: { type: 'string' },
              quantity: { type: 'number' },
            },
            required: ['sku', 'quantity'],
          },
        },
        new_items: {
          type: 'array',
          description: 'Items the customer wants instead. Prefer sku; query/target_size supported.',
          items: {
            type: 'object',
            properties: {
              sku: { type: 'string' },
              target_size: { type: 'string' },
              query: { type: 'string' },
              quantity: { type: 'number' },
            },
          },
        },
        invoice_requested: {
          type: 'boolean',
          description: 'TRUE only if the operator explicitly asked to invoice/charge the price difference. Leave false otherwise.',
        },
      },
      required: ['return_order_number', 'return_items', 'new_items'],
    },
    handler: async ({ return_order_number, return_items, new_items, invoice_requested }) => {
      // 1. Resolve the new items to current catalog prices.
      const resolved = await resolveLineItems(new_items || []);
      if (resolved.error) return { content: [{ type: 'text', text: resolved.error }] };

      // 2. Map returned items to the original order's line items, then ask Shopify
      //    what those would refund (= actual paid, original discounts baked in).
      const order = await getOrderByNumber(return_order_number);
      if (!order) return { content: [{ type: 'text', text: `Order ${return_order_number} not found.` }] };
      const bySku = new Map((order.lineItems || []).map((li) => [String(li.sku || '').toUpperCase(), li]));
      const refundLineItems = [];
      const unmatched = [];
      const missingId = [];
      for (const ri of return_items || []) {
        const li = bySku.get(String(ri.sku || '').toUpperCase());
        if (!li) { unmatched.push(ri.sku); continue; }
        if (!li.id) { missingId.push(ri.sku); continue; }
        refundLineItems.push({ lineItemId: li.id, quantity: ri.quantity });
      }
      if (unmatched.length) {
        return { content: [{ type: 'text', text: `These return SKUs aren't on ${order.name}: ${unmatched.join(', ')}. Check the order's items.` }] };
      }
      if (missingId.length) {
        return { content: [{ type: 'text', text: `Could not resolve line-item IDs for ${missingId.join(', ')} on ${order.name} — cannot compute the return credit. This is an internal error, not a customer issue; stop and report it.` }] };
      }
      const refund = await calculateRefund(order.id, refundLineItems);
      const returnCredit = parseFloat(refund.subtotalSet?.shopMoney?.amount || '0');

      // 3. Apply live automatic discounts to the new items + compute the net.
      const now = new Date();
      const { volumeDiscounts, sale } = await loadActiveDiscounts(now);
      const newItemsForCalc = resolved.map((r) => ({
        sku: r.sku,
        unitPrice: parseFloat(r.price || 0),
        quantity: r.quantity,
      }));
      const plan = computeExchangeDifference({ newItems: newItemsForCalc, returnCredit, volumeDiscounts, sale });

      const itemsIdentical = itemSetsIdentical(
        return_items,
        resolved.map((r) => ({ sku: r.sku, quantity: r.quantity })),
      );
      const recommended = recommendExchangeAction({
        net: plan.net,
        itemsIdentical,
        operatorRequestedInvoice: !!invoice_requested,
      });

      // 4. Build the preview + the exact next step.
      const lines = ['**Exchange difference — plan (nothing created yet)**', ''];
      lines.push('**New items:**');
      resolved.forEach((r, i) => {
        const l = plan.lines[i];
        const disc = l.effectivePct > 0 ? ` (−${l.effectivePct}% ${l.salePct >= l.volumePct && l.salePct > 0 ? 'sale' : 'volume'})` : '';
        lines.push(`  ${r.quantity}x ${r.productTitle} ${r.variantTitle} @ $${parseFloat(r.price || 0).toFixed(2)}${disc} = $${l.lineTotal.toFixed(2)}`);
      });
      lines.push(`**New items subtotal:** $${plan.newSubtotal.toFixed(2)}`);
      lines.push(`**Return credit (actual paid on ${order.name}):** −$${plan.returnCredit.toFixed(2)}`);
      lines.push('');
      if (plan.direction === 'invoice') lines.push(`**Net: customer owes $${plan.net.toFixed(2)}** (plus tax, Shopify-calculated)`);
      else if (plan.direction === 'refund') lines.push(`**Net: customer is owed $${Math.abs(plan.net).toFixed(2)}**`);
      else lines.push('**Net: even ($0)**');
      lines.push('');

      const paidItemsJson = resolved.map((r, i) => ({
        sku: r.sku, quantity: r.quantity, discount_percent: plan.lines[i].effectivePct || undefined,
      }));

      lines.push(`**Recommended action: ${recommended}**`);
      if (recommended === 'invoice') {
        lines.push(`Call create_invoice_order with paid_items=${JSON.stringify(paidItemsJson)}, return_credit=${plan.returnCredit}, return_credit_note="Return credit from ${order.name}".`);
      } else if (recommended === 'refund') {
        lines.push(`Customer is owed money. Call create_exchange_order to ship the new items free, then refund_order on ${order.name} for $${Math.abs(plan.net).toFixed(2)}. Both are two-phase (preview, then confirm).`);
      } else {
        lines.push('Treat as a free exchange: call create_exchange_order to ship the new items at $0 (no invoice — either an even swap, a straight swap, or the operator did not ask to charge the difference).');
      }

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        _plan: { ...plan, itemsIdentical, recommended, order: order.name },
      };
    },
  },
];

// operatorTools.js iterates each module as an array of tool defs.
module.exports = tools;
module.exports.loadActiveDiscounts = loadActiveDiscounts;
module.exports.saleIsActive = saleIsActive;
