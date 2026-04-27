/**
 * Validate the thank-you classifier against recently-closed tickets.
 *
 * Looks for tickets where Jamie's FINAL sent reply was a short closer (i.e.
 * looked like a "you're welcome" message). For each one, runs the classifier
 * on the customer message that preceded that closer, with the SECOND-to-last
 * sent reply as priorAgentReply. The ground truth is "Jamie sent a closer →
 * the classifier should agree this was a closeable thank-you."
 *
 * Reports agreement: how often the classifier would have auto-closed when
 * Jamie actually did. False negatives (classifier said no, Jamie still
 * closed) are the regrettable cases — false positives can't happen here
 * because we only look at cases Jamie closed.
 *
 * Does NOT write anything. Read + classifier only.
 *
 * Usage:
 *   node customer-service/sync/dryRunAutoCloseThankYouClosed.js
 *   node customer-service/sync/dryRunAutoCloseThankYouClosed.js --days=30 --closer-max=200
 *   node customer-service/sync/dryRunAutoCloseThankYouClosed.js --misses-only
 */

const path = require('path');
if (!process.env.SUPABASE_URL) {
  require('dotenv').config({ path: path.resolve(__dirname, '../..', '.env') });
}

const { getSupabaseClient } = require('../../shared/supabaseClient');
const { classifyThankYou, formatMessagesForClassifier } = require('../lib/thankYouClassifier');

const args = process.argv.slice(2);
function arg(name, def) {
  const a = args.find(x => x.startsWith(`--${name}=`));
  return a ? a.split('=')[1] : def;
}
const DAYS = parseInt(arg('days', '30'), 10);
const CLOSER_MAX = parseInt(arg('closer-max', '180'), 10); // chars — short reply heuristic
const LIMIT = parseInt(arg('limit', '200'), 10);
const MISSES_ONLY = args.includes('--misses-only');

function truncate(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}
function divider() { console.log('─'.repeat(80)); }

/**
 * Walk conversation_history backwards to find:
 *   - finalAgentMsg: the last non-bot agent message
 *   - lastCustomerMsg: the customer message immediately before finalAgentMsg
 *   - priorAgentMsg: the agent message immediately before lastCustomerMsg
 */
function pickLastExchange(history) {
  if (!Array.isArray(history) || history.length < 3) return null;
  const sorted = [...history].sort((a, b) =>
    new Date(a.created_at || 0) - new Date(b.created_at || 0)
  );

  let finalAgentIdx = -1;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const m = sorted[i];
    if (m.sender === 'agent' && !m.is_bot) { finalAgentIdx = i; break; }
  }
  if (finalAgentIdx <= 0) return null;

  let lastCustomerIdx = -1;
  for (let i = finalAgentIdx - 1; i >= 0; i--) {
    if (sorted[i].sender === 'customer') { lastCustomerIdx = i; break; }
  }
  if (lastCustomerIdx <= 0) return null;

  let priorAgentIdx = -1;
  for (let i = lastCustomerIdx - 1; i >= 0; i--) {
    if (sorted[i].sender === 'agent' && !sorted[i].is_bot) { priorAgentIdx = i; break; }
  }
  if (priorAgentIdx < 0) return null;

  return {
    finalAgent: sorted[finalAgentIdx],
    lastCustomer: sorted[lastCustomerIdx],
    priorAgent: sorted[priorAgentIdx],
    sorted,
    lastCustomerIdx,
  };
}

async function evaluate(supabase, ticket) {
  const ticketId = ticket.gorgias_ticket_id;
  const ex = pickLastExchange(ticket.conversation_history);
  if (!ex) return { ticketId, skip: 'no_three_message_exchange' };

  const closerText = String(ex.finalAgent.body || '').trim();
  if (!closerText) return { ticketId, skip: 'empty_closer' };
  if (closerText.length > CLOSER_MAX) {
    return { ticketId, skip: 'closer_too_long', closerLen: closerText.length };
  }

  // Skip closers that were follow-up nudges. We don't have draft_kind on the
  // history entry, so do a cheap text check.
  const lower = closerText.toLowerCase();
  if (lower.includes('checking in') || lower.includes('did this resolve') || lower.includes('any update')) {
    return { ticketId, skip: 'closer_looks_like_followup' };
  }

  // Action carve-out: if there's an unexecuted action draft, skip.
  const { data: lastSentDraft } = await supabase
    .from('cs_ai_drafts')
    .select('id, action_type, action_executed_at, draft_kind, sent_response, draft_response')
    .eq('gorgias_ticket_id', ticketId)
    .eq('status', 'sent')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (lastSentDraft && lastSentDraft.action_type && !lastSentDraft.action_executed_at) {
    return { ticketId, skip: 'open_action_in_flight' };
  }

  const customerText = String(ex.lastCustomer.body || '').trim();
  if (!customerText) return { ticketId, skip: 'empty_customer_msg' };
  if (customerText.length > 400) return { ticketId, skip: 'customer_msg_too_long' };

  // Build classifier input from conversation_history up to and including the
  // customer's last message (NOT the final closer — we're testing whether the
  // classifier would have decided to auto-close given just what it would have
  // seen at intake time).
  const upToCustomer = ex.sorted.slice(0, ex.lastCustomerIdx + 1);
  const messagesForClassifier = upToCustomer.slice(-6).map(m => ({
    from_agent: m.sender !== 'customer',
    stripped_text: m.body || '',
    body_text: m.body || '',
  }));
  const recent = formatMessagesForClassifier(messagesForClassifier, 6);
  const priorReply = String(ex.priorAgent.body || '');

  const cls = await classifyThankYou({ recentMessages: recent, priorAgentReply: priorReply });

  return {
    ticketId,
    customerEmail: ticket.customer_email,
    messageType: ticket.message_type,
    closerText,
    customerText,
    priorReply,
    classifier: cls,
  };
}

