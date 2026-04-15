/**
 * Gorgias Ticket Intake
 *
 * Processes Gorgias customer messages (via webhook or manual trigger),
 * runs them through the CS advisor, and stores AI-drafted responses
 * in Supabase for dashboard review.
 *
 * Assigns handled tickets to "AI Bot" in Gorgias so they disappear from
 * Jamie's inbox/unassigned queues.
 *
 * Usage:
 *   node customer-service/intake/processGorgiasTickets.js   (standalone)
 *   npm run cs-intake
 *
 * Exports run() and processTicket() for programmatic use.
 */

const path = require('path');
if (!process.env.SUPABASE_URL) {
  require('dotenv').config({ path: path.resolve(__dirname, '../..', '.env') });
}

const { getSupabaseClient } = require('../../shared/supabaseClient');
const { buildContext } = require('../lib/contextBuilder');
const gorgias = require('../import/gorgiasClient');

// Lazy-load AI advisor
let _advisorHandler = null;

function getAdvisorHandler() {
  if (!_advisorHandler) {
    const { aiAdvisor } = require('../lib/aiAdvisor');
    _advisorHandler = aiAdvisor;
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
    console.warn(`[intake] Could not find Gorgias user "${AI_BOT_NAME}" — tickets will not be assigned`);
    return null;
  }
  _aiBotUserId = user.id;
  return _aiBotUserId;
}

// ---------------------------------------------------------------------------
// Core polling logic
// ---------------------------------------------------------------------------

// Gorgias help-center chat flows arrive as one concatenated message: bot
// prompt lines plus customer choices prefixed with `>`. Extract only the
// real customer free-text so the dashboard card isn't full of bot copy.
const HELP_CENTER_BUTTON_LABELS = new Set([
  'help me with a return or exchange',
  'start a return or exchange',
  'learn about our returns and exchanges policy',
  'sign in to continue',
  'no, i need more help',
  'exchange', 'return', 'refund',
  'go back', 'no', 'yes',
]);

