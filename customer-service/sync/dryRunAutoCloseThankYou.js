/**
 * Dry-run the thank-you auto-close gate against existing "needs reply" tickets.
 *
 * Targets the same population as the dashboard's Follow-up tab:
 *   cs_tickets where status='open' AND has_agent_reply=true AND active_draft_id IS NOT NULL.
 *
 * For each ticket: runs the deterministic preconditions and (when those pass)
 * the Sonnet classifier. Does NOT send anything, does NOT close anything,
 * does NOT touch Supabase. Prints results so they can be eyeballed.
 *
 * Usage:
 *   node customer-service/sync/dryRunAutoCloseThankYou.js
 *   node customer-service/sync/dryRunAutoCloseThankYou.js --limit=20
 *   node customer-service/sync/dryRunAutoCloseThankYou.js --positives-only
 */

const path = require('path');
if (!process.env.SUPABASE_URL) {
  require('dotenv').config({ path: path.resolve(__dirname, '../..', '.env') });
}

const { getSupabaseClient } = require('../../shared/supabaseClient');
const { classifyThankYou, formatMessagesForClassifier } = require('../lib/thankYouClassifier');

const args = process.argv.slice(2);
const limitArg = args.find(a => a.startsWith('--limit='));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : 100;
const POSITIVES_ONLY = args.includes('--positives-only');

function truncate(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

function divider() {
  console.log('─'.repeat(80));
}

async function evaluateTicket(supabase, ticket) {
  const ticketId = ticket.gorgias_ticket_id;

  // Latest customer message — pulled from stored conversation_history snapshot.
  const history = ticket.conversation_history || [];
  const customerMsgs = history.filter(m => m.sender === 'customer');
  if (!customerMsgs.length) {
    return { ticketId, skip: 'no_customer_messages' };
  }
  const latestCustomerMsg = customerMsgs[customerMsgs.length - 1];

  // Make sure customer's last message is actually after our last agent reply.
  // If an agent (non-bot) replied AFTER the latest customer message, this isn't
  // a "needs reply" state and the gate wouldn't fire on it.
  const latestCustomerAt = new Date(latestCustomerMsg.created_at || 0).getTime();
  const agentRepliedAfter = history.some(m =>
    m.sender === 'agent' && !m.is_bot &&
    new Date(m.created_at || 0).getTime() > latestCustomerAt
  );
  if (agentRepliedAfter) {
    return { ticketId, skip: 'agent_replied_after_customer' };
  }

  // Pull last sent advisor draft (precondition source).
  const { data: lastSentDraft } = await supabase
    .from('cs_ai_drafts')
    .select('id, sent_response, draft_response, action_type, action_executed_at, draft_kind, sent_at')
    .eq('gorgias_ticket_id', ticketId)
    .eq('status', 'sent')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!lastSentDraft) {
    return { ticketId, skip: 'no_prior_sent_reply' };
  }
  if (lastSentDraft.draft_kind && lastSentDraft.draft_kind !== 'advisor_draft') {
    return { ticketId, skip: `prior_was_${lastSentDraft.draft_kind}` };
  }
  if (lastSentDraft.action_type && !lastSentDraft.action_executed_at) {
    return { ticketId, skip: 'open_action_in_flight', actionType: lastSentDraft.action_type };
  }

  const latestText = String(latestCustomerMsg.body || '').trim();
  if (!latestText) return { ticketId, skip: 'empty_message' };
  if (latestText.length > 400) return { ticketId, skip: 'message_too_long' };

  // Build classifier input from the stored conversation_history (instead of
  // re-fetching from Gorgias). Map to the shape the formatter expects.
  const messagesForClassifier = history.slice(-6).map(m => ({
    from_agent: m.sender !== 'customer',
    stripped_text: m.body || '',
    body_text: m.body || '',
  }));
  const recent = formatMessagesForClassifier(messagesForClassifier, 6);
  const priorReply = lastSentDraft.sent_response || lastSentDraft.draft_response || '';

  const cls = await classifyThankYou({ recentMessages: recent, priorAgentReply: priorReply });

  return {
    ticketId,
    customerEmail: ticket.customer_email,
    latestText,
    priorReply,
    classifier: cls,
    priorDraftId: lastSentDraft.id,
  };
}

async function main() {
  const supabase = getSupabaseClient();

  console.log(`[dry-run] Fetching needs-reply tickets (limit ${LIMIT})…`);
  const { data: tickets, error } = await supabase
    .from('cs_tickets')
    .select('id, gorgias_ticket_id, customer_email, customer_name, conversation_history, active_draft_id, message_type, last_customer_message_at')
    .eq('status', 'open')
    .eq('has_agent_reply', true)
    .not('active_draft_id', 'is', null)
    .order('last_customer_message_at', { ascending: false })
    .limit(LIMIT);

  if (error) {
    console.error('[dry-run] Query error:', error.message);
    process.exit(1);
  }
  console.log(`[dry-run] ${tickets.length} tickets in needs-reply state\n`);

  let positives = 0;
  let negatives = 0;
  let skipped = 0;
  const skipReasons = {};
  const positivesList = [];

  for (const ticket of tickets) {
    let result;
    try {
      result = await evaluateTicket(supabase, ticket);
    } catch (err) {
      console.error(`[dry-run] Error on ticket ${ticket.gorgias_ticket_id}: ${err.message}`);
      continue;
    }

    if (result.skip) {
      skipped++;
      skipReasons[result.skip] = (skipReasons[result.skip] || 0) + 1;
      continue;
    }

    const verdict = result.classifier.auto_close ? 'AUTO_CLOSE' : 'skip';
    if (result.classifier.auto_close) {
      positives++;
      positivesList.push(result);
    } else {
      negatives++;
      if (POSITIVES_ONLY) continue;
    }

    divider();
    console.log(`Ticket #${result.ticketId}  (${result.customerEmail || 'no email'})`);
    console.log(`Verdict: ${verdict}  —  reason: ${result.classifier.reason || '(none)'}`);
    console.log(`Prior reply (ours):  ${truncate(result.priorReply, 200)}`);
    console.log(`Customer's latest:   ${truncate(result.latestText, 300)}`);
    if (result.classifier._usage) {
      console.log(`(classifier tokens in/out: ${result.classifier._usage.input_tokens}/${result.classifier._usage.output_tokens})`);
    }
  }

  divider();
  console.log('\n=== Summary ===');
  console.log(`Total tickets evaluated: ${tickets.length}`);
  console.log(`  Skipped (preconditions): ${skipped}`);
  for (const [reason, count] of Object.entries(skipReasons).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${reason}: ${count}`);
  }
  console.log(`  Classifier ran: ${positives + negatives}`);
  console.log(`    AUTO_CLOSE positives: ${positives}`);
  console.log(`    Negatives:            ${negatives}`);

  if (positives > 0) {
    console.log('\nPositives (would auto-close in live mode):');
    for (const p of positivesList) {
      console.log(`  #${p.ticketId}  —  ${p.classifier.reason || ''}  —  "${truncate(p.latestText, 80)}"`);
    }
  }
}

main().catch(err => {
  console.error('[dry-run] Fatal:', err);
  process.exit(1);
});
