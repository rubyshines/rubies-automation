/**
 * CS Draft Dashboard — local review server
 *
 * No external dependencies (uses Node built-in http module).
 * Serves the dashboard UI and proxies Gorgias/Supabase API calls.
 *
 * Usage: npm run dashboard
 * Default port: 3847 (override with PORT env var)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

if (!process.env.SUPABASE_URL) {
  require('dotenv').config({ path: path.resolve(__dirname, '../..', '.env') });
}

const { getSupabaseClient } = require('../../shared/supabaseClient');
const gorgias = require('../import/gorgiasClient');
const { fetchOrderByNumber, warehanceOrderUrl } = require('../../reports/lib/warehanceClient');
const { autoLinkProducts } = require('../lib/autoLinker');
const Anthropic = require('@anthropic-ai/sdk');

// Product config for auto-linking (loaded at startup)
let _productConfig = [];
async function loadProductConfig() {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('product_cs_config')
    .select('product_handle, nickname, category, keywords');
  if (error) { console.warn('[dashboard] Failed to load product config for auto-linker:', error.message); return; }
  _productConfig = data || [];
  console.log(`[dashboard] Auto-linker loaded ${_productConfig.length} products`);
}

const PORT = process.env.DASHBOARD_PORT || 3847;
const STATIC_DIR = path.join(__dirname, 'public');

// MIME types for static files
const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

// ---------------------------------------------------------------------------
// API handlers
// ---------------------------------------------------------------------------

async function apiGetDrafts(query) {
  const supabase = getSupabaseClient();
  const status = query.get('status') || 'pending';
  const limit = parseInt(query.get('limit') || '50', 10);

  let q = supabase
    .from('cs_ai_drafts')
    .select('id, gorgias_ticket_id, gorgias_message_id, customer_email, customer_name, customer_country, order_number, draft_response, confidence, advisor_status, message_type, action_type, turn_number, status, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (status !== 'all') q = q.eq('status', status);

  const { data, error } = await q;
  if (error) throw error;
  return data;
}

async function apiGetDraft(id) {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('cs_ai_drafts')
    .select('*')
    .eq('id', id)
    .single();
  if (error) throw error;
  return data;
}

async function apiSendDraft(id, body) {
  const supabase = getSupabaseClient();

  // Get the draft
  const { data: draft, error: fetchErr } = await supabase
    .from('cs_ai_drafts')
    .select('*')
    .eq('id', id)
    .single();
  if (fetchErr) throw fetchErr;
  if (draft.status !== 'pending') throw new Error(`Draft ${id} is not pending (status: ${draft.status})`);

  const finalResponse = body.response || draft.draft_response;
  const notes = body.notes || null;

  // Send to Gorgias (auto-link product names in HTML)
  const bodyHtml = autoLinkProducts(finalResponse, _productConfig);
  const replyResult = await gorgias.createTicketReply(draft.gorgias_ticket_id, {
    body_html: bodyHtml,
    body_text: finalResponse,
  });

  // Compute edit distance
  const editDist = computeEditDistance(draft.draft_response, finalResponse);

  // Update draft
  await supabase.from('cs_ai_drafts').update({
    status: 'sent',
    sent_response: finalResponse,
    edit_distance: editDist,
    feedback_notes: notes,
    reviewed_at: new Date().toISOString(),
    sent_at: new Date().toISOString(),
    gorgias_reply_message_id: replyResult?.id || null,
  }).eq('id', id);

  // Post-send action: snooze (default) or close
  const afterAction = body.after || 'snooze';

  // Log feedback (include which button was clicked)
  const baseAction = editDist < 0.05 ? 'sent' : 'edited';
  await supabase.from('cs_ai_feedback_log').insert({
    draft_id: id,
    gorgias_ticket_id: draft.gorgias_ticket_id,
    action: `${baseAction}_${afterAction}`,
    original_response: draft.draft_response,
    final_response: finalResponse,
    edit_distance: editDist,
    feedback_notes: notes,
    advisor_status: draft.advisor_status,
    confidence: draft.confidence,
    message_type: draft.message_type,
    turn_number: draft.turn_number,
  });
  try {
    if (afterAction === 'close') {
      await gorgias.closeTicket(draft.gorgias_ticket_id);
      await gorgias.assignTicket(draft.gorgias_ticket_id, null);
      await gorgias.addTicketTag(draft.gorgias_ticket_id, 'ai-resolved');
    } else {
      // Snooze for 3 days — if customer replies, Gorgias auto-unsnoozes
      await gorgias.snoozeTicket(draft.gorgias_ticket_id, 3);
    }
  } catch (err) {
    console.warn(`[dashboard] Post-send action (${afterAction}) failed: ${err.message}`);
  }

  // Update ticket status
  await updateTicketStatus(supabase, draft.gorgias_ticket_id, afterAction === 'close' ? 'closed' : 'snoozed');

  return { success: true, edit_distance: editDist, gorgias_message_id: replyResult?.id, after: afterAction };
}

async function apiExecuteAction(id) {
  const supabase = getSupabaseClient();

  const { data: draft, error: fetchErr } = await supabase
    .from('cs_ai_drafts')
    .select('*')
    .eq('id', id)
    .single();
  if (fetchErr) throw fetchErr;

  if (!draft.action_type) throw new Error('No action to execute for this draft');
  if (draft.action_executed_at) throw new Error('Action already executed');

  const structured = draft.structured_output;
  const results = {};

  // Import the MCP tool handlers
  const advisorTools = require('../lib/tools/exchangeAdvisor');
  const exchangeHandler = advisorTools.find(t => t.name === 'create_exchange_order')?.handler;
  const refundHandler = advisorTools.find(t => t.name === 'refund_order')?.handler;

  if (draft.action_type.includes('exchange') && exchangeHandler) {
    // Build exchange params from structured output
    const items = (structured.intake?.items || []).filter(i => i.resolved_size);
    if (items.length > 0) {
      try {
        const exchangeResult = await exchangeHandler({
          customer_email: draft.customer_email,
          items: items.map(i => ({
            product: i.resolved_product || i.product,
            size: i.resolved_size,
            color: i._orderColors?.[0] || i.color,
            quantity: i._orderQty || 1,
          })),
        });
        results.exchange = exchangeResult;
      } catch (err) {
        results.exchange = { error: err.message };
      }
    }
  }

  if (draft.action_type.includes('refund') && refundHandler) {
    try {
      const refundResult = await refundHandler({
        customer_email: draft.customer_email,
        order_number: draft.order_number,
      });
      results.refund = refundResult;
    } catch (err) {
      results.refund = { error: err.message };
    }
  }

  // Update draft with action result
  await supabase.from('cs_ai_drafts').update({
    action_result: results,
    action_executed_at: new Date().toISOString(),
  }).eq('id', id);

  return results;
}

async function apiCloseDraft(id, body) {
  const supabase = getSupabaseClient();

  const { data: draft, error: fetchErr } = await supabase
    .from('cs_ai_drafts')
    .select('gorgias_ticket_id')
    .eq('id', id)
    .single();
  if (fetchErr) throw fetchErr;

  // Close ticket + unassign from AI Bot
  try {
    await gorgias.closeTicket(draft.gorgias_ticket_id);
    await gorgias.assignTicket(draft.gorgias_ticket_id, null);
  } catch (err) {
    console.warn(`[dashboard] Could not close/unassign ticket: ${err.message}`);
  }

  await supabase.from('cs_ai_drafts').update({
    status: 'sent',
    feedback_notes: body.notes || 'Closed without reply',
    reviewed_at: new Date().toISOString(),
    sent_at: new Date().toISOString(),
  }).eq('id', id);

  await supabase.from('cs_ai_feedback_log').insert({
    draft_id: id,
    gorgias_ticket_id: draft.gorgias_ticket_id,
    action: 'closed_no_reply',
    feedback_notes: body.notes || null,
  });

  await updateTicketStatus(supabase, draft.gorgias_ticket_id, 'closed');

  return { success: true };
}

async function apiTrainDraft(id, body) {
  const supabase = getSupabaseClient();

  const { data: draft, error: fetchErr } = await supabase
    .from('cs_ai_drafts')
    .select('*')
    .eq('id', id)
    .single();
  if (fetchErr) throw fetchErr;

  const finalResponse = body.response || draft.draft_response;
  const notes = body.notes || null;
  const editDist = computeEditDistance(draft.draft_response, finalResponse);

  // Keep draft as pending — Train just logs training data, draft stays in queue for Refresh
  await supabase.from('cs_ai_drafts').update({
    feedback_notes: notes,
    reviewed_at: new Date().toISOString(),
  }).eq('id', id);

  // Log as training data
  await supabase.from('cs_ai_feedback_log').insert({
    draft_id: id,
    gorgias_ticket_id: draft.gorgias_ticket_id,
    action: 'trained',
    original_response: draft.draft_response,
    final_response: finalResponse,
    edit_distance: editDist,
    feedback_notes: notes,
    advisor_status: draft.advisor_status,
    confidence: draft.confidence,
    message_type: draft.message_type,
    turn_number: draft.turn_number,
  });

  // Ticket stays assigned to AI Bot — Train is just for capturing data, not releasing

  return { success: true, edit_distance: editDist };
}

async function apiRefreshDraft(id) {
  const supabase = getSupabaseClient();
  const gorgiasClient = require('../import/gorgiasClient');

  const { data: draft, error: fetchErr } = await supabase
    .from('cs_ai_drafts')
    .select('*')
    .eq('id', id)
    .single();
  if (fetchErr) throw fetchErr;

  // Re-fetch messages from Gorgias and re-run advisor
  const messages = await gorgiasClient.getTicketMessages(draft.gorgias_ticket_id);
  const lastCustomer = [...messages].reverse().find(m => m.from_agent === false);
  if (!lastCustomer) throw new Error('No customer message found');

  const messageText = gorgiasClient.stripHtml(lastCustomer.stripped_text || lastCustomer.body_text || '');

  // Build conversation context (same as poller)
  const { buildConversationContext } = require('../intake/processGorgiasTickets');
  let contextParts = [];
  if (typeof buildConversationContext === 'function') {
    const ctx = buildConversationContext(messages, lastCustomer.id);
    if (ctx) contextParts.push(`[CONVERSATION HISTORY]\n${ctx}`);
  }
  contextParts.push(`[LATEST CUSTOMER MESSAGE]\n${messageText}`);
  const issueDescription = contextParts.join('\n\n');

  // Run hybrid advisor (same as intake path)
  const { hybridAdvisor } = require('../lib/hybridAdvisor');
  const result = await hybridAdvisor({
    customer_email: draft.customer_email,
    issue_description: issueDescription,
    intake: draft.intake_state || undefined,
  });

  const s = result._structured;
  let newDraft = s?._composedResponse || '';
  if (!newDraft && s) {
    try {
      const { composeAgentResponse } = require('../lib/responseComposer');
      newDraft = await composeAgentResponse(s, []);
    } catch (e) {
      newDraft = `[Compose error: ${e.message}]`;
    }
  }

  // Update the draft in Supabase
  await supabase.from('cs_ai_drafts').update({
    draft_response: newDraft,
    structured_output: s,
    audit_trail: s?.audit || [],
    advisor_status: s?.status,
    confidence: ['ready', 'complete'].includes(s?.status) ? 'high' : s?.status === 'needs_info' ? 'medium' : 'low',
    action_type: s?.action_type || null,
    message_type: s?.intake?.message_type || null,
    order_number: s?.order?.name || s?.intake?.order_number ? `#${(s?.order?.name || s?.intake?.order_number).toString().replace('#', '')}` : undefined,
  }).eq('id', id);

  // Also update ticket row with latest classification
  if (draft.ticket_id) {
    const ticketUpdates = { updated_at: new Date().toISOString() };
    if (s?.intake?.message_type) ticketUpdates.message_type = s.intake.message_type;
    if (s?.action_type) ticketUpdates.action_type = s.action_type;
    if (s?.confidence) ticketUpdates.confidence = s.confidence;
    if (s?.status) ticketUpdates.advisor_status = s.status;
    await supabase.from('cs_tickets').update(ticketUpdates).eq('id', draft.ticket_id);
  }

  return { draft_response: newDraft, structured: s };
}

async function apiReleaseDraft(id, body) {
  const supabase = getSupabaseClient();

  const { data: draft, error: fetchErr } = await supabase
    .from('cs_ai_drafts')
    .select('gorgias_ticket_id')
    .eq('id', id)
    .single();
  if (fetchErr) throw fetchErr;

  // Unassign from AI Bot
  try {
    await gorgias.assignTicket(draft.gorgias_ticket_id, null);
  } catch (err) {
    console.warn(`[dashboard] Could not unassign ticket: ${err.message}`);
  }

  // Update draft
  await supabase.from('cs_ai_drafts').update({
    status: 'released',
    feedback_notes: body.notes || 'Released to Gorgias',
    reviewed_at: new Date().toISOString(),
  }).eq('id', id);

  // Log feedback
  await supabase.from('cs_ai_feedback_log').insert({
    draft_id: id,
    gorgias_ticket_id: draft.gorgias_ticket_id,
    action: 'released',
    feedback_notes: body.notes || null,
  });

  await updateTicketStatus(supabase, draft.gorgias_ticket_id, 'closed');

  return { success: true };
}

async function apiDeleteDraft(id) {
  const supabase = getSupabaseClient();

  const { data: draft, error: fetchErr } = await supabase
    .from('cs_ai_drafts')
    .select('gorgias_ticket_id')
    .eq('id', id)
    .maybeSingle();
  if (fetchErr) throw fetchErr;
  if (!draft) return { success: true };

  // Close ticket in Gorgias so poller won't pick it up again
  if (draft.gorgias_ticket_id) {
    try {
      await gorgias.closeTicket(draft.gorgias_ticket_id);
      await gorgias.assignTicket(draft.gorgias_ticket_id, null);
    } catch (err) {
      console.warn(`[dashboard] Could not close ticket on delete: ${err.message}`);
    }
  }

  // Soft-delete: mark as deleted so intake won't recreate
  await supabase.from('cs_ai_drafts').update({
    status: 'deleted',
    reviewed_at: new Date().toISOString(),
  }).eq('id', id);

  if (draft.gorgias_ticket_id) {
    await updateTicketStatus(supabase, draft.gorgias_ticket_id, 'closed');
  }

  return { success: true };
}

async function apiMarkSpam(id) {
  const supabase = getSupabaseClient();

  const { data: draft, error: fetchErr } = await supabase
    .from('cs_ai_drafts')
    .select('gorgias_ticket_id')
    .eq('id', id)
    .maybeSingle();
  if (fetchErr) throw fetchErr;
  if (!draft) return { success: true };

  // Close ticket, tag as spam, unassign from AI Bot
  if (draft.gorgias_ticket_id) {
    try {
      await gorgias.addTicketTag(draft.gorgias_ticket_id, 'spam');
      await gorgias.closeTicket(draft.gorgias_ticket_id);
      await gorgias.assignTicket(draft.gorgias_ticket_id, null);
    } catch (err) {
      console.warn(`[dashboard] Spam Gorgias actions failed: ${err.message}`);
    }
  }

  // Soft-delete: mark as spam so intake won't recreate
  await supabase.from('cs_ai_drafts').update({
    status: 'spam',
    reviewed_at: new Date().toISOString(),
  }).eq('id', id);

  if (draft.gorgias_ticket_id) {
    await updateTicketStatus(supabase, draft.gorgias_ticket_id, 'closed');
  }

  return { success: true };
}

async function apiGetStats() {
  const supabase = getSupabaseClient();

  const { data: recentFeedback } = await supabase
    .from('cs_ai_feedback_log')
    .select('action, edit_distance, confidence, message_type, created_at')
    .gte('created_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString())
    .order('created_at', { ascending: false });

  const { count: pendingCount } = await supabase
    .from('cs_ai_drafts')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'pending');

  const feedback = recentFeedback || [];
  const total = feedback.length;
  const sent = feedback.filter(f => f.action === 'sent').length;
  const edited = feedback.filter(f => f.action === 'edited').length;
  const released = feedback.filter(f => f.action === 'released').length;
  const bypassed = feedback.filter(f => f.action === 'bypassed').length;
  const avgEditDist = feedback.filter(f => f.edit_distance != null).reduce((sum, f) => sum + f.edit_distance, 0)
    / (feedback.filter(f => f.edit_distance != null).length || 1);

  // Get last poll time
  const { data: pollerState } = await supabase
    .from('cs_poller_state')
    .select('last_poll_at')
    .eq('id', 'gorgias_drafter')
    .single();

  return {
    pending: pendingCount || 0,
    last30Days: { total, sent, edited, released, bypassed },
    acceptanceRate: total > 0 ? ((sent / total) * 100).toFixed(1) + '%' : 'N/A',
    avgEditDistance: avgEditDist.toFixed(3),
    lastPollAt: pollerState?.last_poll_at || null,
  };
}

async function apiRunTest(body) {
  const { customer_email, messages, order_number } = body;
  if (!customer_email || !messages?.length) throw new Error('Provide customer_email and messages array');

  // Use the conversation tester handler directly
  const testerTools = require('../lib/tools/conversationTester');
  const tester = testerTools.find(t => t.name === 'test_cs_conversation');
  const result = await tester.handler({ customer_email, messages, order_number });

  // Also get the raw structured data for each turn by running advisor directly
  const advisorTools = require('../lib/tools/exchangeAdvisor');
  const advisor = (advisorTools.find(t => t.name === 'cs_advisor') || advisorTools.find(t => t.name === 'exchange_advisor'));

  const turns = [];
  let intake = null;
  for (const msg of messages) {
    try {
      const advResult = await advisor.handler({
        customer_email,
        issue_description: msg,
        order_number: order_number || undefined,
        intake,
      });
      const s = advResult._structured;
      if (s) intake = s.intake;

      const { composeAgentResponse } = require('../lib/responseComposer');
      let draft = '';
      try {
        const prevResponses = turns.map(t => t.ai_response).filter(Boolean);
        draft = await composeAgentResponse(s, prevResponses);
      } catch (e) {
        draft = `[Compose error: ${e.message}]`;
      }

      turns.push({
        customer_message: msg,
        ai_response: draft,
        status: s?.status,
        confidence: s?.status === 'ready' ? 'high' : s?.status === 'needs_info' ? 'medium' : 'low',
        audit: s?.audit || [],
        intake: s?.intake,
        prescription: s?.prescription,
      });
    } catch (e) {
      turns.push({
        customer_message: msg,
        ai_response: `[Error: ${e.message}]`,
        status: 'error',
        confidence: 'low',
        audit: [],
      });
    }
  }

  return { turns, tester_output: result.content?.[0]?.text };
}

async function apiReplayTicket(body) {
  const { ticket_id } = body;
  if (!ticket_id) throw new Error('Provide ticket_id');

  const gorgiasClient = require('../import/gorgiasClient');
  const ticket = await gorgiasClient.getTicket(ticket_id);
  const messages = await gorgiasClient.getTicketMessages(ticket_id);
  const customerEmail = ticket.customer?.email;
  if (!customerEmail) throw new Error('No customer email on ticket');

  // Extract customer messages in order
  const customerMsgs = messages
    .filter(m => m.from_agent === false)
    .map(m => gorgiasClient.stripHtml(m.stripped_text || m.body_text || ''));

  // Extract agent (Jamie's) actual responses
  const agentMsgs = messages
    .filter(m => m.from_agent === true && !m.sender?.email?.endsWith('@email.gorgias.com'))
    .map(m => gorgiasClient.stripHtml(m.stripped_text || m.body_text || ''));

  // Run the AI on each customer message
  const advisorTools = require('../lib/tools/exchangeAdvisor');
  const advisor = (advisorTools.find(t => t.name === 'cs_advisor') || advisorTools.find(t => t.name === 'exchange_advisor'));

  const turns = [];
  let intake = null;
  for (let i = 0; i < customerMsgs.length; i++) {
    const msg = customerMsgs[i];
    const actualReply = agentMsgs[i] || null;

    try {
      const advResult = await advisor.handler({
        customer_email: customerEmail,
        issue_description: msg,
        intake,
      });
      const s = advResult._structured;
      if (s) intake = s.intake;

      const { composeAgentResponse } = require('../lib/responseComposer');
      let draft = '';
      try {
        const prevResponses = turns.map(t => t.ai_response).filter(Boolean);
        draft = await composeAgentResponse(s, prevResponses);
      } catch (e) {
        draft = `[Compose error: ${e.message}]`;
      }

      turns.push({
        customer_message: msg,
        ai_response: draft,
        actual_response: actualReply,
        status: s?.status,
        audit: s?.audit || [],
      });
    } catch (e) {
      turns.push({
        customer_message: msg,
        ai_response: `[Error: ${e.message}]`,
        actual_response: actualReply,
        status: 'error',
        audit: [],
      });
    }
  }

  return { ticket_id, customer_email: customerEmail, turns };
}

// ---------------------------------------------------------------------------
// Simulator endpoints
// ---------------------------------------------------------------------------

async function apiSimulatorRandom(category, ticketId) {
  const supabase = getSupabaseClient();
  const gorgiasClient = require('../import/gorgiasClient');

  let convo;

  if (ticketId) {
    // Load a specific conversation by Gorgias ticket ID
    const { data } = await supabase
      .from('cs_conversations')
      .select('id, customer_email, order_numbers, subject, summary, message_count, source_id, category, created_at')
      .eq('source_id', String(ticketId))
      .single();
    if (!data) {
      // Try gorgias: prefix
      const { data: data2 } = await supabase
        .from('cs_conversations')
        .select('id, customer_email, order_numbers, subject, summary, message_count, source_id, category, created_at')
        .eq('id', `gorgias:${ticketId}`)
        .single();
      if (!data2) throw new Error(`Conversation not found for ticket ${ticketId}`);
      convo = data2;
    } else {
      convo = data;
    }
  } else {
    // Category-to-filter mapping
    const categoryFilters = {
      exchange: 'category.eq.exchange_return,tags.cs.{RETURN/EXCHANGE}',
      sizing: 'category.eq.sizing_fit,tags.cs.{SIZING}',
      shipping: 'category.eq.shipping,tags.cs.{SHIPPING}',
      order_status: 'category.eq.order_status,tags.cs.{ORDER STATUS}',
      product: 'category.eq.product_info,tags.cs.{PRODUCT}',
      general: 'category.eq.general',
      payment: 'category.eq.payment',
    };

    const filterType = category || 'exchange';
    const orFilter = categoryFilters[filterType] || categoryFilters.exchange;

    let q = supabase
      .from('cs_conversations')
      .select('id, customer_email, order_numbers, subject, summary, message_count, source_id, category, created_at')
      .or(orFilter)
      .gt('message_count', 2)
      .limit(100);

    if (['exchange', 'sizing'].includes(filterType)) {
      q = q.not('order_numbers', 'is', null);
    }

    const { data: convos } = await q;
    if (!convos?.length) throw new Error(`No ${filterType} conversations found`);
    convo = convos[Math.floor(Math.random() * convos.length)];
  }

  // Load messages from Gorgias API (has correct from_agent + stripped_text)
  const gorgiasTicketId = convo.source_id || convo.id.replace('gorgias:', '');
  const messages = await gorgiasClient.getTicketMessages(gorgiasTicketId);

  // Build first customer turn: all customer messages before the first real agent reply
  const firstTurnParts = [];
  for (const m of messages) {
    const isBot = m.sender?.email?.endsWith('@email.gorgias.com') || m.via === 'rule';
    const isRealAgent = m.from_agent === true && !isBot;
    if (isRealAgent && firstTurnParts.length > 0) break;
    if (m.from_agent === false) {
      const body = gorgiasClient.stripHtml(m.stripped_text || m.body_text || '').trim();
      if (body) firstTurnParts.push(body);
    }
  }

  if (!firstTurnParts.length) throw new Error('No customer messages in this conversation');
  const firstMessage = firstTurnParts.join('\n');

  // Get order details from Shopify
  // Try order_numbers array first, then extract from subject (e.g. "Order #27715 - Exchange")
  let orderNumber = convo.order_numbers?.[0];
  if (!orderNumber && convo.subject) {
    const subjectMatch = convo.subject.match(/#(\d{4,6})/);
    if (subjectMatch) orderNumber = subjectMatch[1];
  }
  let orderContext = null;
  let customerContext = null;

  try {
    const advisorTools = require('../lib/tools/exchangeAdvisor');
    const advisor = advisorTools.find(t => t.name === 'cs_advisor') || advisorTools.find(t => t.name === 'exchange_advisor');
    const result = await advisor.handler({
      customer_email: convo.customer_email,
      issue_description: firstMessage,
      order_number: orderNumber,
    });
    const s = result._structured;
    if (s) {
      orderContext = s.order;
      customerContext = {
        email: s.customer?.email,
        name: s.customer?.name,
        pronouns: s.customer?.pronouns,
        country: s.customer?.country,
        address: s.customer?.address,
      };
    }
  } catch (e) {
    // Order lookup failed — continue without it
  }

  return {
    conversation: { id: convo.id, subject: convo.subject, summary: convo.summary, customer_email: convo.customer_email, order_number: orderNumber, created_at: convo.created_at },
    firstMessage,
    orderContext,
    customerContext,
  };
}

async function apiSimulatorTurn(body) {
  const { customer_email, issue_description, order_number, intake, previous_responses, reference_date } = body;
  if (!customer_email || !issue_description) throw new Error('Provide customer_email and issue_description');

  const { hybridAdvisor } = require('../lib/hybridAdvisor');

  const result = await hybridAdvisor({
    customer_email,
    issue_description,
    order_number: order_number || undefined,
    intake: intake || undefined,
    reference_date: reference_date || undefined,
  });

  const s = result._structured;
  const aiResponse = s?._composedResponse || '';

  return {
    ai_response: aiResponse,
    structured: s,
  };
}

async function apiSimulatorSave(body) {
  const supabase = getSupabaseClient();
  const { source_conversation_id, customer_email, order_number, order_context, customer_context, turns, reference_date } = body;

  // Extract Gorgias ticket ID from source conversation ID (e.g. "gorgias:67811718" → 67811718)
  const gorgiasTicketId = source_conversation_id
    ? parseInt(String(source_conversation_id).replace('gorgias:', ''))
    : 0;

  // Supersede previous simulator drafts for the same ticket
  if (gorgiasTicketId) {
    await supabase
      .from('cs_ai_drafts')
      .update({ status: 'superseded' })
      .eq('gorgias_ticket_id', gorgiasTicketId)
      .eq('source', 'simulator')
      .eq('status', 'pending');
  }

  // Save each turn as a draft in cs_ai_drafts
  const savedIds = [];
  let previousDraftId = null;

  for (let i = 0; i < (turns || []).length; i++) {
    const turn = turns[i];
    const structured = turn.structured_output || {};

    const { data: draft, error } = await supabase
      .from('cs_ai_drafts')
      .insert({
        gorgias_ticket_id: gorgiasTicketId,
        gorgias_message_id: -(Date.now() + i), // synthetic negative ID for simulator
        customer_email: customer_email || 'unknown',
        customer_name: structured.customer?.name || null,
        customer_pronouns: structured.customer?.pronouns || null,
        customer_country: structured.customer?.country || null,
        order_number: structured.order?.name || order_number || null,
        draft_response: turn.original_ai_response || '',
        sent_response: turn.edited_ai_response || null,
        edit_distance: turn.original_ai_response !== turn.edited_ai_response ? 1 : 0,
        structured_output: structured,
        intake_state: structured.intake || null,
        audit_trail: structured.audit || [],
        confidence: structured.confidence || 'low',
        advisor_status: structured.status || 'unknown',
        message_type: structured.intake?.message_type || structured.intake?.items?.[0]?.issue || 'unknown',
        order_context: structured.order || order_context || null,
        customer_context: structured.customer || customer_context || null,
        action_type: structured.action_type || null,
        feedback_notes: turn.notes || null,
        turn_number: turn.turn_number || (i + 1),
        previous_draft_id: previousDraftId,
        source: 'simulator',
        advisor_version: structured.advisor_version || null,
        status: 'pending',
      })
      .select('id')
      .single();

    if (error) {
      console.error(`[simulator] Save turn ${i + 1} error:`, error.message);
      continue;
    }
    savedIds.push(draft.id);
    previousDraftId = draft.id;
  }

  return { draft_ids: savedIds, count: savedIds.length };
}

async function apiSimulatorSaveTurn(body) {
  const supabase = getSupabaseClient();
  const { source_conversation_id, customer_email, order_number, order_context, customer_context, turn } = body;

  const gorgiasTicketId = source_conversation_id
    ? parseInt(String(source_conversation_id).replace('gorgias:', ''))
    : 0;

  // On first turn, supersede previous simulator drafts for this ticket
  if (turn.turn_number === 1 && gorgiasTicketId) {
    await supabase
      .from('cs_ai_drafts')
      .update({ status: 'superseded' })
      .eq('gorgias_ticket_id', gorgiasTicketId)
      .eq('source', 'simulator')
      .eq('status', 'pending');
  }

  const structured = turn.structured_output || {};

  const { data: draft, error } = await supabase
    .from('cs_ai_drafts')
    .insert({
      gorgias_ticket_id: gorgiasTicketId,
      gorgias_message_id: -(Date.now()),
      customer_email: customer_email || 'unknown',
      customer_name: structured.customer?.name || null,
      customer_pronouns: structured.customer?.pronouns || null,
      customer_country: structured.customer?.country || null,
      order_number: structured.order?.name || order_number || null,
      draft_response: turn.original_ai_response || '',
      sent_response: turn.edited_ai_response || null,
      edit_distance: turn.original_ai_response !== turn.edited_ai_response ? 1 : 0,
      structured_output: structured,
      intake_state: structured.intake || null,
      audit_trail: structured.audit || [],
      confidence: structured.confidence || 'low',
      advisor_status: structured.status || 'unknown',
      message_type: structured.intake?.message_type || structured.intake?.items?.[0]?.issue || 'unknown',
      order_context: structured.order || order_context || null,
      customer_context: structured.customer || customer_context || null,
      action_type: structured.action_type || null,
      feedback_notes: turn.notes || null,
      turn_number: turn.turn_number || 1,
      source: 'simulator',
      advisor_version: structured.advisor_version || null,
      status: 'pending',
    })
    .select('id')
    .single();

  if (error) throw error;
  return { draft_id: draft.id };
}

async function apiSimulatorUpdateTurn(body) {
  const supabase = getSupabaseClient();
  const { draft_id, edited_response, notes } = body;
  if (!draft_id) throw new Error('Provide draft_id');

  const updates = { reviewed_at: new Date().toISOString() };
  if (edited_response != null) {
    updates.sent_response = edited_response;
    // Compute edit distance
    const { data: draft } = await supabase.from('cs_ai_drafts').select('draft_response').eq('id', draft_id).single();
    if (draft?.draft_response) {
      const orig = draft.draft_response.toLowerCase().split(/\s+/);
      const edit = edited_response.toLowerCase().split(/\s+/);
      const maxLen = Math.max(orig.length, edit.length);
      updates.edit_distance = maxLen === 0 ? 0 : (orig.join(' ') === edit.join(' ') ? 0 : 1);
    }
  }
  if (notes != null) updates.feedback_notes = notes;

  const { error } = await supabase.from('cs_ai_drafts').update(updates).eq('id', draft_id);
  if (error) throw error;
  return { updated: true };
}

async function apiTriggerPoll() {
  const { run } = require('../intake/processGorgiasTickets');
  return run();
}

// SSE version of poll with progress streaming
function apiPollStream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  const { run } = require('../intake/processGorgiasTickets');
  run({
    onProgress: (data) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    },
  }).then((result) => {
    res.write(`data: ${JSON.stringify({ phase: 'done', ...result })}\n\n`);
    res.end();
  }).catch((err) => {
    res.write(`data: ${JSON.stringify({ phase: 'error', error: err.message })}\n\n`);
    res.end();
  });
}

async function apiGetHistory(query) {
  const supabase = getSupabaseClient();
  const limit = parseInt(query.get('limit') || '50', 10);

  const { data, error } = await supabase
    .from('cs_ai_drafts')
    .select('id, gorgias_ticket_id, customer_email, customer_name, order_number, draft_response, sent_response, edit_distance, feedback_notes, confidence, advisor_status, message_type, status, sent_at, created_at')
    .neq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data;
}

// ---------------------------------------------------------------------------
// Two-phase execute endpoints
// ---------------------------------------------------------------------------

async function apiExecuteExchange(id, body) {
  const supabase = getSupabaseClient();
  const { data: draft, error: fetchErr } = await supabase
    .from('cs_ai_drafts').select('*').eq('id', id).single();
  if (fetchErr) throw fetchErr;

  const exchangeTools = require('../lib/tools/exchangeOrder');
  const exchangeHandler = exchangeTools.find(t => t.name === 'create_exchange_order')?.handler;
  if (!exchangeHandler) throw new Error('Exchange tool not found');

  if (body.confirmed) {
    // Phase 2: complete the draft order
    const prevResult = draft.action_result;
    if (!prevResult?.draft_order_id) throw new Error('No draft_order_id from Phase 1');

    const result = await exchangeHandler({
      customer_id: prevResult.customer_id,
      confirmed: true,
      draft_order_id: prevResult.draft_order_id,
    });

    await supabase.from('cs_ai_drafts').update({
      action_result: { ...prevResult, phase: 'completed', phase2: result },
      action_executed_at: new Date().toISOString(),
    }).eq('id', id);

    return result;
  }

  // Phase 1: create draft order preview
  const { searchCustomers } = require('../lib/shopify');
  const customers = await searchCustomers(draft.customer_email);
  const customer = customers?.[0];
  if (!customer) throw new Error(`Customer not found: ${draft.customer_email}`);

  const structured = draft.structured_output || {};
  const items = (structured.intake?.items || []).filter(i => i.resolved_size);
  if (!items.length) throw new Error('No exchange items resolved');

  const result = await exchangeHandler({
    customer_id: customer.id,
    items: items.map(i => ({
      sku: i._orderSku || undefined,
      target_size: i.resolved_size,
      query: (!i._orderSku) ? `${i.resolved_product || i.product} ${i.resolved_size}` : undefined,
      quantity: i._orderQty || 1,
    })),
    note: `Exchange via CS Dashboard (draft #${id})`,
  });

  // Extract draft_order_id from result text
  const resultText = result.content?.[0]?.text || '';
  const draftIdMatch = resultText.match(/gid:\/\/shopify\/DraftOrder\/(\d+)/);
  const draftOrderId = draftIdMatch ? `gid://shopify/DraftOrder/${draftIdMatch[1]}` : null;

  await supabase.from('cs_ai_drafts').update({
    action_result: { phase: 'preview', customer_id: customer.id, draft_order_id: draftOrderId, preview: resultText },
  }).eq('id', id);

  return result;
}

async function apiExecuteRefund(id, body) {
  const supabase = getSupabaseClient();
  const { data: draft, error: fetchErr } = await supabase
    .from('cs_ai_drafts').select('*').eq('id', id).single();
  if (fetchErr) throw fetchErr;

  const refundTools = require('../lib/tools/refundOrder');
  const refundHandler = refundTools.find(t => t.name === 'refund_order')?.handler;
  if (!refundHandler) throw new Error('Refund tool not found');

  if (body.confirmed) {
    // Phase 2: execute the refund
    const prevResult = draft.action_result;
    if (!prevResult?._refund_data) throw new Error('No refund data from Phase 1');

    const result = await refundHandler({
      order_number: String(draft.order_number),
      confirmed: true,
      _refund_data: prevResult._refund_data,
    });

    await supabase.from('cs_ai_drafts').update({
      action_result: { ...prevResult, phase: 'completed', phase2: result },
      action_executed_at: new Date().toISOString(),
    }).eq('id', id);

    return result;
  }

  // Phase 1: calculate refund
  const structured = draft.structured_output || {};
  const refundItems = (structured.prescription?.items || [])
    .filter(i => i.state === 'REFUND_CONFIRMED' || i.state === 'REFUND_READY');
  const intakeItems = (structured.intake?.items || []).filter(i => i.product);
  const itemsForRefund = refundItems.length ? refundItems : intakeItems;

  const result = await refundHandler({
    order_number: String(draft.order_number),
    items: itemsForRefund.map(i => ({
      sku: i._orderSku || i.sku || undefined,
      quantity: i._orderQty || i.quantity || 1,
    })).filter(i => i.sku),
    note: `Refund via CS Dashboard (draft #${id})`,
  });

  // Extract _refund_data from the result (the handler stores it in the response)
  const resultText = result.content?.[0]?.text || '';
  // The refund handler returns _refund_data in a structured way — look for it
  const refundData = result._refund_data || null;

  await supabase.from('cs_ai_drafts').update({
    action_result: { phase: 'preview', _refund_data: refundData, preview: resultText },
  }).eq('id', id);

  return result;
}

async function apiExecuteEdit(id, body) {
  const supabase = getSupabaseClient();
  const { data: draft, error: fetchErr } = await supabase
    .from('cs_ai_drafts').select('*').eq('id', id).single();
  if (fetchErr) throw fetchErr;

  const editTools = require('../lib/tools/editOrder');
  const editHandler = editTools.find(t => t.name === 'edit_order')?.handler;
  if (!editHandler) throw new Error('Edit order tool not found');

  if (body.confirmed) {
    // Phase 2: commit the edit (pending edits stored server-side in editOrder.js)
    const result = await editHandler({
      order_number: String(draft.order_number),
      confirmed: true,
    });

    const prevResult = draft.action_result || {};
    await supabase.from('cs_ai_drafts').update({
      action_result: { ...prevResult, phase: 'completed', phase2: result },
      action_executed_at: new Date().toISOString(),
    }).eq('id', id);

    return result;
  }

  // Phase 1: stage the edit
  const structured = draft.structured_output || {};
  // Extract swap items from structured output - these would come from order_modification intent
  const swapItems = structured.prescription?.swap_items || [];

  const result = await editHandler({
    order_number: String(draft.order_number),
    swap_items: swapItems,
    note: `Edit via CS Dashboard (draft #${id})`,
  });

  const resultText = result.content?.[0]?.text || '';
  await supabase.from('cs_ai_drafts').update({
    action_result: { phase: 'preview', preview: resultText },
  }).eq('id', id);

  return result;
}

// ---------------------------------------------------------------------------
// Action Chat — Claude-powered tool execution via chat
// ---------------------------------------------------------------------------

let _anthropicClient = null;
function getAnthropic() {
  if (!_anthropicClient) _anthropicClient = new Anthropic();
  return _anthropicClient;
}

// Tool definitions for Claude (simplified schemas matching our MCP handlers)
const ACTION_CHAT_TOOLS = [
  {
    name: 'create_exchange_order',
    description: 'Create a free exchange draft order. Returns a preview first. Call again with confirmed=true and draft_order_id to complete.',
    input_schema: {
      type: 'object',
      properties: {
        customer_email: { type: 'string', description: 'Customer email address' },
        items: {
          type: 'array', description: 'Items for the exchange',
          items: {
            type: 'object',
            properties: {
              sku: { type: 'string', description: 'Original SKU (e.g. AJ-BLK-M)' },
              target_size: { type: 'string', description: 'New size (e.g. L, XL, 14)' },
              query: { type: 'string', description: 'Product search query if SKU unknown' },
              quantity: { type: 'number', description: 'Quantity (default 1)' },
            },
          },
        },
        confirmed: { type: 'boolean', description: 'Set true to complete a previously created draft' },
        draft_order_id: { type: 'string', description: 'Draft order ID from preview (required when confirmed=true)' },
        note: { type: 'string', description: 'Note for the order' },
      },
      required: ['customer_email'],
    },
  },
  {
    name: 'refund_order',
    description: 'Refund specific items on an order. Returns a preview first. Call again with confirmed=true and _refund_data to execute.',
    input_schema: {
      type: 'object',
      properties: {
        order_number: { type: 'string', description: 'Order number (e.g. "29119")' },
        items: {
          type: 'array', description: 'Items to refund',
          items: {
            type: 'object',
            properties: {
              sku: { type: 'string', description: 'SKU of the item' },
              quantity: { type: 'number', description: 'Quantity to refund (default 1)' },
            },
          },
        },
        confirmed: { type: 'boolean', description: 'Set true to execute the refund' },
        _refund_data: { type: 'object', description: 'Refund data from preview (required when confirmed=true)' },
        note: { type: 'string', description: 'Refund note' },
      },
      required: ['order_number'],
    },
  },
  {
    name: 'edit_order',
    description: 'Edit an unfulfilled order by swapping, removing, or adding line items, and/or updating shipping address. Returns preview first. Call again with confirmed=true to commit.',
    input_schema: {
      type: 'object',
      properties: {
        order_number: { type: 'string', description: 'Order number' },
        swap_items: {
          type: 'array', description: 'Items to swap/remove/add',
          items: {
            type: 'object',
            properties: {
              remove_sku: { type: 'string', description: 'SKU to remove' },
              add_query: { type: 'string', description: 'Product search for replacement' },
              add_quantity: { type: 'number' },
            },
          },
        },
        shipping_address: {
          type: 'object', description: 'New shipping address (for address changes)',
          properties: {
            first_name: { type: 'string' },
            last_name: { type: 'string' },
            address1: { type: 'string' },
            address2: { type: 'string' },
            city: { type: 'string' },
            province: { type: 'string' },
            country: { type: 'string' },
            zip: { type: 'string' },
          },
        },
        confirmed: { type: 'boolean', description: 'Set true to commit the edit' },
        note: { type: 'string', description: 'Staff note' },
      },
      required: ['order_number'],
    },
  },
  {
    name: 'warehouse_hold',
    description: 'Place a warehouse hold on an unfulfilled order to prevent shipment. Use when resolving address changes, edits, or other issues before the order ships.',
    input_schema: {
      type: 'object',
      properties: {
        order_number: { type: 'number', description: 'Order number (e.g. 29887)' },
        reason: { type: 'string', description: 'Reason for hold (e.g. "Customer requested address change")' },
      },
      required: ['order_number', 'reason'],
    },
  },
  {
    name: 'release_warehouse_hold',
    description: 'Release a warehouse hold on an order, allowing it to proceed to fulfillment. Use after an issue has been resolved.',
    input_schema: {
      type: 'object',
      properties: {
        order_number: { type: 'number', description: 'Order number (e.g. 29887)' },
        reason: { type: 'string', description: 'Reason for release (e.g. "Address updated, ready to ship")' },
      },
      required: ['order_number', 'reason'],
    },
  },
  {
    name: 'release_address_hold',
    description: 'Release an address validation hold on an order. Use when address has been verified or corrected.',
    input_schema: {
      type: 'object',
      properties: {
        order_number: { type: 'number', description: 'Order number (e.g. 29887)' },
        reason: { type: 'string', description: 'Reason (e.g. "Address confirmed by customer")' },
      },
      required: ['order_number', 'reason'],
    },
  },
];

async function apiActionChat(draftId, body) {
  const supabase = getSupabaseClient();
  const { data: draft, error: fetchErr } = await supabase
    .from('cs_ai_drafts').select('*').eq('id', draftId).single();
  if (fetchErr) throw fetchErr;

  const userMessage = body.message;
  const history = body.history || [];

  // Build system prompt with context
  const structured = draft.structured_output || {};
  const orderItems = (structured.order?.items || [])
    .map(i => `  - ${i.title} ${i.variant || ''} (SKU: ${i.sku}, qty: ${i.quantity})`).join('\n');

  const systemPrompt = `You are an action executor for the RUBIES CS dashboard. You help the operator execute exchanges, refunds, and order edits.

CONTEXT:
- Customer: ${draft.customer_email}
- Order: #${draft.order_number}
- Order items:
${orderItems || '  (no items)'}
- Fulfillment: ${structured.order?.fulfillment_status || 'unknown'}

AI ADVISOR SUGGESTION: ${draft.action_type || 'none'} — ${draft.advisor_status || ''}
${structured.intake?.items?.length ? 'Suggested items: ' + structured.intake.items.map(i => `${i.product} ${i.size || ''} → ${i.resolved_size || '?'}`).join(', ') : ''}

RULES:
- Be concise. Show what you're about to do and ask for confirmation before executing.
- For exchanges: call create_exchange_order with the customer_email and items array. Use SKU + target_size.
- For refunds: call refund_order with order_number and items array.
- For edits: call edit_order with order_number and swap_items.
- Always show a preview first (phase 1), then ask for confirmation before completing (phase 2).
- When the operator says "yes", "confirm", "do it", etc. — proceed with phase 2.
- After completing an action, summarize what was done.
- If the operator wants multiple actions (exchange + refund), do them sequentially.`;

  // Build messages array
  const messages = [...history, { role: 'user', content: userMessage }];

  const client = getAnthropic();

  // Run the agentic loop — keep going while Claude wants to use tools
  let currentMessages = messages;
  let finalResponse = '';
  let toolResults = [];
  const maxIterations = 10;

  for (let i = 0; i < maxIterations; i++) {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: systemPrompt,
      tools: ACTION_CHAT_TOOLS,
      messages: currentMessages,
    });

    // Collect text and tool use blocks
    const textBlocks = response.content.filter(b => b.type === 'text');
    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');

    if (textBlocks.length) {
      finalResponse += textBlocks.map(b => b.text).join('\n');
    }

    // If no tool calls, we're done
    if (toolUseBlocks.length === 0 || response.stop_reason === 'end_turn') {
      if (toolUseBlocks.length === 0) break;
    }

    // Execute tool calls
    const toolResultMessages = [];
    for (const toolUse of toolUseBlocks) {
      let result;
      try {
        result = await executeActionTool(toolUse.name, toolUse.input, draft);
        toolResults.push({ tool: toolUse.name, input: toolUse.input, result });
      } catch (err) {
        result = { error: err.message };
        toolResults.push({ tool: toolUse.name, input: toolUse.input, error: err.message });
      }

      toolResultMessages.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: typeof result === 'string' ? result : JSON.stringify(result),
      });
    }

    // Add assistant response + tool results to messages for next iteration
    currentMessages = [
      ...currentMessages,
      { role: 'assistant', content: response.content },
      { role: 'user', content: toolResultMessages },
    ];

    // If stop_reason is end_turn and there were tool calls, continue to get final text
    if (response.stop_reason === 'end_turn' && toolUseBlocks.length > 0) {
      // One more iteration to get Claude's response after tool results
      continue;
    }
  }

  // Update draft with action results and chat history
  if (toolResults.length || finalResponse) {
    const prevResult = draft.action_result || {};
    const updates = {
      action_result: {
        ...prevResult,
        chat_tool_results: toolResults,
        chat_history: currentMessages,
        chat_response: finalResponse,
      },
    };

    // Detect if a completing action was performed (refund, exchange, edit)
    const completedAction = toolResults.some(tr =>
      (tr.tool === 'refund_order' && tr.input?.confirmed) ||
      (tr.tool === 'create_exchange_order' && tr.input?.confirmed) ||
      (tr.tool === 'edit_order' && tr.input?.confirmed) ||
      (tr.tool === 'warehouse_hold') ||
      (tr.result && typeof tr.result === 'string' && /completed|refunded|created|hold placed/i.test(tr.result))
    );
    if (completedAction && !draft.action_executed_at) {
      updates.action_executed_at = new Date().toISOString();
    }

    await supabase.from('cs_ai_drafts').update(updates).eq('id', draftId);
  }

  // Return the full conversation for the client to display
  return {
    response: finalResponse,
    tool_results: toolResults,
    history: currentMessages,
  };
}

async function executeActionTool(toolName, input, draft) {
  if (toolName === 'create_exchange_order') {
    const exchangeTools = require('../lib/tools/exchangeOrder');
    const handler = exchangeTools.find(t => t.name === 'create_exchange_order')?.handler;
    if (!handler) throw new Error('Exchange tool not found');

    // Resolve customer_id from email
    if (!input.confirmed) {
      const { searchCustomers } = require('../lib/shopify');
      const customers = await searchCustomers(input.customer_email || draft.customer_email);
      const customer = customers?.[0];
      if (!customer) throw new Error(`Customer not found: ${input.customer_email || draft.customer_email}`);
      input.customer_id = customer.id;
    }

    const result = await handler(input);
    return result.content?.[0]?.text || JSON.stringify(result);
  }

  if (toolName === 'refund_order') {
    const refundTools = require('../lib/tools/refundOrder');
    const handler = refundTools.find(t => t.name === 'refund_order')?.handler;
    if (!handler) throw new Error('Refund tool not found');
    const result = await handler(input);
    // Extract _refund_data if present (needed for phase 2)
    const text = result.content?.[0]?.text || '';
    if (result._refund_data) {
      return JSON.stringify({ text, _refund_data: result._refund_data });
    }
    return text;
  }

  if (toolName === 'edit_order') {
    const editTools = require('../lib/tools/editOrder');
    const handler = editTools.find(t => t.name === 'edit_order')?.handler;
    if (!handler) throw new Error('Edit tool not found');
    const result = await handler(input);
    return result.content?.[0]?.text || JSON.stringify(result);
  }

  if (toolName === 'warehouse_hold' || toolName === 'release_warehouse_hold' || toolName === 'release_address_hold') {
    const orderNotesTools = require('../lib/tools/orderNotes');
    const handler = orderNotesTools.find(t => t.name === toolName)?.handler;
    if (!handler) throw new Error(`${toolName} tool not found`);
    const result = await handler(input);
    return result.content?.[0]?.text || JSON.stringify(result);
  }

  throw new Error(`Unknown tool: ${toolName}`);
}

/**
 * Standalone action chat — works without a draft (for simulator + ad-hoc use).
 * Accepts context directly instead of looking up a draft.
 */
