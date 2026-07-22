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
 * available. Cancellation drafts get the same protective freeze — the cancel
 * only executes when the operator confirms, and until then nothing stops the
 * warehouse from shipping the order — but for those the hold is a SIDE action:
 * it lands in actions[] without touching action_executed_at (which tracks the
 * cancel itself). It runs on a short interval from the always-on webhook server
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

/**
 * Whether a draft's timeline already shows hold activity (a placed hold OR a
 * deliberate release). Pure — unit tested. Used to stop the sweep from
 * re-placing a hold on cancellation drafts, where action_executed_at can't
 * serve as the done-marker (it tracks the cancel, not the hold), and to
 * respect an operator's explicit release (a released hold means a human made
 * a call — the sweep must not override it).
 */
function hasHoldActivity(actions) {
  return (Array.isArray(actions) ? actions : []).some(
    (a) => a?.action_type === 'warehouse_hold' || a?.action_type === 'release_warehouse_hold',
  );
}

/**
 * The order number a draft's hold must land on. Pure — unit tested.
 *
 * Prefers the advisor's explicit action target (structured_output.
 * action_order_number) over the draft's order_number column: order_number is
 * filled from the loaded order context, which is the WRONG order when an
 * operator steer redirected the action elsewhere (ticket 2700: the sweep held
 * the loaded #31533 — already shipped — instead of the steered #31485).
 */
function holdTargetOrderNumber(draft) {
  const target = draft?.structured_output?.action_order_number || draft?.order_number;
  return parseInt(String(target || '').replace(/^#/, ''), 10) || null;
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

  // warehouse_hold drafts: the hold IS the staged action. cancellation drafts:
  // the hold is protective — action_executed_at null means the cancel hasn't
  // been executed yet, which is exactly the window the hold must cover.
  const { data: drafts, error } = await supabase
    .from('cs_ai_drafts')
    .select('id, ticket_id, order_number, structured_output, actions, audit_trail, status, action_type')
    .in('action_type', ['warehouse_hold', 'cancellation'])
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
    // Hold already placed (intake or a prior sweep) or deliberately released
    // by an operator — either way, no work to do. This is the done-marker for
    // cancellation drafts, whose action_executed_at tracks the cancel itself.
    if (hasHoldActivity(d.actions)) continue;

    // Only act on the ticket's current active draft, and only if still open.
    const { data: t } = await supabase
      .from('cs_tickets')
      .select('status, active_draft_id')
      .eq('id', d.ticket_id)
      .single();
    if (!t || t.status === 'closed') continue;
    if (t.active_draft_id && t.active_draft_id !== d.id) continue;

    const orderNumber = holdTargetOrderNumber(d);
    if (!orderNumber) continue;

    let result;
    try {
      result = await handleWarehouseHold({
        order_number: orderNumber,
        reason: d.action_type === 'cancellation'
          ? 'Auto-hold (backstop): customer asked to cancel, holding before we cancel'
          : 'Auto-hold (backstop): customer wants to modify the order',
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
      // Atomic append — read-modify-write here raced the dashboard operator
      // path and could silently drop the other writer's entry.
      const { appendDraftAction } = require('./draftActions');
      const ap = await appendDraftAction(supabase, d.id, action);
      if (ap.error) console.error(`[hold-reconcile] actions append failed for draft ${d.id}: ${ap.error}`);
      // Cancellation drafts: the hold is protective; action_executed_at tracks
      // the cancel and stays null until the operator executes it. The appended
      // hold action is what stops the next sweep from re-placing (hasHoldActivity).
      if (d.action_type !== 'cancellation') {
        await supabase
          .from('cs_ai_drafts')
          .update({ action_executed_at: action.executed_at })
          .eq('id', d.id);
      }
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

module.exports = { reconcilePendingHolds, classifyHoldResult, hasHoldActivity, holdTargetOrderNumber, GAVEUP_MARKER };
