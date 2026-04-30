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
const { fetchOrderByNumber, releaseAddressHold, setWarehouseHold, releaseWarehouseHold, updateShippingMethod, warehanceOrderUrl } = require('../../../reports/lib/warehanceClient');

// Warehance shipping method IDs (from /shipping-methods endpoint).
// Refreshed 2026-04-30 — earlier IDs (231185182253 / 231185182258) were stale.
const US_SHIPPING_METHODS = {
  standard: { id: 231185182340, name: 'US Standard Shipping' },
  expedited: { id: 231185182342, name: 'US Expedited Shipping' },
};

// Non-US expedited routes through Fedex regardless of zone (Incoterms is set
// manually in the Warehance UI for now — operator handles DDP/DDU there).
const FEDEX_METHOD = { id: 231185182476, name: 'Fedex' };

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// list_pending_orders — pure bucket+filter helper, tested independently
// ---------------------------------------------------------------------------

const BUCKET_LABELS = {
  urgent: 'Urgent',
  attention: 'Attention',
  waiting_on_response: 'Waiting on Response',
  normal: 'Normal',
  pre_orders: 'Pre-Orders',
  auto_resolved: 'Auto-Resolved',
};

/**
 * Pure function: takes the result of checkUnfulfilledOrders() and returns
 * a bucketed view that mirrors the daily order report. Filters by bucket
 * name and/or minimum business days. Same precedence rule as the report —
 * an unresolved operator note pulls a pre-order out of Pre-Orders into the
 * actionable flow.
 */
function bucketPendingOrders(unfulfilledResult, { bucket, minBusinessDays } = {}) {
  const u = unfulfilledResult?.results || [];
  const preOrders = u.filter(r => r.isPreOrder && !r.note);
  const ufActionable = u.filter(r => (!r.isPreOrder || r.note) && !r.note?.resolved);
  const ufWaiting = ufActionable.filter(r => r.note && !r.note.resolved && r.note.author !== 'auto');
  const ufNoNote = ufActionable.filter(r => !r.note || r.note.resolved || r.note.author === 'auto');
  const ufAutoResolved = ufNoNote.filter(r => r.classification.severity === 'auto_resolved');
  const ufRest = ufNoNote.filter(r => r.classification.severity !== 'auto_resolved');

  const buckets = {
    urgent: ufRest.filter(r => r.classification.severity === 'urgent'),
    attention: ufRest.filter(r => r.classification.severity === 'attention'),
    waiting_on_response: ufWaiting,
    normal: ufRest.filter(r => r.classification.severity === 'normal'),
    pre_orders: preOrders,
    auto_resolved: ufAutoResolved,
  };

  if (bucket) {
    if (!Object.prototype.hasOwnProperty.call(buckets, bucket)) {
      throw new Error(`Unknown bucket "${bucket}". Valid: ${Object.keys(buckets).join(', ')}`);
    }
    const filtered = {};
    filtered[bucket] = buckets[bucket];
    return applyMinBusinessDays(filtered, minBusinessDays);
  }
  return applyMinBusinessDays(buckets, minBusinessDays);
}

function applyMinBusinessDays(buckets, minBusinessDays) {
  if (minBusinessDays == null) return buckets;
  const out = {};
  for (const [name, rows] of Object.entries(buckets)) {
    out[name] = rows.filter(r => (r.businessDays || 0) >= minBusinessDays);
  }
  return out;
}

async function handleListPendingOrders({ bucket, min_business_days }) {
  const { checkUnfulfilledOrders } = require('../../../reports/lib/unfulfilled');
  let unfulfilledResult;
  try {
    unfulfilledResult = await checkUnfulfilledOrders();
  } catch (err) {
    return { content: [{ type: 'text', text: `Failed to fetch pending orders: ${err.message}` }], isError: true };
  }

  let bucketed;
  try {
    bucketed = bucketPendingOrders(unfulfilledResult, { bucket, minBusinessDays: min_business_days });
  } catch (err) {
    return { content: [{ type: 'text', text: err.message }], isError: true };
  }

  let md = `## Pending Orders\n\n`;
  let total = 0;
  for (const [name, rows] of Object.entries(bucketed)) {
    if (!rows.length) continue;
    md += `### ${BUCKET_LABELS[name]} (${rows.length})\n\n`;
    md += '| Order # | Date | Customer | Biz Days | Note / Reason |\n|---|---|---|---|---|\n';
    for (const r of rows) {
      const date = r.order.created_at?.split('T')[0] || '-';
      const email = r.order.customer_email || '-';
      const bd = r.businessDays ?? 0;
      const noteOrReason = r.note ? r.note.note : (r.classification?.detail || r.classification?.reason || '-');
      md += `| ${r.order.order_number} | ${date} | ${email} | ${bd} | ${String(noteOrReason).replace(/\|/g, '\\|').slice(0, 80)} |\n`;
      total++;
    }
    md += '\n';
  }
  if (!total) md += '_No matching pending orders._\n';

  return { content: [{ type: 'text', text: md }] };
}