async function apiActionChatStandalone(body) {
  const userMessage = body.message;
  const history = body.history || [];
  const ctx = body.context || {};

  const orderItems = (ctx.order_items || [])
    .map(i => `  - ${i.title || ''} ${i.variant || ''} (SKU: ${i.sku || '?'}, qty: ${i.quantity || 1})`).join('\n');

  const systemPrompt = `You are an action executor for the RUBIES CS dashboard. You help the operator execute exchanges, refunds, and order edits.

CONTEXT:
- Customer: ${ctx.customer_email || 'unknown'}
- Order: #${ctx.order_number || '?'}
- Order items:
${orderItems || '  (no items)'}

RULES:
- Be concise. Show what you're about to do and ask for confirmation before executing.
- For exchanges: call create_exchange_order with the customer_email and items array. Use SKU + target_size.
- For refunds: call refund_order with order_number and items array.
- For edits: call edit_order with order_number and swap_items.
- Always show a preview first (phase 1), then ask for confirmation before completing (phase 2).
- When the operator says "yes", "confirm", "do it", etc. — proceed with phase 2.
- After completing an action, summarize what was done.
- If the operator wants multiple actions (exchange + refund), do them sequentially.`;

  const messages = [...history, { role: 'user', content: userMessage }];
  const client = getAnthropic();

  let currentMessages = messages;
  let finalResponse = '';
  let toolResults = [];

  for (let i = 0; i < 10; i++) {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: systemPrompt,
      tools: ACTION_CHAT_TOOLS,
      messages: currentMessages,
    });

    const textBlocks = response.content.filter(b => b.type === 'text');
    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');

    if (textBlocks.length) {
      finalResponse += textBlocks.map(b => b.text).join('\n');
    }

    if (toolUseBlocks.length === 0) break;

    const toolResultMessages = [];
    for (const toolUse of toolUseBlocks) {
      let result;
      try {
        result = await executeActionTool(toolUse.name, toolUse.input, { customer_email: ctx.customer_email, order_number: ctx.order_number });
        toolResults.push({ tool: toolUse.name, input: toolUse.input, result });
      } catch (err) {
        result = { error: err.message };
        toolResults.push({ tool: toolUse.name, input: toolUse.input, error: err.message });
      }

      toolResultMessages.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: typeof result === 'string' ? result : JSON.stringify(result),
      });
    }

    currentMessages = [
      ...currentMessages,
      { role: 'assistant', content: response.content },
      { role: 'user', content: toolResultMessages },
    ];
  }

  return {
    response: finalResponse,
    tool_results: toolResults,
    history: currentMessages,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractTrackingUrl(fulfillments) {
  if (!fulfillments || !Array.isArray(fulfillments)) return null;
  for (const f of fulfillments) {
    if (f.tracking_url) return f.tracking_url;
    if (f.tracking_urls?.length) return f.tracking_urls[0];
    // Shopify GraphQL format
    if (f.trackingInfo?.length) {
      const ti = f.trackingInfo[0];
      if (ti.url) return ti.url;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Customer context
// ---------------------------------------------------------------------------

async function apiGetCustomerContext(email, orderNumber) {
  const supabase = getSupabaseClient();

  // Run all queries in parallel
  const [customerRes, ordersRes, ticketsRes, aiDraftsRes, warehanceRes] = await Promise.all([
    // 1. Customer profile
    supabase
      .from('customers')
      .select('email, first_name, last_name, phone, default_address, total_orders, total_spent, total_spent_currency, tags, note, first_order_at, last_order_at')
      .eq('email', email)
      .single(),

    // 2. Recent orders
    supabase
      .from('orders')
      .select('shopify_order_id, order_number, created_at, fulfillment_status, financial_status, total_price, shop_currency, shipping_address, note, tags, fulfillments')
      .eq('customer_email', email)
      .order('created_at', { ascending: false })
      .limit(10),

    // 3. Past CS conversations
    supabase
      .from('cs_conversations')
      .select('id, source_id, customer_email, subject, summary, category, resolution_successful, resolution_type, message_count, created_at, resolved_at')
      .eq('customer_email', email)
      .order('created_at', { ascending: false })
      .limit(10),

    // 5. AI drafts for this customer (to flag AI-processed tickets)
    supabase
      .from('cs_ai_drafts')
      .select('gorgias_ticket_id, message_type, confidence, advisor_status')
      .eq('customer_email', email)
      .not('gorgias_ticket_id', 'is', null),

    // 6. Warehance order (for unfulfilled orders)
    orderNumber
      ? fetchOrderByNumber(orderNumber).catch(() => null)
      : Promise.resolve(null),
  ]);

  // Build customer object
  const cust = customerRes.data;
  const customer = cust ? {
    email: cust.email,
    name: [cust.first_name, cust.last_name].filter(Boolean).join(' ') || cust.email,
    phone: cust.phone,
    address: cust.default_address,
    tags: cust.tags,
    note: cust.note,
  } : { email, name: email };

  // Build LTV stats
  const allOrders = ordersRes.data || [];
  const exchangeCount = allOrders.filter(o => parseFloat(o.total_price) === 0).length;
  const paidOrders = allOrders.filter(o => parseFloat(o.total_price) > 0);
  const totalSpent = cust?.total_spent || paidOrders.reduce((sum, o) => sum + parseFloat(o.total_price || 0), 0);
  const avgOrder = paidOrders.length > 0 ? totalSpent / paidOrders.length : 0;
  const daysSinceLast = cust?.last_order_at
    ? Math.floor((Date.now() - new Date(cust.last_order_at).getTime()) / (1000 * 60 * 60 * 24))
    : null;

  const ltv = {
    total_spent: totalSpent,
    currency: cust?.total_spent_currency || allOrders[0]?.shop_currency || 'CAD',
    order_count: cust?.total_orders || allOrders.length,
    exchange_count: exchangeCount,
    avg_order_value: Math.round(avgOrder * 100) / 100,
    first_order: cust?.first_order_at,
    last_order: cust?.last_order_at,
    days_since_last: daysSinceLast,
  };

  // Build ticket order (the order this ticket is about)
  let ticketOrder = null;
  const orderNum = orderNumber ? parseInt(String(orderNumber).replace('#', '')) : null;
  if (orderNum) {
    const matchedOrder = allOrders.find(o => o.order_number === orderNum);
    if (matchedOrder) {
      // Fetch line items for this specific order
      const { data: items } = await supabase
        .from('order_line_items')
        .select('title, variant_title, sku, quantity, unit_price, unit_price_currency')
        .eq('shopify_order_id', matchedOrder.shopify_order_id);

      const trackingUrl = extractTrackingUrl(matchedOrder.fulfillments);
      ticketOrder = {
        order_number: matchedOrder.order_number,
        created_at: matchedOrder.created_at,
        total: matchedOrder.total_price,
        currency: matchedOrder.shop_currency,
        fulfillment_status: matchedOrder.fulfillment_status,
        financial_status: matchedOrder.financial_status,
        shopify_order_id: matchedOrder.shopify_order_id,
        shipping_address: matchedOrder.shipping_address,
        warehance_url: warehanceRes ? warehanceOrderUrl(warehanceRes) : null,
        tracking_url: trackingUrl,
        items: (items || []).map(i => ({
          title: i.title,
          variant: i.variant_title,
          sku: i.sku,
          quantity: i.quantity,
          price: i.unit_price,
          currency: i.unit_price_currency,
        })),
      };
    }
  }

  // Build all orders list (sorted by date, includes ticket's order)
  const otherOrdersRaw = allOrders;

  // Batch-fetch line items for other orders (first 10)
  let otherLineItems = {};
  if (otherOrdersRaw.length) {
    const otherIds = otherOrdersRaw.slice(0, 10).map(o => o.shopify_order_id);
    const { data: allItems } = await supabase
      .from('order_line_items')
      .select('shopify_order_id, title, variant_title, sku, quantity, unit_price, unit_price_currency')
      .in('shopify_order_id', otherIds);
    for (const item of (allItems || [])) {
      if (!otherLineItems[item.shopify_order_id]) otherLineItems[item.shopify_order_id] = [];
      otherLineItems[item.shopify_order_id].push(item);
    }
  }

  const otherOrders = otherOrdersRaw.map(o => ({
    order_number: o.order_number,
    created_at: o.created_at,
    total: o.total_price,
    currency: o.shop_currency,
    fulfillment_status: o.fulfillment_status,
    financial_status: o.financial_status,
    shopify_order_id: o.shopify_order_id,
    shipping_address: o.shipping_address,
    tracking_url: extractTrackingUrl(o.fulfillments),
    items: (otherLineItems[o.shopify_order_id] || []).map(i => ({
      title: i.title,
      variant: i.variant_title,
      sku: i.sku,
      quantity: i.quantity,
      price: i.unit_price,
    })),
  }));

  // Build past tickets with AI-processed flag
  const aiTicketIds = new Set((aiDraftsRes.data || []).map(d => String(d.gorgias_ticket_id)));
  const pastTickets = (ticketsRes.data || []).map(t => ({
    id: t.id,
    created_at: t.created_at,
    resolved_at: t.resolved_at,
    category: t.category,
    subject: t.subject,
    summary: t.summary,
    resolution_successful: t.resolution_successful,
    resolution_type: t.resolution_type,
    message_count: t.message_count,
    ai_processed: aiTicketIds.has(String(t.source_id)),
  }));

  return { customer, ltv, ticket_order: ticketOrder, other_orders: otherOrders, past_tickets: pastTickets };
}

// ---------------------------------------------------------------------------
// Ticket-centric API (cs_tickets as primary entity)
// ---------------------------------------------------------------------------

/**
 * Update cs_tickets status after a draft action.
 * Called from existing draft endpoints to keep ticket state in sync.
 */
async function updateTicketStatus(supabase, gorgiasTicketId, status, extra = {}) {
  const now = new Date().toISOString();
  const updates = { status, updated_at: now, ...extra };
  if (status === 'snoozed') updates.snoozed_at = now;
  if (status === 'closed') updates.closed_at = now;
  if (status === 'snoozed' || status === 'closed') updates.active_draft_id = null;

  await supabase
    .from('cs_tickets')
    .update(updates)
    .eq('gorgias_ticket_id', gorgiasTicketId);
}

async function apiGetTickets(query) {
  const supabase = getSupabaseClient();
  const tab = query.get('tab') || 'new';
  const limit = parseInt(query.get('limit') || '50', 10);

  let q = supabase
    .from('cs_tickets')
    .select('id, gorgias_ticket_id, customer_email, customer_name, customer_country, order_number, message_type, confidence, advisor_status, turn_number, status, active_draft_id, updated_at, created_at')
    .order('updated_at', { ascending: false })
    .limit(limit);

  switch (tab) {
    case 'new':
      q = q.eq('status', 'open').eq('turn_number', 1);
      break;
    case 'followup':
      q = q.eq('status', 'open').gt('turn_number', 1);
      break;
    case 'snoozed':
      q = q.eq('status', 'snoozed');
      break;
    case 'closed':
      q = q.eq('status', 'closed');
      break;
  }

  const { data, error } = await q;
  if (error) throw error;
  return data;
}

async function apiGetTicketStats() {
  const supabase = getSupabaseClient();

  const [newResult, followupResult, snoozedResult] = await Promise.all([
    supabase.from('cs_tickets').select('id', { count: 'exact', head: true })
      .eq('status', 'open').eq('turn_number', 1),
    supabase.from('cs_tickets').select('id', { count: 'exact', head: true })
      .eq('status', 'open').gt('turn_number', 1),
    supabase.from('cs_tickets').select('id', { count: 'exact', head: true })
      .eq('status', 'snoozed'),
  ]);

  return {
    new: newResult.count || 0,
    followup: followupResult.count || 0,
    snoozed: snoozedResult.count || 0,
  };
}

async function apiGetTicket(id) {
  const supabase = getSupabaseClient();

  // Get ticket
  const { data: ticket, error } = await supabase
    .from('cs_tickets')
    .select('*')
    .eq('id', id)
    .single();
  if (error) throw error;

  // Get active draft if present
  let activeDraft = null;
  if (ticket.active_draft_id) {
    const { data } = await supabase
      .from('cs_ai_drafts')
      .select('*')
      .eq('id', ticket.active_draft_id)
      .single();
    activeDraft = data;
  }

  // Get all drafts for this ticket (for history/training panel)
  const { data: allDrafts } = await supabase
    .from('cs_ai_drafts')
    .select('id, draft_response, sent_response, edit_distance, feedback_notes, confidence, advisor_status, message_type, action_type, action_result, status, turn_number, sent_at, created_at')
    .eq('ticket_id', id)
    .order('created_at', { ascending: true });

  return { ...ticket, active_draft: activeDraft, drafts: allDrafts || [] };
}

async function apiSendTicketMessage(ticketId, body) {
  const supabase = getSupabaseClient();

  const { data: ticket, error } = await supabase
    .from('cs_tickets')
    .select('gorgias_ticket_id, conversation_history')
    .eq('id', ticketId)
    .single();
  if (error) throw error;

  const message = body.message;
  if (!message?.trim()) throw new Error('Message is required');

  // Send to Gorgias
  const bodyHtml = autoLinkProducts(message, _productConfig);
  const replyResult = await gorgias.createTicketReply(ticket.gorgias_ticket_id, {
    body_html: bodyHtml,
    body_text: message,
  });

  // Append to conversation history
  const history = ticket.conversation_history || [];
  history.push({
    id: replyResult?.id,
    sender: 'agent',
    body: message,
    body_html: bodyHtml,
    created_at: new Date().toISOString(),
    channel: 'email',
  });

  // Post-send action
  const afterAction = body.after || 'snooze';
  const now = new Date().toISOString();
  const updates = { conversation_history: history, updated_at: now };

  if (afterAction === 'close') {
    updates.status = 'closed';
    updates.closed_at = now;
    try {
      await gorgias.closeTicket(ticket.gorgias_ticket_id);
      await gorgias.assignTicket(ticket.gorgias_ticket_id, null);
    } catch (err) {
      console.warn(`[dashboard] Post-message close failed: ${err.message}`);
    }
  } else {
    updates.status = 'snoozed';
    updates.snoozed_at = now;
    try {
      await gorgias.snoozeTicket(ticket.gorgias_ticket_id, 3);
    } catch (err) {
      console.warn(`[dashboard] Post-message snooze failed: ${err.message}`);
    }
  }

  await supabase.from('cs_tickets').update(updates).eq('id', ticketId);

  return { success: true, gorgias_message_id: replyResult?.id, after: afterAction };
}

async function apiReopenTicket(ticketId) {
  const supabase = getSupabaseClient();
  const now = new Date().toISOString();

  await supabase.from('cs_tickets').update({
    status: 'open',
    updated_at: now,
  }).eq('id', ticketId);

  return { success: true };
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

const routes = {
  'GET /api/drafts': (req) => apiGetDrafts(new URL(req.url, 'http://localhost').searchParams),
  'GET /api/stats': () => apiGetStats(),
  'GET /api/history': (req) => apiGetHistory(new URL(req.url, 'http://localhost').searchParams),
  'POST /api/poll': () => apiTriggerPoll(),
  'GET /api/tickets': (req) => apiGetTickets(new URL(req.url, 'http://localhost').searchParams),
  'GET /api/tickets/stats': () => apiGetTicketStats(),
};

// Routes with path params
const paramRoutes = [
  { method: 'GET', pattern: /^\/api\/customer\/([^/]+)\/context$/, handler: (_, email, req) => {
    const url = new URL(req.url, 'http://localhost');
    return apiGetCustomerContext(decodeURIComponent(email), url.searchParams.get('order'));
  }},
  { method: 'GET', pattern: /^\/api\/drafts\/(\d+)$/, handler: (_, id) => apiGetDraft(parseInt(id)) },
  { method: 'POST', pattern: /^\/api\/drafts\/(\d+)\/send$/, handler: (body, id) => apiSendDraft(parseInt(id), body) },
  { method: 'POST', pattern: /^\/api\/drafts\/(\d+)\/execute$/, handler: (body, id) => apiExecuteAction(parseInt(id)) },
  { method: 'POST', pattern: /^\/api\/drafts\/(\d+)\/execute\/exchange$/, handler: (body, id) => apiExecuteExchange(parseInt(id), body) },
  { method: 'POST', pattern: /^\/api\/drafts\/(\d+)\/execute\/refund$/, handler: (body, id) => apiExecuteRefund(parseInt(id), body) },
  { method: 'POST', pattern: /^\/api\/drafts\/(\d+)\/execute\/edit$/, handler: (body, id) => apiExecuteEdit(parseInt(id), body) },
  { method: 'POST', pattern: /^\/api\/drafts\/(\d+)\/action-chat$/, handler: (body, id) => apiActionChat(parseInt(id), body) },
  { method: 'POST', pattern: /^\/api\/action-chat$/, handler: (body) => apiActionChatStandalone(body) },
  { method: 'POST', pattern: /^\/api\/drafts\/(\d+)\/close$/, handler: (body, id) => apiCloseDraft(parseInt(id), body) },
  { method: 'POST', pattern: /^\/api\/drafts\/(\d+)\/train$/, handler: (body, id) => apiTrainDraft(parseInt(id), body) },
  { method: 'POST', pattern: /^\/api\/drafts\/(\d+)\/refresh$/, handler: (_, id) => apiRefreshDraft(parseInt(id)) },
  { method: 'POST', pattern: /^\/api\/drafts\/(\d+)\/release$/, handler: (body, id) => apiReleaseDraft(parseInt(id), body) },
  { method: 'POST', pattern: /^\/api\/drafts\/(\d+)\/delete$/, handler: (_, id) => apiDeleteDraft(parseInt(id)) },
  { method: 'POST', pattern: /^\/api\/drafts\/(\d+)\/spam$/, handler: (_, id) => apiMarkSpam(parseInt(id)) },
  // Ticket-centric routes
  { method: 'GET', pattern: /^\/api\/tickets\/(\d+)$/, handler: (_, id) => apiGetTicket(parseInt(id)) },
  { method: 'POST', pattern: /^\/api\/tickets\/(\d+)\/send$/, handler: (body, id) => {
    // Delegate to draft send via active_draft_id
    const supabase = getSupabaseClient();
    return supabase.from('cs_tickets').select('active_draft_id').eq('id', parseInt(id)).single()
      .then(({ data: t }) => {
        if (!t?.active_draft_id) throw new Error('No active draft for this ticket');
        return apiSendDraft(t.active_draft_id, body);
      });
  }},
  { method: 'POST', pattern: /^\/api\/tickets\/(\d+)\/close$/, handler: (body, id) => {
    const supabase = getSupabaseClient();
    return supabase.from('cs_tickets').select('active_draft_id').eq('id', parseInt(id)).single()
      .then(({ data: t }) => {
        if (!t?.active_draft_id) throw new Error('No active draft for this ticket');
        return apiCloseDraft(t.active_draft_id, body);
      });
  }},
  { method: 'POST', pattern: /^\/api\/tickets\/(\d+)\/train$/, handler: (body, id) => {
    const supabase = getSupabaseClient();
    return supabase.from('cs_tickets').select('active_draft_id').eq('id', parseInt(id)).single()
      .then(({ data: t }) => {
        if (!t?.active_draft_id) throw new Error('No active draft for this ticket');
        return apiTrainDraft(t.active_draft_id, body);
      });
  }},
  { method: 'POST', pattern: /^\/api\/tickets\/(\d+)\/refresh$/, handler: (_, id) => {
    const supabase = getSupabaseClient();
    return supabase.from('cs_tickets').select('active_draft_id').eq('id', parseInt(id)).single()
      .then(({ data: t }) => {
        if (!t?.active_draft_id) throw new Error('No active draft for this ticket');
        return apiRefreshDraft(t.active_draft_id);
      });
  }},
  { method: 'POST', pattern: /^\/api\/tickets\/(\d+)\/release$/, handler: (body, id) => {
    const supabase = getSupabaseClient();
    return supabase.from('cs_tickets').select('active_draft_id').eq('id', parseInt(id)).single()
      .then(({ data: t }) => {
        if (!t?.active_draft_id) throw new Error('No active draft for this ticket');
        return apiReleaseDraft(t.active_draft_id, body);
      });
  }},
  { method: 'POST', pattern: /^\/api\/tickets\/(\d+)\/spam$/, handler: (_, id) => {
    const supabase = getSupabaseClient();
    return supabase.from('cs_tickets').select('active_draft_id').eq('id', parseInt(id)).single()
      .then(({ data: t }) => {
        if (!t?.active_draft_id) throw new Error('No active draft for this ticket');
        return apiMarkSpam(t.active_draft_id);
      });
  }},
  { method: 'POST', pattern: /^\/api\/tickets\/(\d+)\/delete$/, handler: (_, id) => {
    const supabase = getSupabaseClient();
    return supabase.from('cs_tickets').select('active_draft_id').eq('id', parseInt(id)).single()
      .then(({ data: t }) => {
        if (!t?.active_draft_id) throw new Error('No active draft for this ticket');
        return apiDeleteDraft(t.active_draft_id);
      });
  }},
  { method: 'POST', pattern: /^\/api\/tickets\/(\d+)\/execute\/exchange$/, handler: (body, id) => {
    const supabase = getSupabaseClient();
    return supabase.from('cs_tickets').select('active_draft_id').eq('id', parseInt(id)).single()
      .then(({ data: t }) => {
        if (!t?.active_draft_id) throw new Error('No active draft for this ticket');
        return apiExecuteExchange(t.active_draft_id, body);
      });
  }},
  { method: 'POST', pattern: /^\/api\/tickets\/(\d+)\/execute\/refund$/, handler: (body, id) => {
    const supabase = getSupabaseClient();
    return supabase.from('cs_tickets').select('active_draft_id').eq('id', parseInt(id)).single()
      .then(({ data: t }) => {
        if (!t?.active_draft_id) throw new Error('No active draft for this ticket');
        return apiExecuteRefund(t.active_draft_id, body);
      });
  }},
  { method: 'POST', pattern: /^\/api\/tickets\/(\d+)\/execute\/edit$/, handler: (body, id) => {
    const supabase = getSupabaseClient();
    return supabase.from('cs_tickets').select('active_draft_id').eq('id', parseInt(id)).single()
      .then(({ data: t }) => {
        if (!t?.active_draft_id) throw new Error('No active draft for this ticket');
        return apiExecuteEdit(t.active_draft_id, body);
      });
  }},
  { method: 'POST', pattern: /^\/api\/tickets\/(\d+)\/action-chat$/, handler: (body, id) => {
    const supabase = getSupabaseClient();
    return supabase.from('cs_tickets').select('active_draft_id').eq('id', parseInt(id)).single()
      .then(({ data: t }) => {
        if (!t?.active_draft_id) throw new Error('No active draft for this ticket');
        return apiActionChat(t.active_draft_id, body);
      });
  }},
  { method: 'POST', pattern: /^\/api\/tickets\/(\d+)\/message$/, handler: (body, id) => apiSendTicketMessage(parseInt(id), body) },
  { method: 'POST', pattern: /^\/api\/tickets\/(\d+)\/reopen$/, handler: (_, id) => apiReopenTicket(parseInt(id)) },
  // Legacy draft routes (kept for simulator + backward compat)
  { method: 'POST', pattern: /^\/api\/test$/, handler: (body) => apiRunTest(body) },
  { method: 'POST', pattern: /^\/api\/replay$/, handler: (body) => apiReplayTicket(body) },
  { method: 'GET', pattern: /^\/api\/simulator\/random$/, handler: (_, __, req) => {
    const url = new URL(req.url, 'http://localhost');
    return apiSimulatorRandom(url.searchParams.get('category'), url.searchParams.get('ticket'));
  }},
  { method: 'POST', pattern: /^\/api\/simulator\/turn$/, handler: (body) => apiSimulatorTurn(body) },
  { method: 'POST', pattern: /^\/api\/simulator\/save$/, handler: (body) => apiSimulatorSave(body) },
  { method: 'POST', pattern: /^\/api\/simulator\/save-turn$/, handler: (body) => apiSimulatorSaveTurn(body) },
  { method: 'POST', pattern: /^\/api\/simulator\/update-turn$/, handler: (body) => apiSimulatorUpdateTurn(body) },
];

async function handleRequest(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  // SSE stream endpoint (not JSON)
  if (pathname === '/api/poll/stream' && req.method === 'GET') {
    return apiPollStream(req, res);
  }

  // API routes
  if (pathname.startsWith('/api/')) {
    res.setHeader('Content-Type', 'application/json');

    try {
      // Static routes
      const routeKey = `${req.method} ${pathname}`;
      if (routes[routeKey]) {
        const result = await routes[routeKey](req);
        res.writeHead(200);
        res.end(JSON.stringify(result));
        return;
      }

      // Param routes
      for (const route of paramRoutes) {
        if (req.method !== route.method) continue;
        const match = pathname.match(route.pattern);
        if (match) {
          let body = {};
          if (req.method === 'POST') {
            body = await readBody(req);
          }
          const result = await route.handler(body, match[1], req);
          res.writeHead(200);
          res.end(JSON.stringify(result));
          return;
        }
      }

      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Not found' }));
    } catch (err) {
      console.error(`[dashboard] API error: ${err.message}`);
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Static files
  let filePath = pathname === '/' ? '/index.html' : pathname;
  const fullPath = path.join(STATIC_DIR, filePath);

  // Prevent directory traversal
  if (!fullPath.startsWith(STATIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  try {
    const content = fs.readFileSync(fullPath);
    const ext = path.extname(fullPath);
    res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
    res.writeHead(200);
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

// Reuse from poller
function computeEditDistance(a, b) {
  if (!a && !b) return 0;
  if (!a || !b) return 1;
  const wordsA = a.toLowerCase().split(/\s+/);
  const wordsB = b.toLowerCase().split(/\s+/);
  const maxLen = Math.max(wordsA.length, wordsB.length);
  if (maxLen === 0) return 0;
  const m = wordsA.length, n = wordsB.length;
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
// Start server
// ---------------------------------------------------------------------------

const server = http.createServer(handleRequest);
server.listen(PORT, async () => {
  console.log(`\n  RUBIES Care running at http://localhost:${PORT}\n`);
  await loadProductConfig();
});
