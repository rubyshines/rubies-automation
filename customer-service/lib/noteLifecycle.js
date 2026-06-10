/**
 * Order-alert note lifecycle — keeps order_alert_notes in sync with what
 * actually happened, so daily-report rows move between buckets without
 * manual `resolve_order` bookkeeping.
 *
 * Three entry points:
 *   markOutreachSent()      — event hook: an outreach draft for an order was
 *                             sent from the dashboard. Supersedes the staged
 *                             "drafted — pending review" note with an
 *                             "outreach sent — awaiting reply" note, moving
 *                             the order from "Drafted in CS Advisor (auto)"
 *                             to "Waiting on Response".
 *   resolveOnTicketClose()  — event hook: a ticket linked to an order closed.
 *                             Resolves an open outreach-related note (the
 *                             conversation ending IS the resolution).
 *   reconcileNotes()        — daily sweep (cron, before the report renders).
 *                             Safety net for everything the hooks miss:
 *                             auto notes on shipped/cancelled orders, and
 *                             outreach notes whose tickets are all closed.
 *
 * Scope guard: only OUTREACH-RELATED notes are ever touched automatically —
 * `author='auto'` notes, or operator notes written when staging/sending an
 * outreach draft. Operator judgment notes (Passport reship decisions,
 * waiting-on-customer states) are never auto-resolved; the report ages them
 * instead.
 *
 * All writes are append-only inserts (latest-note-wins governs bucketing),
 * so every function is idempotent: a re-run sees the superseding/resolved
 * note as the latest and no-ops.
 */

const { getSupabaseClient } = require('../../shared/supabaseClient');

// Notes written by outreach staging/sending machinery. Matches:
//  - the unnotified pre-order auto-drafter ("[auto-draft] ...")
//  - create_outreach_ticket staging notes ("... outreach drafted ... pending operator review")
//  - the send-hook's own superseding notes ("Outreach sent ...")
const OUTREACH_NOTE_RE = /\[auto-draft\]|outreach drafted|outreach sent|pending operator review/i;

function isOutreachNote(note) {
  if (!note) return false;
  if (note.author === 'auto') return true;
  return OUTREACH_NOTE_RE.test(note.note || '');
}

