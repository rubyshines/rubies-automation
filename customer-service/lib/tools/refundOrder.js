/**
 * Refund order tool: refund_order
 * Refunds specific line items on a fulfilled order back to the original payment method.
 * Two-phase flow: Phase 1 calculates + shows preview, Phase 2 (confirmed=true) executes the refund.
 */

const { getOrderByNumber, calculateRefund, createRefund, normalizeGid, getAdminUrl, shopifyGraphQL } = require('../shopify');

const tools = [
  {
    name: 'refund_order',
    description: [
      'Refund on an order. Supports two modes:',
      '(A) Line-item refund: provide items array with { sku, quantity } or { line_item_id, quantity }.',
      '(B) Custom amount refund: provide amount (e.g. "13.90") for arbitrary refunds like customs reimbursement, goodwill credits, or partial adjustments that don\'t map to a specific line item.',
      'Two-phase flow:',
      'Phase 1 (confirmed omitted or false): calculates/previews the refund. Does NOT execute.',
      'Phase 2 (confirmed=true): executes the refund, returning funds to the original payment method.',
      'IMPORTANT: You MUST present the Phase 1 preview to the user and receive explicit confirmation before calling Phase 2.',
      'A notification email is always sent to the customer.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        order_number: {
          type: 'string',
          description: 'Order number (e.g. "29338", "#29338")',
        },
        amount: {
          type: 'string',
          description: 'Custom refund amount (e.g. "13.90"). Use this for arbitrary refunds like customs reimbursement that don\'t map to a specific line item. Mutually exclusive with items.',
        },
        items: {
          type: 'array',
          description: 'Items to refund. Each item needs { sku, quantity } or { line_item_id, quantity }. Mutually exclusive with amount.',
          items: {
            type: 'object',
            properties: {
              sku: { type: 'string', description: 'SKU of the item to refund' },
              line_item_id: { type: 'string', description: 'Shopify line item GID (if known)' },
              quantity: { type: 'number', description: 'Quantity to refund' },
            },
          },
        },
        note: {
          type: 'string',
          description: 'Optional note for the refund',
        },
        confirmed: {
          type: 'boolean',
          description: 'Set to true to execute the refund (phase 2). Requires phase 1 to have been run first.',
        },
        // Phase 2 carries forward the calculated data
        _refund_data: {
          type: 'object',
          description: 'Internal: refund calculation data from phase 1. Pass this back unchanged when confirming.',
        },
      },
      required: ['order_number'],
    },
    handler: async ({ order_number, amount, items, note, confirmed, _refund_data }) => {
      // --- Phase 2: Execute the refund ---
      if (confirmed && _refund_data) {
        const refundInput = {
          orderId: _refund_data.order_id,
          currency: _refund_data.currency || 'USD',
          transactions: _refund_data.transactions.map(t => ({ ...t, orderId: _refund_data.order_id })),
          notify: true,
        };
        // Only include refundLineItems if this is a line-item refund (not a custom amount refund)
        if (_refund_data.refund_line_items && _refund_data.refund_line_items.length > 0) {
          refundInput.refundLineItems = _refund_data.refund_line_items;
        }
        if (note) refundInput.note = note;

        const refund = await createRefund(refundInput);

        // Custom amount refund — no line items in the response
        if (_refund_data.custom_amount) {
          return {
            content: [{
              type: 'text',
              text: [
                '**Refund Completed**',
                '',
                `**Order:** ${_refund_data.order_name} — ${getAdminUrl(_refund_data.order_id)}`,
                `**Refunded:** ${_refund_data.custom_amount} ${_refund_data.currency}`,
                `**Notification:** Sent`,
                note ? `\n**Note:** ${note}` : '',
              ].filter(Boolean).join('\n'),
            }],
          };
        }

        const itemLines = refund.refundLineItems.map(rli =>
          `  ${rli.quantity}x ${rli.lineItem.title}${rli.lineItem.variantTitle ? ` - ${rli.lineItem.variantTitle}` : ''} → ${rli.subtotalSet.shopMoney.amount} ${rli.subtotalSet.shopMoney.currencyCode}`
        ).join('\n');

        // Sum refund total from line items (totalRefundedSet on Refund object is unreliable)
        const currency = refund.refundLineItems[0]?.subtotalSet?.shopMoney?.currencyCode || 'USD';
        const totalRefunded = refund.refundLineItems
          .reduce((sum, rli) => sum + parseFloat(rli.subtotalSet.shopMoney.amount), 0)
          .toFixed(2);

        return {
          content: [{
            type: 'text',
            text: [
              '**Refund Completed**',
              '',
              `**Order:** ${_refund_data.order_name} — ${getAdminUrl(_refund_data.order_id)}`,
              `**Refunded:** ${totalRefunded} ${currency}`,
              `**Notification:** Sent`,
              '',
              '**Items refunded:**',
              itemLines,
              note ? `\n**Note:** ${note}` : '',
            ].filter(Boolean).join('\n'),
          }],
        };
      }

      // --- Phase 1: Calculate and preview ---

      // Validate: need either amount or items
      if (!amount && (!items || items.length === 0)) {
        return { content: [{ type: 'text', text: 'Error: provide either amount (for custom refund) or items (for line-item refund).' }] };
      }
      if (amount && items && items.length > 0) {
        return { content: [{ type: 'text', text: 'Error: provide either amount or items, not both.' }] };
      }

      // --- Custom amount refund path ---
      if (amount) {
        const refundAmount = parseFloat(amount);
        if (isNaN(refundAmount) || refundAmount <= 0) {
          return { content: [{ type: 'text', text: `Error: invalid refund amount "${amount}". Must be a positive number.` }] };
        }

        const order = await getOrderByNumber(order_number);
        if (order.displayFinancialStatus === 'REFUNDED') {
          return { content: [{ type: 'text', text: `Error: Order ${order.name} is already fully refunded.` }] };
        }

        // Get the order's transactions to find the parent transaction for refund
        const parentTransaction = await getOrderParentTransaction(order.id);
        if (!parentTransaction) {
          return { content: [{ type: 'text', text: `Error: Could not find a successful payment transaction on order ${order.name} to refund against.` }] };
        }

        const currency = parentTransaction.presentmentCurrency || 'USD';

        const transactions = [{
          gateway: parentTransaction.gateway,
          parentId: parentTransaction.id,
          amount: refundAmount.toFixed(2),
          kind: 'REFUND',
        }];

        const refundData = {
          order_id: order.id,
          order_name: order.name,
          custom_amount: refundAmount.toFixed(2),
          refund_line_items: [],
          transactions,
          currency,
        };

        const outputLines = [
          '**Custom Amount Refund Preview — Awaiting Confirmation**',
          '',
          `**Order:** ${order.name} — ${getAdminUrl(order.id)}`,
          `**Customer:** ${order.customer?.firstName || ''} ${order.customer?.lastName || ''} (${order.customer?.email || 'no email'})`.trim(),
          '',
          `**Refund amount:** ${refundAmount.toFixed(2)} ${currency}`,
          `**Refund to:** original payment method (${parentTransaction.gateway})`,
          '',
          `To confirm, call refund_order again with confirmed=true, order_number="${order_number}", and _refund_data=${JSON.stringify(refundData)}`,
        ];

        return { content: [{ type: 'text', text: outputLines.join('\n') }] };
      }

      // Look up the order
      const order = await getOrderByNumber(order_number);

      if (order.displayFinancialStatus === 'REFUNDED') {
        return { content: [{ type: 'text', text: `Error: Order ${order.name} is already fully refunded.` }] };
      }

      // Match requested items to order line items. The order query already carries
      // line-item ids + remaining quantities, so no extra round-trip is needed.
      // A SKU can map to MULTIPLE separate line items (Simple Bundles unbundles a
      // bundle into one line item per component), so allocate the requested quantity
      // across every matching line, tracking consumed capacity to avoid over-refunding.
      const allocation = allocateRefundLineItems(order.lineItems, items);
      if (allocation.error) {
        return { content: [{ type: 'text', text: `Error: ${allocation.error}` }] };
      }
      const { refundLineItems } = allocation;

      // Calculate the refund via Shopify
      const calculation = await calculateRefund(order.id, refundLineItems);

      const refundAmount = calculation.amountSet.shopMoney;
      const subtotal = calculation.subtotalSet.shopMoney;
      const tax = calculation.totalTaxSet.shopMoney;

      const itemLines = calculation.refundLineItems.map(rli =>
        `  ${rli.quantity}x ${rli.lineItem.title}${rli.lineItem.variantTitle ? ` - ${rli.lineItem.variantTitle}` : ''} (${rli.lineItem.sku || 'no SKU'}) → ${rli.subtotalSet.shopMoney.amount} ${rli.subtotalSet.shopMoney.currencyCode}`
      ).join('\n');

      // Build transaction data for phase 2
      // IMPORTANT: use presentmentMoney amount — must match the parent transaction currency
      // (Shopify infers currency from parentId, so don't pass a currency field)
      const transactions = calculation.suggestedTransactions.map(t => ({
        gateway: t.gateway,
        parentId: t.parentTransaction.id,
        amount: t.amountSet.presentmentMoney.amount,
        kind: 'REFUND',
      }));

      // Determine the presentment currency from the suggested transactions
      const presentmentCurrency = calculation.suggestedTransactions[0]?.amountSet?.presentmentMoney?.currencyCode || 'USD';

      const refundData = {
        order_id: order.id,
        order_name: order.name,
        refund_line_items: refundLineItems,
        transactions,
        currency: presentmentCurrency,
      };

      const outputLines = [
        '**Refund Preview — Awaiting Confirmation**',
        '',
        `**Order:** ${order.name} — ${getAdminUrl(order.id)}`,
        `**Customer:** ${order.customer?.firstName || ''} ${order.customer?.lastName || ''} (${order.customer?.email || 'no email'})`.trim(),
        '',
        '**Items to refund:**',
        itemLines,
        '',
        `**Subtotal:** ${subtotal.amount} ${subtotal.currencyCode}`,
        tax.amount !== '0.0' ? `**Tax:** ${tax.amount} ${tax.currencyCode}` : null,
        `**Total refund:** ${refundAmount.amount} ${refundAmount.currencyCode}`,
        `**Refund to:** original payment method (${transactions.map(t => t.gateway).join(', ')})`,
        '',
        `To confirm, call refund_order again with confirmed=true, order_number="${order_number}", and _refund_data=${JSON.stringify(refundData)}`,
      ].filter(Boolean);

      return {
        content: [{
          type: 'text',
          text: outputLines.join('\n'),
        }],
      };
    },
  },
];