async function handleAddNote({ order_number, note, author }) {
  const supabase = getSupabaseClient();
  const { error } = await supabase
    .from('order_alert_notes')
    .insert({
      order_number,
      note,
      resolved: false,
      author: author || 'operator',
      alert_type: 'unfulfilled',
    });

  if (error) {
    return { content: [{ type: 'text', text: `Failed to save note: ${error.message}` }], isError: true };
  }

  return {
    content: [{
      type: 'text',
      text: `Note added to order #${order_number}:\n> ${note}\n\nThis order will appear in the "Waiting on Response" section of the daily order alerts.`,
    }],
  };
}

async function handleResolve({ order_number, reason, author }) {
  const supabase = getSupabaseClient();
  const { error } = await supabase
    .from('order_alert_notes')
    .insert({
      order_number,
      note: reason,
      resolved: true,
      author: author || 'operator',
      alert_type: 'unfulfilled',
    });

  if (error) {
    return { content: [{ type: 'text', text: `Failed to resolve: ${error.message}` }], isError: true };
  }

  return {
    content: [{
      type: 'text',
      text: `Order #${order_number} marked as **resolved**:\n> ${reason}\n\nThis order will be hidden from the main alerts and shown in the "Resolved" section.`,
    }],
  };
}

async function handleUnresolve({ order_number, reason, author }) {
  const supabase = getSupabaseClient();
  const { error } = await supabase
    .from('order_alert_notes')
    .insert({
      order_number,
      note: reason,
      resolved: false,
      author: author || 'operator',
      alert_type: 'unfulfilled',
    });

  if (error) {
    return { content: [{ type: 'text', text: `Failed to unresolve: ${error.message}` }], isError: true };
  }

  return {
    content: [{
      type: 'text',
      text: `Order #${order_number} **re-opened**:\n> ${reason}\n\nThis order will reappear in the daily order alerts.`,
    }],
  };
}

async function handleGetNotes({ order_number }) {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('order_alert_notes')
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
  await supabase.from('order_alert_notes').insert({
    order_number,
    note: `Address hold released: ${reason}`,
    resolved: true,
    author: 'operator',
    alert_type: 'unfulfilled',
  });

  const whUrl = `https://staging.warehance.com/orders/${whOrder.id}?orderId=${whOrder.id}`;

  return {
    content: [{
      type: 'text',
      text: `**Address hold released** on order #${order_number}\n\nReason: ${reason}\n\nWarehance: ${whUrl}\n\nThe order should now proceed to fulfillment.`,
    }],
  };
}

async function handleWarehouseHold({ order_number, reason }) {
  const supabase = getSupabaseClient();

  let whOrder;
  try {
    whOrder = await fetchOrderByNumber(String(order_number));
  } catch (err) {
    return { content: [{ type: 'text', text: `Failed to look up order in Warehance: ${err.message}` }], isError: true };
  }

  const whUrl = whOrder ? warehanceOrderUrl(whOrder) : null;

  if (!whOrder) {
    return { content: [{ type: 'text', text: `Order #${order_number} not found in Warehance.` }], isError: true };
  }

  if (whOrder.fulfillment_status === 'in_progress') {
    return {
      content: [{
        type: 'text',
        text: `**Cannot place warehouse hold** — order #${order_number} is already **in progress** (being picked/packed by the 3PL). Contact the warehouse directly to intervene.\n\nWarehance: ${whUrl}`,
      }],
      isError: true,
    };
  }

  if (whOrder.warehouse_hold) {
    return {
      content: [{
        type: 'text',
        text: `Order #${order_number} already has a **warehouse hold**.\n\nWarehance: ${whUrl}`,
      }],
    };
  }

  try {
    await setWarehouseHold(whOrder.id);
  } catch (err) {
    return { content: [{ type: 'text', text: `Failed to set warehouse hold: ${err.message}\n\nWarehance: ${whUrl}` }], isError: true };
  }

  await supabase.from('order_alert_notes').insert({
    order_number,
    note: `Warehouse hold placed: ${reason}`,
    resolved: false,
    author: 'operator',
    alert_type: 'unfulfilled',
  });

  return {
    content: [{
      type: 'text',
      text: `**Warehouse hold placed** on order #${order_number}\n\nReason: ${reason}\n\nWarehance: ${whUrl}\n\nThe order is now on hold and will not be shipped until the hold is released.`,
    }],
  };
}

