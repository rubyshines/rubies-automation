/**
 * Create Order MCP Tool
 *
 * General-purpose order creation for new or existing customers.
 * Supports paid orders, free orders (samples/gifts), and custom discounts.
 * Two-phase flow: preview then confirm.
 */

const {
  searchCustomers,
  createCustomer,
  createDraftOrder,
  completeDraftOrder,
  sendDraftOrderInvoice,
  normalizeGid,
} = require('../shopify');
const { searchProducts } = require('../productCache');

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
      return { error: 'Each item must have either variant_id or query.' };
    }
  }
  return resolved;
}

function fmtCurrency(n) {
  if (n == null || isNaN(n)) return '$0.00';
  return `$${Number(n).toFixed(2)}`;
}

async function findOrCreateCustomer({ email, first_name, last_name, phone, address }) {
  // Try to find existing customer by email
  const existing = await searchCustomers(`email:${email}`);
  if (existing.length > 0) {
    const c = existing[0];
    return {
      id: c.id,
      name: `${c.firstName || ''} ${c.lastName || ''}`.trim(),
      email: c.email,
      address: c.defaultAddress,
      created: false,
    };
  }

  // Create new customer
  const input = {
    email,
    firstName: first_name || '',
    lastName: last_name || '',
  };
  if (phone) input.phone = phone;
  if (address) {
    input.addresses = [{
      address1: address.address1 || '',
      city: address.city || '',
      province: address.province || '',
      country: address.country || 'AU',
      zip: address.zip || '',
    }];
  }

  const customer = await createCustomer(input);
  return {
    id: customer.id,
    name: `${customer.firstName || ''} ${customer.lastName || ''}`.trim(),
    email: customer.email,
    address: customer.defaultAddress,
    created: true,
  };
}

async function handleCreateOrder({
  email, first_name, last_name, phone, address,
  customer_id,
  items, discount_percent, free, note, tags,
  confirmed,
}) {
  if (!items || items.length === 0) {
    return { content: [{ type: 'text', text: 'Must provide at least one item.' }] };
  }

  // Resolve items
  const resolved = await resolveItems(items);
  if (resolved.error) {
    return { content: [{ type: 'text', text: resolved.error }] };
  }

  // Determine discount
  const isFree = free === true;
  const discountPct = isFree ? 100 : (discount_percent || 0);
  const discountLabel = isFree ? 'Free (samples/gift)' : `${discountPct}% off`;

  // Calculate totals for preview
  let subtotal = 0;
  const itemLines = [];
  for (const r of resolved) {
    const unitPrice = parseFloat(r.price || 0);
    const discounted = unitPrice * (1 - discountPct / 100);
    const lineTotal = discounted * r.quantity;
    subtotal += lineTotal;
    itemLines.push({
      ...r,
      unitPrice,
      discountedPrice: discounted,
      lineTotal,
    });
  }

  // Resolve customer
  let customerInfo;
  if (customer_id) {
    const results = await searchCustomers(`id:${customer_id}`);
    if (results.length === 0) {
      return { content: [{ type: 'text', text: `No customer found for ID "${customer_id}".` }] };
    }
    const c = results[0];
    customerInfo = {
      id: c.id,
      name: `${c.firstName || ''} ${c.lastName || ''}`.trim(),
      email: c.email,
      address: c.defaultAddress,
      created: false,
    };
  } else if (email) {
    if (!confirmed) {
      // Preview: just check if they exist
      const existing = await searchCustomers(`email:${email}`);
      customerInfo = existing.length > 0
        ? {
            id: existing[0].id,
            name: `${existing[0].firstName || ''} ${existing[0].lastName || ''}`.trim(),
            email: existing[0].email,
            address: existing[0].defaultAddress,
            created: false,
          }
        : {
            id: null,
            name: `${first_name || ''} ${last_name || ''}`.trim() || '(new customer)',
            email,
            address: address || null,
            created: true,
          };
    } else {
      customerInfo = await findOrCreateCustomer({ email, first_name, last_name, phone, address });
    }
  } else {
    return { content: [{ type: 'text', text: 'Must provide either email or customer_id.' }] };
  }

  // Build preview markdown
  const storeUrl = (process.env.SHOPIFY_STORE_URL || '').replace('.myshopify.com', '');
  let md = `**Order Preview**\n\n`;
  md += `**Customer:** ${customerInfo.name}`;
  if (customerInfo.created && !confirmed) md += ` (will be created)`;
  if (customerInfo.created && confirmed) md += ` (newly created)`;
  md += `\n**Email:** ${customerInfo.email || email}\n`;
  if (customerInfo.created && phone) md += `**Phone:** ${phone}\n`;

  if (customerInfo.address) {
    const a = customerInfo.address;
    md += `**Ship to:** ${a.address1 || ''}, ${a.city || ''}, ${a.province || ''} ${a.zip || ''}, ${a.country || ''}\n`;
  } else if (address) {
    md += `**Ship to:** ${address.address1 || ''}, ${address.city || ''}, ${address.province || ''} ${address.zip || ''}, ${address.country || ''}\n`;
  }

  md += `\n**Items:**\n`;
  for (const r of itemLines) {
    if (discountPct > 0) {
      md += `  ${r.quantity}x ${r.productTitle} - ${r.variantTitle} — ~~${fmtCurrency(r.unitPrice)}~~ → ${fmtCurrency(r.discountedPrice)}\n`;
    } else {
      md += `  ${r.quantity}x ${r.productTitle} - ${r.variantTitle} → ${fmtCurrency(r.unitPrice)}\n`;
    }
  }

  if (discountPct > 0) md += `\n**Discount:** ${discountLabel}\n`;
  md += `**Subtotal:** ${fmtCurrency(subtotal)}\n`;
  md += `**Shipping:** ${isFree ? 'Free' : 'Standard (Shopify-calculated)'}\n`;
  if (note) md += `**Note:** ${note}\n`;

  // Phase 1: preview only
  if (!confirmed) {
    md += `\nCall again with \`confirmed=true\` to create this order.`;
    return { content: [{ type: 'text', text: md }] };
  }

  // Phase 2: create the draft order
  const lineItems = [];
  for (const r of itemLines) {
    const li = {
      variantId: r.variantId,
      quantity: r.quantity,
    };
    if (discountPct > 0) {
      li.appliedDiscount = {
        title: isFree ? 'Free / Samples' : `${discountPct}% discount`,
        value: discountPct,
        valueType: 'PERCENTAGE',
      };
    }
    lineItems.push(li);
  }

  const draftInput = {
    customerId: customerInfo.id,
    lineItems,
    note: note || (isFree ? 'Free order created via CS MCP' : 'Order created via CS MCP'),
    tags: [...(tags || []), 'cs-mcp'],
  };

  if (isFree) {
    draftInput.shippingLine = { title: 'Free Shipping', price: '0.00' };
  }

  // Pass shipping address if available
  const addr = customerInfo.address || address;
  if (addr) {
    const shippingAddr = {
      address1: addr.address1 || '',
      city: addr.city || '',
      province: addr.province || '',
      country: addr.country || 'AU',
      zip: addr.zip || '',
    };
    if (customerInfo.name) {
      const parts = customerInfo.name.split(' ');
      shippingAddr.firstName = parts[0] || '';
      shippingAddr.lastName = parts.slice(1).join(' ') || '';
    }
    draftInput.shippingAddress = shippingAddr;
  }

  const draftOrder = await createDraftOrder(draftInput);
  const numericDraftId = draftOrder.id.split('/').pop();

  if (isFree) {
    // Free order: complete + mark as paid
    const completed = await completeDraftOrder(draftOrder.id);
    const order = completed.order;

    md += `\n---\n**Free Order Created & Completed**\n\n`;
    md += `**Order:** ${order.name} — https://admin.shopify.com/store/${storeUrl}/orders/${order.id.split('/').pop()}\n`;
    md += `**Draft:** ${draftOrder.name} — https://admin.shopify.com/store/${storeUrl}/draft_orders/${numericDraftId}\n`;
    md += `**Status:** Completed (marked as paid)\n`;
  } else {
    // Paid order: send invoice to customer
    await sendDraftOrderInvoice(draftOrder.id);

    md += `\n---\n**Draft Order Created & Invoice Sent**\n\n`;
    md += `**Draft:** ${draftOrder.name} — https://admin.shopify.com/store/${storeUrl}/draft_orders/${numericDraftId}\n`;
    md += `**Total:** $${draftOrder.totalPrice}\n`;
    md += `**Invoice URL:** ${draftOrder.invoiceUrl}\n`;
    md += `**Invoice:** Sent to ${customerInfo.email || email}\n`;
  }

  return { content: [{ type: 'text', text: md }] };
}

