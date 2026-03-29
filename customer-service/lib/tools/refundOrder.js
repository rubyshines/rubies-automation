/**
 * Refund order tool: refund_order
 * Refunds specific line items on a fulfilled order back to the original payment method.
 * Two-phase flow: Phase 1 calculates + shows preview, Phase 2 (confirmed=true) executes the refund.
 */

const { getOrderByNumber, calculateRefund, createRefund, normalizeGid, getAdminUrl } = require('../shopify');

const tools = [
  {
    name: 'refund_order',
    description: [
      'Refund specific line items on an order. Two-phase flow:',
      'Phase 1 (confirmed omitted or false): calculates the refund using Shopify suggestedRefund and returns a preview with amounts. Does NOT execute the refund.',
      'Phase 2 (confirmed=true): executes the refund, returning funds to the original payment method.',
      'IMPORTANT: You MUST present the Phase 1 preview to the user and receive explicit confirmation before calling Phase 2.',
      'Provide items as an array of { sku, quantity } or { line_item_id, quantity } to refund.',
      'A notification email is always sent to the customer.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        order_number: {
          type: 'string',
          description: 'Order number (e.g. "29338", "#29338")',
        },
        items: {
          type: 'array',
          description: 'Items to refund. Each item needs { sku, quantity } or { line_item_id, quantity }.',
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
    handler: async ({ order_number, items, note, confirmed, _refund_data }) => {
      // --- Phase 2: Execute the refund ---
      if (confirmed && _refund_data) {
        const refundInput = {
          orderId: _refund_data.order_id,
          currency: _refund_data.currency || 'USD',
          refundLineItems: _refund_data.refund_line_items,
          transactions: _refund_data.transactions.map(t => ({ ...t, orderId: _refund_data.order_id })),
          notify: true,
        };
        if (note) refundInput.note = note;

        const refund = await createRefund(refundInput);
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
      if (!items || items.length === 0) {
        return { content: [{ type: 'text', text: 'Error: items are required to calculate a refund. Provide [{ sku, quantity }] or [{ line_item_id, quantity }].' }] };
      }

      // Look up the order
      const order = await getOrderByNumber(order_number);

      if (order.displayFinancialStatus === 'REFUNDED') {
        return { content: [{ type: 'text', text: `Error: Order ${order.name} is already fully refunded.` }] };
      }

      // Match requested items to order line items
      const refundLineItems = [];
      const matchedItems = [];

      for (const item of items) {
        const qty = item.quantity || 1;

        if (item.line_item_id) {
          refundLineItems.push({
            lineItemId: normalizeGid(item.line_item_id, 'LineItem'),
            quantity: qty,
          });
          matchedItems.push({ id: item.line_item_id, title: '(by ID)', quantity: qty });
        } else if (item.sku) {
          // Find matching line item in the order
          const match = order.lineItems.find(li => li.sku === item.sku);
          if (!match) {
            return { content: [{ type: 'text', text: `Error: SKU "${item.sku}" not found in order ${order.name}. Available SKUs: ${order.lineItems.map(li => li.sku).filter(Boolean).join(', ')}` }] };
          }
          if (!match.variant?.id) {
            return { content: [{ type: 'text', text: `Error: Line item for SKU "${item.sku}" has no variant ID — cannot refund.` }] };
          }
          // We need the line item ID, not variant ID. Get it from the order query.
          // The getOrderByNumber query doesn't return line item IDs, so we need to fetch them.
          const orderWithLineItemIds = await getOrderLineItemIds(order.id);
          const lineItemMatch = orderWithLineItemIds.find(li => li.sku === item.sku);
          if (!lineItemMatch) {
            return { content: [{ type: 'text', text: `Error: Could not resolve line item ID for SKU "${item.sku}".` }] };
          }
          refundLineItems.push({
            lineItemId: lineItemMatch.id,
            quantity: qty,
          });
          matchedItems.push({
            id: lineItemMatch.id,
            title: `${match.title}${match.variantTitle ? ` - ${match.variantTitle}` : ''}`,
            sku: item.sku,
            quantity: qty,
          });
        } else {
          return { content: [{ type: 'text', text: 'Error: Each item must have either sku or line_item_id.' }] };
        }
      }

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
 * Fetch line item IDs for an order (needed for refund API).
 */
const { shopifyGraphQL } = require('../shopify');

async function getOrderLineItemIds(orderId) {
  const data = await shopifyGraphQL(`
    query getOrderLineItems($id: ID!) {
      order(id: $id) {
        lineItems(first: 100) {
          edges {
            node {
              id
              title
              variantTitle
              sku
              quantity
            }
          }
        }
      }
    }
  `, { id: orderId });
  return data.order.lineItems.edges.map(e => e.node);
}

module.exports = tools;
