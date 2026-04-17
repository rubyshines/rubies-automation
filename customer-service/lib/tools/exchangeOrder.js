/**
 * Exchange order tool: create_exchange_order
 * Creates a free draft order ($0 line items, free shipping) for exchange replacements.
 * Two-phase flow: Phase 1 creates draft + shows preview, Phase 2 (confirmed=true) marks it as paid.
 */

const { createDraftOrder, completeDraftOrder, normalizeGid, searchCustomers, getCustomerOrders, getCustomerFulfilledOrders, getOrderByNumber, getAdminUrl } = require('../shopify');
const { getCustomerOrdersFromSupabase, getCustomerFulfilledOrdersFromSupabase } = require('../supabaseQueries');
const { resolveLineItems } = require('../resolveLineItems');
const { formatAddressBlock, formatAddressLine } = require('../addressUtils');

const tools = [
  {
    name: 'create_exchange_order',
    description: [
      'Create a free exchange/replacement draft order. Two-phase flow:',
      'Phase 1 (confirmed omitted or false): creates a draft order at $0 and returns a preview with clickable Shopify admin links to both the original order and draft order. Does NOT mark as paid.',
      'Phase 2 (confirmed=true + draft_order_id): completes the draft order and marks it as paid. IMPORTANT: You MUST present the Phase 1 preview summary to the user and receive their explicit confirmation before calling Phase 2. Never auto-confirm.',
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
          description: 'Items to include in the exchange (required for phase 1). Prefer sku over query for accuracy. Use sku + target_size for size exchanges.',
          items: {
            type: 'object',
            properties: {
              variant_id: { type: 'string', description: 'Shopify variant ID (if known — most precise)' },
              sku: { type: 'string', description: 'SKU from the original order (e.g. "RJL-PNK-8"). For exact replacements, pass just sku. For size exchanges, pass sku + target_size.' },
              target_size: { type: 'string', description: 'Target size for size exchanges (e.g. "10", "L", "2X"). Used with sku to find the same product in a different size.' },
              query: { type: 'string', description: 'Product search query (fallback if variant_id and sku not available)' },
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

        // Fetch the completed order details to show full info
        let orderDetails = '';
        try {
          const orderNum = (completedOrder.order?.name || orderName || '').replace('#', '');
          if (orderNum) {
            const details = await getOrderByNumber(orderNum);
            const items = (details.lineItems || []).map(li =>
              `  ${li.quantity}x ${li.title} — ${li.variantTitle || ''} (${li.sku || 'no SKU'})`
            ).join('\n');
            const addr = formatAddressLine(details.shippingAddress);
            orderDetails = [
              `**Customer:** ${details.customer?.name || ''} (${details.customer?.email || ''})`,
              `**Ship to:** ${addr}`,
              `**Items:**\n${items}`,
              `**Note:** ${details.note || '(none)'}`,
            ].join('\n');
          }
        } catch (err) {
          orderDetails = `(Could not fetch order details: ${err.message})`;
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
              '',
              orderDetails,
            ].filter(Boolean).join('\n'),
          }],
        };
      }

      // --- Phase 1: Create draft order + show preview ---
      if (!items || items.length === 0) {
        return { content: [{ type: 'text', text: 'Error: items are required to create an exchange draft order.' }] };
      }

      // Resolve items to variant IDs
      const resolvedItems = await resolveLineItems(items);
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
            addressBlock = formatAddressBlock(a);
            shippingAddress = {
              firstName: c.firstName || '',
              lastName: c.lastName || '',
              address1: a.address1,
              address2: a.address2 || '',
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
      let originalOrderName = null;
      try {
        if (original_order_id) {
          // Explicit order ID provided — still validate it's fulfilled
          let orderResult = await getCustomerOrdersFromSupabase(customerGid, 50);
          if (!orderResult) orderResult = await getCustomerOrders(customerGid, 50);
          const { orders: allOrders } = orderResult;
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
          originalOrderName = match.name;
          // Prefer shipping address from the original order over customer default
          if (match.shippingAddress) {
            const a = match.shippingAddress;
            addressBlock = formatAddressBlock(a);
            shippingAddress = {
              firstName: shippingAddress?.firstName || '',
              lastName: shippingAddress?.lastName || '',
              address1: a.address1,
              address2: a.address2 || '',
              city: a.city,
              province: a.province,
              country: a.countryCodeV2 || a.country,
              zip: a.zip,
            };
          }
        } else {
          // Auto-find: try Supabase first, fall back to Shopify
          let fulfilledOrders = await getCustomerFulfilledOrdersFromSupabase(customerGid, 20);
          if (!fulfilledOrders.length) fulfilledOrders = await getCustomerFulfilledOrders(customerGid, 20);
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
          originalOrderName = eligible.name;
          // Prefer shipping address from the original order over customer default
          if (eligible.shippingAddress) {
            const a = eligible.shippingAddress;
            addressBlock = formatAddressBlock(a);
            shippingAddress = {
              firstName: shippingAddress?.firstName || '',
              lastName: shippingAddress?.lastName || '',
              address1: a.address1,
              address2: a.address2 || '',
              city: a.city,
              province: a.province,
              country: a.countryCodeV2 || a.country,
              zip: a.zip,
            };
          }
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
      const itemLines = resolvedItems.map(r => {
        let line = `  ${r.quantity}x ${r.productTitle} - ${r.variantTitle} (${r.sku || 'no SKU'}) → $0.00`;
        if (r.inventoryQuantity != null && r.inventoryQuantity < r.quantity) {
          line += `\n  ⚠️ **INSUFFICIENT STOCK** — only ${r.inventoryQuantity} available (need ${r.quantity})`;
        }
        return line;
      }).join('\n');

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
        note: (note ? `${note}${originalOrderName ? ` from order ${originalOrderName}` : ''}` : `Exchange order from ${originalOrderName || 'unknown order'} via CS MCP server`),
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

module.exports = tools;
