/**
 * Gorgias Draft Poller
 *
 * Polls Gorgias for new customer messages, runs them through the CS advisor,
 * and stores AI-drafted responses in Supabase for dashboard review.
 *
 * Assigns handled tickets to "AI Bot" in Gorgias so they disappear from
 * Jamie's inbox/unassigned queues.
 *
 * Usage:
 *   node customer-service/poller/pollGorgiasDrafts.js   (standalone)
 *   npm run cs-poll-drafts
 *
 * Exports run() for programmatic use.
 */

const path = require('path');
if (!process.env.SUPABASE_URL) {
  require('dotenv').config({ path: path.resolve(__dirname, '../..', '.env') });
}

const { getSupabaseClient } = require('../../shared/supabaseClient');
const gorgias = require('../import/gorgiasClient');

// Lazy-load advisors
let _hybridHandler = null;
let _treeHandler = null;

function getAdvisorHandler() {
  if (!_hybridHandler) {
    const { hybridAdvisor } = require('../lib/hybridAdvisor');
    _hybridHandler = hybridAdvisor;
  }
  return _hybridHandler;
}

function getTreeFallback() {
  if (!_treeHandler) {
    const advisorTools = require('../lib/tools/exchangeAdvisor');
    _treeHandler = (advisorTools.find(t => t.name === 'cs_advisor') || advisorTools.find(t => t.name === 'exchange_advisor')).handler;
  }
  return _treeHandler;
}

// AI Bot user ID — cached after first lookup
let _aiBotUserId = null;
const AI_BOT_NAME = 'RUBIES AI';

async function getAiBotUserId() {
  if (_aiBotUserId) return _aiBotUserId;
  const user = await gorgias.findUser(AI_BOT_NAME);
  if (!user) {
    console.warn(`[poller] Could not find Gorgias user "${AI_BOT_NAME}" — tickets will not be assigned`);
    return null;
  }
  _aiBotUserId = user.id;
  return _aiBotUserId;
}

// ---------------------------------------------------------------------------
// Core polling logic
// ---------------------------------------------------------------------------

