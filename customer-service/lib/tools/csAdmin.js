/**
 * CS Admin MCP Tools — log conversations handled via Claude Code back into the knowledge base
 *
 * Tools: cs_log_conversation
 */

const { getSupabaseClient } = require('../../../shared/supabaseClient');
const { embed } = require('../embeddings');

// ---------------------------------------------------------------------------
// Tool: cs_log_conversation
// ---------------------------------------------------------------------------

async function handleLogConversation({ customer_email, category, summary, resolution_type, resolution_successful, messages }) {
  const supabase = getSupabaseClient();

  // Generate a unique ID
  const timestamp = Date.now();
  const convId = `claude_code:${timestamp}`;

  // Generate embedding from the summary
  let embedding = null;
  try {
    embedding = await embed(summary);
  } catch (e) {
    console.error('[csAdmin] Warning: could not generate embedding:', e.message);
  }

  // Insert conversation
  const { error: convErr } = await supabase
    .from('cs_conversations')
    .upsert({
      id: convId,
      source: 'claude_code',
      source_id: String(timestamp),
      customer_email: customer_email || null,
      subject: summary.slice(0, 100),
      status: 'resolved',
      channel: 'claude_code',
      category: category || 'general',
      resolution_successful: resolution_successful != null ? resolution_successful : true,
      resolution_type: resolution_type || 'info_provided',
      summary,
      created_at: new Date().toISOString(),
      resolved_at: new Date().toISOString(),
      message_count: (messages || []).length,
      embedding: embedding ? JSON.stringify(embedding) : null,
    });

  if (convErr) throw new Error(`Failed to log conversation: ${convErr.message}`);

  // Insert messages
  if (messages && messages.length > 0) {
    const msgRows = messages.map((m, i) => ({
      id: `claude_code:${timestamp}:${i}`,
      conversation_id: convId,
      source: 'claude_code',
      sender_type: m.sender_type || 'agent',
      sender_name: m.sender_name || null,
      body_text: m.body_text,
      created_at: new Date(Date.now() + i * 1000).toISOString(), // Order by index
    }));

    const { error: msgErr } = await supabase
      .from('cs_messages')
      .upsert(msgRows);

    if (msgErr) console.error('[csAdmin] Warning: could not save messages:', msgErr.message);
  }

  let md = `## Conversation Logged\n\n`;
  md += `**ID:** \`${convId}\`\n`;
  md += `**Category:** ${category || 'general'}\n`;
  md += `**Resolution:** ${resolution_type || 'info_provided'}\n`;
  md += `**Successful:** ${resolution_successful !== false ? 'Yes' : 'No'}\n`;
  md += `**Messages saved:** ${(messages || []).length}\n\n`;
  md += `This conversation is now searchable via \`cs_search_history\` and will help improve future responses.`;

  return { content: [{ type: 'text', text: md }] };
}

// ---------------------------------------------------------------------------
// Tool: cs_update_conversation
// ---------------------------------------------------------------------------

