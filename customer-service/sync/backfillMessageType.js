#!/usr/bin/env node
/**
 * Backfill cs_tickets.message_type from cached draft data.
 *
 * Re-derives message_type for any cs_tickets row whose current value is
 * NOT in the canonical taxonomy. Fallback chain:
 *   1. cs_ai_drafts.structured_output.message_type (canonical, if advisor stored it)
 *   2. Heuristic mapping from cs_ai_drafts.intake_state.message_type
 *   3. Default to 'uncategorized'
 *
 * Free — no LLM calls. Idempotent — the query filter only picks up still-broken rows.
 *
 * Usage: node customer-service/sync/backfillMessageType.js [--dry-run] [--limit N]
 */

const path = require('path');
if (!process.env.SUPABASE_URL) {
  require('dotenv').config({ path: path.resolve(__dirname, '../..', '.env') });
}

const { getSupabaseClient } = require('../../shared/supabaseClient');
const { CANONICAL_MESSAGE_TYPES } = require('../lib/messageTypes');

// intake_state.message_type → canonical mapping
const INTAKE_TO_CANONICAL = {
  // Direct canonical matches
  exchange: 'exchange',
  refund: 'refund',
  refund_request: 'refund',
  defect: 'defect',
  product_not_working: 'defect',
  product_not_working_tight: 'defect',
  sizing_inquiry: 'sizing_inquiry',
  shipping: 'shipping',
  closing: 'closing',
  business_outreach: 'business_outreach',
  community_outreach: 'community_outreach',
  general_inquiry: 'general_inquiry',
  positive_feedback: 'general_inquiry',
  none: 'general_inquiry',
  unknown: 'general_inquiry',
  // Operational outcomes that are refund-adjacent
  wrong_item_shipped: 'refund',
  missing_item: 'refund',
  order_modification: 'refund',
  wrong_item: 'refund',
  // Item-level issue codes that leaked from items[].issue — came from exchange flows
  close_fit_tight: 'exchange',
  close_fit_loose: 'exchange',
  doesnt_fit: 'exchange',
  way_off: 'exchange',
  too_tight: 'exchange',
  too_loose: 'exchange',
  too_short: 'exchange',
  too_long: 'exchange',
  tight_legs: 'exchange',
  onepiece_fit: 'exchange',
  fit_issue: 'exchange',
  expectation_mismatch: 'exchange',
  // Artificial follow-up values (should never be in cs_tickets, but handle defensively)
  follow_up: 'general_inquiry',
  personal_follow_up: 'general_inquiry',
};

// Substantive categories are preferred over generic ones when a ticket has
// multiple drafts (e.g. a multi-turn exchange that ends with "thanks!").
const SUBSTANTIVE_CATEGORIES = new Set(['exchange', 'refund', 'defect', 'sizing_inquiry', 'shipping', 'business_outreach', 'community_outreach', 'closing']);

function mapOneDraft(draft) {
  // Step 1: structured_output.message_type (canonical, if advisor stored it)
  const structuredMt = draft?.structured_output?.message_type;
  if (structuredMt && CANONICAL_MESSAGE_TYPES.has(structuredMt)) {
    return { value: structuredMt, source: 'structured_output' };
  }
  // Step 2: intake_state.message_type via mapping
  const intakeMt = draft?.intake_state?.message_type;
  if (intakeMt && INTAKE_TO_CANONICAL[intakeMt]) {
    return { value: INTAKE_TO_CANONICAL[intakeMt], source: `intake_state(${intakeMt})` };
  }
  return null;
}

function deriveCanonical(ticket, allDrafts) {
  if (!allDrafts?.length) {
    return { value: 'uncategorized', source: 'no_draft' };
  }

  // Scan all drafts for this ticket. Prefer substantive classifications (exchange/refund/etc)
  // over generic ones (general_inquiry) — a multi-turn ticket ending with "thanks!" should
  // still be classified by its operational purpose, not its closing tone.
  let fallback = null;
  for (const d of allDrafts) {
    const mapped = mapOneDraft(d);
    if (!mapped) continue;
    if (SUBSTANTIVE_CATEGORIES.has(mapped.value)) {
      return mapped; // first substantive match wins
    }
    if (!fallback) fallback = mapped; // remember first non-substantive
  }

  return fallback || { value: 'uncategorized', source: 'default' };
}

