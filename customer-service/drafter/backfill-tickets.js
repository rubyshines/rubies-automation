#!/usr/bin/env node
/**
 * Backfill cs_tickets from existing cs_ai_drafts data.
 * Idempotent — safe to run multiple times.
 *
 * Usage: node customer-service/drafter/backfill-tickets.js
 */

if (!process.env.SUPABASE_URL) {
  require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
}

const { getSupabaseClient, fetchAllPaginated } = require('../../shared/supabaseClient');
const { canonicalMessageType } = require('../lib/messageTypes');

async function backfill() {
  const supabase = getSupabaseClient();

  // 1. Get all distinct gorgias_ticket_ids from drafts — paginated, or a re-run
  // past 1000 drafts sees only the OLDEST drafts and clobbers live cs_tickets
  // rows with stale data (the header's idempotency claim depended on this).
  const allDrafts = await fetchAllPaginated(() => supabase
    .from('cs_ai_drafts')
    .select('id, gorgias_ticket_id, gorgias_message_id, customer_email, customer_name, customer_pronouns, customer_country, order_number, conversation_history, order_context, customer_context, message_type, confidence, advisor_status, turn_number, status, created_at')
    .order('created_at', { ascending: true })
    .order('id', { ascending: true }));
  console.log(`Loaded ${allDrafts.length} drafts`);

  // Group by gorgias_ticket_id
  const byTicket = new Map();
  for (const d of allDrafts) {
    if (!d.gorgias_ticket_id) continue;
    if (!byTicket.has(d.gorgias_ticket_id)) byTicket.set(d.gorgias_ticket_id, []);
    byTicket.get(d.gorgias_ticket_id).push(d);
  }

  console.log(`Found ${byTicket.size} distinct tickets`);

  let created = 0;
  let updated = 0;
  let errors = 0;

  for (const [gorgiasTicketId, drafts] of byTicket) {
    try {
      const latest = drafts[drafts.length - 1]; // most recent draft
      const pendingDraft = drafts.find(d => d.status === 'pending');

      // Determine ticket status from latest draft
      let ticketStatus;
      if (pendingDraft) {
        ticketStatus = 'open';
      } else if (latest.status === 'sent') {
        // Check feedback log to determine if it was snoozed or closed
        const { data: feedback } = await supabase
          .from('cs_ai_feedback_log')
          .select('action')
          .eq('draft_id', latest.id)
          .limit(1)
          .single();

        const action = feedback?.action || '';
        if (action.includes('close') || action === 'closed_no_reply') {
          ticketStatus = 'closed';
        } else {
          ticketStatus = 'snoozed';
        }
      } else {
        // superseded, released, deleted, spam — all closed from our perspective
        ticketStatus = 'closed';
      }

      // Upsert the ticket
      const { data: ticket, error: upsertErr } = await supabase
        .from('cs_tickets')
        .upsert({
          gorgias_ticket_id: gorgiasTicketId,
          status: ticketStatus,
          // cs_ai_drafts has no message_count column — turn_number is the
          // real source (the old first operand was always undefined).
          message_count: latest.turn_number || 1,
          customer_email: latest.customer_email,
          customer_name: latest.customer_name,
          customer_pronouns: latest.customer_pronouns,
          customer_country: latest.customer_country,
          order_number: latest.order_number,
          conversation_history: latest.conversation_history,
          order_context: latest.order_context,
          customer_context: latest.customer_context,
          message_type: canonicalMessageType(latest.message_type, `backfill ticket ${latest.gorgias_ticket_id}`),
          confidence: latest.confidence,
          advisor_status: latest.advisor_status,
          active_draft_id: pendingDraft?.id || null,
          updated_at: latest.created_at,
          ...(ticketStatus === 'snoozed' ? { snoozed_at: latest.created_at } : {}),
          ...(ticketStatus === 'closed' ? { closed_at: latest.created_at } : {}),
        }, { onConflict: 'gorgias_ticket_id' })
        .select('id')
        .single();

      if (upsertErr) throw upsertErr;

      // Update all drafts for this ticket with ticket_id FK
      const draftIds = drafts.map(d => d.id);
      const { error: updateErr } = await supabase
        .from('cs_ai_drafts')
        .update({ ticket_id: ticket.id })
        .in('id', draftIds);

      if (updateErr) throw updateErr;

      created++;
    } catch (err) {
      console.error(`Error backfilling ticket ${gorgiasTicketId}:`, err.message);
      errors++;
    }
  }

  console.log(`\nBackfill complete: ${created} tickets created/updated, ${errors} errors`);

  // Verification
  const { count: ticketCount } = await supabase
    .from('cs_tickets')
    .select('id', { count: 'exact', head: true });

  const { count: nullCount } = await supabase
    .from('cs_ai_drafts')
    .select('id', { count: 'exact', head: true })
    .is('ticket_id', null)
    .not('gorgias_ticket_id', 'is', null);

  console.log(`\nVerification:`);
  console.log(`  cs_tickets rows: ${ticketCount}`);
  console.log(`  Distinct gorgias_ticket_ids: ${byTicket.size}`);
  console.log(`  Drafts with null ticket_id: ${nullCount}`);

  if (ticketCount === byTicket.size && nullCount === 0) {
    console.log(`  ✓ Backfill verified`);
  } else {
    console.log(`  ✗ Mismatch — investigate`);
  }
}

backfill().catch(err => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