/**
 * Fetch the parent (SALE) transaction for an order, needed for custom amount refunds.
 */
async function getOrderParentTransaction(orderId) {
  const gid = normalizeGid(orderId, 'Order');
  const data = await shopifyGraphQL(`
    query getOrderTransactions($id: ID!) {
      order(id: $id) {
        transactions(first: 20) {
          id
          kind
          status
          gateway
          amountSet {
            shopMoney { amount currencyCode }
            presentmentMoney { amount currencyCode }
          }
        }
      }
    }
  `, { id: gid });
  // Find the successful payment transaction (SALE or CAPTURE depending on gateway)
  const txns = data.order.transactions || [];
  const sale = txns.find(t => (t.kind === 'SALE' || t.kind === 'CAPTURE') && t.status === 'SUCCESS');
  if (!sale) return null;
  return {
    id: sale.id,
    gateway: sale.gateway,
    presentmentCurrency: sale.amountSet.presentmentMoney.currencyCode,
  };
}

/**
 * Resolve requested refund items to Shopify refundLineItems, allocating each
 * requested SKU across every matching line item on the order.
 *
 * Why allocation (not a simple `.find`): a single SKU can appear as multiple
 * separate line items on one order — Simple Bundles unbundles a bundle into one
 * line item per component, so `UNW-BLK-3XL` can show up twice, each quantity 1.
 * A `.find()` resolver targets only the first line item, so refunding 2 units of
 * that SKU asks Shopify to refund 2 against a line whose quantity is 1, which it
 * rejects ("cannot refund more items than were purchased"). Here we spread the
 * requested quantity across the matching lines and track consumed capacity so
 * repeated requests for the same SKU don't double-count the same line item.
 *
 * Pure + deterministic (no I/O) so it's unit-testable. `orderLineItems` is the
 * array returned by getOrderByNumber (each node has id, sku, title, variantTitle,
 * quantity, currentQuantity). `currentQuantity` already nets out prior refunds.
 *
 * Returns { refundLineItems: [{ lineItemId, quantity }], matchedItems: [...] }
 * or { error: string }.
 */
