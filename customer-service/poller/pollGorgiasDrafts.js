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
const { composeAgentResponse } = require('../lib/responseComposer');

// Lazy-load advisor to avoid circular deps at module level
let _advisorHandler = null;
function getAdvisorHandler() {
  if (!_advisorHandler) {
    const advisorTools = require('../lib/tools/exchangeAdvisor');
    _advisorHandler = (advisorTools.find(t => t.name === 'cs_advisor') || advisorTools.find(t => t.name === 'exchange_advisor')).handler;
  }
  return _advisorHandler;
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

  // 1. Get high-water mark
  const { data: stateRow } = await supabase
    .from('cs_poller_state')
    .select('last_poll_at')
    .eq('id', 'gorgias_drafter')
    .single();

  const lastPollAt = stateRow?.last_poll_at
    ? new Date(new Date(stateRow.last_poll_at).getTime() - 5 * 60 * 1000) // 5min overlap buffer
    : new Date(Date.now() - 60 * 60 * 1000); // default: 1 hour ago

  console.log(`[poller] Polling since ${lastPollAt.toISOString()}`);

  // 2. Fetch recent tickets
  let cursor = null;
  const allTickets = [];
  do {
    const { data: tickets, nextCursor } = await gorgias.getTickets({
      cursor,
      limit: 30,
      order_by: 'updated_datetime:desc',
    });
    // Client-side filter by updated_datetime (not created_datetime)
    const recent = tickets.filter(t => new Date(t.updated_datetime) >= lastPollAt);
    allTickets.push(...recent);
    // Stop paginating if we've gone past our time window
    if (recent.length < tickets.length) break;
    cursor = nextCursor;
    if (cursor) await gorgias.delay(500);
  } while (cursor);

  console.log(`[poller] Found ${allTickets.length} updated tickets`);
  emit({ phase: 'fetched', total: allTickets.length });

  // 3. Process each ticket
  const aiBotId = await getAiBotUserId();

  for (let i = 0; i < allTickets.length; i++) {
    const ticket = allTickets[i];
    const customer = ticket.customer?.email || ticket.customer?.name || `#${ticket.id}`;
    emit({ phase: 'processing', current: i + 1, total: allTickets.length, customer });
    try {
      await processTicket(supabase, ticket, aiBotId);
      ticketsProcessed++;
    } catch (err) {
      console.error(`[poller] Error processing ticket ${ticket.id}: ${err.message}`);
      ticketsSkipped++;
    }
    await gorgias.delay(500);
  }

  // 4. Check for stale conversations needing follow-up (sent >3 days ago, no customer reply)
  let followUpsCreated = 0;
  const { data: staleDrafts } = await supabase
    .from('cs_ai_drafts')
    .select('id, gorgias_ticket_id, customer_email, customer_name, order_number, sent_at')
    .eq('status', 'sent')
    .lt('sent_at', new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString())
    .is('follow_up_draft_id', null);

  for (const stale of (staleDrafts || [])) {
    try {
      // Check Gorgias: has the customer replied since we sent?
      const messages = await gorgias.getTicketMessages(stale.gorgias_ticket_id);
      const customerRepliedAfterSend = messages.some(m =>
        (m.from_agent === false)
        && new Date(m.created_datetime) > new Date(stale.sent_at)
      );

      if (customerRepliedAfterSend) continue; // Customer replied, poller will handle it normally

      // Check if we already created a follow-up for this ticket
      const { data: existingFollowUp } = await supabase
        .from('cs_ai_drafts')
        .select('id')
        .eq('gorgias_ticket_id', stale.gorgias_ticket_id)
        .eq('message_type', 'follow_up')
        .eq('status', 'pending')
        .single();

      if (existingFollowUp) continue;

      const greeting = stale.customer_name ? `Hi ${stale.customer_name}` : 'Hi there';
      const followUpText = `${greeting}, just checking in! Did you have any questions about the exchange? Happy to help if so.`;

      const { data: newDraft } = await supabase
        .from('cs_ai_drafts')
        .insert({
          gorgias_ticket_id: stale.gorgias_ticket_id,
          gorgias_message_id: 0, // No customer message triggered this
          customer_email: stale.customer_email,
          customer_name: stale.customer_name,
          order_number: stale.order_number,
          draft_response: followUpText,
          structured_output: { status: 'follow_up', reason: '3-day no-reply' },
          audit_trail: ['[Follow-up] No customer reply 3+ days after agent response'],
          confidence: 'high',
          advisor_status: 'follow_up',
          message_type: 'follow_up',
          status: 'pending',
          previous_draft_id: stale.id,
        })
        .select('id')
        .single();

      // Link the follow-up back to the original draft
      if (newDraft) {
        await supabase.from('cs_ai_drafts').update({ follow_up_draft_id: newDraft.id }).eq('id', stale.id);
        followUpsCreated++;
        console.log(`[poller] Follow-up draft created for ticket ${stale.gorgias_ticket_id} (${stale.customer_name || stale.customer_email})`);
      }
    } catch (err) {
      console.error(`[poller] Follow-up error for ticket ${stale.gorgias_ticket_id}: ${err.message}`);
    }
    await gorgias.delay(500);
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

  // --- inner functions ---

  async function processTicket(supabase, ticket, aiBotId) {
    const ticketId = ticket.id;

    // Fetch messages
    const messages = await gorgias.getTicketMessages(ticketId);
    if (!messages.length) return;

    // Find latest customer message
    const customerMessages = messages.filter(m =>
      m.from_agent === false
    );
    if (!customerMessages.length) { ticketsSkipped++; return; }

    const latestCustomerMsg = customerMessages[customerMessages.length - 1];
    const latestCustomerMsgId = latestCustomerMsg.id;

    // Skip if ticket is currently closed (but will be picked up if customer reopens it)
    if (ticket.status === 'closed') { ticketsSkipped++; return; }

    // Check if latest message is already from a real agent (not a bot auto-reply)
    const latestMsg = messages[messages.length - 1];
    const isBot = latestMsg.sender?.email?.endsWith('@email.gorgias.com') || latestMsg.via === 'rule';
    const latestIsAgent = latestMsg.from_agent === true && !isBot;
    if (latestIsAgent) {
      // Check for bypass: agent replied on a ticket with pending draft
      await detectBypass(supabase, ticketId, messages);
      ticketsSkipped++;
      return;
    }

    // Check if we already have a draft for this message
    const { data: existingDraft } = await supabase
      .from('cs_ai_drafts')
      .select('id')
      .eq('gorgias_ticket_id', ticketId)
      .eq('gorgias_message_id', latestCustomerMsgId)
      .single();

    if (existingDraft) { ticketsSkipped++; return; }

    // Get customer email from ticket
    const customerEmail = ticket.customer?.email;
    if (!customerEmail) { ticketsSkipped++; return; }

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
    if (!messageText.trim()) { ticketsSkipped++; return; }

    // Quick detection: if the last customer message is just "thank you" / "thanks"
    // and the previous message was from an agent, this is a resolved conversation
    const isThankYou = /^\s*(thanks?(\s+you)?|thank\s+you|thx|ty|appreciate\s+it)[\s!.]*$/i.test(messageText);
    const prevAgentMsg = [...messages].reverse().find(m => m.from_agent === true && !m.sender?.email?.endsWith('@email.gorgias.com') && m.id !== latestCustomerMsg.id);
    if (isThankYou && prevAgentMsg) {
      // Auto-generate a "you're welcome" draft
      const customerName = ticket.customer?.name?.split(' ')[0] || null;
      const greeting = customerName ? `You're welcome, ${customerName}!` : "You're welcome!";
      const draftResponse = `${greeting}\n\nTake care,\nJamie Alexander, RUBIES Founder`;

      const conversationHistory = messages.map(m => ({
        id: m.id,
        sender: m.from_agent === false ? 'customer' : m.channel === 'internal-note' ? 'note' : 'agent',
        body_html: m.stripped_html || m.body_html || null,
        body: gorgias.stripHtml(m.stripped_html || m.stripped_text || m.body_html || m.body_text || ''),
        created_at: m.created_datetime,
        channel: m.channel,
      }));

      await supabase.from('cs_ai_drafts').insert({
        gorgias_ticket_id: ticketId,
        gorgias_message_id: latestCustomerMsgId,
        customer_email: customerEmail,
        customer_name: ticket.customer?.name || null,
        order_number: null,
        draft_response: draftResponse,
        structured_output: { status: 'complete', reason: 'thank_you_response' },
        intake_state: previousIntake,
        audit_trail: ['[Quick detect] Customer said thank you after agent reply — auto "you\'re welcome"'],
        confidence: 'high',
        advisor_status: 'complete',
        message_type: 'positive_feedback',
        conversation_history: conversationHistory,
        turn_number: turnNumber,
        previous_draft_id: previousDraftId,
      });
      draftsCreated++;
      console.log(`[poller] Thank-you draft created for ticket ${ticketId}`);

      if (aiBotId) {
        try {
          await gorgias.assignTicket(ticketId, aiBotId);
          await gorgias.addTicketTag(ticketId, 'ai-draft');
        } catch (err) {
          console.warn(`[poller] Could not assign/tag ticket ${ticketId}: ${err.message}`);
        }
      }
      return;
    }

    // Build conversation context from all previous messages
    const conversationContext = buildConversationContext(messages, latestCustomerMsg.id);

    // Enrich with structured data from previous drafts (if any)
    const previousDraftContext = await buildPreviousDraftContext(supabase, ticketId);

    // Combine context + previous processing + latest message
    const contextParts = [];
    if (conversationContext) contextParts.push(`[CONVERSATION HISTORY]\n${conversationContext}`);
    if (previousDraftContext) contextParts.push(`[PREVIOUS AI PROCESSING]\n${previousDraftContext}`);
    contextParts.push(`[LATEST CUSTOMER MESSAGE]\n${messageText}`);
    const issueDescription = contextParts.join('\n\n');

    // Run through CS advisor
    console.log(`[poller] Processing ticket ${ticketId} — "${messageText.substring(0, 80)}..."`);
    const advisorHandler = getAdvisorHandler();

    let result;
    try {
      result = await advisorHandler({
        customer_email: customerEmail,
        issue_description: issueDescription,
        intake: previousIntake || undefined,
      });
    } catch (err) {
      // Advisor crashed (likely missing Shopify customer) — skip, don't create junk draft
      // TODO: fix null safety in exchangeAdvisor.js so this doesn't crash
      console.log(`[poller] Advisor error on ticket ${ticketId}: ${err.message}`);
      ticketsSkipped++;
      return;
    }

    const structured = result?._structured;
    if (!structured) {
      console.warn(`[poller] No structured output for ticket ${ticketId}`);
      return;
    }

    // Check if AI can handle this type or if it needs manual response
    const routeToHuman = structured.status === 'route_to_human'
      || (structured.error && !structured.intake);

    // Compose the draft response (or placeholder for route-to-human)
    const previousResponses = [];
    let draftResponse;
    if (routeToHuman) {
      // Can't auto-draft — create placeholder for training data capture
      const routeReason = structured.results?.[0]?.summary || structured.error || 'Unhandled message type';
      draftResponse = `[AI could not draft a response — needs manual reply]\n\nRoute reason: ${routeReason}\n\nCustomer message: ${messageText}`;
      console.log(`[poller] Ticket ${ticketId} routed to human — creating training draft`);
    } else {
      try {
        draftResponse = await composeAgentResponse(structured, previousResponses);
      } catch (composeErr) {
        console.warn(`[poller] Compose failed for ticket ${ticketId}: ${composeErr.message}`);
        ticketsSkipped++;
        return;
      }
    }

    // Format: ensure paragraph breaks and add signature (skip for placeholders)
    if (!routeToHuman && !draftResponse.startsWith('[AI')) {
      draftResponse = formatDraftResponse(draftResponse, structured);
    }

    // Compute confidence
    const confidence = routeToHuman ? 'low' : computeConfidence(structured);

    // Build conversation history snapshot
    const conversationHistory = messages.map(m => ({
      id: m.id,
      sender: m.from_agent === false ? 'customer' : m.channel === 'internal-note' ? 'note' : 'agent',
      body_html: m.stripped_html || m.body_html || null,
      body: gorgias.stripHtml(m.stripped_html || m.stripped_text || m.body_html || m.body_text || ''),
      created_at: m.created_datetime,
      channel: m.channel,
    }));

    // Determine action type from prescription
    let actionType = null;
    if (structured.status === 'ready') {
      const hasExchange = structured.prescription?.items?.some(i => i.state === 'CONFIRMED');
      const hasRefund = structured.prescription?.items?.some(i => i.state === 'REFUND_CONFIRMED');
      if (hasExchange && hasRefund) actionType = 'exchange+refund';
      else if (hasExchange) actionType = 'exchange';
      else if (hasRefund) actionType = 'refund';
    }

    // Insert draft
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
        confidence,
        advisor_status: structured.status,
        message_type: structured.intake?.items?.[0]?.issue || 'unknown',
        conversation_history: conversationHistory,
        order_context: structured.order || null,
        customer_context: {
          email: structured.customer?.email,
          name: structured.customer?.name,
          pronouns: structured.customer?.pronouns,
          country: structured.customer?.country,
          buying_for: structured.customer?.buying_for,
          address: structured.customer?.address,
        },
        action_type: actionType,
        turn_number: turnNumber,
        previous_draft_id: previousDraftId,
      });

    if (insertErr) {
      console.error(`[poller] Insert error for ticket ${ticketId}: ${insertErr.message}`);
      return;
    }

    draftsCreated++;
    console.log(`[poller] Draft created for ticket ${ticketId} (confidence: ${confidence}, status: ${structured.status})`);

    // Assign to AI Bot in Gorgias
    if (aiBotId) {
      try {
        await gorgias.assignTicket(ticketId, aiBotId);
        await gorgias.addTicketTag(ticketId, 'ai-draft');
      } catch (err) {
        console.warn(`[poller] Could not assign/tag ticket ${ticketId}: ${err.message}`);
      }
    }
  }
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

