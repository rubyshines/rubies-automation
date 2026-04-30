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
  getAdminUrl,
} = require('../shopify');
const { resolveLineItems } = require('../resolveLineItems');
const { getFedExTag, isUSCountry } = require('../orderUtils');

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
      address2: address.address2 || '',
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
  items, custom_items, discount_percent, free, donation, note, tags,
  ship_fedex,
  confirmed,
}) {
  const hasItems = items && items.length > 0;
  const hasCustomItems = custom_items && custom_items.length > 0;
  if (!hasItems && !hasCustomItems) {
    return { content: [{ type: 'text', text: 'Must provide at least one item or custom_item.' }] };
  }

  // Resolve catalog items
  const resolved = hasItems ? await resolveLineItems(items) : [];
  if (resolved.error) {
    return { content: [{ type: 'text', text: resolved.error }] };
  }

  // Add custom items (no variant, no inventory)
  if (hasCustomItems) {
    for (const ci of custom_items) {
      resolved.push({
        variantId: null,
        productTitle: ci.title,
        variantTitle: 'Custom',
        sku: null,
        price: ci.price,
        quantity: ci.quantity || 1,
        isCustom: true,
      });
    }
  }

  // Determine discount
  const isFree = free === true;
  const discountPct = isFree ? 100 : (discount_percent || 0);
  const freeLabel = donation ? 'Donation' : 'Free / Samples';
  const discountLabel = isFree ? freeLabel : `${discountPct}% off`;

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
    // Always find or create the customer — the draft order needs a customerId
    customerInfo = await findOrCreateCustomer({ email, first_name, last_name, phone, address });
  } else {
    return { content: [{ type: 'text', text: 'Must provide either email or customer_id.' }] };
  }

  // Determine shipping country and resolve ship_fedex tag (US orders never get the tag)
  const shipCountry =
    customerInfo.address?.countryCodeV2 ||
    customerInfo.address?.country ||
    address?.country ||
    '';
  const fedexRequested = ship_fedex === true;
  const fedexBlockedUS = fedexRequested && isUSCountry(shipCountry);
  const fedexTag = fedexRequested ? await getFedExTag(shipCountry) : null;
  const fedexApplied = !!fedexTag;

  // Build preview markdown
  let md = `**Order Preview**\n\n`;
  md += `**Customer:** ${customerInfo.name}`;
  if (customerInfo.created && !confirmed) md += ` (will be created)`;
  if (customerInfo.created && confirmed) md += ` (newly created)`;
  md += `\n**Email:** ${customerInfo.email || email}\n`;
  if (customerInfo.created && phone) md += `**Phone:** ${phone}\n`;

  if (customerInfo.address) {
    const a = customerInfo.address;
    md += `**Ship to:** ${[a.address1, a.address2, a.city, `${a.province || ''} ${a.zip || ''}`, a.country].filter(Boolean).join(', ')}\n`;
  } else if (address) {
    md += `**Ship to:** ${[address.address1, address.address2, address.city, `${address.province || ''} ${address.zip || ''}`, address.country].filter(Boolean).join(', ')}\n`;
  }

  md += `\n**Items:**\n`;
  for (const r of itemLines) {
    const label = r.isCustom
      ? `${r.quantity}x ${r.productTitle} (custom — no fulfillment)`
      : `${r.quantity}x ${r.productTitle} - ${r.variantTitle}`;
    if (discountPct > 0) {
      md += `  ${label} — ~~${fmtCurrency(r.unitPrice)}~~ → ${fmtCurrency(r.discountedPrice)}\n`;
    } else {
      md += `  ${label} → ${fmtCurrency(r.unitPrice)}\n`;
    }
    if (r.inventoryQuantity != null && r.inventoryQuantity < r.quantity) {
      md += `  ⚠️ **INSUFFICIENT STOCK** — only ${r.inventoryQuantity} available (need ${r.quantity})\n`;
    }
  }

  if (discountPct > 0) md += `\n**Discount:** ${discountLabel}\n`;
  md += `**Subtotal:** ${fmtCurrency(subtotal)}\n`;
  md += `**Shipping:** ${isFree ? 'Free' : 'Standard (Shopify-calculated)'}${fedexApplied ? ` — ${fedexTag === 'ship fedex ddp' ? 'FedEx DDP' : 'FedEx DDU'} requested` : ''}\n`;
  if (fedexBlockedUS) {
    md += `⚠️ **FedEx tag skipped:** ship_fedex was requested but order ships to US. Only non-US orders may carry a FedEx tag.\n`;
  }
  if (note) md += `**Note:** ${note}\n`;

  // Build line items for Shopify draft
  const lineItems = [];
  for (const r of itemLines) {
    let li;
    if (r.isCustom) {
      li = {
        title: r.productTitle,
        originalUnitPrice: r.unitPrice.toFixed(2),
        quantity: r.quantity,
        requiresShipping: false,
      };
    } else {
      li = {
        variantId: r.variantId,
        quantity: r.quantity,
      };
    }
    if (discountPct > 0) {
      li.appliedDiscount = {
        title: isFree ? freeLabel : `${discountPct}% discount`,
        value: discountPct,
        valueType: 'PERCENTAGE',
      };
    }
    lineItems.push(li);
  }

  const draftTags = [...(tags || []), 'cs-mcp'];
  if (fedexApplied) draftTags.push(fedexTag);

  const draftInput = {
    customerId: customerInfo.id,
    lineItems,
    note: note || (isFree ? (donation ? 'Donation order created via CS MCP' : 'Free order created via CS MCP') : 'Order created via CS MCP'),
    tags: draftTags,
  };

  if (isFree) {
    draftInput.shippingLine = { title: 'Free Shipping', price: '0.00' };
  }

  // Pass shipping address if available
  const addr = customerInfo.address || address;
  if (addr) {
    const shippingAddr = {
      address1: addr.address1 || '',
      address2: addr.address2 || '',
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

  // Always create draft in Phase 1 so we get the admin link + Shopify-calculated totals
  const draftOrder = await createDraftOrder(draftInput);

  md += `\n---\n**Draft Order Created — Awaiting Confirmation**\n\n`;
  md += `**Draft:** ${draftOrder.name} — ${getAdminUrl(draftOrder.id)}\n`;
  md += `**Total:** $${draftOrder.totalPrice}\n`;

  if (isFree) {
    md += `\nReview the draft order above, then call create_order_complete with draft_order_id="${draftOrder.id}" to complete it and mark as paid.`;
  } else {
    md += `\nReview the draft order above, then call create_order_complete with draft_order_id="${draftOrder.id}" and send_invoice=true to send the invoice to ${customerInfo.email || email}.`;
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
            address2: { type: 'string', description: 'Apartment, suite, unit, etc.' },
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
          description: 'Products to include in the order (real catalog items). Prefer sku over query when known.',
          items: {
            type: 'object',
            properties: {
              variant_id: { type: 'string', description: 'Shopify variant ID (most precise)' },
              sku: { type: 'string', description: 'Exact SKU from the catalog' },
              target_size: { type: 'string', description: 'Target size when using sku to find a sibling variant in a different size' },
              query: { type: 'string', description: 'Fuzzy search fallback, e.g. "AJ Black 10"' },
              quantity: { type: 'number', description: 'Quantity (default: 1)' },
            },
          },
        },
        custom_items: {
          type: 'array',
          description: 'Custom line items (not from catalog, won\'t reserve inventory or require fulfillment). Use for charge-backs, adjustments, or special cases.',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Line item title (e.g. "3x AJ Underwear — keep charge")' },
              price: { type: 'string', description: 'Unit price (e.g. "25.20")' },
              quantity: { type: 'number', description: 'Quantity (default: 1)' },
            },
            required: ['title', 'price'],
          },
        },
        free: {
          type: 'boolean',
          description: 'Set to true for a free order (samples, gifts, donations). 100% discount, free shipping. Draft is created but NOT completed — must be confirmed via create_order_complete.',
        },
        donation: {
          type: 'boolean',
          description: 'Set to true for donation orders (e.g. community outreach). Changes the discount label from "Free / Samples" to "Donation". Requires free=true.',
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
        ship_fedex: {
          type: 'boolean',
          description: 'Request FedEx shipping. Adds a FedEx tag to the draft order: "ship fedex ddp" for Canada or DDP-zone destinations (duties prepaid), "ship fedex ddu" for DDU-zone destinations. ONLY applied for orders shipping outside the US — US orders are blocked from any FedEx tag and the request is ignored with a warning.',
        },
        confirmed: {
          type: 'boolean',
          description: 'Set to true to create the order. Omit or false for preview.',
        },
      },
      required: [],
    },
    handler: handleCreateOrder,
  },
  {
    name: 'create_order_complete',
    description: 'Complete a previously created draft order. For free orders: marks as paid. For paid orders: sends invoice to customer. IMPORTANT: Always confirm with the user before calling this.',
    inputSchema: {
      type: 'object',
      properties: {
        draft_order_id: {
          type: 'string',
          description: 'Draft order GID from create_order phase 2.',
        },
        send_invoice: {
          type: 'boolean',
          description: 'Set to true to send an invoice instead of completing/marking as paid.',
        },
        email: {
          type: 'string',
          description: 'Email to send invoice to (only needed if send_invoice=true and customer has no email).',
        },
      },
      required: ['draft_order_id'],
    },
    handler: async ({ draft_order_id, send_invoice, email }) => {
      const draftGid = normalizeGid(draft_order_id, 'DraftOrder');

      if (send_invoice) {
        const result = await sendDraftOrderInvoice(draftGid, email);
        return {
          content: [{
            type: 'text',
            text: [
              '**Invoice Sent**',
              '',
              `**Draft:** ${result.name} — ${getAdminUrl(draftGid)}`,
              `**Invoice URL:** ${result.invoiceUrl}`,
            ].join('\n'),
          }],
        };
      }

      // Complete and mark as paid
      const completed = await completeDraftOrder(draftGid);
      const order = completed.order;

      return {
        content: [{
          type: 'text',
          text: [
            '**Order Completed**',
            '',
            `**Order:** ${order.name} — ${getAdminUrl(order.id)}`,
            `**Draft:** ${completed.name} — ${getAdminUrl(draftGid)}`,
            '**Status:** Completed (marked as paid)',
          ].join('\n'),
        }],
      };
    },
  },
];

module.exports = tools;