async function run() {
  const dryRun = process.argv.includes('--dry-run');
  const limitArg = process.argv.findIndex(a => a === '--limit');
  const limit = limitArg >= 0 ? parseInt(process.argv[limitArg + 1], 10) : null;

  const supabase = getSupabaseClient();

  // Pull all cs_tickets rows whose message_type is NOT in the canonical set.
  // Supabase's .not('col', 'in', '(...)') handles this.
  const canonicalList = Array.from(CANONICAL_MESSAGE_TYPES).map(v => `"${v}"`).join(',');
  let query = supabase
    .from('cs_tickets')
    .select('id, gorgias_ticket_id, message_type')
    .or(`message_type.is.null,message_type.not.in.(${Array.from(CANONICAL_MESSAGE_TYPES).join(',')})`);
  if (limit) query = query.limit(limit);

  const { data: brokenTickets, error } = await query;
  if (error) {
    console.error('[backfill] Fetch error:', error.message);
    process.exit(1);
  }

  console.log(`[backfill] Found ${brokenTickets.length} rows with non-canonical message_type${dryRun ? ' (DRY RUN)' : ''}`);
  if (!brokenTickets.length) return;

  // Fetch ALL drafts per ticket via ticket_id. We scan across drafts to prefer
  // substantive classifications over generic ones (see deriveCanonical).
  const ticketIds = brokenTickets.map(t => t.id);
  const { data: drafts } = await supabase
    .from('cs_ai_drafts')
    .select('id, ticket_id, structured_output, intake_state, created_at')
    .in('ticket_id', ticketIds)
    .order('created_at', { ascending: true }); // earliest first — initial message is most representative

  // Group drafts by ticket_id
  const draftsByTicket = {};
  for (const d of drafts || []) {
    if (!draftsByTicket[d.ticket_id]) draftsByTicket[d.ticket_id] = [];
    draftsByTicket[d.ticket_id].push(d);
  }

  const stats = {
    total: brokenTickets.length,
    fromStructured: 0,
    fromIntake: 0,
    defaultUncategorized: 0,
    noDraft: 0,
  };
  const samples = [];

  for (const ticket of brokenTickets) {
    const ticketDrafts = draftsByTicket[ticket.id] || [];
    const derived = deriveCanonical(ticket, ticketDrafts);

    if (derived.source === 'no_draft') stats.noDraft++;
    else if (derived.source === 'structured_output') stats.fromStructured++;
    else if (derived.source.startsWith('intake_state')) stats.fromIntake++;
    else stats.defaultUncategorized++;

    if (samples.length < 15) {
      samples.push({ ticket: ticket.id, was: ticket.message_type, now: derived.value, source: derived.source });
    }

    if (!dryRun) {
      await supabase.from('cs_tickets').update({ message_type: derived.value }).eq('id', ticket.id);
    }
  }

  console.log('\n[backfill] Results:');
  console.log(`  total: ${stats.total}`);
  console.log(`  from structured_output: ${stats.fromStructured}`);
  console.log(`  from intake_state mapping: ${stats.fromIntake}`);
  console.log(`  default to uncategorized: ${stats.defaultUncategorized}`);
  console.log(`  no draft found: ${stats.noDraft}`);
  console.log('\n[backfill] Sample:');
  for (const s of samples) {
    console.log(`  ticket ${s.ticket}: "${s.was || '(null)'}" → "${s.now}" (${s.source})`);
  }

  if (dryRun) console.log('\n[backfill] DRY RUN — no rows updated.');
}

run().catch(err => {
  console.error('[backfill] Fatal:', err);
  process.exit(1);
});
