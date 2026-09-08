/**
 * Spam gate — the only way in for a customer Gorgias has flagged as spam.
 *
 * Gorgias's spam detector mislabels real customers, and a spam-flagged ticket
 * is invisible twice over: the Gorgias views exclude it upstream, and Gorgias
 * does NOT deliver `ticket-message-created` for a customer message on it
 * (verified 2026-09-08 against the webhook event log: zero deliveries for any
 * spam-flagged customer message, while an agent reply on the same ticket did
 * fire). So the known-customer override in the webhook handler can never run,
 * and everything below has to happen in a sweep.
 *
 * One pass over the open spam-flagged population:
 *
 *   - already in our system → Gorgias never delivers the follow-up reply
 *     either, so compare customer-message counts and run intake when Gorgias
 *     holds more than we do. Triage already passed this ticket once (or Jamie
 *     replied to it); re-judging would only cost an Opus call.
 *   - known customer (order history) → draft via normal intake, no triage.
 *   - unknown sender → Opus triage with the flag as tie-break; pitches and
 *     junk are closed with an audit note, a CUSTOMER verdict is drafted.
 *
 * Two callers: the nightly reconcile (full population, 60-day floor) and the
 * webhook server's timer (only tickets Gorgias touched since the last tick,
 * so a mislabelled customer waits minutes rather than a day). Both go through
 * here so the two can never disagree on policy.
 *
 * Dry runs list what would happen and write nothing — no triage, no drafts.
 */

const {
  fetchOpenSpamTickets,
  fetchAdvisorTicketsFor,
  countGorgiasMessages,
  countAdvisorCustomerMessages,
} = require('./gorgiasDriftCore');

// Cost cap, not a coverage cap: each unknown sender costs an Opus classify.
// Steady state is a handful/day; a flood waits for the next run.
const MAX_SPAM_GATE_PER_RUN = 30;

// Webhook-server fast path: tick every 15 minutes over tickets Gorgias updated
// since the previous tick (with overlap, so a slow tick never opens a gap). A
// freshly deployed process looks back a day so a reply that landed during the
// redeploy is not left for the nightly run.
const SPAM_GATE_SWEEP_MS = 15 * 60 * 1000;
const SPAM_GATE_OVERLAP_MS = 5 * 60 * 1000;
const SPAM_GATE_FIRST_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * @param {object} opts
 * @param {object} opts.supabase
 * @param {object} opts.gorgias         gorgiasClient (getTicketMessages, getTickets, delay)
 * @param {number} opts.aiBotId         Gorgias user id intake drafts as
 * @param {boolean} [opts.dryRun]       list only, write nothing
 * @param {Date}    [opts.updatedAfter] fast path: only tickets Gorgias updated after this
 * @param {number}  [opts.maxPerRun]
 * @param {Function} [opts.log]
 * @param {Function} [opts.warn]
 * Injectable for tests: hasOrderHistory, triageDriftTicket, processTicket,
 * fetchSpam (fetchOpenSpamTickets), fetchAdvisor (fetchAdvisorTicketsFor).
 * @returns {{ spamRecovered: Array, autoResolved: Array, wouldGate: Array, recoveredIds: Set<number>, candidates: number }}
 */