const tools = [
  {
    name: 'create_order',
    description: 'Create a new order for any customer (new or existing). Supports paid orders, free orders (samples/gifts), and custom discounts. Two-phase: preview first (confirmed omitted/false), then create (confirmed=true). Free orders: 100% discount + free shipping, completed and marked as paid. Paid orders: draft order created and invoice automatically sent to customer. For new customers, provide email + name + address and the customer is created in Shopify automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Customer email. If customer exists, links to them. If not, creates a new customer.',
        },
        first_name: { type: 'string', description: 'Customer first name (for new customers)' },
        last_name: { type: 'string', description: 'Customer last name (for new customers)' },
        phone: { type: 'string', description: 'Customer phone (for new customers)' },
        address: {
          type: 'object',
          description: 'Shipping address (for new customers)',
          properties: {
            address1: { type: 'string' },
            city: { type: 'string' },
            province: { type: 'string' },
            country: { type: 'string', description: 'Country code e.g. "AU", "US"' },
            zip: { type: 'string' },
          },
        },
        customer_id: {
          type: 'string',
          description: 'Shopify customer ID (use instead of email for existing customers)',
        },
        items: {
          type: 'array',
          description: 'Products to include in the order',
          items: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Product search query (e.g. "AJ Black 10")' },
              variant_id: { type: 'string', description: 'Shopify variant ID (if known)' },
              quantity: { type: 'number', description: 'Quantity (default: 1)' },
            },
          },
        },
        free: {
          type: 'boolean',
          description: 'Set to true for a free order (samples, gifts). 100% discount, free shipping, auto-completed and marked as paid.',
        },
        discount_percent: {
          type: 'number',
          description: 'Custom discount percentage (e.g. 50 for 50% off). Ignored if free=true.',
        },
        note: { type: 'string', description: 'Order note' },
        tags: {
          type: 'array',
          description: 'Additional tags (cs-mcp is always added)',
          items: { type: 'string' },
        },
        confirmed: {
          type: 'boolean',
          description: 'Set to true to create the order. Omit or false for preview.',
        },
      },
      required: ['items'],
    },
    handler: handleCreateOrder,
  },
];

module.exports = tools;