async function run({ onProgress } = {}) {
  const emit = onProgress || (() => {});
  const supabase = getSupabaseClient();
  const startTime = Date.now();
  let draftsCreated = 0;
  let ticketsProcessed = 0;
  let ticketsSkipped = 0;

  // 1. Get high-water mark for efficient scanning
  const { data: stateRow } = await supabase
    .from('cs_poller_state')
    .select('last_poll_at')
    .eq('id', 'gorgias_drafter')
    .maybeSingle();

  const lastPollAt = stateRow?.last_poll_at
    ? new Date(new Date(stateRow.last_poll_at).getTime() - 5 * 60 * 1000) // 5min overlap
    : new Date(Date.now() - 24 * 60 * 60 * 1000); // default: 24hrs ago

  console.log(`[poller] Scanning since ${lastPollAt.toISOString()}...`);

  // Fetch recent tickets, keep only open + unassigned or assigned to AI bot
  let cursor = null;
  const allTickets = [];
  const seen = new Set();
  do {
    const { data: tickets, nextCursor } = await gorgias.getTickets({
      cursor,
      limit: 30,
      order_by: 'updated_datetime:desc',
    });
    // Stop once we pass the high-water mark
    const recent = tickets.filter(t => new Date(t.updated_datetime) >= lastPollAt);
    for (const t of recent) {
      if (t.status === 'open' && !t.spam && !seen.has(t.id)) {
        allTickets.push(t);
        seen.add(t.id);
      }
    }
    if (recent.length < tickets.length) break;
    cursor = nextCursor;
    if (cursor) await gorgias.delay(500);
  } while (cursor);

  console.log(`[poller] Found ${allTickets.length} open tickets`);
  emit({ phase: 'fetched', total: allTickets.length });

  // 3. Pre-filter using ticket list data + batch Supabase check (no Gorgias API calls)
  const aiBotId = await getAiBotUserId();
  const ticketIds = allTickets.map(t => t.id);

  // Batch-check which tickets already have drafts or were spammed
  const { data: existingDrafts } = await supabase
    .from('cs_ai_drafts')
    .select('gorgias_ticket_id, gorgias_message_id, status')
    .in('gorgias_ticket_id', ticketIds.length ? ticketIds : [0]);

  const draftedMessages = {};
  const spammedTickets = new Set();
  for (const d of (existingDrafts || [])) {
    if (d.status === 'spam') spammedTickets.add(d.gorgias_ticket_id);
    if (!draftedMessages[d.gorgias_ticket_id]) draftedMessages[d.gorgias_ticket_id] = new Set();
    draftedMessages[d.gorgias_ticket_id].add(d.gorgias_message_id);
  }

  // Build set of tickets with released drafts (don't re-draft those)
  const releasedTickets = new Set();
  for (const d of (existingDrafts || [])) {
    if (d.status === 'released') releasedTickets.add(d.gorgias_ticket_id);
  }

  // Filter using only data we already have (no API calls)
  const ticketsToProcess = allTickets.filter(t => {
    // Only process unassigned tickets OR tickets assigned to AI bot
    // (tickets assigned to other agents are being handled elsewhere)
    const assigneeId = t.assignee_user?.id;
    if (assigneeId && assigneeId !== aiBotId) {
      console.log(`[poller] Skip ${t.id}: assigned to another agent`);
      ticketsSkipped++;
      return false;
    }
    // Assigned to AI bot with a pending draft = already in our queue
    if (assigneeId === aiBotId && draftedMessages[t.id]?.size > 0) {
      console.log(`[poller] Skip ${t.id}: AI bot + pending draft`);
      ticketsSkipped++;
      return false;
    }
    // Released back to Gorgias = don't re-draft
    if (releasedTickets.has(t.id) && !assigneeId) {
      // Only skip if unassigned (released). If AI bot re-assigned somehow, process it.
      console.log(`[poller] Skip ${t.id}: released to Gorgias`);
      ticketsSkipped++;
      return false;
    }
    // Spammed in our system
    if (spammedTickets.has(t.id)) {
      console.log(`[poller] Skip ${t.id}: spammed`);
      ticketsSkipped++;
      return false;
    }
    // Gorgias spam detection (field is `spam`, not `is_spam`)
    if (t.spam) {
      console.log(`[poller] Skip ${t.id}: Gorgias spam`);
      ticketsSkipped++;
      return false;
    }
    // Spam-tagged
    const tags = (t.tags || []).map(tag => (tag.name || tag).toLowerCase());
    if (tags.includes('spam')) {
      console.log(`[poller] Skip ${t.id}: spam tag`);
      ticketsSkipped++;
      return false;
    }
    // No customer email
    if (!t.customer?.email) {
      console.log(`[poller] Skip ${t.id}: no email`);
      ticketsSkipped++;
      return false;
    }
    return true;
  });

  console.log(`[poller] ${ticketsToProcess.length} to process, ${ticketsSkipped} pre-filtered`);

  // 4. Process only tickets that passed all filters
  for (let i = 0; i < ticketsToProcess.length; i++) {
    const ticket = ticketsToProcess[i];
    emit({ phase: 'processing', current: i + 1, total: ticketsToProcess.length });
    try {
      const ptResult = await processTicket(supabase, ticket, aiBotId, draftedMessages[ticket.id]);
      if (ptResult?.drafted) draftsCreated++;
      if (ptResult?.skipped) ticketsSkipped++;
      else ticketsProcessed++;
    } catch (err) {
      console.error(`[poller] Error processing ticket ${ticket.id}: ${err.message}`);
      ticketsSkipped++;
    }
    await gorgias.delay(500);
  }

  // 4. Check for follow-ups and bypasses via MCP tools
  let followUpsCreated = 0;
  try {
    const adminTools = require('../lib/tools/csAdmin');
    const followUpHandler = adminTools.find(t => t.name === 'check_follow_ups')?.handler;
    if (followUpHandler) {
      const followUpResult = await followUpHandler({ days_threshold: 3 });
      const text = followUpResult?.content?.[0]?.text || '';
      const match = text.match(/Created (\d+) follow-up/);
      followUpsCreated = match ? parseInt(match[1]) : 0;
      if (followUpsCreated > 0) console.log(`[poller] ${followUpsCreated} follow-up drafts created`);
    }
  } catch (err) {
    console.warn(`[poller] Follow-up check failed: ${err.message}`);
  }

  try {
    const adminTools = require('../lib/tools/csAdmin');
    const bypassHandler = adminTools.find(t => t.name === 'detect_bypasses')?.handler;
    if (bypassHandler) {
      const bypassResult = await bypassHandler({});
      const text = bypassResult?.content?.[0]?.text || '';
      if (!text.includes('0 bypasses')) console.log(`[poller] Bypass detection: ${text.split('\n')[0]}`);
    }
  } catch (err) {
    console.warn(`[poller] Bypass detection failed: ${err.message}`);
  }

  // 5. Update high-water mark
  await supabase
    .from('cs_poller_state')
    .upsert({ id: 'gorgias_drafter', last_poll_at: new Date().toISOString(), updated_at: new Date().toISOString() });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[poller] Done in ${elapsed}s — ${ticketsProcessed} processed, ${draftsCreated} drafts created, ${followUpsCreated} follow-ups, ${ticketsSkipped} skipped`);

  const result = { ticketsProcessed, draftsCreated, followUpsCreated, ticketsSkipped, elapsed };
  emit({ phase: 'done', ...result });
  return result;
}

// ---------------------------------------------------------------------------
// processTicket — extracted from run() for reuse by webhook handler
// ---------------------------------------------------------------------------

/**
 * Process a single Gorgias ticket through the advisor.
 * Returns { drafted: true } if a draft was created, { skipped: true } otherwise.
 */
async function processTicket(supabase, ticket, aiBotId, existingMessageIds) {
  const ticketId = ticket.id;

  // Fetch messages (only called for tickets that passed pre-filter)
  const messages = await gorgias.getTicketMessages(ticketId);
  if (!messages.length) return { skipped: true };

  // Find latest customer message
  const customerMessages = messages.filter(m => m.from_agent === false);
  if (!customerMessages.length) return { skipped: true };

  const latestCustomerMsg = customerMessages[customerMessages.length - 1];
  const latestCustomerMsgId = latestCustomerMsg.id;

  // Check if we already have a draft for this specific message
  if (existingMessageIds?.has(latestCustomerMsgId)) {
    console.log(`[poller] Skip ${ticketId}: draft exists for this message`);
    return { skipped: true };
  }

  // Check if latest message is already from a real agent
  const latestMsg = messages[messages.length - 1];
  const isBot = latestMsg.sender?.email?.endsWith('@email.gorgias.com') || latestMsg.via === 'rule';
  if (latestMsg.from_agent === true && !isBot) {
    console.log(`[poller] Skip ${ticketId}: agent already replied`);
    return { skipped: true };
  }

  const customerEmail = ticket.customer?.email;

  // Get previous draft's intake state for multi-turn
  let previousIntake = null;
  let turnNumber = 1;
  let previousDraftId = null;
  const { data: prevDraft } = await supabase
    .from('cs_ai_drafts')
    .select('id, intake_state, turn_number')
    .eq('gorgias_ticket_id', ticketId)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (prevDraft) {
    previousIntake = prevDraft.intake_state;
    turnNumber = (prevDraft.turn_number || 0) + 1;
    previousDraftId = prevDraft.id;

    // Supersede old pending drafts
    await supabase
      .from('cs_ai_drafts')
      .update({ status: 'superseded' })
      .eq('gorgias_ticket_id', ticketId)
      .eq('status', 'pending');
  }

  // Extract message text (use stripped version for cleaner input)
  const messageText = gorgias.stripHtml(latestCustomerMsg.stripped_text || latestCustomerMsg.body_text || '');
  if (!messageText.trim()) return { skipped: true };

  // Build conversation context from all previous messages (input preparation)
  const conversationContext = buildConversationContext(messages, latestCustomerMsg.id);
  const previousDraftContext = await buildPreviousDraftContext(supabase, ticketId);

  const contextParts = [];
  if (conversationContext) contextParts.push(`[CONVERSATION HISTORY]\n${conversationContext}`);
  if (previousDraftContext) contextParts.push(`[PREVIOUS AI PROCESSING]\n${previousDraftContext}`);
  contextParts.push(`[LATEST CUSTOMER MESSAGE]\n${messageText}`);
  const issueDescription = contextParts.join('\n\n');

  // Run through hybrid advisor (Opus) with tree fallback
  console.log(`[poller] Processing ticket ${ticketId} — "${messageText.substring(0, 80)}..."`);

  let result;
  let usedFallback = false;
  try {
    const advisorHandler = getAdvisorHandler();
    result = await advisorHandler({
      customer_email: customerEmail,
      issue_description: issueDescription,
      intake: previousIntake || undefined,
    });
  } catch (err) {
    console.warn(`[poller] Hybrid advisor error on ticket ${ticketId}: ${err.message} — falling back to tree`);
    try {
      const treeFallback = getTreeFallback();
      result = await treeFallback({
        customer_email: customerEmail,
        issue_description: issueDescription,
        intake: previousIntake || undefined,
      });
      usedFallback = true;
    } catch (err2) {
      console.log(`[poller] Tree fallback also failed on ticket ${ticketId}: ${err2.message}`);
      return { skipped: true };
    }
  }

  const structured = result?._structured;
  if (!structured) {
    console.warn(`[poller] No structured output for ticket ${ticketId}`);
    return { skipped: true };
  }
  if (usedFallback) structured.advisor_version = (structured.advisor_version || '') + '-fallback';

  // Draft response comes from advisor (composed inside the tool)
  const routeToHuman = structured.status === 'route_to_human' || (structured.error && !structured.intake);
  let draftResponse;
  if (routeToHuman && !structured._composedResponse) {
    const routeReason = structured.results?.[0]?.summary || structured.error || 'Unhandled message type';
    draftResponse = `[AI could not draft a response — needs manual reply]\n\nRoute reason: ${routeReason}\n\nCustomer message: ${messageText}`;
    console.log(`[poller] Ticket ${ticketId} routed to human — creating training draft`);
  } else {
    draftResponse = structured._composedResponse || '[No response composed]';
  }

  // Build conversation history snapshot (for dashboard display)
  const conversationHistory = messages.map(m => ({
    id: m.id,
    sender: m.from_agent === false ? 'customer' : m.channel === 'internal-note' ? 'note' : 'agent',
    body_html: m.stripped_html || m.body_html || null,
    body: gorgias.stripHtml(m.stripped_html || m.stripped_text || m.body_html || m.body_text || ''),
    created_at: m.created_datetime,
    channel: m.channel,
  }));

  // Insert draft — save advisor result verbatim, no post-processing
  const { error: insertErr } = await supabase
    .from('cs_ai_drafts')
    .insert({
      gorgias_ticket_id: ticketId,
      gorgias_message_id: latestCustomerMsgId,
      customer_email: customerEmail,
      customer_name: structured.customer?.name || null,
      customer_pronouns: structured.customer?.pronouns || null,
      customer_country: structured.customer?.country || null,
      order_number: structured.order?.name || null,
      draft_response: draftResponse,
      structured_output: structured,
      intake_state: structured.intake || null,
      audit_trail: structured.audit || [],
      confidence: structured.confidence || 'low',
      advisor_status: structured.status,
      message_type: structured.intake?.message_type || structured.intake?.items?.[0]?.issue || 'unknown',
      conversation_history: conversationHistory,
      order_context: structured.order || null,
      customer_context: structured.customer || null,
      action_type: structured.action_type || null,
      turn_number: turnNumber,
      previous_draft_id: previousDraftId,
    });

  if (insertErr) {
    console.error(`[poller] Insert error for ticket ${ticketId}: ${insertErr.message}`);
    return { skipped: true };
  }

  console.log(`[poller] Draft created for ticket ${ticketId} (confidence: ${structured.confidence || 'low'}, status: ${structured.status})`);

  // Assign to AI Bot in Gorgias
  if (aiBotId) {
    try {
      await gorgias.assignTicket(ticketId, aiBotId);
      await gorgias.addTicketTag(ticketId, 'ai-draft');
    } catch (err) {
      console.warn(`[poller] Could not assign/tag ticket ${ticketId}: ${err.message}`);
    }
  }

  return { drafted: true };
}

// ---------------------------------------------------------------------------
// Previous draft context builder
// ---------------------------------------------------------------------------

/**
 * Build structured context from previous AI drafts for this ticket.
 * This tells the AI what was already discussed, decided, and sent.
 */
async function buildPreviousDraftContext(supabase, ticketId) {
  const { data: prevDrafts } = await supabase
    .from('cs_ai_drafts')
    .select('draft_response, sent_response, structured_output, advisor_status, action_type, action_result, status, feedback_notes')
    .eq('gorgias_ticket_id', ticketId)
    .neq('status', 'superseded')
    .order('created_at', { ascending: true });

  if (!prevDrafts?.length) return null;

  const lines = [];
  for (const d of prevDrafts) {
    const s = d.structured_output || {};
    const items = s.intake?.items || [];
    const status = d.advisor_status || 'unknown';

    let summary = `Turn (status: ${status})`;

    // What items were identified
    if (items.length > 0) {
      const itemDescs = items.map(i => {
        let desc = `${i.product || '?'} size ${i.size || '?'}`;
        if (i.issue) desc += ` (${i.issue})`;
        if (i.resolved_size) desc += ` → resolved to ${i.resolved_size}`;
        return desc;
      });
      summary += ` | Items: ${itemDescs.join(', ')}`;
    }

    // What measurements were collected
    if (s.intake?.measurement) summary += ` | Waist: ${s.intake.measurement.value}${s.intake.measurement.unit === 'cm' ? 'cm' : '"'}`;
    if (s.intake?.chest_measurement) summary += ` | Chest: ${s.intake.chest_measurement.value}${s.intake.chest_measurement.unit === 'cm' ? 'cm' : '"'}`;

    // What action was taken
    if (d.action_type) summary += ` | Action: ${d.action_type}`;
    if (d.action_result) summary += ' (executed)';

    // What was actually sent
    if (d.status === 'sent' && d.sent_response) {
      const sentPreview = d.sent_response.substring(0, 200);
      summary += `\nAgent sent: ${sentPreview}`;
    }

    // Donation info already provided?
    const donationMentioned = (d.sent_response || d.draft_response || '').toLowerCase();
    if (donationMentioned.includes('donate') || donationMentioned.includes('rubies returns')) {
      summary += '\n[Donation/return info was already provided to customer]';
    }

    lines.push(summary);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Conversation context builder
// ---------------------------------------------------------------------------

/**
 * Build a summary of all previous messages in a Gorgias ticket
 * (excluding the latest customer message which is handled separately).
 * This gives the AI parser context about what's been discussed.
 */
function buildConversationContext(messages, latestMsgId) {
  // Filter out internal notes and the latest message itself
  const previousMsgs = messages.filter(m =>
    m.id !== latestMsgId && m.channel !== 'internal-note'
  );

  if (previousMsgs.length === 0) return null;

  // Build a compact summary — truncate each message to keep total under 3000 chars
  const maxPerMsg = Math.min(400, Math.floor(3000 / previousMsgs.length));
  const lines = [];

  for (const m of previousMsgs) {
    const sender = m.from_agent === false ? 'Customer' : 'Agent';
    const isBot = m.sender?.email?.endsWith('@email.gorgias.com') || m.via === 'rule';
    if (isBot) continue; // Skip bot auto-replies

    const body = gorgias.stripHtml(m.stripped_text || m.body_text || '').trim();
    if (!body) continue;

    const truncated = body.length > maxPerMsg ? body.substring(0, maxPerMsg) + '...' : body;
    lines.push(`${sender}: ${truncated}`);
  }

  return lines.length > 0 ? lines.join('\n') : null;
}

// ---------------------------------------------------------------------------
// Draft formatting
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

if (require.main === module) {
  run()
    .then(result => {
      console.log('[poller] Result:', JSON.stringify(result));
      process.exit(0);
    })
    .catch(err => {
      console.error('[poller] Fatal error:', err);
      process.exit(1);
    });
}

module.exports = { run, processTicket, getAiBotUserId, buildConversationContext, buildPreviousDraftContext };
