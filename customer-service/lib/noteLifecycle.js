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
 * waiting-on-customer states) are never auto-resolved while the order is still
 * live; the report ages them instead. The one exception is a CANCELLED order:
 * it's terminal, so any note about it (operator or auto) is auto-resolved.
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

// Warehouse/address hold notes ("Warehouse hold placed: ..."). Written
// author='operator' even when the hold is auto-placed, so the auto-only shipped
// rule misses them. A hold note is moot the moment the order ships — shipping
// requires the hold to have been released — so it's resolved regardless of
// author once the order is FULFILLED.
const HOLD_NOTE_RE = /hold placed/i;

// Shipping-method update notes ("Shipping updated to <method>: <reason>",
// written by update_shipping_speed — see tools/orderNotes.js). Same shape of
// fact as a hold note: it records a mechanical change we made to the order, not
// a decision we still owe someone, so it's moot the moment the order ships.
// Anchored to the writer's exact prefix precisely so a free-form operator note
// ("Expedited after split — watching for reply") can never match it; the notes
// safe to auto-resolve are the machine-written ones with a known format.
const SHIPPING_UPDATE_NOTE_RE = /^shipping updated to /i;

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
 * closed. Resolves an open outreach note for that order — but only when NO
 * other ticket for the order is still active (e.g. a superseded draft gets
 * deleted while the live outreach conversation is still awaiting the
 * customer; the note must survive until that one closes too).
 */
