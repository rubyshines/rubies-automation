/**
 * MCP Tools: Passport Claims + Shipping Delay Management
 *
 * Tools:
 *   passport_claims — list open/lost claims for follow-up
 *   passport_claim_update — update claim status (delivered/lost/resolved)
 *   passport_claim_note — add a note to a claim
 *   shipping_delay_resolve — resolve/note a shipping delay
 *   shipping_delay_list — list current shipping delays
 */

const { getSupabaseClient } = require('../../../shared/supabaseClient');

// ---------------------------------------------------------------------------
// passport_claims — list claims
// ---------------------------------------------------------------------------

async function handlePassportClaims({ status }) {
  const supabase = getSupabaseClient();
  const filterStatus = status || 'open';

  let query = supabase
    .from('passport_claims')
    .select('*')
    .order('created_at', { ascending: false });

  if (filterStatus !== 'all') {
    query = query.eq('status', filterStatus);
  }

  const { data: claims, error } = await query;
  if (error) return { content: [{ type: 'text', text: `Error: ${error.message}` }] };

  if (!claims || claims.length === 0) {
    return { content: [{ type: 'text', text: `No ${filterStatus === 'all' ? '' : filterStatus + ' '}Passport claims found.` }] };
  }

  const lines = [`## Passport Claims (${filterStatus})\n`];
  for (const c of claims) {
    const daysSince = Math.round((Date.now() - new Date(c.created_at).getTime()) / 86400000);
    const costs = [];
    if (c.shipping_fee_usd) costs.push(`shipping: $${c.shipping_fee_usd}`);
    if (c.ddp_total_usd) costs.push(`duties: $${c.ddp_total_usd}`);

    lines.push(`**#${c.order_number}** — ${c.destination || c.country_code || '?'}`);
    lines.push(`  Status: **${c.status}** | Reason: ${c.claim_reason || '?'} | Filed: ${c.created_at?.split('T')[0]} (${daysSince}d ago)`);
    lines.push(`  Tracking: ${c.tracking_number || '?'} | Customer: ${c.customer_email || '?'}`);
    if (costs.length) lines.push(`  Costs: ${costs.join(', ')}`);
    if (c.resolution) lines.push(`  Resolution: ${c.resolution} (${c.resolution_date?.split('T')[0]})`);
    lines.push('');
  }

  lines.push(`Total: ${claims.length} claims`);

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

// ---------------------------------------------------------------------------
// passport_claim_update — change claim status
// ---------------------------------------------------------------------------

async function handlePassportClaimUpdate({ order_number, status, note }) {
  const supabase = getSupabaseClient();

  if (!order_number || !status) {
    return { content: [{ type: 'text', text: 'Required: order_number and status (delivered, lost, or resolved)' }] };
  }

  const validStatuses = ['delivered', 'lost', 'resolved', 'open'];
  if (!validStatuses.includes(status)) {
    return { content: [{ type: 'text', text: `Invalid status. Use: ${validStatuses.join(', ')}` }] };
  }

  const update = {
    status,
    resolution: note || null,
    resolution_date: status !== 'open' ? new Date().toISOString() : null,
  };

  const { error } = await supabase
    .from('passport_claims')
    .update(update)
    .eq('order_number', order_number);

  if (error) return { content: [{ type: 'text', text: `Error: ${error.message}` }] };

  return { content: [{ type: 'text', text: `Claim #${order_number} updated to **${status}**${note ? ': ' + note : ''}` }] };
}

// ---------------------------------------------------------------------------
// passport_claim_note — add note without changing status
// ---------------------------------------------------------------------------

async function handlePassportClaimNote({ order_number, note }) {
  const supabase = getSupabaseClient();

  if (!order_number || !note) {
    return { content: [{ type: 'text', text: 'Required: order_number and note' }] };
  }

  // Append to resolution field (or set it)
  const { data: claim } = await supabase
    .from('passport_claims')
    .select('resolution')
    .eq('order_number', order_number)
    .maybeSingle();

  if (!claim) {
    return { content: [{ type: 'text', text: `No claim found for order #${order_number}` }] };
  }

  const today = new Date().toISOString().split('T')[0];
  const existing = claim.resolution || '';
  const updated = existing
    ? `${existing}\n[${today}] ${note}`
    : `[${today}] ${note}`;

  await supabase
    .from('passport_claims')
    .update({ resolution: updated })
    .eq('order_number', order_number);

  return { content: [{ type: 'text', text: `Note added to claim #${order_number}: "${note}"` }] };
}

// ---------------------------------------------------------------------------
// shipping_delay_resolve — resolve/note shipping delays
// ---------------------------------------------------------------------------

async function handleShippingDelayResolve({ order_number, action, note }) {
  const supabase = getSupabaseClient();

  if (!order_number || !action || !note) {
    return { content: [{ type: 'text', text: 'Required: order_number, action (resolve/unresolve/note), and note' }] };
  }

  const resolved = action === 'resolve';

  await supabase.from('shipping_delay_notes').insert({
    order_number,
    note,
    resolved,
    author: 'operator',
  });

  const verb = action === 'resolve' ? 'Resolved' : action === 'unresolve' ? 'Unresolved' : 'Note added to';
  return { content: [{ type: 'text', text: `${verb} #${order_number}: "${note}"` }] };
}

// ---------------------------------------------------------------------------
// shipping_delay_list — list current delays
// ---------------------------------------------------------------------------

async function handleShippingDelayList({ show_resolved }) {
  // Import and run the check (reuse the existing logic)
  const { checkShippingDelays } = require('../../alerts/dailyShippingAlerts');
  const result = await checkShippingDelays({ showResolved: show_resolved || false });

  if (result.alerts.length === 0 && (result.resolvedCount || 0) === 0) {
    return { content: [{ type: 'text', text: 'No shipping delays detected.' }] };
  }

  const lines = [`## Shipping Delays\n`, result.summary, ''];

  for (const a of result.alerts) {
    const sev = a.severity === 'high' ? 'URGENT' : 'delayed';
    lines.push(`**#${a.order_number}** ${a.destination} — ${a.carrier} — ${a.business_days}bd [${sev}]`);
    for (const i of a.issues) lines.push(`  - ${i}`);
    if (a.last_event) lines.push(`  Last: ${a.last_event}`);
    if (a.note) lines.push(`  Note: ${a.note.note} (${a.note.created_at?.split('T')[0]})`);
    lines.push('');
  }

  if (result.resolved?.length) {
    lines.push('### Resolved');
    for (const a of result.resolved) {
      lines.push(`**#${a.order_number}** ${a.destination} — ${a.note?.note || 'resolved'}`);
    }
  }

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = [
  {
    name: 'passport_claims',
    description: 'List Passport shipping claims (packages lost or stuck). Use to check on open claims, follow up, or review claim history.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          description: 'Filter by status: "open" (default), "lost", "delivered", "resolved", or "all"',
        },
      },
    },
    handler: handlePassportClaims,
  },
  {
    name: 'passport_claim_update',
    description: 'Update a Passport claim status. Use "delivered" if package eventually arrived, "lost" if confirmed lost (need reimbursement), "resolved" if reimbursement received or written off.',
    inputSchema: {
      type: 'object',
      properties: {
        order_number: { type: 'number', description: 'Order number' },
        status: { type: 'string', description: '"delivered", "lost", or "resolved"' },
        note: { type: 'string', description: 'Resolution note (e.g. "Customer confirmed received" or "Passport refunded $15.20")' },
      },
      required: ['order_number', 'status'],
    },
    handler: handlePassportClaimUpdate,
  },
  {
    name: 'passport_claim_note',
    description: 'Add a note to a Passport claim without changing its status. Use for tracking communication with Passport.',
    inputSchema: {
      type: 'object',
      properties: {
        order_number: { type: 'number', description: 'Order number' },
        note: { type: 'string', description: 'Note text' },
      },
      required: ['order_number', 'note'],
    },
    handler: handlePassportClaimNote,
  },
  {
    name: 'shipping_delay_resolve',
    description: 'Resolve, unresolve, or add a note to a shipping delay alert. Resolved delays are hidden from the daily alert email.',
    inputSchema: {
      type: 'object',
      properties: {
        order_number: { type: 'number', description: 'Order number' },
        action: { type: 'string', description: '"resolve", "unresolve", or "note"' },
        note: { type: 'string', description: 'Note explaining the action' },
      },
      required: ['order_number', 'action', 'note'],
    },
    handler: handleShippingDelayResolve,
  },
  {
    name: 'shipping_delay_list',
    description: 'List current shipping delays and alerts. Shows overdue, stale, exception, and returned orders.',
    inputSchema: {
      type: 'object',
      properties: {
        show_resolved: { type: 'boolean', description: 'Include resolved delays (default: false)' },
      },
    },
    handler: handleShippingDelayList,
  },
];