function cleanOrderNumber(orderNumber) {
  const n = Number(String(orderNumber).replace(/^#/, ''));
  return Number.isNaN(n) ? null : n;
}

/** Latest note per order, for the given order numbers (or all orders if omitted). */
async function fetchLatestNotes(supabase, orderNumbers = null) {
  const latest = new Map();
  for (let from = 0; ; from += 1000) {
    let q = supabase
      .from('order_alert_notes')
      .select('order_number, note, author, resolved, created_at')
      .order('created_at', { ascending: false })
      .range(from, from + 999);
    if (orderNumbers) q = q.in('order_number', orderNumbers);
    const { data, error } = await q;
    if (error) throw new Error(`order_alert_notes fetch: ${error.message}`);
    for (const n of data) {
      if (!latest.has(n.order_number)) latest.set(n.order_number, n);
    }
    if (data.length < 1000) break;
  }
  return latest;
}

async function insertNote(supabase, orderNumber, note, { resolved, author }) {
  const { error } = await supabase.from('order_alert_notes').insert({
    order_number: orderNumber,
    note,
    resolved,
    author,
    alert_type: 'unfulfilled',
  });
  if (error) throw new Error(`order_alert_notes insert: ${error.message}`);
}

/**
 * Event hook for the dashboard send path. Call after a draft tied to an
 * order is successfully sent. No-ops unless the order's latest note is an
 * unresolved outreach note.
 */
async function markOutreachSent({ supabase = getSupabaseClient(), orderNumber, csTicketId } = {}) {
  const orderNum = cleanOrderNumber(orderNumber);
  if (!orderNum) return { superseded: false };

  const latest = (await fetchLatestNotes(supabase, [orderNum])).get(orderNum);
  if (!latest || latest.resolved || !isOutreachNote(latest)) return { superseded: false };
  // Already superseded by a prior send — don't stack duplicates.
  if (/^Outreach sent/i.test(latest.note || '')) return { superseded: false };

  await insertNote(
    supabase,
    orderNum,
    `Outreach sent${csTicketId ? ` (ticket #${csTicketId})` : ''} — awaiting customer reply`,
    { resolved: false, author: 'operator' },
  );
  return { superseded: true };
}

/**
 * Event hook for ticket close. Call when a ticket linked to an order is
 * closed. Resolves an open outreach note for that order.
 */
async function resolveOnTicketClose({ supabase = getSupabaseClient(), orderNumber, csTicketId } = {}) {
  const orderNum = cleanOrderNumber(orderNumber);
  if (!orderNum) return { resolved: false };

  const latest = (await fetchLatestNotes(supabase, [orderNum])).get(orderNum);
  if (!latest || latest.resolved || !isOutreachNote(latest)) return { resolved: false };

  await insertNote(
    supabase,
    orderNum,
    `Conversation closed${csTicketId ? ` (ticket #${csTicketId})` : ''} — auto-resolved`,
    { resolved: true, author: 'auto' },
  );
  return { resolved: true };
}

/**
 * Daily sweep. For every order whose latest note is unresolved:
 *   R1 — auto-author note + order shipped or cancelled → resolve.
 *   R2 — outreach note + the order has ≥1 CS ticket and ALL are closed → resolve.
 * Operator judgment notes fall through both rules and stay open.
 *
 * @returns {Promise<{checked: number, resolved: Array<{order_number, rule, reason}>}>}
 */
async function reconcileNotes({ supabase = getSupabaseClient() } = {}) {
  const latestByOrder = await fetchLatestNotes(supabase);
  const open = [...latestByOrder.values()].filter(n => !n.resolved);
  if (!open.length) return { checked: 0, resolved: [] };

  const orderNumbers = open.map(n => n.order_number);

  const { data: orders, error: oErr } = await supabase
    .from('orders')
    .select('order_number, fulfillment_status, cancelled_at')
    .in('order_number', orderNumbers);
  if (oErr) throw new Error(`orders fetch: ${oErr.message}`);
  const orderByNum = new Map((orders || []).map(o => [o.order_number, o]));

  // cs_tickets.order_number is text.
  const { data: tickets, error: tErr } = await supabase
    .from('cs_tickets')
    .select('id, order_number, status')
    .in('order_number', orderNumbers.map(String));
  if (tErr) throw new Error(`cs_tickets fetch: ${tErr.message}`);
  const ticketsByOrder = new Map();
  for (const t of tickets || []) {
    const k = Number(t.order_number);
    if (!ticketsByOrder.has(k)) ticketsByOrder.set(k, []);
    ticketsByOrder.get(k).push(t);
  }

  const resolved = [];
  for (const note of open) {
    const order = orderByNum.get(note.order_number);
    const orderDone = order && (order.cancelled_at || order.fulfillment_status === 'FULFILLED');

    let rule = null;
    let reason = null;

    if (note.author === 'auto' && orderDone) {
      rule = 'order_done';
      reason = order.cancelled_at
        ? 'Order cancelled — note auto-resolved (reconciler)'
        : 'Order shipped — outreach no longer pending (reconciler)';
    } else if (isOutreachNote(note)) {
      const orderTickets = ticketsByOrder.get(note.order_number) || [];
      if (orderTickets.length > 0 && orderTickets.every(t => t.status === 'closed')) {
        rule = 'tickets_closed';
        reason = 'Linked conversation closed — note auto-resolved (reconciler)';
      }
    }

    if (!rule) continue;
    await insertNote(supabase, note.order_number, reason, { resolved: true, author: 'auto' });
    resolved.push({ order_number: note.order_number, rule, reason });
  }

  return { checked: open.length, resolved };
}

module.exports = {
  isOutreachNote,
  fetchLatestNotes,
  markOutreachSent,
  resolveOnTicketClose,
  reconcileNotes,
};