async function resolveOnTicketClose({ supabase = getSupabaseClient(), orderNumber, csTicketId } = {}) {
  const orderNum = cleanOrderNumber(orderNumber);
  if (!orderNum) return { resolved: false };

  const latest = (await fetchLatestNotes(supabase, [orderNum])).get(orderNum);
  if (!latest || latest.resolved || !isOutreachNote(latest)) return { resolved: false };

  // cs_tickets.order_number is text and appears both with and without a
  // leading '#' depending on which pipeline wrote the row — match both.
  const { data: tickets, error: tErr } = await supabase
    .from('cs_tickets')
    .select('id, status')
    .in('order_number', [String(orderNum), `#${orderNum}`]);
  if (tErr) throw new Error(`cs_tickets fetch: ${tErr.message}`);
  if ((tickets || []).some(t => t.status !== 'closed')) return { resolved: false };

  await insertNote(
    supabase,
    orderNum,
    `Conversation closed${csTicketId ? ` (ticket #${csTicketId})` : ''} — auto-resolved`,
    { resolved: true, author: 'auto' },
  );
  return { resolved: true };
}

/**
 * Look up a single Warehance order, returning null on any failure (the caller
 * treats "unknown" conservatively as still-held). The client is required lazily
 * so unit tests that never reach the hold-release branch don't load it, and so
 * tests can inject a stub via reconcileNotes({ fetchWhOrder }).
 */
async function getWhOrder(fetchWhOrder, orderNumber) {
  const fn = fetchWhOrder || require('../../reports/lib/warehanceClient').fetchOrderByNumber;
  try {
    return await fn(orderNumber);
  } catch {
    return null;
  }
}

/**
 * Daily sweep. For every order whose latest note is unresolved:
 *   R1a — order cancelled (terminal) → resolve, regardless of note author.
 *   R1b — auto-author note + order shipped → resolve.
 *   R1c — hold note + EITHER order shipped, OR the warehouse hold is released in
 *         Warehance AND all linked CS tickets are closed → resolve, any author.
 *         A "hold placed" note is moot once the hold is gone and the conversation
 *         that motivated it has ended. Warehance exposes no hold history, so we
 *         read current state (has_hold); a not-yet-placed hold can't false-positive
 *         because that order's ticket would still be open. A still-active hold keeps
 *         the note visible — the order genuinely won't ship.
 *   R1d — shipping-method update note + order shipped → resolve, any author, no
 *         ticket required. Records a mechanical change we made, so shipping
 *         closes the question; these are routinely written with no ticket at all,
 *         which put them beyond R3's reach entirely.
 *   R2  — outreach note + the order has ≥1 CS ticket and ALL are closed → resolve.
 *         "The order's tickets" means the order-number join, falling back to the
 *         ticket id the note itself names — see ticketsForNote().
 *   R3  — any-author note + order shipped + the order has ≥1 CS ticket and ALL are
 *         closed → resolve. Catches free-form operator notes R2 misses (their text
 *         doesn't match the outreach regex) once the order has shipped and no
 *         conversation remains open. The ≥1-closed-ticket guard keeps a shipped
 *         order whose operator note has no/open ticket aging visibly.
 * Operator judgment notes on still-live orders fall through all rules and stay open.
 *
 * @returns {Promise<{checked: number, resolved: Array<{order_number, rule, reason}>}>}
 */
async function reconcileNotes({ supabase = getSupabaseClient(), fetchWhOrder } = {}) {
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

  // cs_tickets.order_number is text and appears both with and without a
  // leading '#' depending on which pipeline wrote the row — match both.
  const { data: tickets, error: tErr } = await supabase
    .from('cs_tickets')
    .select('id, order_number, status')
    .in('order_number', orderNumbers.flatMap(n => [String(n), `#${n}`]));
  if (tErr) throw new Error(`cs_tickets fetch: ${tErr.message}`);
  const ticketsByOrder = new Map();
  for (const t of tickets || []) {
    const k = Number(String(t.order_number).replace(/^#/, ''));
    if (!ticketsByOrder.has(k)) ticketsByOrder.set(k, []);
    ticketsByOrder.get(k).push(t);
  }

  // Fallback link for notes whose conversation lives on a DIFFERENT order than
  // the note. markOutreachSent records the id it was given (`Outreach sent
  // (ticket #2883)`, from draft.ticket_id — always a cs_tickets id), but the
  // join above re-derives the link by order number and so misses the case where
  // outreach about one order was placed on the customer's existing conversation
  // filed under another. That happens on exchanges: the note lands on the child
  // exchange order while the ticket stays on the parent, and the note is then
  // unreachable by EVERY rule below, since R2 and R3 both need this join. It
  // stays stranded in "Waiting on Response" forever, reading "awaiting customer
  // reply" long after the conversation closed.
  const notedTicketIds = [...new Set(
    open.map(n => Number((n.note || '').match(/ticket #(\d+)/i)?.[1])).filter(Boolean),
  )];
  const ticketById = new Map();
  if (notedTicketIds.length) {
    const { data: noted, error: nErr } = await supabase
      .from('cs_tickets')
      .select('id, order_number, status')
      .in('id', notedTicketIds);
    if (nErr) throw new Error(`cs_tickets by id fetch: ${nErr.message}`);
    for (const t of noted || []) ticketById.set(t.id, t);
  }
  /** Tickets for a note: the order-number join, else the ticket the note names. */
  function ticketsForNote(note) {
    const byOrder = ticketsByOrder.get(note.order_number) || [];
    if (byOrder.length) return byOrder;
    const id = Number((note.note || '').match(/ticket #(\d+)/i)?.[1]);
    const t = id ? ticketById.get(id) : null;
    return t ? [t] : [];
  }

  const resolved = [];
  for (const note of open) {
    const order = orderByNum.get(note.order_number);
    const orderCancelled = !!(order && order.cancelled_at);
    const orderShipped = !!(order && order.fulfillment_status === 'FULFILLED');
    const orderTickets = ticketsForNote(note);
    const allTicketsClosed = orderTickets.length > 0 && orderTickets.every(t => t.status === 'closed');

    let rule = null;
    let reason = null;

    if (orderCancelled) {
      // A cancelled order is terminal — it's out of the fulfillment pipeline,
      // so ANY lingering note about it (operator or auto) is moot. Resolve it
      // regardless of author. This is the deliberate exception to the
      // "never auto-resolve operator judgment notes" rule: the report is about
      // orders that still need fulfillment attention, and a cancelled order
      // needs none. (Shipped orders keep the auto-only gate below — an operator
      // note on a shipped order may still track a real follow-up.)
      rule = 'order_cancelled';
      reason = 'Order cancelled — note auto-resolved (reconciler)';
    } else if (note.author === 'auto' && orderShipped) {
      rule = 'order_done';
      reason = 'Order shipped — outreach no longer pending (reconciler)';
    } else if (HOLD_NOTE_RE.test(note.note || '')) {
      // A "hold placed" note (written author='operator' even when auto-placed,
      // so the auto-only rules above miss it) is moot once the hold is gone.
      // Genuine operator follow-up notes (e.g. a Passport reship decision) don't
      // match HOLD_NOTE_RE, so they still age visibly.
      if (orderShipped) {
        // Shipping required the hold to be released — definitively moot.
        rule = 'hold_cleared';
        reason = 'Order shipped — warehouse hold released; hold note moot (reconciler)';
      } else if (allTicketsClosed) {
        // Conversation settled. The hold is only truly cleared if Warehance
        // confirms it's released — a still-active hold means the order won't
        // ship, so keep the note visible. (Unknown/unreachable → treat as held.)
        const whOrder = await getWhOrder(fetchWhOrder, note.order_number);
        const holdActive = whOrder ? !!whOrder.has_hold : true;
        if (!holdActive) {
          rule = 'hold_cleared';
          reason = 'Warehouse hold released and conversation closed — hold note moot (reconciler)';
        }
      }
    } else if (SHIPPING_UPDATE_NOTE_RE.test(note.note || '') && orderShipped) {
      // Sibling of the hold rule above, and deliberately NOT gated on tickets:
      // an expedite either happened or it didn't, and once the order has shipped
      // that question is closed no matter what the conversation is doing. R3
      // below can't cover this — it needs >=1 closed ticket as evidence the
      // conversation ended, and these notes are routinely written with no ticket
      // at all (an operator expediting an order nobody wrote in about), which
      // left them stuck in "Waiting on Response" forever with no exit.
      rule = 'shipping_update_applied';
      reason = 'Order shipped — shipping-method update applied; note moot (reconciler)';
    } else if (isOutreachNote(note)) {
      if (allTicketsClosed) {
        rule = 'tickets_closed';
        reason = 'Linked conversation closed — note auto-resolved (reconciler)';
      }
    } else if (orderShipped && allTicketsClosed) {
      // R3 — operator judgment note, order shipped, AND every linked ticket
      // closed. The shipped-order author='auto' gate (R1b) deliberately keeps
      // operator notes alive because one may track a real follow-up — but once
      // the order has shipped and no conversation remains open, there's no
      // follow-up surface and the note is moot. The allTicketsClosed guard
      // (needs ≥1 linked ticket) means a shipped order with an operator note but
      // no/open ticket still ages visibly. Catches free-form operator notes R2
      // misses because their text doesn't match the outreach regex (e.g. a
      // pre-order-split + expedite note).
      rule = 'order_done_tickets_closed';
      reason = 'Order shipped and linked conversation closed — note auto-resolved (reconciler)';
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
