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
const { businessDaysSince } = require('../../../shared/businessDays');
const { fetchOrderByNumber, releaseAddressHold, setWarehouseHold, releaseWarehouseHold, updateShippingMethod, resolveShippingMethod, warehanceOrderUrl } = require('../../../reports/lib/warehanceClient');
const { getShippingZone } = require('./shippingLookup');
const { getDraftOrderByName, updateDraftOrderShipping, getAdminUrl } = require('../shopify');
const { getShippingMethodTitle } = require('../orderUtils');

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

// Build synthetic waiting-on-response rows for orders that have unresolved
// operator notes but are no longer in the unfulfilled Shopify set (already
// shipped or fulfilled). Pure so it's testable without Supabase.
// `notes` must be in descending created_at order; deduplicates to latest per
// order FIRST, then applies skip rules to that latest note only — an order
// whose latest note is resolved (or auto-authored) must not resurface on the
// strength of an older unresolved note (latest-note-wins).
// `ordersByNum` maps order_number → { shopify_order_id, customer_email } so the
// synthetic row carries a real Shopify deep link and customer email. The note
// table has neither, so without this the report renders a dead Shopify link
// (empty href) and a "?" email. Orders missing from the map fall back to nulls.
function buildOrphanRows(notes, knownOrderNumbers, ordersByNum = new Map()) {
  const seen = new Set();
  const rows = [];
  for (const n of notes) {
    if (seen.has(n.order_number)) continue;
    seen.add(n.order_number);
    if (knownOrderNumbers.has(Number(n.order_number))) continue;
    if (n.author === 'auto') continue;
    if (n.resolved) continue;
    const order = ordersByNum.get(Number(n.order_number));
    rows.push({
      order: {
        order_number: n.order_number,
        customer_email: order?.customer_email || null,
        created_at: n.created_at,
        order_line_items: [],
      },
      isPreOrder: false,
      note: n,
      classification: { severity: 'normal', reason: 'waiting', detail: null },
      businessDays: businessDaysSince(n.created_at) || 0,
      shopifyUrl: order?.shopify_order_id ? getAdminUrl(String(order.shopify_order_id)) : null,
    });
  }
  return rows;
}

// Fetch orders whose LATEST note is an unresolved operator note and that are
// NOT already in the unfulfilled Shopify set. Returns synthetic result rows
// ready for the waiting_on_response bucket. Must fetch all notes (not just
// unresolved ones) — resolution is recorded as a newer resolved=true row, so
// filtering at the query level would hide the resolving note and resurface
// the stale operator note underneath it.
async function fetchFulfilledOrphanNotes(supabase, knownOrderNumbers) {
  const { fetchLatestNotes } = require('../noteLifecycle');
  const latestByOrder = await fetchLatestNotes(supabase);
  const orphanNums = [...latestByOrder.values()]
    .map(n => Number(n.order_number))
    .filter(num => !knownOrderNumbers.has(num));

  // Enrich with shopify_order_id + customer_email so each orphan row gets a
  // clickable Shopify link and the real email (the note table has neither).
  const ordersByNum = new Map();
  if (orphanNums.length) {
    const { data, error } = await supabase
      .from('orders')
      .select('order_number, shopify_order_id, customer_email')
      .in('order_number', orphanNums);
    if (error) throw new Error(`orders fetch: ${error.message}`);
    for (const o of data || []) ordersByNum.set(Number(o.order_number), o);
  }

  return buildOrphanRows([...latestByOrder.values()], knownOrderNumbers, ordersByNum);
}

