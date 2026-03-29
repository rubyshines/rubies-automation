/**
 * MCP tools for managing unfulfilled order notes and resolved status.
 *
 * Tools:
 *   - add_order_note: Add a note to an unfulfilled order
 *   - resolve_order: Mark an order as resolved (hides from report)
 *   - unresolve_order: Re-open a previously resolved order
 *   - get_order_notes: View all notes for an order
 */

const { getSupabaseClient } = require('../../../shared/supabaseClient');
const { fetchOrderByNumber, releaseAddressHold } = require('../../../reports/lib/warehanceClient');

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleAddNote({ order_number, note, author }) {
  const supabase = getSupabaseClient();
  const { error } = await supabase
    .from('unfulfilled_order_notes')
    .insert({
      order_number,
      note,
      resolved: false,
      author: author || 'operator',
    });

  if (error) {
    return { content: [{ type: 'text', text: `Failed to save note: ${error.message}` }], isError: true };
  }

  return {
    content: [{
      type: 'text',
      text: `Note added to order #${order_number}:\n> ${note}\n\nThis order will appear in the "Waiting on Response" section of the next unfulfilled orders report.`,
    }],
  };
}

async function handleResolve({ order_number, reason, author }) {
  const supabase = getSupabaseClient();
  const { error } = await supabase
    .from('unfulfilled_order_notes')
    .insert({
      order_number,
      note: reason,
      resolved: true,
      author: author || 'operator',
    });

  if (error) {
    return { content: [{ type: 'text', text: `Failed to resolve: ${error.message}` }], isError: true };
  }

  return {
    content: [{
      type: 'text',
      text: `Order #${order_number} marked as **resolved**:\n> ${reason}\n\nThis order will be hidden from the main report and shown in the "Resolved" section.`,
    }],
  };
}

async function handleUnresolve({ order_number, reason, author }) {
  const supabase = getSupabaseClient();
  const { error } = await supabase
    .from('unfulfilled_order_notes')
    .insert({
      order_number,
      note: reason,
      resolved: false,
      author: author || 'operator',
    });

  if (error) {
    return { content: [{ type: 'text', text: `Failed to unresolve: ${error.message}` }], isError: true };
  }

  return {
    content: [{
      type: 'text',
      text: `Order #${order_number} **re-opened**:\n> ${reason}\n\nThis order will reappear in the main unfulfilled orders report.`,
    }],
  };
}

async function handleGetNotes({ order_number }) {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('unfulfilled_order_notes')
    .select('*')
    .eq('order_number', order_number)
    .order('created_at', { ascending: false });

  if (error) {
    return { content: [{ type: 'text', text: `Failed to fetch notes: ${error.message}` }], isError: true };
  }

  if (!data || !data.length) {
    return { content: [{ type: 'text', text: `No notes found for order #${order_number}.` }] };
  }

  const latest = data[0];
  const status = latest.resolved ? 'RESOLVED' : 'ACTIVE';

  let md = `## Notes for Order #${order_number}\n\n`;
  md += `**Current status:** ${status}\n\n`;
  md += `| Date | Note | Author | Resolved |\n|---|---|---|---|\n`;
  for (const n of data) {
    const date = n.created_at?.split('T')[0] || '?';
    md += `| ${date} | ${n.note} | ${n.author} | ${n.resolved ? 'Yes' : 'No'} |\n`;
  }

  return { content: [{ type: 'text', text: md }] };
}

async function handleReleaseAddressHold({ order_number, reason }) {
  const supabase = getSupabaseClient();

  // Look up the Warehance order
  let whOrder;
  try {
    whOrder = await fetchOrderByNumber(String(order_number));
  } catch (err) {
    return { content: [{ type: 'text', text: `Failed to look up order in Warehance: ${err.message}` }], isError: true };
  }

  if (!whOrder) {
    return { content: [{ type: 'text', text: `Order #${order_number} not found in Warehance.` }], isError: true };
  }

  if (!whOrder.address_hold) {
    return { content: [{ type: 'text', text: `Order #${order_number} does not have an address hold in Warehance.` }] };
  }

  // Release the hold
  try {
    await releaseAddressHold(whOrder.id);
  } catch (err) {
    return { content: [{ type: 'text', text: `Failed to release hold: ${err.message}` }], isError: true };
  }

  // Log a note
  await supabase.from('unfulfilled_order_notes').insert({
    order_number,
    note: `Address hold released: ${reason}`,
    resolved: true,
    author: 'operator',
  });

  const whUrl = `https://staging.warehance.com/orders/${whOrder.id}?orderId=${whOrder.id}`;

  return {
    content: [{
      type: 'text',
      text: `**Address hold released** on order #${order_number}\n\nReason: ${reason}\n\nWarehance: ${whUrl}\n\nThe order should now proceed to fulfillment.`,
    }],
  };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const tools = [
  {
    name: 'add_order_note',
    description: 'Add a note to an unfulfilled order (e.g., "waiting for customer response"). Orders with active notes appear in the "Waiting on Response" section of the unfulfilled orders report.',
    inputSchema: {
      type: 'object',
      properties: {
        order_number: { type: 'number', description: 'Order number (e.g., 29377)' },
        note: { type: 'string', description: 'The note text (e.g., "On hold - waiting for customer to confirm size")' },
        author: { type: 'string', description: 'Who is adding the note (default: "operator")' },
      },
      required: ['order_number', 'note'],
    },
    handler: handleAddNote,
  },
  {
    name: 'resolve_order',
    description: 'Mark an unfulfilled order as resolved. Resolved orders are hidden from the main report and shown in a separate "Resolved" section. Use when an issue has been handled and the order no longer needs attention.',
    inputSchema: {
      type: 'object',
      properties: {
        order_number: { type: 'number', description: 'Order number (e.g., 29444)' },
        reason: { type: 'string', description: 'Why this order is being resolved (e.g., "Pre-order items, customer informed")' },
        author: { type: 'string', description: 'Who is resolving (default: "operator")' },
      },
      required: ['order_number', 'reason'],
    },
    handler: handleResolve,
  },
  {
    name: 'unresolve_order',
    description: 'Re-open a previously resolved order so it appears in the main unfulfilled orders report again.',
    inputSchema: {
      type: 'object',
      properties: {
        order_number: { type: 'number', description: 'Order number to re-open' },
        reason: { type: 'string', description: 'Why this order is being re-opened' },
        author: { type: 'string', description: 'Who is re-opening (default: "operator")' },
      },
      required: ['order_number', 'reason'],
    },
    handler: handleUnresolve,
  },
  {
    name: 'get_order_notes',
    description: 'View all notes and resolution history for an unfulfilled order.',
    inputSchema: {
      type: 'object',
      properties: {
        order_number: { type: 'number', description: 'Order number to look up' },
      },
      required: ['order_number'],
    },
    handler: handleGetNotes,
  },
  {
    name: 'release_address_hold',
    description: 'Release an address hold on an order in Warehance. Use when you\'ve verified the address is valid (e.g., customer confirmed, previous order shipped there, or Street View shows a real residence).',
    inputSchema: {
      type: 'object',
      properties: {
        order_number: { type: 'number', description: 'Order number (e.g., 29444)' },
        reason: { type: 'string', description: 'Why the hold is being released (e.g., "Address confirmed by customer")' },
      },
      required: ['order_number', 'reason'],
    },
    handler: handleReleaseAddressHold,
  },
];

module.exports = tools;