async function handleReleaseWarehouseHold({ order_number, reason }) {
  const supabase = getSupabaseClient();

  let whOrder;
  try {
    whOrder = await fetchOrderByNumber(String(order_number));
  } catch (err) {
    return { content: [{ type: 'text', text: `Failed to look up order in Warehance: ${err.message}` }], isError: true };
  }

  const whUrl = whOrder ? warehanceOrderUrl(whOrder) : null;

  if (!whOrder) {
    return { content: [{ type: 'text', text: `Order #${order_number} not found in Warehance.` }], isError: true };
  }

  if (!whOrder.warehouse_hold) {
    return {
      content: [{
        type: 'text',
        text: `Order #${order_number} does not have a warehouse hold.\n\nWarehance: ${whUrl}`,
      }],
    };
  }

  try {
    await releaseWarehouseHold(whOrder.id);
  } catch (err) {
    return { content: [{ type: 'text', text: `Failed to release warehouse hold: ${err.message}\n\nWarehance: ${whUrl}` }], isError: true };
  }

  await supabase.from('order_alert_notes').insert({
    order_number,
    note: `Warehouse hold released: ${reason}`,
    resolved: true,
    author: 'operator',
    alert_type: 'unfulfilled',
  });

  return {
    content: [{
      type: 'text',
      text: `**Warehouse hold released** on order #${order_number}\n\nReason: ${reason}\n\nWarehance: ${whUrl}\n\nThe order should now proceed to fulfillment.`,
    }],
  };
}