async function handleListPendingOrders({ bucket, min_business_days }) {
  const supabase = getSupabaseClient();
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

  // Also surface unresolved operator notes for orders that have already shipped
  // (not in the unfulfilled set). Filtered + deduped per order.
  if (!bucket || bucket === 'waiting_on_response') {
    try {
      const knownNums = new Set(
        (unfulfilledResult?.results || []).map(r => Number(r.order.order_number))
      );
      let orphans = await fetchFulfilledOrphanNotes(supabase, knownNums);
      if (min_business_days != null) {
        orphans = orphans.filter(r => (r.businessDays || 0) >= min_business_days);
      }
      bucketed.waiting_on_response = [...(bucketed.waiting_on_response || []), ...orphans];
    } catch (err) {
      console.warn('[listPendingOrders] orphan notes fetch failed:', err.message);
    }
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

// Update the shippingLine on a Shopify draft order. Used when the order the
// operator wants to retitle hasn't been paid yet — there's no Warehance row
// to update, but the title on the draft drives both the customer-facing
// rate and the eventual carrier mapping when the order is placed.
async function updateDraftShippingSpeed(draftName, speed, reason) {
  const draft = await getDraftOrderByName(draftName);
  if (!draft) {
    return {
      content: [{ type: 'text', text: `Draft order ${draftName} not found in Shopify.` }],
      isError: true,
    };
  }
  if (draft.status === 'COMPLETED') {
    return {
      content: [{
        type: 'text',
        text: `Draft ${draftName} has already been completed (became a real order). Use the order number instead — this tool will route to Warehance.`,
      }],
      isError: true,
    };
  }

  const country = draft.shippingAddress?.countryCodeV2 || draft.shippingAddress?.country || '';
  const newTitle = await getShippingMethodTitle(country, speed);
  const oldTitle = draft.shippingLine?.title || '(none)';

  if (newTitle === oldTitle) {
    return {
      content: [{
        type: 'text',
        text: `Draft ${draftName} is already on **${newTitle}** — no change needed.\n\n${getAdminUrl(draft.id)}`,
      }],
    };
  }

  await updateDraftOrderShipping(draft.id, { title: newTitle, price: '0.00' });

  return {
    content: [{
      type: 'text',
      text: [
        `**Draft shipping updated** — ${draftName}`,
        '',
        `**From:** ${oldTitle}`,
        `**To:** ${newTitle}`,
        `Reason: ${reason}`,
        '',
        getAdminUrl(draft.id),
      ].join('\n'),
    }],
  };
}

async function handleUpdateShippingSpeed({ order_number, speed, reason }) {
  const supabase = getSupabaseClient();

  if (speed !== 'standard' && speed !== 'expedited') {
    return { content: [{ type: 'text', text: `Invalid speed "${speed}". Use "standard" or "expedited".` }], isError: true };
  }

  // Drafts are addressed by name (e.g. "D6720"). Route to Shopify
  // draftOrderUpdate before consulting Warehance — drafts never appear in
  // the warehouse queue until the invoice is paid + the order placed.
  const rawId = String(order_number ?? '').trim();
  if (/^d\d+$/i.test(rawId)) {
    return await updateDraftShippingSpeed(rawId.toUpperCase(), speed, reason);
  }

  let whOrder;
  try {
    whOrder = await fetchOrderByNumber(rawId);
  } catch (err) {
    return { content: [{ type: 'text', text: `Failed to look up order in Warehance: ${err.message}` }], isError: true };
  }

  const whUrl = whOrder ? warehanceOrderUrl(whOrder) : null;

  if (!whOrder) {
    // Numeric input that wasn't in Warehance — try as a draft name (D<num>)
    // before giving up. Covers "the order #6720 hasn't been placed yet" cases.
    // Only forward to the draft path if a draft with that name actually
    // exists; otherwise return the original "not found in Warehance" error
    // so the operator knows the canonical lookup actually ran.
    try {
      const maybeDraft = await getDraftOrderByName(`D${rawId}`);
      if (maybeDraft) {
        return await updateDraftShippingSpeed(`D${rawId}`, speed, reason);
      }
    } catch (_) { /* fall through */ }
    return { content: [{ type: 'text', text: `Order #${order_number} not found in Warehance.` }], isError: true };
  }

  const countryCode = whOrder.ship_to_address?.country_code;

  // Pick the Warehance method to apply — routing rule lives in
  // warehanceClient.pickShippingMethod (matched against the live method list).
  const zone = countryCode === 'US' ? 'us' : await getShippingZone(countryCode);
  let method;
  try {
    method = await resolveShippingMethod({ zone, speed });
  } catch (err) {
    return { content: [{ type: 'text', text: `Failed to load Warehance shipping methods: ${err.message}\n\nWarehance: ${whUrl}` }], isError: true };
  }
  if (!method) {
    return { content: [{ type: 'text', text: `No Warehance shipping method matched zone "${zone}" / ${speed} — update manually in Warehance.\n\nWarehance: ${whUrl}` }], isError: true };
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
      text: `**Shipping speed updated** on order #${order_number}\n\n**New method:** ${method.name}\nReason: ${reason}\n\nWarehance: ${whUrl}`,
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
    description: 'Update the shipping speed on an unfulfilled order or an open Shopify draft order. Pass either a placed order number (e.g. 29444) or a draft order name (e.g. "D6720"). Drafts route to Shopify draftOrderUpdate, retitling the shippingLine; placed orders route to Warehance, which updates the carrier method. US: "expedited" (US Expedited) or "standard" (US Standard). Non-US "expedited" sets the Warehance method to Fedex (or the Expedited International Shipping line on a draft). Non-US "standard" sets Passport DDP (Canada / DDP zone) or Passport DDU (DDU zone), determined from shipping_zones. Only works for orders not yet in progress.',
    inputSchema: {
      type: 'object',
      properties: {
        order_number: {
          oneOf: [
            { type: 'number' },
            { type: 'string' },
          ],
          description: 'Placed order number (e.g. 29444) or draft order name (e.g. "D6720"). Draft names are detected by the leading "D" — pass them as strings.',
        },
        speed: { type: 'string', enum: ['expedited', 'standard'], description: 'Shipping speed: "expedited" (2-3 bus days) or "standard" (2-7 bus days)' },
        reason: { type: 'string', description: 'Why the shipping speed is being changed (e.g., "Customer paid for upgrade", "Compensating for delay", "Customer asked to downgrade pre-payment")' },
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

// Pure helpers exported for testing without Supabase
module.exports = tools;
module.exports._bucketPendingOrders = bucketPendingOrders;
module.exports._buildOrphanRows = buildOrphanRows;
module.exports.fetchFulfilledOrphanNotes = fetchFulfilledOrphanNotes;
// Named export of the warehouse-hold handler so the intake auto-hold
// (processGorgiasTickets.autoExecuteAdvisorHold) and the backstop sweep
// (holdReconcile.reconcilePendingHolds) can call it directly. Both destructure
// `{ handleWarehouseHold }` from this module — without this export it resolved
// to undefined and every automatic hold threw, so holds only ever landed when
// an operator placed them by hand.
module.exports.handleWarehouseHold = handleWarehouseHold;
