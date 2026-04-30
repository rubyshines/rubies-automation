/**
 * Invoice order tools: create_invoice_order, send_draft_order_invoice
 *
 * create_invoice_order: Mixed exchange + paid items in a single draft order.
 * Exchange items are $0 (100% discount), paid items are full price.
 * Supports return_credit: a fixed dollar discount applied to the order total
 * for "return items + order new items" scenarios.
 */

const { createDraftOrder, sendDraftOrderInvoice, normalizeGid, getAdminUrl } = require('../shopify');
const { resolveLineItems } = require('../resolveLineItems');
const { resolveCustomerForDraft, getFedExTag, isUSCountry } = require('../orderUtils');
const { formatAddressBlock } = require('../addressUtils');

const tools = [
  {
    name: 'create_invoice_order',
    description: [
      'Create a draft order with a mix of free exchange items ($0) and paid items (full price), then send an invoice.',
      'Use this when a customer needs replacements AND wants to add/pay for additional items.',
      'Also use this for "return + new order" scenarios: set return_credit to deduct the return value from the invoice total.',
      'Two-phase flow: Phase 1 (confirmed omitted or false) creates the draft and returns a preview.',
      'Phase 2 (confirmed=true + draft_order_id) sends the invoice to the customer.',
      'IMPORTANT: Present Phase 1 preview to the user and get explicit confirmation before calling Phase 2.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        customer_id: {
          type: 'string',
          description: 'Shopify customer ID (GID or numeric)',
        },
        exchange_items: {
          type: 'array',
          description: 'Items to include for free (exchange/replacement). Prefer sku over query when known.',
          items: {
            type: 'object',
            properties: {
              variant_id: { type: 'string' },
              sku: { type: 'string', description: 'Exact SKU from the catalog (preferred)' },
              target_size: { type: 'string', description: 'Target size when using sku to find a sibling variant in a different size' },
              query: { type: 'string', description: 'Fuzzy search fallback' },
              quantity: { type: 'number' },
            },
          },
        },
        paid_items: {
          type: 'array',
          description: 'Items to include at full price. Prefer sku over query when known.',
          items: {
            type: 'object',
            properties: {
              variant_id: { type: 'string' },
              sku: { type: 'string', description: 'Exact SKU from the catalog (preferred)' },
              target_size: { type: 'string', description: 'Target size when using sku to find a sibling variant in a different size' },
              query: { type: 'string', description: 'Fuzzy search fallback' },
              quantity: { type: 'number' },
            },
          },
        },
        return_credit: {
          type: 'number',
          description: 'Fixed dollar amount to deduct from the invoice total as a return credit. Use this when the customer is returning items from a previous order and the return value should be applied against the new order. The invoice total becomes (items - return_credit).',
        },
        return_credit_note: {
          type: 'string',
          description: 'Description for the return credit (e.g. "Stella return credit from order #20335"). Shown on the invoice.',
        },
        note: { type: 'string', description: 'Optional note for the draft order' },
        ship_fedex: {
          type: 'boolean',
          description: 'Request FedEx shipping. Adds a FedEx tag to the draft order: "ship fedex ddp" for Canada or DDP-zone destinations (duties prepaid), "ship fedex ddu" for DDU-zone destinations. ONLY applied for orders shipping outside the US — US orders are blocked from any FedEx tag and the request is ignored with a warning.',
        },
        confirmed: {
          type: 'boolean',
          description: 'Set to true to send the invoice for a previously created draft (phase 2). Requires draft_order_id.',
        },
        draft_order_id: {
          type: 'string',
          description: 'Draft order GID from phase 1. Required when confirmed=true.',
        },
      },
      required: ['customer_id'],
    },
    handler: async ({ customer_id, exchange_items, paid_items, return_credit, return_credit_note, note, ship_fedex, confirmed, draft_order_id }) => {
      const customerGid = normalizeGid(customer_id, 'Customer');

      // --- Phase 2: Send invoice for existing draft ---
      if (confirmed && draft_order_id) {
        const draftGid = normalizeGid(draft_order_id, 'DraftOrder');
        const result = await sendDraftOrderInvoice(draftGid);
        const draftAdminUrl = getAdminUrl(draftGid);
        return {
          content: [{
            type: 'text',
            text: [
              '**Invoice Sent**',
              '',
              `**Draft:** ${result.name} — ${draftAdminUrl}`,
              `**Invoice URL:** ${result.invoiceUrl}`,
            ].join('\n'),
          }],
        };
      }

      // --- Phase 1: Create draft + show preview ---
      const allExchange = exchange_items || [];
      const allPaid = paid_items || [];

      if (allExchange.length === 0 && allPaid.length === 0) {
        return { content: [{ type: 'text', text: 'Must provide at least one exchange_item or paid_item.' }] };
      }

      // Resolve items
      const resolvedExchange = allExchange.length > 0 ? await resolveLineItems(allExchange) : [];
      if (resolvedExchange.error) {
        return { content: [{ type: 'text', text: resolvedExchange.error }] };
      }
      const resolvedPaid = allPaid.length > 0 ? await resolveLineItems(allPaid) : [];
      if (resolvedPaid.error) {
        return { content: [{ type: 'text', text: resolvedPaid.error }] };
      }

      // Resolve customer details
      const { customerName, addressBlock, shippingAddress } = await resolveCustomerForDraft(customerGid);

      // Build line items
      const lineItems = [];
      for (const r of resolvedExchange) {
        lineItems.push({
          variantId: r.variantId,
          quantity: r.quantity,
          appliedDiscount: { title: 'Exchange', value: 100, valueType: 'PERCENTAGE' },
        });
      }
      for (const r of resolvedPaid) {
        lineItems.push({ variantId: r.variantId, quantity: r.quantity });
      }

      // FedEx tag — only applied for non-US orders. Canada / DDP zone → ddp tag, DDU zone → ddu tag.
      const fedexRequested = ship_fedex === true;
      const shipCountry = shippingAddress?.country || '';
      const fedexBlockedUS = fedexRequested && isUSCountry(shipCountry);
      const fedexTag = fedexRequested ? await getFedExTag(shipCountry) : null;
      const fedexApplied = !!fedexTag;

      const draftTags = ['invoice', 'cs-mcp'];
      if (fedexApplied) draftTags.push(fedexTag);

      // Build draft input
      const defaultNote = 'Invoice order (exchange + paid items) created via CS MCP server';
      const draftInput = {
        customerId: customerGid,
        lineItems,
        shippingLine: { title: 'Free Shipping', price: '0.00' },
        note: note || defaultNote,
        tags: draftTags,
      };
      if (shippingAddress) {
        draftInput.shippingAddress = shippingAddress;
        draftInput.billingAddress = shippingAddress;
      }

      // Apply return credit as an order-level discount
      if (return_credit && return_credit > 0) {
        draftInput.appliedDiscount = {
          title: return_credit_note || 'Return credit',
          value: return_credit,
          valueType: 'FIXED_AMOUNT',
        };
      }

      const draftOrder = await createDraftOrder(draftInput);
      const draftAdminUrl = getAdminUrl(draftOrder.id);

      // Build preview output
      const lines = [
        '**Invoice Draft Order Created — Awaiting Confirmation**',
        '',
        `**Draft Order:** ${draftOrder.name} — ${draftAdminUrl}`,
        '',
        `**Customer:** ${customerName}`,
        '**Ship to:**',
        addressBlock,
        '',
      ];

      if (resolvedExchange.length > 0) {
        lines.push('**Exchange items (free):**');
        for (const r of resolvedExchange) {
          lines.push(`  ${r.quantity}x ${r.productTitle} - ${r.variantTitle} → $0.00`);
          if (r.inventoryQuantity != null && r.inventoryQuantity < r.quantity) {
            lines.push(`  ⚠️ **INSUFFICIENT STOCK** — only ${r.inventoryQuantity} available (need ${r.quantity})`);
          }
        }
        lines.push('');
      }

      if (resolvedPaid.length > 0) {
        lines.push('**Paid items:**');
        let paidTotal = 0;
        for (const r of resolvedPaid) {
          const lineTotal = parseFloat(r.price || 0) * r.quantity;
          paidTotal += lineTotal;
          lines.push(`  ${r.quantity}x ${r.productTitle} - ${r.variantTitle} → $${parseFloat(r.price || 0).toFixed(2)} each = $${lineTotal.toFixed(2)}`);
          if (r.inventoryQuantity != null && r.inventoryQuantity < r.quantity) {
            lines.push(`  ⚠️ **INSUFFICIENT STOCK** — only ${r.inventoryQuantity} available (need ${r.quantity})`);
          }
        }
        lines.push(`**Paid subtotal:** $${paidTotal.toFixed(2)}`);
        lines.push('');
      }

      if (return_credit && return_credit > 0) {
        lines.push(`**Return credit:** -$${return_credit.toFixed(2)}${return_credit_note ? ` (${return_credit_note})` : ''}`);
      }

      lines.push(`**Shipping:** Free${fedexApplied ? ` (${fedexTag === 'ship fedex ddp' ? 'FedEx DDP' : 'FedEx DDU'} requested)` : ''}`);
      lines.push(`**Total:** $${draftOrder.totalPrice}`);
      if (fedexBlockedUS) {
        lines.push(`⚠️ **FedEx tag skipped:** ship_fedex was requested but order ships to US. Only non-US orders may carry a FedEx tag.`);
      }
      lines.push('');
      lines.push(`Review the draft order above, then call create_invoice_order again with confirmed=true and draft_order_id="${draftOrder.id}" to send the invoice.`);

      return { content: [{ type: 'text', text: lines.join('\n') }] };
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
      const draftGid = normalizeGid(draft_order_id, 'DraftOrder');
      const result = await sendDraftOrderInvoice(draftGid, email);
      const adminUrl = getAdminUrl(draftGid);
      return {
        content: [{
          type: 'text',
          text: [
            '**Invoice Sent**',
            '',
            `**Draft Order:** ${result.name} — ${adminUrl}`,
            `**Invoice URL:** ${result.invoiceUrl}`,
            email ? `**Sent to:** ${email}` : '**Sent to:** customer on file',
          ].join('\n'),
        }],
      };
    },
  },
];

module.exports = tools;
