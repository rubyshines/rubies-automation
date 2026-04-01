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

  // Send to Gorgias
  const replyResult = await gorgias.createTicketReply(draft.gorgias_ticket_id, {
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
  const { buildConversationContext } = require('../poller/pollGorgiasDrafts');
  let contextParts = [];
  if (typeof buildConversationContext === 'function') {
    const ctx = buildConversationContext(messages, lastCustomer.id);
    if (ctx) contextParts.push(`[CONVERSATION HISTORY]\n${ctx}`);
  }
  contextParts.push(`[LATEST CUSTOMER MESSAGE]\n${messageText}`);
  const issueDescription = contextParts.join('\n\n');

  // Run advisor
  const advisorTools = require('../lib/tools/exchangeAdvisor');
  const advisor = advisorTools.find(t => t.name === 'cs_advisor') || advisorTools.find(t => t.name === 'exchange_advisor');
  const result = await advisor.handler({
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
    confidence: s?.status === 'ready' ? 'high' : s?.status === 'needs_info' ? 'medium' : 'low',
  }).eq('id', id);

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

  return { success: true };
}

async function apiDeleteDraft(id) {
  const supabase = getSupabaseClient();

  const { data: draft, error: fetchErr } = await supabase
    .from('cs_ai_drafts')
    .select('gorgias_ticket_id')
    .eq('id', id)
    .single();
  if (fetchErr) throw fetchErr;

  // Unassign from AI Bot so ticket goes back to inbox
  if (draft.gorgias_ticket_id) {
    try {
      await gorgias.assignTicket(draft.gorgias_ticket_id, null);
    } catch (err) {
      console.warn(`[dashboard] Could not unassign ticket on delete: ${err.message}`);
    }
  }

  // Delete the draft
  const { error: delErr } = await supabase
    .from('cs_ai_drafts')
    .delete()
    .eq('id', id);
  if (delErr) throw delErr;

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

async function apiSimulatorRandom(category) {
  const supabase = getSupabaseClient();
  const gorgiasClient = require('../import/gorgiasClient');

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

  // Pick a random conversation from Supabase matching the category
  let q = supabase
    .from('cs_conversations')
    .select('id, customer_email, order_numbers, subject, summary, message_count, source_id, category')
    .or(orFilter)
    .gt('message_count', 2)
    .limit(100);

  // Only require order_numbers for exchange/sizing (others may not have orders)
  if (['exchange', 'sizing'].includes(filterType)) {
    q = q.not('order_numbers', 'is', null);
  }

  const { data: convos } = await q;

  if (!convos?.length) throw new Error(`No ${filterType} conversations found`);
  const convo = convos[Math.floor(Math.random() * convos.length)];

  // Load messages from Gorgias API (has correct from_agent + stripped_text)
  const ticketId = convo.source_id || convo.id.replace('gorgias:', '');
  const messages = await gorgiasClient.getTicketMessages(ticketId);

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
  const orderNumber = convo.order_numbers?.[0];
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
    conversation: { id: convo.id, subject: convo.subject, summary: convo.summary, customer_email: convo.customer_email, order_number: orderNumber },
    firstMessage,
    orderContext,
    customerContext,
  };
}

async function apiSimulatorTurn(body) {
  const { customer_email, issue_description, order_number, intake, previous_responses } = body;
  if (!customer_email || !issue_description) throw new Error('Provide customer_email and issue_description');

  const advisorTools = require('../lib/tools/exchangeAdvisor');
  const advisor = advisorTools.find(t => t.name === 'cs_advisor') || advisorTools.find(t => t.name === 'exchange_advisor');

  const result = await advisor.handler({
    customer_email,
    issue_description,
    order_number: order_number || undefined,
    intake: intake || undefined,
  });

  const s = result._structured;
  let aiResponse = s?._composedResponse || '';
  if (!aiResponse && s) {
    try {
      const { composeAgentResponse } = require('../lib/responseComposer');
      aiResponse = await composeAgentResponse(s, previous_responses || []);
    } catch (e) {
      aiResponse = `[Compose error: ${e.message}]`;
    }
  }

  return {
    ai_response: aiResponse,
    structured: s,
  };
}

async function apiSimulatorSave(body) {
  const supabase = getSupabaseClient();
  const { source_conversation_id, customer_email, order_number, order_context, customer_context, turns, status } = body;

  const { data, error } = await supabase
    .from('cs_simulator_sessions')
    .insert({
      source_conversation_id,
      customer_email: customer_email || 'unknown',
      order_number,
      order_context,
      customer_context,
      turns: turns || [],
      status: status || 'completed',
      completed_at: new Date().toISOString(),
    })
    .select('id')
    .single();

  if (error) throw error;
  return { id: data.id };
}

async function apiTriggerPoll() {
  const { run } = require('../poller/pollGorgiasDrafts');
  return run();
}

// SSE version of poll with progress streaming
function apiPollStream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  const { run } = require('../poller/pollGorgiasDrafts');
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
// Routing
// ---------------------------------------------------------------------------

const routes = {
  'GET /api/drafts': (req) => apiGetDrafts(new URL(req.url, 'http://localhost').searchParams),
  'GET /api/stats': () => apiGetStats(),
  'GET /api/history': (req) => apiGetHistory(new URL(req.url, 'http://localhost').searchParams),
  'POST /api/poll': () => apiTriggerPoll(),
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
  { method: 'POST', pattern: /^\/api\/drafts\/(\d+)\/close$/, handler: (body, id) => apiCloseDraft(parseInt(id), body) },
  { method: 'POST', pattern: /^\/api\/drafts\/(\d+)\/train$/, handler: (body, id) => apiTrainDraft(parseInt(id), body) },
  { method: 'POST', pattern: /^\/api\/drafts\/(\d+)\/refresh$/, handler: (_, id) => apiRefreshDraft(parseInt(id)) },
  { method: 'POST', pattern: /^\/api\/drafts\/(\d+)\/release$/, handler: (body, id) => apiReleaseDraft(parseInt(id), body) },
  { method: 'POST', pattern: /^\/api\/drafts\/(\d+)\/delete$/, handler: (_, id) => apiDeleteDraft(parseInt(id)) },
  { method: 'POST', pattern: /^\/api\/test$/, handler: (body) => apiRunTest(body) },
  { method: 'POST', pattern: /^\/api\/replay$/, handler: (body) => apiReplayTicket(body) },
  { method: 'GET', pattern: /^\/api\/simulator\/random$/, handler: (_, __, req) => {
    const url = new URL(req.url, 'http://localhost');
    return apiSimulatorRandom(url.searchParams.get('category'));
  }},
  { method: 'POST', pattern: /^\/api\/simulator\/turn$/, handler: (body) => apiSimulatorTurn(body) },
  { method: 'POST', pattern: /^\/api\/simulator\/save$/, handler: (body) => apiSimulatorSave(body) },
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
server.listen(PORT, () => {
  console.log(`\n  CS Draft Dashboard running at http://localhost:${PORT}\n`);
});
