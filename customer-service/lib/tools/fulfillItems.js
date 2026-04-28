/**
 * Fulfill items tool: fulfill_items
 *
 * Marks specific line items on an order as fulfilled in Shopify (placeholder
 * fulfillment — no tracking, customer not notified). Built for the pre-order
 * split case: if an order has 1+ out-of-stock items blocking the warehouse
 * from shipping the in-stock portion, mark the OOS items as fulfilled here so
 * the warehouse can ship the rest. Tags the order `pre-order-pending` and
 * appends an explanatory staff note.
 *
 * When the OOS item comes back in stock, create a NEW order for it (using
 * create_order) with a note referencing the original — do NOT try to
 * "unfulfill" the placeholder.
 *
 * Two-phase: phase 1 previews; phase 2 (confirmed=true) executes.
 */

const {
  getOrderWithFulfillmentOrders,
  createFulfillment,
  addTags,
  appendOrderNote,
  getAdminUrl,
} = require('../shopify');

const PRE_ORDER_TAG = 'pre-order-pending';

const tools = [
  {
    name: 'fulfill_items',
    description: [
      'Mark specific line items on an order as fulfilled in Shopify, with no tracking and no customer notification.',
      'Use this for the pre-order split case: when an order has out-of-stock items blocking the warehouse from shipping the in-stock items, fulfill the OOS items here so the warehouse can ship the rest.',
      'Always tags the order `pre-order-pending` and appends an explanatory staff note.',
      'Two-phase: phase 1 (confirmed omitted/false) previews; phase 2 (confirmed=true) executes.',
      'You MUST present the phase 1 preview to the operator and receive explicit confirmation before calling phase 2.',
      'Do NOT use this tool for manual shipment recording with real tracking — that is a different flow.',
      'When the held items eventually come back in stock, create a NEW order for them via create_order (with a note referencing this order) — do not try to unfulfill the placeholder.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        order_number: { type: 'string', description: 'Order number (e.g. "30267", "#30267")' },
        items: {
          type: 'array',
          description: 'Line items to mark as fulfilled. Each item: { sku, quantity? } — quantity defaults to the full unfulfilled quantity for that SKU.',
          items: {
            type: 'object',
            properties: {
              sku: { type: 'string', description: 'SKU of the item to fulfill' },
              quantity: { type: 'number', description: 'Quantity to fulfill (default: all remaining)' },
            },
            required: ['sku'],
          },
        },
        staff_note: { type: 'string', description: 'Optional additional context appended to the order note' },
        confirmed: { type: 'boolean', description: 'Set true in phase 2 to execute' },
        _fulfill_data: {
          type: 'object',
          description: 'Internal: phase 1 carry data — pass back unchanged in phase 2',
        },
      },
      required: ['order_number', 'items'],
    },
    handler: async ({ order_number, items, staff_note, confirmed, _fulfill_data }) => {
      // --- Phase 2: execute ---
      if (confirmed && _fulfill_data) {
        const fulfillment = await createFulfillment({
          lineItemsByFulfillmentOrder: _fulfill_data.line_items_by_fo,
          notifyCustomer: false,
        });

        const noteText = [
          `Pre-order: ${_fulfill_data.item_summary} marked as fulfilled (out of stock); will ship as a new order when inventory arrives.`,
          staff_note ? staff_note : null,
        ].filter(Boolean).join(' — ');

        await appendOrderNote(_fulfill_data.order_id, noteText);
        await addTags(_fulfill_data.order_id, [PRE_ORDER_TAG]);

        return {
          content: [{
            type: 'text',
            text: [
              '**Items marked as fulfilled (placeholder)**',
              '',
              `**Order:** ${_fulfill_data.order_name} — ${getAdminUrl(_fulfill_data.order_id)}`,
              `**Items:** ${_fulfill_data.item_summary}`,
              `**Tag added:** \`${PRE_ORDER_TAG}\``,
              `**Customer notified:** no`,
              `**Tracking:** none (placeholder)`,
              `**Fulfillment:** ${fulfillment?.id || '(no id returned)'}`,
              '',
              `Warehance will now see the remaining items as the only ones needing pick + ship. When the held items come back in stock, create a new order for them via \`create_order\` and reference this order in the note.`,
            ].join('\n'),
          }],
        };
      }

      // --- Phase 1: preview ---
      if (!Array.isArray(items) || items.length === 0) {
        return { content: [{ type: 'text', text: 'Error: items array is required (at least one { sku, quantity? }).' }] };
      }

      const order = await getOrderWithFulfillmentOrders(order_number);

      if (order.cancelledAt) {
        return { content: [{ type: 'text', text: `Error: order ${order.name} is cancelled — nothing to fulfill.` }] };
      }
      if (order.displayFulfillmentStatus === 'FULFILLED') {
        return { content: [{ type: 'text', text: `Error: order ${order.name} is already fully fulfilled.` }] };
      }

      // Map requested SKUs to fulfillment-order line items with remaining > 0
      const allFoLineItems = order.fulfillmentOrders.flatMap(fo =>
        fo.lineItems
          .filter(li => li.remainingQuantity > 0)
          .map(li => ({ ...li, fulfillmentOrderId: fo.id, fulfillmentOrderStatus: fo.status }))
      );

      if (allFoLineItems.length === 0) {
        return { content: [{ type: 'text', text: `Error: order ${order.name} has no unfulfilled line items in any open fulfillment order.` }] };
      }

      // Group selected line items by fulfillment order id
      const byFo = new Map();
      const matchedSummary = [];
      const errors = [];

      for (const requested of items) {
        const sku = requested.sku;
        if (!sku) { errors.push('Each item needs a sku.'); continue; }
        const matches = allFoLineItems.filter(li => li.lineItem?.sku === sku);
        if (matches.length === 0) {
          errors.push(`SKU not found in unfulfilled items: ${sku}`);
          continue;
        }
        // For simplicity, fulfill from the first matching FO entry — RUBIES orders almost
        // never split a single SKU across multiple fulfillment orders.
        const target = matches[0];
        const requestedQty = requested.quantity ?? target.remainingQuantity;
        if (requestedQty > target.remainingQuantity) {
          errors.push(`SKU ${sku}: requested ${requestedQty} but only ${target.remainingQuantity} unfulfilled.`);
          continue;
        }
        const list = byFo.get(target.fulfillmentOrderId) || [];
        list.push({ id: target.id, quantity: requestedQty });
        byFo.set(target.fulfillmentOrderId, list);
        matchedSummary.push(`${requestedQty}x ${target.lineItem.title}${target.lineItem.variantTitle ? ` — ${target.lineItem.variantTitle}` : ''} (${sku})`);
      }

      if (errors.length) {
        return { content: [{ type: 'text', text: `Error preparing fulfillment:\n${errors.map(e => `- ${e}`).join('\n')}` }] };
      }

      const lineItemsByFulfillmentOrder = [...byFo.entries()].map(([fulfillmentOrderId, fulfillmentOrderLineItems]) => ({
        fulfillmentOrderId,
        fulfillmentOrderLineItems,
      }));

      const itemSummary = matchedSummary.join('; ');
      const fulfillData = {
        order_id: order.id,
        order_name: order.name,
        line_items_by_fo: lineItemsByFulfillmentOrder,
        item_summary: itemSummary,
      };

      // Show what stays unfulfilled so the operator sees the resulting state
      const stayingUnfulfilled = allFoLineItems
        .filter(li => {
          const list = byFo.get(li.fulfillmentOrderId) || [];
          const claimed = list.find(x => x.id === li.id);
          if (!claimed) return true; // not selected at all
          return claimed.quantity < li.remainingQuantity; // partially selected
        })
        .map(li => {
          const list = byFo.get(li.fulfillmentOrderId) || [];
          const claimed = list.find(x => x.id === li.id);
          const remainingAfter = li.remainingQuantity - (claimed?.quantity || 0);
          return `${remainingAfter}x ${li.lineItem.title}${li.lineItem.variantTitle ? ` — ${li.lineItem.variantTitle}` : ''} (${li.lineItem.sku})`;
        });

      const customerName = [order.customer?.firstName, order.customer?.lastName].filter(Boolean).join(' ').trim() || '(no name)';

      return {
        content: [{
          type: 'text',
          text: [
            '**Fulfill Items Preview — Awaiting Confirmation**',
            '',
            `**Order:** ${order.name} — ${getAdminUrl(order.id)}`,
            `**Customer:** ${customerName} (${order.customer?.email || 'no email'})`,
            '',
            '**Will be marked fulfilled (placeholder, no tracking, no customer email):**',
            `  ${itemSummary}`,
            '',
            stayingUnfulfilled.length
              ? '**Remaining unfulfilled (Warehance will ship these):**\n' + stayingUnfulfilled.map(l => `  ${l}`).join('\n')
              : '**Remaining unfulfilled:** none — this will mark the entire order as fulfilled.',
            '',
            `**Tag to add:** \`${PRE_ORDER_TAG}\``,
            `**Note to append:** "Pre-order: ${itemSummary} marked as fulfilled (out of stock); will ship as a new order when inventory arrives."${staff_note ? ` — ${staff_note}` : ''}`,
            '',
            `To confirm, call fulfill_items again with confirmed=true, order_number="${order_number}", items=${JSON.stringify(items)}, and _fulfill_data=${JSON.stringify(fulfillData)}.`,
          ].join('\n'),
        }],
      };
    },
  },
];

module.exports = tools;