function allocateRefundLineItems(orderLineItems, requestedItems) {
  // Remaining refundable capacity per line-item id (currentQuantity nets prior refunds).
  const remaining = new Map();
  for (const li of orderLineItems) {
    const cap = li.currentQuantity != null ? li.currentQuantity : li.quantity;
    remaining.set(li.id, cap);
  }

  const refundLineItems = [];
  const matchedItems = [];

  const pushAllocation = (lineItem, qty, sku) => {
    refundLineItems.push({ lineItemId: lineItem.id, quantity: qty });
    matchedItems.push({
      id: lineItem.id,
      title: `${lineItem.title || '(unknown)'}${lineItem.variantTitle ? ` - ${lineItem.variantTitle}` : ''}`,
      sku: sku || lineItem.sku || undefined,
      quantity: qty,
    });
  };

  for (const item of requestedItems) {
    const qty = item.quantity || 1;

    if (item.line_item_id) {
      const lineItemId = normalizeGid(item.line_item_id, 'LineItem');
      const lineItem = orderLineItems.find(li => li.id === lineItemId);
      // If the id isn't in the order (caller passed an id we can't validate), pass it
      // through unchanged rather than blocking — Shopify is the final authority.
      if (!lineItem) {
        refundLineItems.push({ lineItemId, quantity: qty });
        matchedItems.push({ id: lineItemId, title: '(by ID)', quantity: qty });
        continue;
      }
      const avail = remaining.get(lineItemId);
      if (qty > avail) {
        return { error: `Requested ${qty}x line item ${lineItemId} but only ${avail} refundable.` };
      }
      remaining.set(lineItemId, avail - qty);
      pushAllocation(lineItem, qty, item.sku);
    } else if (item.sku) {
      const matches = orderLineItems.filter(li => li.sku === item.sku);
      if (matches.length === 0) {
        const available = orderLineItems.map(li => li.sku).filter(Boolean).join(', ');
        return { error: `SKU "${item.sku}" not found on order. Available SKUs: ${available}` };
      }
      let need = qty;
      for (const li of matches) {
        if (need <= 0) break;
        const avail = remaining.get(li.id);
        if (avail <= 0) continue;
        const take = Math.min(avail, need);
        remaining.set(li.id, avail - take);
        pushAllocation(li, take, item.sku);
        need -= take;
      }
      if (need > 0) {
        const totalAvail = matches.reduce((s, li) => s + (li.currentQuantity != null ? li.currentQuantity : li.quantity), 0);
        return { error: `Requested ${qty}x SKU "${item.sku}" but only ${totalAvail} refundable across ${matches.length} line item(s) on the order.` };
      }
    } else {
      return { error: 'Each item must have either sku or line_item_id.' };
    }
  }

  // Merge entries that landed on the same line item (e.g. the same SKU requested
  // across two separate input items) — Shopify expects one entry per line item id.
  const mergedRefund = [];
  const byId = new Map();
  for (const rli of refundLineItems) {
    if (byId.has(rli.lineItemId)) {
      byId.get(rli.lineItemId).quantity += rli.quantity;
    } else {
      const entry = { ...rli };
      byId.set(rli.lineItemId, entry);
      mergedRefund.push(entry);
    }
  }

  return { refundLineItems: mergedRefund, matchedItems };
}

module.exports = tools;
module.exports.getOrderParentTransaction = getOrderParentTransaction;
module.exports.allocateRefundLineItems = allocateRefundLineItems;