async function handleUpdateConversation({ conversation_id, category, resolution_type, resolution_successful, tags, notes }) {
  const supabase = getSupabaseClient();

  // Verify conversation exists
  const { data: existing, error: fetchErr } = await supabase
    .from('cs_conversations')
    .select('id, category, resolution_type, resolution_successful, summary')
    .eq('id', conversation_id)
    .limit(1);

  if (fetchErr) throw new Error(`Failed to fetch conversation: ${fetchErr.message}`);
  if (!existing || !existing.length) throw new Error(`Conversation not found: ${conversation_id}`);

  const current = existing[0];
  const updates = {};
  const changes = [];

  if (category && category !== current.category) {
    updates.category = category;
    changes.push(`category: ${current.category} → ${category}`);
  }
  if (resolution_type && resolution_type !== current.resolution_type) {
    updates.resolution_type = resolution_type;
    changes.push(`resolution_type: ${current.resolution_type} → ${resolution_type}`);
  }
  if (resolution_successful != null && resolution_successful !== current.resolution_successful) {
    updates.resolution_successful = resolution_successful;
    changes.push(`resolution_successful: ${current.resolution_successful} → ${resolution_successful}`);
  }
  if (notes) {
    // Append notes to summary
    updates.summary = current.summary + `\n\n[Update ${new Date().toISOString().split('T')[0]}]: ${notes}`;
    changes.push(`notes appended`);

    // Re-embed with updated summary
    try {
      const embedding = await embed(updates.summary);
      updates.embedding = JSON.stringify(embedding);
    } catch (e) {
      console.error('[csAdmin] Warning: could not re-embed:', e.message);
    }
  }
  if (tags) {
    // Store tags in the summary since cs_conversations doesn't have a tags column
    const tagStr = Array.isArray(tags) ? tags.join(', ') : tags;
    updates.summary = (updates.summary || current.summary) + `\n[Tags: ${tagStr}]`;
    changes.push(`tags: ${tagStr}`);
  }

  if (!changes.length) {
    return { content: [{ type: 'text', text: 'No changes to apply.' }] };
  }

  const { error: updateErr } = await supabase
    .from('cs_conversations')
    .update(updates)
    .eq('id', conversation_id);

  if (updateErr) throw new Error(`Failed to update: ${updateErr.message}`);

  let md = `## Conversation Updated\n\n`;
  md += `**ID:** \`${conversation_id}\`\n\n`;
  md += `**Changes:**\n`;
  for (const c of changes) md += `- ${c}\n`;

  return { content: [{ type: 'text', text: md }] };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const tools = [
  {
    name: 'cs_log_conversation',
    description: 'Log a customer service conversation handled via Claude Code back into the knowledge base. Creates a feedback loop — successful conversations become searchable history for future reference.',
    inputSchema: {
      type: 'object',
      properties: {
        customer_email: {
          type: 'string',
          description: 'Customer email address',
        },
        category: {
          type: 'string',
          description: 'Conversation category: sizing_fit, exchange_return, order_status, wholesale, shipping, product_info, payment, general',
        },
        summary: {
          type: 'string',
          description: 'Brief summary of the conversation and resolution',
        },
        resolution_type: {
          type: 'string',
          description: 'How was it resolved: exchange, refund, info_provided, no_action, escalated',
        },
        resolution_successful: {
          type: 'boolean',
          description: 'Was the customer satisfied with the resolution?',
        },
        messages: {
          type: 'array',
          description: 'Array of messages in the conversation',
          items: {
            type: 'object',
            properties: {
              sender_type: {
                type: 'string',
                description: 'Who sent this: customer or agent',
              },
              body_text: {
                type: 'string',
                description: 'Message text content',
              },
              sender_name: {
                type: 'string',
                description: 'Name of the sender (optional)',
              },
            },
          },
        },
      },
      required: ['summary'],
    },
    handler: handleLogConversation,
  },
  {
    name: 'cs_update_conversation',
    description: 'Update metadata on a logged conversation: re-categorize, change resolution, add notes or tags. Use cs_search_history to find the conversation ID first.',
    inputSchema: {
      type: 'object',
      properties: {
        conversation_id: {
          type: 'string',
          description: 'Conversation ID (e.g. "claude_code:1710000000000" or "gorgias:12345")',
        },
        category: {
          type: 'string',
          description: 'New category: sizing_fit, exchange_return, order_status, wholesale, shipping, product_info, payment, general',
        },
        resolution_type: {
          type: 'string',
          description: 'New resolution type: exchange, refund, info_provided, no_action, escalated',
        },
        resolution_successful: {
          type: 'boolean',
          description: 'Update whether the resolution was successful',
        },
        tags: {
          type: 'string',
          description: 'Comma-separated tags to add (e.g. "duplicate, follow-up-needed")',
        },
        notes: {
          type: 'string',
          description: 'Additional notes to append to the conversation summary',
        },
      },
      required: ['conversation_id'],
    },
    handler: handleUpdateConversation,
  },
  // -----------------------------------------------------------------------
  // Tool: check_follow_ups
  // -----------------------------------------------------------------------
  {
    name: 'check_follow_ups',
    description: 'Audit snoozed tickets and their follow-up stage. Reports which tickets are queued for auto follow-up (event-driven off Gorgias snooze expiry). Read-only — does not send or create anything.',
    inputSchema: {
      type: 'object',
      properties: {
        include_closed: {
          type: 'boolean',
          description: 'Include recently closed tickets that completed the follow-up cycle (default: false)',
        },
      },
    },
    handler: async ({ include_closed = false }) => {
      const supabase = getSupabaseClient();

      // Query snoozed tickets (and optionally recently closed follow-up-completed tickets)
      let query = supabase
        .from('cs_tickets')
        .select('id, gorgias_ticket_id, customer_email, customer_name, status, follow_up_stage, snoozed_at, closed_at, updated_at')
        .order('snoozed_at', { ascending: false });

      if (include_closed) {
        query = query.in('status', ['snoozed', 'closed']).gte('follow_up_stage', 0);
      } else {
        query = query.eq('status', 'snoozed');
      }

      const { data: tickets, error } = await query.limit(100);
      if (error) return { content: [{ type: 'text', text: `Error: ${error.message}` }] };

      const results = (tickets || []).map(t => {
        const snoozedDaysAgo = t.snoozed_at
          ? Math.round((Date.now() - new Date(t.snoozed_at).getTime()) / (24 * 60 * 60 * 1000))
          : null;
        const stageLabel = t.follow_up_stage === 0 ? 'awaiting stage 1'
          : t.follow_up_stage === 1 ? 'stage 1 sent, awaiting stage 2'
          : t.follow_up_stage === 2 ? 'complete (jamie@ sent, closed)'
          : `stage ${t.follow_up_stage}`;
        return {
          ticket_id: t.gorgias_ticket_id,
          customer: t.customer_email,
          name: t.customer_name,
          status: t.status,
          follow_up_stage: t.follow_up_stage,
          stage_label: stageLabel,
          snoozed_days_ago: snoozedDaysAgo,
        };
      });

      const snoozed = results.filter(r => r.status === 'snoozed');
      const summary = `${snoozed.length} snoozed ticket(s) in follow-up pipeline` +
        (include_closed ? `, ${results.length - snoozed.length} closed` : '') +
        `\n\nFollow-ups are event-driven: Gorgias snooze expiry triggers the webhook handler.`;

      return { content: [{ type: 'text', text: `${summary}\n\n${JSON.stringify(results, null, 2)}` }] };
    },
  },

  // -----------------------------------------------------------------------
  // Tool: detect_bypasses
  // -----------------------------------------------------------------------
  {
    name: 'detect_bypasses',
    description: 'Detect pending AI drafts that were bypassed (operator replied directly in Gorgias instead of using the dashboard). Marks them as sent or superseded based on edit distance.',
    inputSchema: {
      type: 'object',
      properties: {
        ticket_id: {
          type: 'number',
          description: 'Specific Gorgias ticket ID to check. If omitted, checks all pending drafts.',
        },
      },
    },
    handler: async ({ ticket_id }) => {
      const supabase = getSupabaseClient();
      let gorgiasClient;
      try {
        gorgiasClient = require('../../import/gorgiasClient');
      } catch (e) {
        return { content: [{ type: 'text', text: 'Error: Gorgias client not available' }] };
      }

      // Get pending drafts
      let query = supabase.from('cs_ai_drafts').select('id, gorgias_ticket_id, draft_response, created_at').eq('status', 'pending');
      if (ticket_id) query = query.eq('gorgias_ticket_id', ticket_id);
      const { data: pendingDrafts, error } = await query;

      if (error) return { content: [{ type: 'text', text: `Error: ${error.message}` }] };
      if (!pendingDrafts?.length) return { content: [{ type: 'text', text: 'No pending drafts found' }] };

      // Group by ticket
      const byTicket = {};
      for (const d of pendingDrafts) {
        if (!byTicket[d.gorgias_ticket_id]) byTicket[d.gorgias_ticket_id] = [];
        byTicket[d.gorgias_ticket_id].push(d);
      }

      const results = [];
      for (const [tid, drafts] of Object.entries(byTicket)) {
        let messages;
        try {
          messages = await gorgiasClient.getTicketMessages(parseInt(tid));
        } catch (e) {
          results.push({ ticket_id: tid, error: e.message });
          continue;
        }

        const agentMessages = messages.filter(m => m.from_agent === true);

        for (const draft of drafts) {
          const agentReplyAfterDraft = agentMessages.find(m =>
            new Date(m.created_datetime) > new Date(draft.created_at)
          );

          if (agentReplyAfterDraft) {
            const sentText = gorgiasClient.stripHtml(agentReplyAfterDraft.body_html || agentReplyAfterDraft.body_text || '');
            const wasEdited = (draft.draft_response || '').trim() !== sentText.trim();
            const status = wasEdited ? 'superseded' : 'sent';

            await supabase.from('cs_ai_drafts').update({
              status,
              sent_response: sentText,
              reviewed_at: agentReplyAfterDraft.created_datetime,
              sent_at: agentReplyAfterDraft.created_datetime,
            }).eq('id', draft.id);

            await supabase.from('cs_ai_feedback_log').insert({
              draft_id: draft.id,
              gorgias_ticket_id: parseInt(tid),
              action: wasEdited ? 'bypassed' : 'sent',
              original_response: draft.draft_response,
              final_response: sentText,
            });

            results.push({ draft_id: draft.id, ticket_id: tid, status });
          }
        }

        await new Promise(r => setTimeout(r, 500));
      }

      return { content: [{ type: 'text', text: `Checked ${pendingDrafts.length} drafts, ${results.length} bypasses detected\n\n${JSON.stringify(results, null, 2)}` }] };
    },
  },
];

/**
 * Word-level Levenshtein edit distance (0 = identical, 1 = completely different).
 */
// ---------------------------------------------------------------------------
// Auto follow-up engine (runs autonomously, not an MCP tool)
// ---------------------------------------------------------------------------

const MIN_AGE_DAYS = 3;
const MAX_AGE_DAYS = 7;

let _followUpRunning = false;

/**
 * Build the personal follow-up email (Stage 2) from jamie@rubyshines.com.
 */
function buildPersonalFollowUpEmail(customerName, originalResponse) {
  const greeting = customerName ? `Hi ${customerName}` : 'Hi there';

  const text = `${greeting},

I wanted to follow up on your inquiry in case my initial response and follow up ended up in your spam folder. This is what I wrote:

${originalResponse}

Talk soon,
Jamie Alexander
RUBIES Founder`;

  const escapedResponse = (originalResponse || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');

  const html = `<p>${greeting},</p>
<p>I wanted to follow up on your inquiry in case my initial response and follow up ended up in your spam folder. This is what I wrote:</p>
<blockquote style="border-left: 3px solid #ccc; padding-left: 12px; margin: 16px 0; color: #555;">
${escapedResponse}
</blockquote>
<p>Talk soon,<br>Jamie Alexander<br>RUBIES Founder</p>`;

  return { subject: 'Follow up from your RUBIES inquiry', text, html };
}

/**
 * Process auto follow-ups for snoozed tickets.
 *
 * Stage 1 (day 3): Send follow-up via Gorgias (care@), re-snooze 3 days.
 * Stage 2 (day 6): Send personal email via SendGrid (jamie@), close ticket.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.dry_run=false] — log what would happen without sending
 * @returns {{ stage1Sent, stage2Sent, skipped, errors, candidates: object[] }}
 */
async function processAutoFollowUps({ dry_run = false } = {}) {
  if (_followUpRunning) {
    console.log('[follow-up] Already running, skipping');
    return { stage1Sent: 0, stage2Sent: 0, skipped: 0, errors: 0, candidates: [] };
  }
  _followUpRunning = true;

  const supabase = getSupabaseClient();
  let gorgias;
  try {
    gorgias = require('../../import/gorgiasClient');
  } catch (e) {
    _followUpRunning = false;
    throw new Error('Gorgias client not available');
  }

  const now = Date.now();
  const minCutoff = new Date(now - MIN_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const maxCutoff = new Date(now - MAX_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString();

  let stage1Sent = 0, stage2Sent = 0, skipped = 0, errors = 0;
  const candidates = [];

  try {
    // Get all snoozed tickets
    const { data: snoozedTickets, error: ticketErr } = await supabase
      .from('cs_tickets')
      .select('id, gorgias_ticket_id, customer_email, customer_name, status, snoozed_at')
      .eq('status', 'snoozed');

    if (ticketErr) throw ticketErr;
    if (!snoozedTickets?.length) {
      console.log('[follow-up] No snoozed tickets');
      return { stage1Sent, stage2Sent, skipped, errors, candidates };
    }

    // --- STAGE 1: Gorgias follow-up (care@) ---
    for (const ticket of snoozedTickets) {
      try {
        const { data: draft } = await supabase
          .from('cs_ai_drafts')
          .select('id, gorgias_ticket_id, customer_email, customer_name, order_number, sent_at, sent_response, message_type')
          .eq('gorgias_ticket_id', ticket.gorgias_ticket_id)
          .eq('status', 'sent')
          .is('follow_up_draft_id', null)
          .eq('draft_kind', 'advisor_draft')
          .order('sent_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (!draft?.sent_at) continue;

        // Check age window: 3-7 days
        const sentAt = new Date(draft.sent_at);
        if (sentAt > new Date(minCutoff) || sentAt < new Date(maxCutoff)) {
          continue; // Too fresh or too stale
        }

        const daysAgo = Math.round((now - sentAt.getTime()) / (24 * 60 * 60 * 1000));
        const entry = { stage: 1, ticket_id: ticket.gorgias_ticket_id, email: draft.customer_email, name: draft.customer_name, days_ago: daysAgo };
        candidates.push(entry);

        if (dry_run) {
          console.log(`[follow-up] DRY RUN Stage 1: ${draft.customer_email} (${daysAgo}d ago)`);
          continue;
        }

        // Belt-and-suspenders: verify Gorgias status
        let gorgiasTicket;
        try {
          gorgiasTicket = await gorgias.getTicket(ticket.gorgias_ticket_id);
        } catch (e) {
          console.warn(`[follow-up] Could not fetch Gorgias ticket ${ticket.gorgias_ticket_id}: ${e.message}`);
          skipped++;
          continue;
        }
        if (gorgiasTicket?.status === 'closed') {
          console.log(`[follow-up] Skip ${ticket.gorgias_ticket_id}: closed in Gorgias`);
          skipped++;
          continue;
        }

        // Send follow-up via Gorgias
        const greeting = draft.customer_name ? `Hi ${draft.customer_name}` : 'Hi there';
        const followUpText = `${greeting}, just checking in! Did you have any questions about the exchange? Happy to help if so.\n\nTalk soon,\nJamie Alexander, RUBIES Founder`;

        const replyResult = await gorgias.createTicketReply(ticket.gorgias_ticket_id, {
          body_text: followUpText,
          body_html: `<p>${followUpText.replace(/\n/g, '<br>')}</p>`,
        });

        // Create audit draft record. gorgias_message_id NULL, not 0 — a
        // second (ticket, 0) row collides on the unique constraint and the
        // audit row is silently lost (see followUp.js).
        const { data: newDraft } = await supabase
          .from('cs_ai_drafts')
          .insert({
            gorgias_ticket_id: ticket.gorgias_ticket_id,
            gorgias_message_id: null,
            customer_email: draft.customer_email,
            customer_name: draft.customer_name,
            order_number: draft.order_number,
            draft_response: followUpText,
            sent_response: followUpText,
            structured_output: { status: 'follow_up', reason: `${MIN_AGE_DAYS}-day no-reply auto follow-up` },
            audit_trail: ['[Auto Follow-up Stage 1] 3-day no-reply, sent via Gorgias'],
            confidence: 'high',
            advisor_status: 'follow_up',
            draft_kind: 'follow_up_care',
            status: 'sent',
            sent_at: new Date().toISOString(),
            previous_draft_id: draft.id,
            gorgias_reply_message_id: replyResult?.id || null,
            source: 'auto_follow_up',
          })
          .select('id')
          .single();

        // Link original → follow-up
        if (newDraft) {
          await supabase.from('cs_ai_drafts').update({ follow_up_draft_id: newDraft.id }).eq('id', draft.id);
        }

        // Log feedback
        await supabase.from('cs_ai_feedback_log').insert({
          draft_id: draft.id,
          gorgias_ticket_id: ticket.gorgias_ticket_id,
          action: 'auto_follow_up_stage1',
          feedback_notes: 'Auto follow-up sent via Gorgias (care@)',
        });

        // Re-snooze for 3 more days
        try {
          await gorgias.snoozeTicket(ticket.gorgias_ticket_id, 3);
        } catch (e) {
          console.warn(`[follow-up] Could not re-snooze ticket ${ticket.gorgias_ticket_id}: ${e.message}`);
        }

        // Update ticket snoozed_at
        await supabase.from('cs_tickets').update({
          snoozed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).eq('id', ticket.id);

        console.log(`[follow-up] Stage 1 sent: ${draft.customer_email} (ticket ${ticket.gorgias_ticket_id})`);
        stage1Sent++;
        entry.sent = true;

        await gorgias.delay(500);
      } catch (err) {
        console.error(`[follow-up] Stage 1 error on ticket ${ticket.gorgias_ticket_id}: ${err.message}`);
        errors++;
      }
    }

    // --- STAGE 2: Personal email (jamie@) ---
    for (const ticket of snoozedTickets) {
      try {
        const { data: followUpDraft } = await supabase
          .from('cs_ai_drafts')
          .select('id, gorgias_ticket_id, customer_email, customer_name, order_number, sent_at, previous_draft_id')
          .eq('gorgias_ticket_id', ticket.gorgias_ticket_id)
          .eq('status', 'sent')
          .eq('draft_kind', 'follow_up_care')
          .is('follow_up_draft_id', null)
          .order('sent_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (!followUpDraft?.sent_at) continue;

        // Check age window: 3-7 days since the follow-up was sent
        const sentAt = new Date(followUpDraft.sent_at);
        if (sentAt > new Date(minCutoff) || sentAt < new Date(maxCutoff)) {
          continue;
        }

        const daysAgo = Math.round((now - sentAt.getTime()) / (24 * 60 * 60 * 1000));

        // Trace back to original draft for the sent_response
        let originalResponse = null;
        if (followUpDraft.previous_draft_id) {
          const { data: origDraft } = await supabase
            .from('cs_ai_drafts')
            .select('sent_response, draft_response')
            .eq('id', followUpDraft.previous_draft_id)
            .single();
          originalResponse = origDraft?.sent_response || origDraft?.draft_response || null;
        }

        if (!originalResponse) {
          console.warn(`[follow-up] Skip stage 2 for ticket ${ticket.gorgias_ticket_id}: no original response found`);
          skipped++;
          continue;
        }

        const entry = { stage: 2, ticket_id: ticket.gorgias_ticket_id, email: followUpDraft.customer_email, name: followUpDraft.customer_name, days_ago: daysAgo };
        candidates.push(entry);

        if (dry_run) {
          console.log(`[follow-up] DRY RUN Stage 2: ${followUpDraft.customer_email} (follow-up ${daysAgo}d ago)`);
          continue;
        }

        // Belt-and-suspenders: verify Gorgias status
        let gorgiasTicket;
        try {
          gorgiasTicket = await gorgias.getTicket(ticket.gorgias_ticket_id);
        } catch (e) {
          console.warn(`[follow-up] Could not fetch Gorgias ticket ${ticket.gorgias_ticket_id}: ${e.message}`);
          skipped++;
          continue;
        }
        if (gorgiasTicket?.status === 'closed') {
          console.log(`[follow-up] Skip ${ticket.gorgias_ticket_id}: closed in Gorgias`);
          skipped++;
          continue;
        }

        // Send personal email via SendGrid
        const { getSendgridClient } = require('../../../shared/sendgridClient');
        const sgMail = getSendgridClient();
        if (!sgMail) {
          console.error('[follow-up] SendGrid not configured — cannot send stage 2 personal email');
          errors++;
          continue;
        }

        const email = buildPersonalFollowUpEmail(followUpDraft.customer_name, originalResponse);
        await sgMail.send({
          to: followUpDraft.customer_email,
          from: { name: 'Jamie Alexander', email: 'jamie@rubyshines.com' },
          subject: email.subject,
          text: email.text,
          html: email.html,
          trackingSettings: { clickTracking: { enable: false, enableText: false } },
        });

        // Create audit draft record (gorgias_message_id NULL — see above).
        const { data: newDraft } = await supabase
          .from('cs_ai_drafts')
          .insert({
            gorgias_ticket_id: ticket.gorgias_ticket_id,
            gorgias_message_id: null,
            customer_email: followUpDraft.customer_email,
            customer_name: followUpDraft.customer_name,
            order_number: followUpDraft.order_number,
            draft_response: email.text,
            sent_response: email.text,
            structured_output: { status: 'personal_follow_up', reason: '6-day no-reply, personal email from jamie@' },
            audit_trail: ['[Auto Follow-up Stage 2] 6-day no-reply, personal email from jamie@rubyshines.com'],
            confidence: 'high',
            advisor_status: 'follow_up',
            draft_kind: 'follow_up_personal',
            status: 'sent',
            sent_at: new Date().toISOString(),
            previous_draft_id: followUpDraft.id,
            source: 'auto_follow_up',
          })
          .select('id')
          .single();

        // Link stage 1 → stage 2
        if (newDraft) {
          await supabase.from('cs_ai_drafts').update({ follow_up_draft_id: newDraft.id }).eq('id', followUpDraft.id);
        }

        // Log feedback
        await supabase.from('cs_ai_feedback_log').insert({
          draft_id: followUpDraft.id,
          gorgias_ticket_id: ticket.gorgias_ticket_id,
          action: 'auto_follow_up_stage2',
          feedback_notes: 'Personal follow-up sent via SendGrid (jamie@)',
        });

        // Close ticket in Gorgias
        try {
          await gorgias.closeTicket(ticket.gorgias_ticket_id);
          await gorgias.assignTicket(ticket.gorgias_ticket_id, null);
          await gorgias.addTicketTag(ticket.gorgias_ticket_id, 'auto-follow-up-closed');
        } catch (e) {
          console.warn(`[follow-up] Could not close ticket ${ticket.gorgias_ticket_id}: ${e.message}`);
        }

        // Update ticket status to closed
        await supabase.from('cs_tickets').update({
          status: 'closed',
          closed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          active_draft_id: null,
        }).eq('id', ticket.id);

        console.log(`[follow-up] Stage 2 sent: ${followUpDraft.customer_email} (ticket ${ticket.gorgias_ticket_id}) — closed`);
        stage2Sent++;
        entry.sent = true;

        await gorgias.delay(500);
      } catch (err) {
        console.error(`[follow-up] Stage 2 error on ticket ${ticket.gorgias_ticket_id}: ${err.message}`);
        errors++;
      }
    }
  } finally {
    _followUpRunning = false;
  }

  const summary = dry_run
    ? `DRY RUN: ${candidates.length} candidates (${candidates.filter(c => c.stage === 1).length} stage 1, ${candidates.filter(c => c.stage === 2).length} stage 2)`
    : `Stage 1: ${stage1Sent} sent, Stage 2: ${stage2Sent} sent, ${skipped} skipped, ${errors} errors`;
  console.log(`[follow-up] ${summary}`);

  return { stage1Sent, stage2Sent, skipped, errors, candidates };
}

module.exports = tools;
module.exports.processAutoFollowUps = processAutoFollowUps;
