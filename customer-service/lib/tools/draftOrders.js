/**
 * Draft Order MCP Tools — list and manage existing Shopify draft orders
 *
 * Tools: list_draft_orders, delete_draft_order
 */

const { listDraftOrders, deleteDraftOrder, normalizeGid } = require('../shopify');

// ---------------------------------------------------------------------------
// Tool: list_draft_orders
// ---------------------------------------------------------------------------

async function handleListDraftOrders({ status, limit }) {
  const maxResults = Math.min(limit || 20, 50);
  const drafts = await listDraftOrders({ status, limit: maxResults });

  if (!drafts.length) {
    const filter = status ? ` with status "${status}"` : '';
    return { content: [{ type: 'text', text: `No draft orders found${filter}.` }] };
  }

  let md = `## Draft Orders (${drafts.length})\n\n`;
  md += '| Draft | Status | Customer | Total | Items | Created | Updated |\n';
  md += '|-------|--------|----------|-------|-------|---------|--------|\n';

  for (const d of drafts) {
    const name = d.name || '—';
    const draftStatus = d.status || '—';
    const customer = d.customer
      ? `${d.customer.firstName || ''} ${d.customer.lastName || ''} (${d.customer.email || '—'})`.trim()
      : '—';
    const total = `$${Number(d.totalPrice || 0).toFixed(2)} ${d.presentmentCurrencyCode || ''}`;
    const items = d.lineItems.length;
    const created = (d.createdAt || '').split('T')[0];
    const updated = (d.updatedAt || '').split('T')[0];

    md += `| ${name} | ${draftStatus} | ${customer} | ${total} | ${items} | ${created} | ${updated} |\n`;
  }

  md += '\n### Draft Details\n\n';
  for (const d of drafts) {
    const numericId = d.id.split('/').pop();
    const storeUrl = process.env.SHOPIFY_STORE_URL;
    const adminUrl = storeUrl ? `https://${storeUrl}/admin/draft_orders/${numericId}` : '';

    md += `**${d.name}** (${d.status})${adminUrl ? ` — [Admin](${adminUrl})` : ''}\n`;
    if (d.note2) md += `Note: ${d.note2}\n`;
    if (d.tags && d.tags.length) md += `Tags: ${d.tags.join(', ')}\n`;
    for (const li of d.lineItems) {
      md += `- ${li.quantity}x ${li.title}${li.variant?.title ? ` — ${li.variant.title}` : ''} @ $${Number(li.originalUnitPrice || 0).toFixed(2)}\n`;
    }
    if (d.invoiceUrl) md += `Invoice: ${d.invoiceUrl}\n`;
    md += '\n';
  }

  return { content: [{ type: 'text', text: md }] };
}

// ---------------------------------------------------------------------------
// Tool: delete_draft_order
// ---------------------------------------------------------------------------

async function handleDeleteDraftOrder({ draft_order_id, confirmed }) {
  if (!confirmed) {
    return {
      content: [{
        type: 'text',
        text: `⚠️ This will permanently delete draft order ${draft_order_id}. Call again with confirmed=true to proceed.`,
      }],
    };
  }

  const deletedId = await deleteDraftOrder(draft_order_id);
  return {
    content: [{
      type: 'text',
      text: `Draft order deleted: ${deletedId}`,
    }],
  };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

const tools = [
  {
    name: 'list_draft_orders',
    description: 'List existing Shopify draft orders. Filter by status (open, invoice_sent, completed). Shows customer, items, totals, and admin links.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          description: 'Filter by status: open, invoice_sent, completed (default: all)',
        },
        limit: {
          type: 'number',
          description: 'Max draft orders to return (default 20, max 50)',
        },
      },
      required: [],
    },
    handler: handleListDraftOrders,
  },
  {
    name: 'delete_draft_order',
    description: 'Delete a Shopify draft order. Requires confirmation. Use list_draft_orders first to find the draft order ID.',
    inputSchema: {
      type: 'object',
      properties: {
        draft_order_id: {
          type: 'string',
          description: 'Draft order GID or numeric ID',
        },
        confirmed: {
          type: 'boolean',
          description: 'Must be true to confirm deletion',
        },
      },
      required: ['draft_order_id'],
    },
    handler: handleDeleteDraftOrder,
  },
];

module.exports = tools;
