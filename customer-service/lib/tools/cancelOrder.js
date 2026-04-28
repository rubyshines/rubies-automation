/**
 * Cancel order tool: cancel_order
 *
 * Cancels an unfulfilled order via Shopify's orderCancel mutation.
 * Defaults: refund the customer, restock inventory, notify the customer,
 * reason CUSTOMER. Blocks if any line item is already fulfilled — for
 * partial cancellation, use refund_order + edit_order instead.
 *
 * Two-phase: phase 1 previews; phase 2 (confirmed=true) executes.
 */

const { getOrderByNumber, cancelOrder, getAdminUrl } = require('../shopify');

const VALID_REASONS = new Set(['CUSTOMER', 'DECLINED', 'FRAUD', 'INVENTORY', 'OTHER', 'STAFF']);

const tools = [
  {
    name: 'cancel_order',
    description: [
      'Cancel an unfulfilled order. Refunds the customer (if paid), restocks inventory, and emails the customer the cancellation notification by default.',
      'Two-phase: phase 1 (confirmed omitted/false) returns a preview; phase 2 (confirmed=true) executes.',
      'You MUST present the phase 1 preview to the operator and receive explicit confirmation before calling phase 2.',
      'Blocks if the order is already fulfilled (in part or whole), already cancelled, or already fully refunded — for those cases use refund_order and/or edit_order.',
      'Use this when the customer wants to cancel an order that has not yet shipped. Cancelling drops the order out of the warehouse fulfillment queue, which a refund alone does not do.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        order_number: { type: 'string', description: 'Order number (e.g. "29338", "#29338")' },
        reason: {
          type: 'string',
          enum: ['CUSTOMER', 'DECLINED', 'FRAUD', 'INVENTORY', 'OTHER', 'STAFF'],
          description: 'Cancellation reason (default CUSTOMER)',
        },
        refund: { type: 'boolean', description: 'Refund the customer (default true)' },
        restock: { type: 'boolean', description: 'Restock the line items (default true)' },
        notify_customer: { type: 'boolean', description: 'Email the customer (default true)' },
        staff_note: { type: 'string', description: 'Internal note attached to the cancellation' },
        confirmed: { type: 'boolean', description: 'Set true in phase 2 to execute' },
      },
      required: ['order_number'],
    },
    handler: async ({
      order_number,
      reason = 'CUSTOMER',
      refund = true,
      restock = true,
      notify_customer = true,
      staff_note,
      confirmed,
    }) => {
      if (!VALID_REASONS.has(reason)) {
        return { content: [{ type: 'text', text: `Error: invalid reason "${reason}". Valid: ${[...VALID_REASONS].join(', ')}.` }] };
      }

      const order = await getOrderByNumber(order_number);

      if ((order.tags || []).map(t => t.toLowerCase()).includes('cancelled') || order.displayFulfillmentStatus === 'RESTOCKED') {
        return { content: [{ type: 'text', text: `Error: order ${order.name} appears to already be cancelled.` }] };
      }
      if (order.displayFinancialStatus === 'REFUNDED') {
        return { content: [{ type: 'text', text: `Error: order ${order.name} is already fully refunded — there is nothing left to cancel.` }] };
      }
      if (['FULFILLED', 'PARTIALLY_FULFILLED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED'].includes(order.displayFulfillmentStatus)) {
        return { content: [{
          type: 'text',
          text: `Error: order ${order.name} is ${order.displayFulfillmentStatus.toLowerCase().replace(/_/g, ' ')} — cannot cancel. Use refund_order (and edit_order if needed) instead.`,
        }] };
      }

      // --- Phase 2: execute ---
      if (confirmed) {
        const job = await cancelOrder(order.id, {
          reason,
          refund,
          restock,
          notifyCustomer: notify_customer,
          staffNote: staff_note,
        });
        return {
          content: [{
            type: 'text',
            text: [
              '**Order cancelled**',
              '',
              `**Order:** ${order.name} — ${getAdminUrl(order.id)}`,
              `**Reason:** ${reason}`,
              `**Refund:** ${refund ? 'yes (to original payment method)' : 'no'}`,
              `**Restock:** ${restock ? 'yes' : 'no'}`,
              `**Customer notified:** ${notify_customer ? 'yes' : 'no'}`,
              staff_note ? `**Note:** ${staff_note}` : '',
              `**Job:** ${job?.id || '(no job id returned)'} — Shopify processes cancellation in the background; admin may take a few seconds to update.`,
            ].filter(Boolean).join('\n'),
          }],
        };
      }

      // --- Phase 1: preview ---
      const customerName = [order.customer?.firstName, order.customer?.lastName].filter(Boolean).join(' ').trim() || '(no name)';
      const itemLines = (order.lineItems || []).map(li =>
        `  ${li.quantity}x ${li.title}${li.variantTitle ? ` — ${li.variantTitle}` : ''}`
      ).join('\n');
      const total = order.totalPriceSet?.shopMoney
        ? `${order.totalPriceSet.shopMoney.amount} ${order.totalPriceSet.shopMoney.currencyCode}`
        : '(unknown total)';

      return {
        content: [{
          type: 'text',
          text: [
            '**Order Cancellation Preview — Awaiting Confirmation**',
            '',
            `**Order:** ${order.name} — ${getAdminUrl(order.id)}`,
            `**Customer:** ${customerName} (${order.customer?.email || 'no email'})`,
            `**Total:** ${total}`,
            `**Financial status:** ${order.displayFinancialStatus || 'unknown'}`,
            `**Fulfillment status:** ${order.displayFulfillmentStatus || 'unknown'}`,
            '',
            '**Items:**',
            itemLines || '  (no items)',
            '',
            `**Reason:** ${reason}`,
            `**Refund:** ${refund ? 'yes (to original payment method)' : 'no'}`,
            `**Restock:** ${restock ? 'yes' : 'no'}`,
            `**Notify customer:** ${notify_customer ? 'yes' : 'no'}`,
            staff_note ? `**Note:** ${staff_note}` : '',
            '',
            `To confirm, call cancel_order again with confirmed=true and order_number="${order_number}" (plus any reason / refund / restock / notify_customer / staff_note overrides).`,
          ].filter(Boolean).join('\n'),
        }],
      };
    },
  },
];

module.exports = tools;
