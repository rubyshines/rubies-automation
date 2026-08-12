/**
 * Gorgias ↔ CS Advisor drift-detection core — the single implementation of
 * the reconciliation primitives that were triplicated (and diverging) across
 * hourlyDriftCheck.js, gorgiasAdvisorResync.js, and gorgiasAdvisorSyncReport.js.
 *
 * Owns:
 *   - the Gorgias view IDs (open + unassigned, deduped, spam dropped)
 *   - the batched cs_tickets lookup by gorgias_ticket_id
 *   - the "Advisor open but not in Gorgias views" query
 *   - the canonical message-count filters (internal notes excluded)
 *   - the canonical status-compatibility map (isStatusInSync)
 */

// Gorgias view IDs (built-in default views)
const VIEW_ALL_OPEN = 28532;    // eq(ticket.status, "open") — excludes snoozed
const VIEW_UNASSIGNED = 28531;  // open + no assignee

/**
 * Fetch all non-closed tickets from the Gorgias views, merged + deduped by
 * ticket id, spam dropped.
 */
async function fetchOpenGorgiasTickets(gorgias) {
  const open = await gorgias.getViewItems(VIEW_ALL_OPEN);
  const unassigned = await gorgias.getViewItems(VIEW_UNASSIGNED);
  const map = new Map();
  for (const t of [...open, ...unassigned]) {
    if (!t.spam) map.set(t.id, t);
  }
  return [...map.values()];
}

/**
 * Batched cs_tickets lookup for a set of Gorgias ticket ids (PostgREST .in
 * URLs blow up past a few hundred ids — batch at 200).
 * Returns { rows, byGorgiasId }.
 */
async function fetchAdvisorTicketsFor(supabase, gorgiasIds, cols) {
  const rows = [];
  const batchSize = 200;
  for (let i = 0; i < gorgiasIds.length; i += batchSize) {
    const { data, error } = await supabase
      .from('cs_tickets').select(cols)
      .in('gorgias_ticket_id', gorgiasIds.slice(i, i + batchSize));
    if (error) throw new Error(`cs_tickets lookup failed: ${error.message}`);
    rows.push(...data);
  }
  const byGorgiasId = new Map();
  for (const t of rows) byGorgiasId.set(t.gorgias_ticket_id, t);
  return { rows, byGorgiasId };
}

/**
 * Advisor tickets still open/snoozed/follow_up that are NOT in the Gorgias
 * open views — candidates for Advisor-side drift.
 */
async function findAdvisorOnlyOpen(supabase, gorgiasIds, cols) {
  const { data, error } = await supabase
    .from('cs_tickets').select(cols)
    .in('status', ['open', 'snoozed', 'follow_up'])
    .not('gorgias_ticket_id', 'in', `(${gorgiasIds.length ? gorgiasIds.join(',') : '0'})`);
  if (error) throw new Error(`advisor-drift lookup failed: ${error.message}`);
  return data || [];
}

// ── Canonical message counting (internal notes excluded everywhere) ──

function countGorgiasMessages(messages) {
  const visible = (messages || []).filter(m => m.channel !== 'internal-note');
  return {
    customer: visible.filter(m => !m.from_agent).length,
    agent: visible.filter(m => m.from_agent).length,
    total: visible.length,
  };
}

function countAdvisorMessages(history) {
  if (!Array.isArray(history)) return 0;
  return history.filter(m => m.channel !== 'internal-note').length;
}

function countAdvisorCustomerMessages(history) {
  if (!Array.isArray(history)) return 0;
  return history.filter(m => m.sender === 'customer' && m.channel !== 'internal-note').length;
}

// ── Canonical status compatibility ──
//
// parked / pending_operator are Advisor-only states Gorgias doesn't know
// about; Advisor-side snooze is allowed while Gorgias shows open, and a
// Gorgias-closed ticket the Advisor has snoozed/parked is deliberate, not
// drift. Anything outside this map IS drift.
const STATUS_OK = {
  open: ['open', 'snoozed', 'parked', 'pending_operator'],
  snoozed: ['snoozed'],
  closed: ['closed', 'snoozed', 'parked'],
};

function isStatusInSync(gorgiasStatus, advisorStatus) {
  const allowed = STATUS_OK[gorgiasStatus];
  if (!allowed) return true; // unknown Gorgias status — don't flag
  return allowed.includes(advisorStatus);
}

// ── Bounced agent messages ──
//
// Gorgias reopens a ticket when an agent message fails to deliver, so a ticket
// we answered and closed flips back to open on their side seconds later. The
// status check above then reads it as drift, and triage — which only knows
// about duplicates, reactions, spam and continuations — falls through to
// `real_miss`, alarming about a customer we did not actually miss. A bounce is
// its own disposition: reported once as undelivered, never as a miss.

/** The agent messages on a ticket that failed to deliver. */
function failedAgentMessages(messages) {
  return (messages || []).filter(m => m.from_agent && m.failed_datetime);
}

/**
 * Split detected drift into what still needs triage and what is explained by a
 * bounce. `bouncedIds` is the set of Gorgias ticket ids with failed agent
 * messages; each drift item is `{ ticket, reason, ... }`.
 */
function partitionBouncedDrift(driftItems, bouncedIds) {
  const driftToTriage = [];
  const bounceResolved = [];
  for (const item of driftItems || []) {
    if (!bouncedIds || !bouncedIds.has(item.ticket.id)) {
      driftToTriage.push(item);
      continue;
    }
    bounceResolved.push({
      ticketId: item.ticket.id,
      email: item.ticket.customer?.email || '?',
      disposition: 'undelivered',
      reason: 'agent message bounced (Gorgias reopens on delivery failure) — see undelivered messages',
    });
  }
  return { driftToTriage, bounceResolved };
}

module.exports = {
  VIEW_ALL_OPEN,
  VIEW_UNASSIGNED,
  fetchOpenGorgiasTickets,
  fetchAdvisorTicketsFor,
  findAdvisorOnlyOpen,
  countGorgiasMessages,
  countAdvisorMessages,
  countAdvisorCustomerMessages,
  isStatusInSync,
  STATUS_OK,
  failedAgentMessages,
  partitionBouncedDrift,
};