async function main() {
  const supabase = getSupabaseClient();
  const sinceIso = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000).toISOString();

  console.log(`[dry-run] Fetching closed tickets from last ${DAYS} days (limit ${LIMIT})…`);
  const { data: tickets, error } = await supabase
    .from('cs_tickets')
    .select('id, gorgias_ticket_id, customer_email, message_type, conversation_history, closed_at')
    .eq('status', 'closed')
    .gte('closed_at', sinceIso)
    .order('closed_at', { ascending: false })
    .limit(LIMIT);

  if (error) {
    console.error('[dry-run] Query error:', error.message);
    process.exit(1);
  }
  console.log(`[dry-run] ${tickets.length} closed tickets to evaluate (closer ≤ ${CLOSER_MAX} chars)\n`);

  let agree = 0;       // Jamie sent closer + classifier said auto_close
  let miss = 0;        // Jamie sent closer + classifier said NO (false negative)
  let skipped = 0;
  const skipReasons = {};
  const agreed = [];
  const missed = [];

  for (const ticket of tickets) {
    let result;
    try {
      result = await evaluate(supabase, ticket);
    } catch (err) {
      console.error(`[dry-run] Error on ticket ${ticket.gorgias_ticket_id}: ${err.message}`);
      continue;
    }

    if (result.skip) {
      skipped++;
      skipReasons[result.skip] = (skipReasons[result.skip] || 0) + 1;
      continue;
    }

    const isHit = result.classifier.auto_close;
    if (isHit) { agree++; agreed.push(result); }
    else { miss++; missed.push(result); }

    if (MISSES_ONLY && isHit) continue;

    divider();
    console.log(`Ticket #${result.ticketId}  (${result.customerEmail || 'no email'})  type=${result.messageType || '?'}`);
    console.log(`Classifier: ${isHit ? 'AUTO_CLOSE ✓ agrees with Jamie' : 'skip ✗ MISS'}  —  ${result.classifier.reason || '(none)'}`);
    console.log(`Prior reply:        ${truncate(result.priorReply, 200)}`);
    console.log(`Customer's msg:     ${truncate(result.customerText, 250)}`);
    console.log(`Jamie's closer:     ${truncate(result.closerText, 200)}`);
  }

  divider();
  const evaluated = agree + miss;
  const agreePct = evaluated ? ((agree / evaluated) * 100).toFixed(1) : 'n/a';
  console.log('\n=== Summary ===');
  console.log(`Closed tickets pulled:      ${tickets.length}`);
  console.log(`Skipped (preconditions):    ${skipped}`);
  for (const [reason, count] of Object.entries(skipReasons).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${reason}: ${count}`);
  }
  console.log(`Classifier ran on:          ${evaluated}`);
  console.log(`  Agree (would auto-close): ${agree}  (${agreePct}%)`);
  console.log(`  Miss (false negative):    ${miss}`);

  if (miss > 0 && !MISSES_ONLY) {
    console.log('\nMisses (Jamie closed but classifier said no — review these for prompt tuning):');
    for (const m of missed.slice(0, 20)) {
      console.log(`  #${m.ticketId}  —  reason: ${m.classifier.reason || ''}`);
      console.log(`     customer: "${truncate(m.customerText, 100)}"`);
    }
    if (missed.length > 20) console.log(`  …and ${missed.length - 20} more`);
  }
}

main().catch(err => {
  console.error('[dry-run] Fatal:', err);
  process.exit(1);
});