async function runSpamGate({
  supabase,
  gorgias,
  aiBotId,
  dryRun = false,
  updatedAfter = null,
  maxPerRun = MAX_SPAM_GATE_PER_RUN,
  log = console.log,
  warn = console.warn,
  hasOrderHistory = require('../../lib/knownCustomer').hasOrderHistory,
  triageDriftTicket = require('../../lib/driftTriage').triageDriftTicket,
  processTicket = require('../../intake/processGorgiasTickets').processTicket,
  fetchSpam = fetchOpenSpamTickets,
  fetchAdvisor = fetchAdvisorTicketsFor,
} = {}) {
  const spamRecovered = [];
  const autoResolved = [];
  const wouldGate = [];
  const recoveredIds = new Set();

  const spamTickets = updatedAfter
    ? await fetchSpam(gorgias, { since: updatedAfter, field: 'updated_datetime' })
    : await fetchSpam(gorgias);
  const gated = spamTickets.slice(0, maxPerRun);
  if (spamTickets.length > gated.length) {
    log(`  [spam-gate] ${spamTickets.length} open spam-flagged tickets; gating first ${gated.length}, rest deferred to next run`);
  }
  if (!gated.length) {
    return { spamRecovered, autoResolved, wouldGate, recoveredIds, candidates: 0 };
  }

  const spamIds = gated.map(t => t.id);
  const { byGorgiasId: advisorMap } = await fetchAdvisor(supabase, spamIds, 'id, gorgias_ticket_id, conversation_history');
  const { data: spamDrafts } = await supabase
    .from('cs_ai_drafts')
    .select('gorgias_ticket_id, gorgias_message_id')
    .in('gorgias_ticket_id', spamIds);
  const draftIdsByTicket = new Map();
  for (const d of (spamDrafts || [])) {
    if (!draftIdsByTicket.has(d.gorgias_ticket_id)) draftIdsByTicket.set(d.gorgias_ticket_id, new Set());
    draftIdsByTicket.get(d.gorgias_ticket_id).add(d.gorgias_message_id);
  }

  for (const ticket of gated) {
    const email = ticket.customer?.email || null;
    try {
      const known = email ? await hasOrderHistory(supabase, email) : false;
      const inSystem = advisorMap.get(ticket.id) || null;
      const existingIds = draftIdsByTicket.get(ticket.id) || new Set();

      if (inSystem) {
        // The webhook never delivers a customer message on a spam-flagged
        // ticket, so a follow-up reply on one we already rescued has no other
        // path in. Counts, not triage: this ticket was judged once already.
        const messages = await gorgias.getTicketMessages(ticket.id);
        const gCust = countGorgiasMessages(messages).customer;
        const aCust = countAdvisorCustomerMessages(inSystem.conversation_history);
        if (gCust <= aCust) continue; // nothing new — the follow-up engine owns it
        const via = `follow-up reply (G:${gCust} vs A:${aCust})`;
        if (dryRun) {
          wouldGate.push({ ticketId: ticket.id, email: email || '?', action: `draft (${via})` });
          log(`  [spam-gate] #${ticket.id} ${email || '?'} — would draft (${via})`);
          continue;
        }
        const result = await processTicket(supabase, ticket, aiBotId, existingIds);
        if (result?.skipped) {
          log(`  [spam-gate] #${ticket.id}: skipped by intake (${result.reason || 'no new message'})`);
        } else {
          spamRecovered.push({ ticketId: ticket.id, email: email || '?', via });
          recoveredIds.add(ticket.id);
          log(`  [spam-gate] #${ticket.id}: drafted (${via})`);
        }
        await gorgias.delay(300);
        continue;
      }

      if (dryRun) {
        const action = known ? 'draft (known customer)' : 'triage (unknown sender)';
        wouldGate.push({ ticketId: ticket.id, email: email || '?', action });
        log(`  [spam-gate] #${ticket.id} ${email || '?'} — would ${action}`);
        continue;
      }

      if (!known) {
        const messages = await gorgias.getTicketMessages(ticket.id);
        // spamFlagged flips the classifier's uncertainty tie-break to JUNK:
        // Gorgias already flagged these, so ambiguity is not enough to draft.
        const { disposition, reason } = await triageDriftTicket({
          supabase, gorgias, ticket, messages, spamFlagged: true,
        });
        if (disposition !== 'real_miss') {
          autoResolved.push({ ticketId: ticket.id, email: email || '?', disposition, reason: `spam-flagged: ${reason}` });
          log(`  [spam-gate] #${ticket.id}: auto-resolved (${disposition}) — ${reason}`);
          await gorgias.delay(300);
          continue;
        }
      }

      const result = await processTicket(supabase, ticket, aiBotId, existingIds);
      if (result?.skipped) {
        log(`  [spam-gate] #${ticket.id}: skipped by intake (${result.reason || 'no new message'})`);
      } else {
        const via = known ? 'known customer' : 'triage: customer';
        spamRecovered.push({ ticketId: ticket.id, email: email || '?', via });
        recoveredIds.add(ticket.id);
        log(`  [spam-gate] #${ticket.id}: drafted (${via})`);
      }
    } catch (e) {
      warn(`  [spam-gate] #${ticket.id}: failed (${e.message}) — will retry next run`);
    }
    await gorgias.delay(300);
  }

  return { spamRecovered, autoResolved, wouldGate, recoveredIds, candidates: gated.length };
}

module.exports = {
  runSpamGate,
  MAX_SPAM_GATE_PER_RUN,
  SPAM_GATE_SWEEP_MS,
  SPAM_GATE_OVERLAP_MS,
  SPAM_GATE_FIRST_WINDOW_MS,
};