async function handleUpdateShippingSpeed({ order_number, speed, reason }) {
  const supabase = getSupabaseClient();

  if (speed !== 'standard' && speed !== 'expedited') {
    return { content: [{ type: 'text', text: `Invalid speed "${speed}". Use "standard" or "expedited".` }], isError: true };
  }

  let whOrder;
  try {
    whOrder = await fetchOrderByNumber(String(order_number));
  } catch (err) {
    return { content: [{ type: 'text', text: `Failed to look up order in Warehance: ${err.message}` }], isError: true };
  }

  const whUrl = whOrder ? warehanceOrderUrl(whOrder) : null;

  if (!whOrder) {
    return { content: [{ type: 'text', text: `Order #${order_number} not found in Warehance.` }], isError: true };
  }

  const countryCode = whOrder.ship_to_address?.country_code;

  // Pick the Warehance method to apply:
  //   US: standard ↔ expedited (US Standard / US Expedited)
  //   Non-US expedited: Fedex (Incoterms is set manually in the Warehance UI for now)
  //   Non-US standard: skip — Passport DDP vs DDU is configured per-order in
  //     Warehance, return a link instead of guessing.
  let method;
  let extraNote = '';
  if (countryCode === 'US') {
    method = US_SHIPPING_METHODS[speed];
  } else if (speed === 'expedited') {
    method = FEDEX_METHOD;
    extraNote = `\n\n⚠️ Verify Incoterms (DDP / DDU) on this order in Warehance — that field isn't set programmatically.`;
  } else {
    return {
      content: [{
        type: 'text',
        text: [
          `**Non-US standard shipping must be updated in Warehance directly.**`,
          ``,
          `Order #${order_number} ships to ${countryCode || 'unknown'}. Standard non-US routing splits between Passport DDP and Passport DDU per-zone — configure in the Warehance UI.`,
          ``,
          `Open the order: ${whUrl}`,
        ].join('\n'),
      }],
    };
  }

  if (whOrder.fulfillment_status === 'in_progress') {
    return {
      content: [{
        type: 'text',
        text: `**Cannot update shipping speed** — order #${order_number} is already **in progress** (being picked/packed). Contact the warehouse directly.\n\nWarehance: ${whUrl}`,
      }],
      isError: true,
    };
  }

  try {
    await updateShippingMethod(whOrder.id, method.id);
  } catch (err) {
    return { content: [{ type: 'text', text: `Failed to update shipping method: ${err.message}\n\nWarehance: ${whUrl}` }], isError: true };
  }

  await supabase.from('order_alert_notes').insert({
    order_number,
    note: `Shipping updated to ${method.name}: ${reason}`,
    resolved: false,
    author: 'operator',
    alert_type: 'unfulfilled',
  });

  return {
    content: [{
      type: 'text',
      text: `**Shipping speed updated** on order #${order_number}\n\n**New method:** ${method.name}\nReason: ${reason}\n\nWarehance: ${whUrl}${extraNote}`,
    }],
  };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const tools = [
  {
    name: 'add_order_note',
    description: 'Add a note to an unfulfilled order (e.g., "waiting for customer response"). Orders with active notes appear in the "Waiting on Response" section of the daily order alerts.',
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
    description: 'Mark an unfulfilled order as resolved. Resolved orders are hidden from the main daily order alerts and shown in a separate "Resolved" section. Use when an issue has been handled and the order no longer needs attention.',
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
    description: 'Re-open a previously resolved order so it appears in the daily order alerts again.',
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
    description: 'View all notes and resolution history for an order.',
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
  {
    name: 'warehouse_hold',
    description: 'Place a warehouse hold on an unfulfilled order in Warehance to prevent shipment while resolving a customer issue. Cannot be used if the order is already in_progress (being picked/packed). Always shows a link to the order in Warehance.',
    inputSchema: {
      type: 'object',
      properties: {
        order_number: { type: 'number', description: 'Order number (e.g., 29444)' },
        reason: { type: 'string', description: 'Why the hold is being placed (e.g., "Customer requested address change", "Exchange in progress")' },
      },
      required: ['order_number', 'reason'],
    },
    handler: handleWarehouseHold,
  },
  {
    name: 'release_warehouse_hold',
    description: 'Release a warehouse hold on an order in Warehance, allowing it to proceed to fulfillment. Use after a customer issue has been resolved.',
    inputSchema: {
      type: 'object',
      properties: {
        order_number: { type: 'number', description: 'Order number (e.g., 29444)' },
        reason: { type: 'string', description: 'Why the hold is being released (e.g., "Address updated, ready to ship", "Exchange resolved")' },
      },
      required: ['order_number', 'reason'],
    },
    handler: handleReleaseWarehouseHold,
  },
  {
    name: 'update_shipping_speed',
    description: 'Update the shipping speed on an unfulfilled order in Warehance. US: "expedited" (US Expedited 2-3 bus days) or "standard" (US Standard 2-7 bus days). Non-US "expedited" sets the Warehance method to Fedex; the operator must still set Incoterms (DDP / DDU) manually in the Warehance UI. Non-US "standard" returns a Warehance link (Passport DDP vs DDU split is configured per-order in the UI). Only works for orders that are not yet in progress.',
    inputSchema: {
      type: 'object',
      properties: {
        order_number: { type: 'number', description: 'Order number (e.g., 29444)' },
        speed: { type: 'string', enum: ['expedited', 'standard'], description: 'Shipping speed: "expedited" (2-3 bus days) or "standard" (2-7 bus days)' },
        reason: { type: 'string', description: 'Why the shipping speed is being changed (e.g., "Customer paid for upgrade", "Compensating for delay")' },
      },
      required: ['order_number', 'speed', 'reason'],
    },
    handler: handleUpdateShippingSpeed,
  },
  {
    name: 'list_pending_orders',
    description: 'List unfulfilled orders flagged on the daily order alert report, grouped by bucket: urgent, attention, waiting_on_response (orders with an unresolved operator note — e.g. incident outreach awaiting customer reply, address verification, in-flight exchanges), normal, pre_orders, auto_resolved. Use this for: "what\'s pending?", "what needs resolution?", "what am I waiting on?", "what\'s in the queue today?", "anything urgent?", "show me orders awaiting customer reply", "list outreaches awaiting a response", "what did I flag for follow-up?". Note text on each row explains why each order is flagged. Use bucket=waiting_on_response to narrow to operator-flagged orders only. This is the canonical tool for unfulfilled-order queue state — distinct from shipping_delay_list (shipping/Passport claim queue) and check_follow_ups (auto-followup pipeline cadence).',
    inputSchema: {
      type: 'object',
      properties: {
        bucket: {
          type: 'string',
          enum: ['urgent', 'attention', 'waiting_on_response', 'normal', 'pre_orders', 'auto_resolved'],
          description: 'Narrow to a single bucket. Use "waiting_on_response" to filter to orders the operator has explicitly flagged with an unresolved note. Omit to see all buckets.',
        },
        min_business_days: {
          type: 'number',
          description: 'Only include orders aged at least this many business days. E.g. 5 = orders 5+ business days old.',
        },
      },
    },
    handler: handleListPendingOrders,
  },
];

// Pure helper exported for testing the bucket+filter logic without Supabase
module.exports = tools;
module.exports._bucketPendingOrders = bucketPendingOrders;