/**
 * Add paragraph breaks and signature to draft response.
 * Jamie's style: greeting, body paragraphs, sign-off + signature on separate lines.
 */
function formatDraftResponse(text, structured) {
  if (!text) return text;

  // Don't re-format if already has clear paragraph structure
  const hasMultipleNewlines = (text.match(/\n\n/g) || []).length >= 2;
  if (hasMultipleNewlines) {
    // Just ensure signature exists
    return ensureSignature(text, structured);
  }

  // Split into sentences and rebuild with paragraph breaks
  // Greeting line (Hi X, / Thanks X!) should be its own paragraph
  let formatted = text;
  formatted = formatted.replace(/^((?:Hi|Hey|Thanks|Hello)[^.!?]*[.!?])\s+/i, '$1\n\n');

  // Add signature if missing
  formatted = ensureSignature(formatted, structured);

  return formatted;
}

function ensureSignature(text, structured) {
  // Check if signature already present
  if (/Jamie Alexander/i.test(text)) return text;

  // Determine sign-off: "Talk soon" if needs_info/gathering (expecting reply), "Take care" if ready/complete
  const isAwaiting = structured?.status === 'needs_info' || structured?.status === 'gathering';
  const signOff = isAwaiting ? 'Talk soon,' : 'Take care,';

  return text.trimEnd() + '\n\n' + signOff + '\nJamie Alexander, RUBIES Founder';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeConfidence(structured) {
  if (structured.status === 'ready') {
    const allResolved = structured.prescription?.items?.every(i =>
      i.state === 'CONFIRMED' || i.state === 'REFUND_CONFIRMED' || i.state === 'ACKNOWLEDGED'
    );
    return allResolved ? 'high' : 'medium';
  }
  if (structured.status === 'needs_info') return 'medium';
  return 'low';
}

async function detectBypass(supabase, ticketId, messages) {
  // Check if there are pending drafts for this ticket that Jamie responded to directly
  const { data: pendingDrafts } = await supabase
    .from('cs_ai_drafts')
    .select('id, draft_response, created_at')
    .eq('gorgias_ticket_id', ticketId)
    .eq('status', 'pending');

  if (!pendingDrafts?.length) return;

  // Find agent messages after the draft was created
  const agentMessages = messages.filter(m => m.from_agent === true);

  for (const draft of pendingDrafts) {
    const agentReplyAfterDraft = agentMessages.find(m =>
      new Date(m.created_datetime) > new Date(draft.created_at)
    );

    if (agentReplyAfterDraft) {
      const sentText = gorgias.stripHtml(agentReplyAfterDraft.body_html || agentReplyAfterDraft.body_text || '');
      const editDist = computeEditDistance(draft.draft_response, sentText);

      const status = editDist < 0.3 ? 'sent' : 'superseded';
      await supabase.from('cs_ai_drafts').update({
        status,
        sent_response: sentText,
        edit_distance: editDist,
        reviewed_at: agentReplyAfterDraft.created_datetime,
        sent_at: agentReplyAfterDraft.created_datetime,
      }).eq('id', draft.id);

      // Log feedback
      await supabase.from('cs_ai_feedback_log').insert({
        draft_id: draft.id,
        gorgias_ticket_id: ticketId,
        action: editDist < 0.3 ? 'sent' : 'bypassed',
        original_response: draft.draft_response,
        final_response: sentText,
        edit_distance: editDist,
      });

      console.log(`[poller] Bypass detected on ticket ${ticketId} — draft ${draft.id} marked as ${status} (edit_distance: ${editDist.toFixed(2)})`);
    }
  }
}

/**
 * Simple normalized edit distance (0 = identical, 1 = completely different).
 * Uses Levenshtein on word tokens for reasonable speed on CS-length messages.
 */
function computeEditDistance(a, b) {
  if (!a && !b) return 0;
  if (!a || !b) return 1;

  const wordsA = a.toLowerCase().split(/\s+/);
  const wordsB = b.toLowerCase().split(/\s+/);
  const maxLen = Math.max(wordsA.length, wordsB.length);
  if (maxLen === 0) return 0;

  // Simple word-level Levenshtein
  const m = wordsA.length;
  const n = wordsB.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = wordsA[i - 1] === wordsB[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n] / maxLen;
}

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

module.exports = { run };
