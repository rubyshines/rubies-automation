/**
 * Exchange order tool: create_exchange_order
 * Creates a free draft order ($0 line items, free shipping) for exchange replacements.
 * Two-phase flow: Phase 1 creates draft + shows preview, Phase 2 (confirmed=true) marks it as paid.
 */

const { createDraftOrder, completeDraftOrder, normalizeGid, searchCustomers, getCustomerOrders, getCustomerFulfilledOrders } = require('../shopify');
const { searchProducts } = require('../productCache');

function getStoreName() {
  const storeUrl = process.env.SHOPIFY_STORE_URL || '';
  return storeUrl.replace('.myshopify.com', '');
}

function getAdminUrl(gid) {
  const storeName = getStoreName();
  const numericId = gid.split('/').pop();
  if (gid.includes('/DraftOrder/')) {
    return `https://admin.shopify.com/store/${storeName}/draft_orders/${numericId}`;
  }
  return `https://admin.shopify.com/store/${storeName}/orders/${numericId}`;
}

const tools = [
  {
    name: 'create_exchange_order',
    description: [
      'Create a free exchange/replacement draft order. Two-phase flow:',
      'Phase 1 (confirmed omitted or false): creates a draft order at $0 and returns a preview with clickable Shopify admin links to both the original order and draft order. Does NOT mark as paid.',
      'Phase 2 (confirmed=true + draft_order_id): completes the draft order and marks it as paid.',
      'IMPORTANT: Only FULFILLED, non-cancelled orders may be used as the basis for an exchange.',
      'When determining sizes (e.g. "one size down"), you MUST reference the most recent FULFILLED order — ignore unfulfilled $0 exchange orders.',
      'Do NOT pass original_order_id unless explicitly given an order number by the user. Let the tool auto-find the correct fulfilled order.',
      'If no original_order_id is provided, automatically finds the customer\'s most recent FULFILLED, non-cancelled order.',
      'If an original_order_id IS provided, validates that it is fulfilled before proceeding.',
      'Tagged with "exchange" and "cs-mcp".',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        customer_id: {
          type: 'string',
          description: 'Shopify customer ID (GID or numeric)',
        },
        items: {
          type: 'array',
          description: 'Items to include in the exchange (required for phase 1)',
          items: {
            type: 'object',
            properties: {
              variant_id: { type: 'string', description: 'Shopify variant ID (if known)' },
              query: { type: 'string', description: 'Product search query (if variant_id not known)' },
              quantity: { type: 'number', description: 'Quantity (default: 1)' },
            },
          },
        },
        note: {
          type: 'string',
          description: 'Optional note to add to the draft order',
        },
        original_order_id: {
          type: 'string',
          description: 'Original order GID or numeric ID to link back to. If omitted, the most recent fulfilled non-cancelled order is used. If provided, must be a fulfilled order.',
        },
        confirmed: {
          type: 'boolean',
          description: 'Set to true to complete a previously created draft order (phase 2). Requires draft_order_id.',
        },
        draft_order_id: {
          type: 'string',
          description: 'Draft order GID from phase 1. Required when confirmed=true.',
        },
      },
      required: ['customer_id'],
    },
    handler: async ({ customer_id, items, note, original_order_id, confirmed, draft_order_id }) => {
      const customerGid = normalizeGid(customer_id, 'Customer');

      // --- Phase 2: Confirm and complete an existing draft ---
      if (confirmed && draft_order_id) {
        const draftGid = normalizeGid(draft_order_id, 'DraftOrder');
        const completedOrder = await completeDraftOrder(draftGid);

        const draftAdminUrl = getAdminUrl(draftGid);
        let orderAdminUrl = '';
        let orderName = completedOrder.name;
        if (completedOrder.order?.id) {
          orderAdminUrl = getAdminUrl(completedOrder.order.id);
          orderName = completedOrder.order.name;
        }

        return {
          content: [{
            type: 'text',
            text: [
              '**Exchange Order Completed**',
              '',
              `**Order:** ${orderName}${orderAdminUrl ? ` — ${orderAdminUrl}` : ''}`,
              `**Draft:** ${completedOrder.name} — ${draftAdminUrl}`,
              '**Status:** Completed (marked as paid)',
            ].join('\n'),
          }],
        };
      }

      // --- Phase 1: Create draft order + show preview ---
      if (!items || items.length === 0) {
        return { content: [{ type: 'text', text: 'Error: items are required to create an exchange draft order.' }] };
      }

      // Resolve items to variant IDs
      const resolvedItems = await resolveItems(items);
      if (resolvedItems.error) {
        return { content: [{ type: 'text', text: resolvedItems.error }] };
      }

      // Look up customer details for address
      let customerName = customer_id;
      let addressBlock = 'No address on file';
      let shippingAddress = null;
      try {
        const numericId = customerGid.split('/').pop();
        const customers = await searchCustomers(`id:${numericId}`);
        if (customers.length > 0) {
          const c = customers[0];
          customerName = `${c.firstName || ''} ${c.lastName || ''}`.trim() || c.email;
          if (c.defaultAddress) {
            const a = c.defaultAddress;
            addressBlock = [a.address1, `${a.city}, ${a.province} ${a.zip}`, a.country].filter(Boolean).join('\n');
            shippingAddress = {
              firstName: c.firstName || '',
              lastName: c.lastName || '',
              address1: a.address1,
              city: a.city,
              province: a.province,
              country: a.countryCodeV2 || a.country,
              zip: a.zip,
            };
          }
        }
      } catch (_) {
        // Non-critical
      }

      // Find original order: use provided ID (validated as fulfilled) or auto-find most recent fulfilled non-cancelled.
      // CRITICAL: We ONLY consider FULFILLED, non-cancelled, non-refunded orders.
      // Uses getCustomerFulfilledOrders which queries the top-level orders endpoint
      // with proper Shopify query filters (NOT customer.orders which doesn't support filtering).
      let originalOrderLine = '';
      try {
        if (original_order_id) {
          // Explicit order ID provided — still validate it's fulfilled
          const { orders: allOrders } = await getCustomerOrders(customerGid, 50);
          const originalGid = normalizeGid(original_order_id, 'Order');
          const match = allOrders.find(o => o.id === originalGid);
          if (!match) {
            return {
              content: [{
                type: 'text',
                text: `Error: Order ${original_order_id} not found for this customer.`,
              }],
            };
          }
          if (match.displayFulfillmentStatus !== 'FULFILLED') {
            return {
              content: [{
                type: 'text',
                text: `Error: Order ${match.name} is not fulfilled (status: ${match.displayFulfillmentStatus}). Exchange orders MUST be based on a fulfilled order. Omit original_order_id to auto-find the most recent fulfilled order.`,
              }],
            };
          }
          if (match.cancelledAt) {
            return {
              content: [{
                type: 'text',
                text: `Error: Order ${match.name} is cancelled. Exchange orders must be based on a non-cancelled fulfilled order.`,
              }],
            };
          }
          if (match.displayFinancialStatus === 'REFUNDED') {
            return {
              content: [{
                type: 'text',
                text: `Error: Order ${match.name} is refunded. Exchange orders must be based on a non-refunded fulfilled order.`,
              }],
            };
          }
          const originalUrl = getAdminUrl(originalGid);
          originalOrderLine = `**Original Order:** ${match.name} — ${originalUrl}`;
        } else {
          // Auto-find: use dedicated fulfilled-orders function (top-level orders query with proper filters)
          const fulfilledOrders = await getCustomerFulfilledOrders(customerGid, 20);
          if (fulfilledOrders.length === 0) {
            return {
              content: [{
                type: 'text',
                text: 'No fulfilled, non-cancelled, non-refunded orders found for this customer. Cannot create an exchange without a qualifying original order.',
              }],
            };
          }
          // Most recent fulfilled order (already sorted by CREATED_AT desc)
          const eligible = fulfilledOrders[0];
          const originalUrl = getAdminUrl(eligible.id);
          originalOrderLine = `**Original Order:** ${eligible.name} — ${originalUrl}`;
        }
      } catch (err) {
        return {
          content: [{
            type: 'text',
            text: `Error looking up customer orders: ${err.message}. Please provide an original_order_id explicitly.`,
          }],
        };
      }

      // Build item summary
      const itemLines = resolvedItems.map(r =>
        `  ${r.quantity}x ${r.productTitle} - ${r.variantTitle} (${r.sku || 'no SKU'}) → $0.00`
      ).join('\n');

      // Create draft order (do NOT complete it yet — wait for confirmation)
      const lineItems = resolvedItems.map(r => ({
        variantId: r.variantId,
        quantity: r.quantity,
        appliedDiscount: {
          title: 'Exchange',
          value: 100,
          valueType: 'PERCENTAGE',
        },
      }));

      const draftInput = {
        customerId: customerGid,
        lineItems,
        note: note || 'Exchange order created via CS MCP server',
        shippingLine: { title: 'Free Shipping', price: '0.00' },
        tags: ['exchange', 'cs-mcp'],
      };
      if (shippingAddress) {
        draftInput.shippingAddress = shippingAddress;
        draftInput.billingAddress = shippingAddress;
      }

      const draftOrder = await createDraftOrder(draftInput);
      const draftAdminUrl = getAdminUrl(draftOrder.id);

      const outputLines = [
        '**Exchange Draft Order Created — Awaiting Confirmation**',
        '',
      ];
      if (originalOrderLine) outputLines.push(originalOrderLine);
      outputLines.push(
        `**Exchange Draft Order:** ${draftOrder.name} — ${draftAdminUrl}`,
        '',
        `**Customer:** ${customerName}`,
        `**Ship to:**`,
        addressBlock,
        '',
        `**Items:**`,
        itemLines,
        `**Shipping:** Free`,
        `**Total:** $${draftOrder.totalPrice}`,
        '',
        `Review the draft order above, then call create_exchange_order again with confirmed=true and draft_order_id="${draftOrder.id}" to complete it.`,
      );

      return {
        content: [{
          type: 'text',
          text: outputLines.join('\n'),
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
        quantity,
      });
    } else {
      return { error: 'Each item must have either variant_id or query' };
    }
  }

  return resolved;
}

module.exports = tools;