function cleanHelpCenterBody(body) {
  if (!body) return body;
  // `>` markers can appear at line start OR inline after bot copy on the
  // same line, so match each `>` segment up to the next newline.
  const keep = [];
  for (const match of body.matchAll(/>\s*([^\n]+)/g)) {
    const text = match[1].trim();
    if (!text) continue;
    const lower = text.toLowerCase();
    if (HELP_CENTER_BUTTON_LABELS.has(lower)) continue;
    if (/^#\d+\s*[-–]\s*\$[\d.,]+/.test(text)) continue; // order pick
    if (/^\d+\s*x\s+/i.test(text)) continue; // selected line item
    if (/^THE\s+[A-Z].*\s[-–]\s/.test(text)) continue; // variant label
    keep.push(text);
  }
  return keep.join('\n').trim();
}

// ---------------------------------------------------------------------------
// Duplicate ticket detection
// ---------------------------------------------------------------------------

/**
 * Check if a new ticket is a duplicate of an existing open/snoozed ticket
 * from the same customer. Only calls the AI when there IS an existing ticket.
 *
 * @returns {string|object} 'close_new' | { action: 'close_existing', ticketsToClose } | 'keep_both' | null
 */
async function checkForDuplicateTicket(supabase, customerEmail, newTicketId, newMessages) {
  // Quick check: does this customer have any non-closed tickets?
  const { data: existingTickets } = await supabase
    .from('cs_tickets')
    .select('id, gorgias_ticket_id, order_number, status, message_type, conversation_history, created_at')
    .eq('customer_email', customerEmail)
    .in('status', ['open', 'snoozed', 'follow_up'])
    .neq('gorgias_ticket_id', newTicketId);

  if (!existingTickets?.length) return null; // No existing tickets — not a duplicate

  // There IS an existing ticket — ask Opus to compare
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic();

  const newContent = newMessages
    .filter(m => !m.from_agent)
    .map(m => gorgias.stripHtml(m.stripped_text || m.body_text || ''))
    .join('\n')
    .substring(0, 800);

  const existingSummaries = existingTickets.map(t => {
    const msgs = t.conversation_history || [];
    const customerMsgs = msgs.filter(m => m.sender === 'customer');
    const agentMsgs = msgs.filter(m => m.sender === 'agent' && !m.is_bot);
    const lastCustomer = customerMsgs[customerMsgs.length - 1]?.body?.substring(0, 300) || '';
    const lastAgent = agentMsgs[agentMsgs.length - 1]?.body?.substring(0, 200) || '';
    return `Ticket #${t.gorgias_ticket_id} (${t.status}, ${t.message_type || 'unknown'}, order ${t.order_number || 'none'}, created ${t.created_at?.substring(0, 10)}):
  Customer: ${lastCustomer}
  Agent reply: ${lastAgent || '(no reply yet)'}`;
  }).join('\n\n');

  const response = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 200,
    messages: [{ role: 'user', content: `A customer (${customerEmail}) just created a new support ticket. They already have existing open ticket(s). Determine if the new ticket is about the same issue.

EXISTING TICKET(S):
${existingSummaries}

NEW TICKET:
${newContent}

Respond with ONLY a JSON object:
{
  "action": "close_new" | "close_existing" | "keep_both",
  "reason": "brief explanation"
}

Rules:
- "close_new": new ticket is clearly about the same issue and the existing ticket has equal or more context (e.g. agent already replied). Close the new one.
- "close_existing": new ticket is about the same issue but has MORE context or detail. Close the old one(s), process the new one.
- "keep_both": tickets are about genuinely different issues (different orders, different problems). Keep both.
- Bot chat retries (short/empty messages about same topic) → close_new
- If existing ticket already has an agent reply with sizing help → close_new (don't restart the conversation)` }],
  });

  const text = response.content[0]?.text || '';
  try {
    const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || '{}');
    console.log(`[intake] Duplicate check for ${newTicketId}: ${parsed.action} — ${parsed.reason}`);

    if (parsed.action === 'close_new') return 'close_new';
    if (parsed.action === 'close_existing') {
      return { action: 'close_existing', ticketsToClose: existingTickets };
    }
    return 'keep_both';
  } catch {
    console.warn(`[intake] Could not parse duplicate check response: ${text.substring(0, 100)}`);
    return 'keep_both'; // When in doubt, keep both
  }
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
    console.log(`[intake] Skip ${ticketId}: draft exists for this message`);
    return { skipped: true };
  }

  // Check if a real human agent replied AFTER the latest customer message.
  // Skip bot messages (Gorgias rules), AI bot messages (our system), and
  // auto follow-ups sent via API — only skip if a human actually handled it.
  const messagesAfterCustomer = messages.filter(m =>
    new Date(m.created_datetime) > new Date(latestCustomerMsg.created_datetime)
    && m.from_agent === true
  );
  const humanRepliedAfter = messagesAfterCustomer.some(m => {
    if (m.sender?.email?.endsWith('@email.gorgias.com')) return false; // Gorgias rule
    if (m.via === 'rule') return false; // automation rule
    if (m.channel === 'internal-note') return false; // internal notes don't count
    if (aiBotId && m.sender?.id === aiBotId) return false; // our AI bot
    return true;
  });
  if (humanRepliedAfter) {
    console.log(`[intake] Skip ${ticketId}: human agent replied after latest customer message`);
    return { skipped: true };
  }

  const customerEmail = ticket.customer?.email;
  const senderName = [ticket.customer?.firstname, ticket.customer?.lastname]
    .filter(Boolean)
    .join(' ')
    .trim() || ticket.customer?.name || null;

  // Check for duplicate tickets from the same customer
  if (customerEmail) {
    const dupAction = await checkForDuplicateTicket(supabase, customerEmail, ticketId, messages);
    if (dupAction === 'close_new') {
      console.log(`[intake] Skip ${ticketId}: duplicate of existing ticket`);
      // Close in Gorgias FIRST — if this fails, operation fails and ticket stays open
      await gorgias.addInternalNote(ticketId, 'Auto-closed: duplicate of existing open ticket for this customer.');
      await gorgias.closeTicket(ticketId);
      return { skipped: true, reason: 'duplicate' };
    }
    if (dupAction?.action === 'close_existing') {
      console.log(`[intake] Closing older ticket(s) — this one has more context`);
      for (const oldTicket of dupAction.ticketsToClose) {
        // Close in Gorgias FIRST — if this fails, operation fails and ticket stays open
        await gorgias.addInternalNote(oldTicket.gorgias_ticket_id, `Auto-closed: superseded by newer ticket #${ticketId} with more context.`);
        await gorgias.closeTicket(oldTicket.gorgias_ticket_id);

        // Update DB only after Gorgias succeeded
        const nowIso = new Date().toISOString();
        await supabase
          .from('cs_tickets')
          .update({ status: 'closed', closed_at: nowIso, updated_at: nowIso })
          .eq('id', oldTicket.id);
      }
    }
    // 'keep_both' or no action → continue processing normally
  }

  // Get previous draft's intake state for multi-turn
  let previousIntake = null;
  let previousDraftId = null;
  const { data: prevDraft } = await supabase
    .from('cs_ai_drafts')
    .select('id, intake_state')
    .eq('gorgias_ticket_id', ticketId)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (prevDraft) {
    previousIntake = prevDraft.intake_state;
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
  // Surface attachment metadata (filenames + types) so the advisor knows what was attached
  const attachments = latestCustomerMsg.attachments || [];
  const attachmentNote = attachments.length
    ? `\n[ATTACHMENTS: ${attachments.map(a => `${a.name || 'file'} (${a.content_type || 'unknown type'})`).join(', ')}]`
    : '';
  contextParts.push(`[LATEST CUSTOMER MESSAGE]\n${messageText}${attachmentNote}`);
  const issueDescription = contextParts.join('\n\n');

  // Deterministic context fetch — always have order/customer data regardless of AI parse outcome
  let preContext = null;
  try {
    preContext = await buildContext({
      customer_email: customerEmail,
      customer_name: senderName,
      issue_description: issueDescription,
      existingIntake: previousIntake,
    });
  } catch (err) {
    console.warn(`[intake] Pre-context fetch failed for ${ticketId}: ${err.message}`);
  }

  // Run through hybrid advisor (Opus) with tree fallback
  console.log(`[intake] Processing ticket ${ticketId} — "${messageText.substring(0, 80)}..."`);

  let result;
  try {
    const advisorHandler = getAdvisorHandler();
    result = await advisorHandler({
      customer_email: customerEmail,
      issue_description: issueDescription,
      intake: previousIntake || undefined,
      preContext,
    });
  } catch (err) {
    console.error(`[intake] AI advisor error on ticket ${ticketId}: ${err.message}`);
    return { skipped: true };
  }

  const structured = result?._structured;
  if (!structured) {
    console.warn(`[intake] No structured output for ticket ${ticketId}`);
    return { skipped: true };
  }

  // Draft response comes from advisor (composed inside the tool)
  const routeToHuman = structured.status === 'route_to_human' || (structured.error && !structured.intake);
  let draftResponse;
  if (routeToHuman && !structured._composedResponse) {
    const routeReason = structured.results?.[0]?.summary || structured.error || 'Unhandled message type';
    draftResponse = `[AI could not draft a response — needs manual reply]\n\nRoute reason: ${routeReason}\n\nCustomer message: ${messageText}`;
    console.log(`[intake] Ticket ${ticketId} routed to human — creating training draft`);
  } else {
    draftResponse = structured._composedResponse || '[No response composed]';
  }

  // Build conversation history snapshot (for dashboard display)
  const conversationHistory = messages.map(m => {
    const sender = m.from_agent === false ? 'customer' : m.channel === 'internal-note' ? 'note' : 'agent';
    let bodyHtml = m.stripped_html || m.body_html || null;
    let bodyText = gorgias.stripHtml(m.stripped_html || m.stripped_text || m.body_html || m.body_text || '');
    // Help-center flows arrive as one blob with bot prompts + `>` customer
    // picks — strip the bot copy so the intake card shows only what the
    // customer actually typed.
    if (sender === 'customer' && m.channel === 'help-center') {
      bodyText = cleanHelpCenterBody(bodyText);
      bodyHtml = null; // force dashboard to render from cleaned plain text
    }
    return {
      id: m.id,
      sender,
      is_bot: m.from_agent !== false && m.via !== 'api' && (
        (m.sender?.email || '').endsWith('@email.gorgias.com') || m.via === 'rule'
      ),
      body_html: bodyHtml,
      body: bodyText,
      created_at: m.created_datetime,
      channel: m.channel,
      attachments: (m.attachments || []).map(a => ({
        name: a.name, url: a.url, content_type: a.content_type,
      })),
    };
  });

  // Count real messages (customer + non-bot agent, excluding internal notes and bot)
  const messageCount = conversationHistory.filter(m =>
    m.sender === 'customer' || (m.sender === 'agent' && !m.is_bot)
  ).length;

  // Detect if an agent has replied (from conversation history — catches replies made outside dashboard)
  const hasAgentReply = conversationHistory.some(m => m.sender === 'agent' && !m.is_bot);

  // Upsert cs_tickets row (ticket-centric model)
  const messageType = structured.intake?.message_type || structured.intake?.items?.[0]?.issue || 'unknown';
  const confidence = structured.confidence || 'low';

  // Get customer name — AI extraction, then preContext, then Supabase fallback
  let customerName = structured.customer?.name || null;
  if (!customerName && preContext?.customer) {
    customerName = [preContext.customer.firstName, preContext.customer.lastName].filter(Boolean).join(' ') || null;
  }
  if (!customerName && customerEmail) {
    const { data: custRow } = await supabase
      .from('customers')
      .select('first_name, last_name')
      .eq('email', customerEmail.toLowerCase())
      .maybeSingle();
    if (custRow) customerName = [custRow.first_name, custRow.last_name].filter(Boolean).join(' ') || null;
  }

  // Detect gmail-import source from Gorgias tags
  const ticketTags = (ticket.tags || []).map(tag => (tag.name || tag).toLowerCase());
  const ticketSource = ticketTags.includes('gmail-import') ? 'gmail' : 'gorgias';

  // Build upsert payload — only include fields with non-null values to avoid
  // clobbering good data from a previous turn when the AI parse fails
  const ticketUpsert = {
    gorgias_ticket_id: ticketId,
    created_at: ticket.created_datetime || new Date().toISOString(),
    status: 'open',
    message_count: messageCount,
    customer_email: customerEmail,
    conversation_history: conversationHistory,
    message_type: messageType,
    confidence,
    summary: structured.summary || null,
    history_summary: structured.history_summary || null,
    advisor_status: structured.status,
    source: ticketSource,
    updated_at: new Date().toISOString(),
    gorgias_status: ticket.status || 'open',
    gorgias_updated_at: ticket.updated_datetime || null,
  };
  // Only overwrite these if we got real values — don't clobber prior data with nulls
  // Fall back to preContext for order/customer data when AI parse fails
  if (customerName) ticketUpsert.customer_name = customerName;
  if (structured.customer?.pronouns) ticketUpsert.customer_pronouns = structured.customer.pronouns;
  if (structured.customer?.country || preContext?.customerCountry) {
    ticketUpsert.customer_country = structured.customer?.country || preContext.customerCountry;
  }
  if (structured.order?.name || preContext?.targetOrder?.name) {
    ticketUpsert.order_number = structured.order?.name || preContext.targetOrder.name;
  }
  if (structured.order) ticketUpsert.order_context = structured.order;
  if (structured.customer) ticketUpsert.customer_context = structured.customer;
  // Only set has_agent_reply to true, never back to false (one-way latch)
  if (hasAgentReply) ticketUpsert.has_agent_reply = true;

  const { data: ticketRow, error: ticketErr } = await supabase
    .from('cs_tickets')
    .upsert(ticketUpsert, { onConflict: 'gorgias_ticket_id' })
    .select('id')
    .single();

  if (ticketErr) {
    console.error(`[intake] Ticket upsert error for ${ticketId}: ${ticketErr.message}`);
    return { skipped: true };
  }

  // Insert draft — save advisor result verbatim, no post-processing
  const { data: newDraft, error: insertErr } = await supabase
    .from('cs_ai_drafts')
    .insert({
      ticket_id: ticketRow.id,
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
      message_type: messageType,
      conversation_history: conversationHistory,
      order_context: structured.order || null,
      customer_context: structured.customer || null,
      action_type: structured.action_type || null,
      previous_draft_id: previousDraftId,
    })
    .select('id')
    .single();

  if (insertErr) {
    console.error(`[intake] Insert error for ticket ${ticketId}: ${insertErr.message}`);
    return { skipped: true };
  }

  // Point ticket to the new active draft
  await supabase
    .from('cs_tickets')
    .update({ active_draft_id: newDraft.id })
    .eq('id', ticketRow.id);

  console.log(`[intake] Draft created for ticket ${ticketId} (confidence: ${confidence}, status: ${structured.status}, type: ${messageType})`);

  // Auto-dispose business outreach — close ticket, tag in Gorgias, mark draft as spam
  if (messageType === 'business_outreach') {
    const now = new Date().toISOString();
    await supabase.from('cs_tickets').update({
      status: 'closed',
      closed_at: now,
      updated_at: now,
      active_draft_id: null,
    }).eq('id', ticketRow.id);

    await supabase.from('cs_ai_drafts').update({ status: 'spam' }).eq('id', newDraft.id);

    try {
      await gorgias.addTicketTag(ticketId, 'business-outreach');
      await gorgias.closeTicket(ticketId);
      await gorgias.assignTicket(ticketId, null);
    } catch (err) {
      console.warn(`[intake] Could not close outreach ticket ${ticketId}: ${err.message}`);
    }

    console.log(`[intake] Auto-closed business outreach: ticket ${ticketId}`);
    return { drafted: true, outreach: true };
  }

  // Assign to AI Bot in Gorgias
  if (aiBotId) {
    try {
      await gorgias.assignTicket(ticketId, aiBotId);
      await gorgias.addTicketTag(ticketId, 'ai-draft');
    } catch (err) {
      console.warn(`[intake] Could not assign/tag ticket ${ticketId}: ${err.message}`);
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

module.exports = { processTicket, getAiBotUserId, buildConversationContext, buildPreviousDraftContext, checkForDuplicateTicket };
