/**
 * Warehouse-hold backstop sweep.
 *
 * The synchronous auto-hold at intake (autoExecuteAdvisorHold in
 * processGorgiasTickets.js) fails when the order isn't queryable in Warehance
 * at the instant intake runs — the customer often starts a chat to edit/cancel
 * within minutes of ordering, before Warehance has ingested the order. A single
 * best-effort attempt that fails silently is the wrong design: the draft says
 * "I've put a hold on the order" while no hold exists.
 *
 * This sweep finds drafts where the advisor proposed a warehouse hold that was
 * never executed, on still-open tickets, and places the hold once the order is
 * available. It runs on a short interval from the always-on webhook server
 * (see webhooks/server.js). Idempotent and cheap: one DB query plus one
 * Warehance call per outstanding candidate (normally zero).
 */
const { getSupabaseClient } = require('../../shared/supabaseClient');

const LOOKBACK_DAYS = 3;
// Marker written to a draft's audit_trail when the hold is genuinely
// impossible (order already in fulfillment / shipped / cancelled). Stops the
// sweep from retrying it every tick. We deliberately do NOT set
// action_executed_at in that case — the past-tense "I've put a hold" draft is
// now wrong and must stay blocked from sending so the operator intervenes.
const GAVEUP_MARKER = 'HOLD_BACKSTOP_GAVEUP';

/**
 * Classify a handleWarehouseHold() result into a reconcile outcome. Pure —
 * unit tested in test/holdReconcile.test.js.
 *   'placed'     → hold is in place (newly placed OR already held)
 *   'pending'    → order not yet visible in Warehance, or a transient error; retry next sweep
 *   'impossible' → order is in fulfillment / shipped / cancelled; cannot be held
 */
function classifyHoldResult(result) {
  const text = (result?.content?.[0]?.text || '').toLowerCase();
  // Non-error covers both "hold placed" and the "already has a warehouse hold" branch.
  if (!result?.isError) return 'placed';
  if (text.includes('not found')) return 'pending';
  if (
    text.includes('in progress') ||
    text.includes('fulfil') ||
    text.includes('shipped') ||
    text.includes('cancel')
  ) {
    return 'impossible';
  }
  // Unknown error (transient API/network) — retry rather than give up.
  return 'pending';
}

async function reconcilePendingHolds({ now = new Date() } = {}) {
  const supabase = getSupabaseClient();
  const since = new Date(now.getTime() - LOOKBACK_DAYS * 86400000).toISOString();

  // Kill switch: the sweep is the backstop for the same warehouse_hold
  // auto-action governed by the dashboard. If it's disabled, don't place holds.
  const { isAutoactionEnabled } = require('./autoactionGate');
  if (!(await isAutoactionEnabled('warehouse_hold'))) {
    return { checked: 0, placed: 0, impossible: 0, pending: 0, disabled: true };
  }

  const { data: drafts, error } = await supabase
    .from('cs_ai_drafts')
    .select('id, ticket_id, order_number, actions, audit_trail, status')
    .eq('action_type', 'warehouse_hold')
    .is('action_executed_at', null)
    .gte('created_at', since);
  if (error) {
    console.error(`[hold-reconcile] candidate query error: ${error.message}`);
    return { checked: 0, placed: 0, impossible: 0, pending: 0 };
  }

  const { handleWarehouseHold } = require('./tools/orderNotes');
  let placed = 0;
  let impossible = 0;
  let pending = 0;

  for (const d of drafts || []) {
    if (d.status === 'superseded' || d.status === 'deleted') continue;
    // Already gave up on this one (order unholdable) — don't keep hammering it.
    if ((d.audit_trail || []).some((a) => String(a).includes(GAVEUP_MARKER))) continue;

    // Only act on the ticket's current active draft, and only if still open.
    const { data: t } = await supabase
      .from('cs_tickets')
      .select('status, active_draft_id')
      .eq('id', d.ticket_id)
      .single();
    if (!t || t.status === 'closed') continue;
    if (t.active_draft_id && t.active_draft_id !== d.id) continue;

    const orderNumber = parseInt(String(d.order_number || '').replace(/^#/, ''), 10);
    if (!orderNumber) continue;

    let result;
    try {
      result = await handleWarehouseHold({
        order_number: orderNumber,
        reason: 'Auto-hold (backstop): customer wants to modify the order',
      });
    } catch (e) {
      console.error(`[hold-reconcile] #${orderNumber} threw: ${e.message}`);
      pending++;
      continue;
    }

    const outcome = classifyHoldResult(result);
    const text = result?.content?.[0]?.text || '';

    if (outcome === 'placed') {
      const { SOURCE } = require('./autoactionGate');
      const action = {
        executed_at: new Date().toISOString(),
        action_type: 'warehouse_hold',
        summary: text,
        links: [],
        source: SOURCE.HOLD_SWEEP,
      };
      await supabase
        .from('cs_ai_drafts')
        .update({
          actions: [...(Array.isArray(d.actions) ? d.actions : []), action],
          action_executed_at: action.executed_at,
        })
        .eq('id', d.id);
      placed++;
      console.log(`[hold-reconcile] placed hold on #${orderNumber} (draft ${d.id})`);
    } else if (outcome === 'impossible') {
      const note = `${GAVEUP_MARKER}: could not place hold on #${orderNumber} — ${text.replace(/\s+/g, ' ').trim().slice(0, 200)}`;
      await supabase
        .from('cs_ai_drafts')
        .update({
          audit_trail: [...(Array.isArray(d.audit_trail) ? d.audit_trail : []), note],
        })
        .eq('id', d.id);
      impossible++;
      console.warn(`[hold-reconcile] ${note}`);
    } else {
      pending++; // order not in Warehance yet (or transient) — retry next sweep
    }
  }

  if (placed || impossible) {
    console.log(
      `[hold-reconcile] swept ${drafts?.length || 0}: placed=${placed} impossible=${impossible} pending=${pending}`,
    );
  }
  return { checked: drafts?.length || 0, placed, impossible, pending };
}

module.exports = { reconcilePendingHolds, classifyHoldResult, GAVEUP_MARKER };
