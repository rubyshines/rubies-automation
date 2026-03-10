/**
 * Invoice order tools: create_invoice_order, send_draft_order_invoice
 *
 * create_invoice_order: Mixed exchange + paid items in a single draft order.
 * Exchange items are $0 (100% discount), paid items are full price.
 */

const { createDraftOrder, sendDraftOrderInvoice, normalizeGid } = require('../shopify');
const { searchProducts } = require('../productCache');

const tools = [
  {
    name: 'create_invoice_order',
    description: 'Create a draft order with a mix of free exchange items ($0) and paid items (full price). Use this when a customer needs both a replacement and wants to add/pay for additional items. Set confirmed=true to create.',
    inputSchema: {
      type: 'object',
      properties: {
        customer_id: {
          type: 'string',
          description: 'Shopify customer ID (GID or numeric)',
        },
        exchange_items: {
          type: 'array',
          description: 'Items to include for free (exchange/replacement)',
          items: {
            type: 'object',
            properties: {
              variant_id: { type: 'string' },
              query: { type: 'string' },
              quantity: { type: 'number' },
            },
          },
        },
        paid_items: {
          type: 'array',
          description: 'Items to include at full price',
          items: {
            type: 'object',
            properties: {
              variant_id: { type: 'string' },
              query: { type: 'string' },
              quantity: { type: 'number' },
            },
          },
        },
        note: { type: 'string', description: 'Optional note for the draft order' },
        confirmed: {
          type: 'boolean',
          description: 'Set to true to actually create the draft order. False (default) returns a preview.',
        },
      },
      required: ['customer_id'],
    },
    handler: async ({ customer_id, exchange_items, paid_items, note, confirmed }) => {
      const allExchange = exchange_items || [];
      const allPaid = paid_items || [];

      if (allExchange.length === 0 && allPaid.length === 0) {
        return { content: [{ type: 'text', text: 'Must provide at least one exchange_item or paid_item.' }] };
      }

      // Resolve exchange items
      const resolvedExchange = allExchange.length > 0 ? await resolveItems(allExchange) : [];
      if (resolvedExchange.error) {
        return { content: [{ type: 'text', text: resolvedExchange.error }] };
      }

      // Resolve paid items
      const resolvedPaid = allPaid.length > 0 ? await resolveItems(allPaid) : [];
      if (resolvedPaid.error) {
        return { content: [{ type: 'text', text: resolvedPaid.error }] };
      }

      // Build summary
      let summary = `**Invoice Order Preview**\n\nCustomer: ${customer_id}\n`;

      if (resolvedExchange.length > 0) {
        summary += `\nExchange items (free):\n`;
        for (const r of resolvedExchange) {
          summary += `  ${r.quantity}x ${r.productTitle} - ${r.variantTitle} → $0.00\n`;
        }
      }

      if (resolvedPaid.length > 0) {
        summary += `\nPaid items:\n`;
        let paidTotal = 0;
        for (const r of resolvedPaid) {
          const lineTotal = parseFloat(r.price || 0) * r.quantity;
          paidTotal += lineTotal;
          summary += `  ${r.quantity}x ${r.productTitle} - ${r.variantTitle} → $${parseFloat(r.price || 0).toFixed(2)} each = $${lineTotal.toFixed(2)}\n`;
        }
        summary += `\nPaid subtotal: $${paidTotal.toFixed(2)}\n`;
      }

      summary += `Shipping: Standard (calculated by Shopify)\n`;
      summary += `Note: ${note || 'Invoice order (exchange + paid items) created via CS MCP server'}\n`;

      if (!confirmed) {
        summary += `\nCall again with confirmed=true to create this draft order.`;
        return { content: [{ type: 'text', text: summary }] };
      }

      // Build line items
      const lineItems = [];

      for (const r of resolvedExchange) {
        lineItems.push({
          variantId: r.variantId,
          quantity: r.quantity,
          appliedDiscount: {
            title: 'Exchange',
            value: 100,
            valueType: 'PERCENTAGE',
          },
        });
      }

      for (const r of resolvedPaid) {
        lineItems.push({
          variantId: r.variantId,
          quantity: r.quantity,
        });
      }

      const draftOrder = await createDraftOrder({
        customerId: normalizeGid(customer_id, 'Customer'),
        lineItems,
        note: note || 'Invoice order (exchange + paid items) created via CS MCP server',
        tags: ['invoice', 'cs-mcp'],
      });

      return {
        content: [{
          type: 'text',
          text: `**Invoice Draft Order Created**\n\nOrder: ${draftOrder.name}\nID: ${draftOrder.id}\nTotal: $${draftOrder.totalPrice}\nInvoice URL: ${draftOrder.invoiceUrl}\n\nUse send_draft_order_invoice to email the payment link to the customer.`,
        }],
      };
    },
  },
  {
    name: 'send_draft_order_invoice',
    description: 'Send a Shopify invoice email to the customer for a draft order. The email includes a payment link.',
    inputSchema: {
      type: 'object',
      properties: {
        draft_order_id: {
          type: 'string',
          description: 'Shopify draft order ID (GID or numeric)',
        },
        email: {
          type: 'string',
          description: 'Optional: override the recipient email address',
        },
      },
      required: ['draft_order_id'],
    },
    handler: async ({ draft_order_id, email }) => {
      const result = await sendDraftOrderInvoice(draft_order_id, email);
      return {
        content: [{
          type: 'text',
          text: `**Invoice Sent**\n\nDraft Order: ${result.name}\nID: ${result.id}\nInvoice URL: ${result.invoiceUrl}\n${email ? `Sent to: ${email}` : 'Sent to customer on file'}`,
        }],
      };
    },
  },
];

async function resolveItems(items) {
  const resolved = [];

  for (const item of items) {
    const quantity = item.quantity || 1;

    if (item.variant_id) {
      resolved.push({
        variantId: normalizeGid(item.variant_id, 'ProductVariant'),
        productTitle: '(by ID)',
        variantTitle: item.variant_id,
        sku: null,
        price: item.price || '0',
        quantity,
      });
    } else if (item.query) {
      const results = searchProducts(item.query);
      if (results.length === 0) {
        return { error: `No products found matching "${item.query}". Try a different search.` };
      }
      const best = results[0];
      resolved.push({
        variantId: best.variantId,
        productTitle: best.productTitle,
        variantTitle: best.variantTitle,
        sku: best.sku,
        price: best.price,
        quantity,
      });
    } else {
      return { error: 'Each item must have either variant_id or query' };
    }
  }

  return resolved;
}

module.exports = tools;
