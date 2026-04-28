/**
 * Fulfill items tool: fulfill_items
 *
 * Splits an order for the pre-order case in one operation:
 *   1. Marks the held items as fulfilled on the original order (placeholder
 *      fulfillment — no tracking, customer not notified) so the warehouse can
 *      ship the in-stock portion.
 *   2. Tags the original order `pre-order-pending` and appends a staff note
 *      explaining the split.
 *   3. Creates a new $0 order for the held items, tagged `pre-order` and
 *      `pre-order-from-<original>`, with a note referencing the original.
 *      The new order queues with Warehance and ships automatically when
 *      inventory arrives.
 *
 * Two-phase: phase 1 previews; phase 2 (confirmed=true) executes.
 *
 * NOT for manual shipment recording with real tracking — that is a different
 * flow that doesn't yet exist as a tool.
 */

const {
  getOrderWithFulfillmentOrders,
  createFulfillment,
  addTags,
  appendOrderNote,
  createDraftOrder,
  completeDraftOrder,
  getAdminUrl,
} = require('../shopify');

const PRE_ORDER_PENDING_TAG = 'pre-order-pending';
const NEW_ORDER_TAGS = ['pre-order', 'cs-mcp'];

const tools = [
  {
    name: 'fulfill_items',
    description: [
      'Split an order for the pre-order case: marks specified out-of-stock line items as fulfilled (placeholder, no tracking, no customer notification) on the original order so the warehouse can ship the in-stock items, AND immediately creates a new $0 pre-order for the held items so they queue for shipment when inventory arrives.',
      'Tags the original order `pre-order-pending` and appends a staff note. Tags the new pre-order `pre-order` + `pre-order-from-<original>` with a referencing note.',
      'Two-phase: phase 1 (confirmed omitted/false) previews; phase 2 (confirmed=true) executes.',
      'You MUST present the phase 1 preview to the operator and receive explicit confirmation before calling phase 2.',
      'Use this when an order has out-of-stock items blocking the warehouse from shipping the in-stock items, AND the operator wants the held items queued as a separate pre-order rather than refunded.',
      'Do NOT use this for refunds — the customer pays nothing extra and receives nothing less; this just splits the shipment timing.',
      'Do NOT use for manual shipment recording with real tracking — that is a different flow.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        order_number: { type: 'string', description: 'Original order number (e.g. "30267", "#30267")' },
        items: {
          type: 'array',
          description: 'Line items to mark as fulfilled on the original AND move into a new pre-order. Each item: { sku, quantity? } — quantity defaults to the full unfulfilled quantity for that SKU.',
          items: {
            type: 'object',
            properties: {
              sku: { type: 'string', description: 'SKU of the held item' },
              quantity: { type: 'number', description: 'Quantity (default: all remaining)' },
            },
            required: ['sku'],
          },
        },
        staff_note: { type: 'string', description: 'Optional additional context appended to both the original-order note and the new pre-order note' },
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
        const {
          order_id,
          order_name,
          line_items_by_fo,
          item_summary,
          customer_id,
          shipping_address,
          new_order_line_items,
        } = _fulfill_data;

        const originalShortName = (order_name || '').replace(/^#/, '');

        // Step 1: placeholder fulfillment on original order
        const fulfillment = await createFulfillment({
          lineItemsByFulfillmentOrder: line_items_by_fo,
          notifyCustomer: false,
        });

        // Step 2: tag + note original order
        const originalNote = [
          `Pre-order split: ${item_summary} marked as fulfilled (out of stock); a new $0 pre-order has been queued and will ship when inventory arrives.`,
          staff_note || null,
        ].filter(Boolean).join(' — ');
        await appendOrderNote(order_id, originalNote);
        await addTags(order_id, [PRE_ORDER_PENDING_TAG]);

        // Step 3: create the new pre-order. If this fails after step 1 succeeded,
        // surface a clear recovery instruction to the operator.
        let newOrder = null;
        let newOrderError = null;
        try {
          const draftInput = {
            customerId: customer_id,
            lineItems: new_order_line_items,
            shippingAddress: shipping_address || undefined,
            tags: [...NEW_ORDER_TAGS, `pre-order-from-${originalShortName}`],
            note: [
              `Pre-order release from order #${originalShortName}. The following items were out of stock when the original order was placed; they will ship from this order when inventory arrives. Customer has already paid via the original order.`,
              staff_note || null,
            ].filter(Boolean).join(' — '),
            useCustomerDefaultAddress: !shipping_address,
          };
          // Apply 100% discount so the new order totals $0
          draftInput.appliedDiscount = {
            valueType: 'PERCENTAGE',
            value: 100,
            description: 'Pre-order release — paid in original order',
          };
          const draft = await createDraftOrder(draftInput);
          const completed = await completeDraftOrder(draft.id);
          newOrder = completed.order || completed;
        } catch (err) {
          newOrderError = err.message || String(err);
        }

        if (newOrderError) {
          return {
            content: [{
              type: 'text',
              text: [
                '**Partial success — placeholder fulfillment done, new pre-order failed**',
                '',
                `**Original order:** ${order_name} — ${getAdminUrl(order_id)}`,
                `**Held items marked fulfilled:** ${item_summary}`,
                `**Tag added:** \`${PRE_ORDER_PENDING_TAG}\``,
                '',
                `**Pre-order creation failed:** ${newOrderError}`,
                '',
                `Recovery: manually create a $0 order for the held items via \`create_order\` (customer ${customer_id}, items as listed above, tag \`pre-order\` and \`pre-order-from-${originalShortName}\`, note referencing #${originalShortName}).`,
              ].join('\n'),
            }],
          };
        }

        const newOrderUrl = newOrder?.id ? getAdminUrl(newOrder.id) : '(no admin url)';
        const newOrderName = newOrder?.name || '(no order name returned)';

        return {
          content: [{
            type: 'text',
            text: [
              '**Order split for pre-order**',
              '',
              `**Original order:** ${order_name} — ${getAdminUrl(order_id)}`,
              `  - Held items marked fulfilled (placeholder): ${item_summary}`,
              `  - Tag added: \`${PRE_ORDER_PENDING_TAG}\``,
              `  - Fulfillment id: ${fulfillment?.id || '(none)'}`,
              '',
              `**New pre-order:** ${newOrderName} — ${newOrderUrl}`,
              `  - Items: ${item_summary}`,
              `  - Tags: \`${[...NEW_ORDER_TAGS, `pre-order-from-${originalShortName}`].join('`, `')}\``,
              `  - Total: $0 (already paid via original)`,
              '',
              `Warehance will ship the in-stock items on ${order_name} now, and the new pre-order automatically when inventory arrives.`,
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
      if (!order.customer?.id) {
        return { content: [{ type: 'text', text: `Error: order ${order.name} has no associated customer — cannot create a new pre-order without a customer.` }] };
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

      const byFo = new Map();
      const matchedSummary = [];
      const newOrderLineItems = [];
      const errors = [];

      for (const requested of items) {
        const sku = requested.sku;
        if (!sku) { errors.push('Each item needs a sku.'); continue; }
        const matches = allFoLineItems.filter(li => li.lineItem?.sku === sku);
        if (matches.length === 0) {
          errors.push(`SKU not found in unfulfilled items: ${sku}`);
          continue;
        }
        const target = matches[0];
        const requestedQty = requested.quantity ?? target.remainingQuantity;
        if (requestedQty > target.remainingQuantity) {
          errors.push(`SKU ${sku}: requested ${requestedQty} but only ${target.remainingQuantity} unfulfilled.`);
          continue;
        }
        if (!target.lineItem.variant?.id) {
          errors.push(`SKU ${sku}: no variant id on original line item — cannot create pre-order line item. Likely a custom/manual item.`);
          continue;
        }
        const list = byFo.get(target.fulfillmentOrderId) || [];
        list.push({ id: target.id, quantity: requestedQty });
        byFo.set(target.fulfillmentOrderId, list);
        matchedSummary.push(`${requestedQty}x ${target.lineItem.title}${target.lineItem.variantTitle ? ` — ${target.lineItem.variantTitle}` : ''} (${sku})`);
        newOrderLineItems.push({
          variantId: target.lineItem.variant.id,
          quantity: requestedQty,
        });
      }

      if (errors.length) {
        return { content: [{ type: 'text', text: `Error preparing fulfillment:\n${errors.map(e => `- ${e}`).join('\n')}` }] };
      }

      const lineItemsByFulfillmentOrder = [...byFo.entries()].map(([fulfillmentOrderId, fulfillmentOrderLineItems]) => ({
        fulfillmentOrderId,
        fulfillmentOrderLineItems,
      }));

      const itemSummary = matchedSummary.join('; ');
      const originalShortName = (order.name || '').replace(/^#/, '');

      const fulfillData = {
        order_id: order.id,
        order_name: order.name,
        line_items_by_fo: lineItemsByFulfillmentOrder,
        item_summary: itemSummary,
        customer_id: order.customer.id,
        shipping_address: order.shippingAddress || null,
        new_order_line_items: newOrderLineItems,
      };

      const stayingUnfulfilled = allFoLineItems
        .filter(li => {
          const list = byFo.get(li.fulfillmentOrderId) || [];
          const claimed = list.find(x => x.id === li.id);
          if (!claimed) return true;
          return claimed.quantity < li.remainingQuantity;
        })
        .map(li => {
          const list = byFo.get(li.fulfillmentOrderId) || [];
          const claimed = list.find(x => x.id === li.id);
          const remainingAfter = li.remainingQuantity - (claimed?.quantity || 0);
          return `${remainingAfter}x ${li.lineItem.title}${li.lineItem.variantTitle ? ` — ${li.lineItem.variantTitle}` : ''} (${li.lineItem.sku})`;
        });

      const customerName = [order.customer?.firstName, order.customer?.lastName].filter(Boolean).join(' ').trim() || '(no name)';
      const newOrderTags = [...NEW_ORDER_TAGS, `pre-order-from-${originalShortName}`];

      return {
        content: [{
          type: 'text',
          text: [
            '**Order Split Preview — Awaiting Confirmation**',
            '',
            `**Original order:** ${order.name} — ${getAdminUrl(order.id)}`,
            `**Customer:** ${customerName} (${order.customer?.email || 'no email'})`,
            '',
            '**On the original order — mark fulfilled (placeholder, no tracking, no customer email):**',
            `  ${itemSummary}`,
            stayingUnfulfilled.length
              ? '\n**On the original order — remaining (Warehance will ship now):**\n' + stayingUnfulfilled.map(l => `  ${l}`).join('\n')
              : '\n**Remaining on original:** none — original will become fully fulfilled.',
            '',
            '**New pre-order to create:**',
            `  Items: ${itemSummary}`,
            `  Total: $0 (already paid via ${order.name})`,
            `  Tags: \`${newOrderTags.join('`, `')}\``,
            `  Customer: ${order.customer?.email || customerName}`,
            '  Shipping address: ' + (order.shippingAddress ? `same as ${order.name}` : 'customer default'),
            '',
            staff_note ? `**Staff note (added to both orders):** ${staff_note}\n` : '',
            `To confirm, call fulfill_items again with confirmed=true, order_number="${order_number}", items=${JSON.stringify(items)}, and _fulfill_data=${JSON.stringify(fulfillData)}.`,
          ].filter(Boolean).join('\n'),
        }],
      };
    },
  },
];

module.exports = tools;
