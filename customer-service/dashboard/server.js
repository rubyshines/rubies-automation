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
const crypto = require('crypto');

if (!process.env.SUPABASE_URL) {
  require('dotenv').config({ path: path.resolve(__dirname, '../..', '.env') });
}

const { execSync } = require('child_process');

// Capture git version at startup
let GIT_VERSION;
try {
  const hash = execSync('git rev-parse HEAD', { cwd: __dirname, encoding: 'utf8' }).trim();
  const short = hash.slice(0, 7);
  const date = execSync('git log -1 --format=%ci', { cwd: __dirname, encoding: 'utf8' }).trim();
  GIT_VERSION = { hash, short, date, started: new Date().toISOString() };
} catch { GIT_VERSION = { hash: 'unknown', short: '???', date: '', started: new Date().toISOString() }; }

const { getSupabaseClient } = require('../../shared/supabaseClient');
const gorgias = require('../import/gorgiasClient');
const { fetchOrderByNumber, warehanceOrderUrl } = require('../../reports/lib/warehanceClient');
const { autoLinkProducts } = require('../lib/autoLinker');
const { canonicalMessageType } = require('../lib/messageTypes');
const Anthropic = require('@anthropic-ai/sdk');

// Product config for auto-linking (loaded at startup)
// Product config loaded at startup for any server-side product lookups
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

const PORT = process.env.PORT || process.env.DASHBOARD_PORT || 3847;
const STATIC_DIR = path.join(__dirname, 'public');

// MIME types for static files
const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};

// ---------------------------------------------------------------------------
// Authentication (Google OAuth + signed cookie session)
// ---------------------------------------------------------------------------

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const ALLOWED_EMAIL = process.env.ALLOWED_EMAIL;
const SESSION_SECRET = process.env.SESSION_SECRET;
const SESSION_MAX_AGE = 30 * 24 * 60 * 60; // 30 days in seconds
const DASHBOARD_API_TOKEN = process.env.DASHBOARD_API_TOKEN;

function isLocalRequest(req) {
  const addr = req.socket && req.socket.remoteAddress;
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function verifyBearerToken(req) {
  if (!DASHBOARD_API_TOKEN) return false;
  if (!isLocalRequest(req)) return false;
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  const provided = Buffer.from(match[1]);
  const expected = Buffer.from(DASHBOARD_API_TOKEN);
  if (provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(provided, expected);
}

let _oauthClient = null;
async function verifyGoogleToken(idToken) {
  if (!_oauthClient) {
    const { OAuth2Client } = require('google-auth-library');
    _oauthClient = new OAuth2Client(GOOGLE_CLIENT_ID);
  }
  const ticket = await _oauthClient.verifyIdToken({
    idToken,
    audience: GOOGLE_CLIENT_ID,
  });
  return ticket.getPayload();
}

function signSession(email) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_MAX_AGE;
  const payload = JSON.stringify({ email, exp });
  const b64 = Buffer.from(payload).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(b64).digest('base64url');
  return `${b64}.${sig}`;
}

function verifySession(cookie) {
  if (!cookie || !SESSION_SECRET) return null;
  const [b64, sig] = cookie.split('.');
  if (!b64 || !sig) return null;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(b64).digest('base64url');
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(b64, 'base64url').toString());
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const cookies = {};
  header.split(';').forEach(pair => {
    const [name, ...rest] = pair.trim().split('=');
    if (name) cookies[name.trim()] = decodeURIComponent(rest.join('='));
  });
  return cookies;
}

function setSessionCookie(res, value, host) {
  const isLocalhost = (host || '').startsWith('localhost');
  const flags = [
    `session=${encodeURIComponent(value)}`,
    `Path=/`,
    `HttpOnly`,
    `SameSite=Lax`,
    `Max-Age=${SESSION_MAX_AGE}`,
  ];
  if (!isLocalhost) flags.push('Secure');
  res.setHeader('Set-Cookie', flags.join('; '));
}

function clearSessionCookie(res, host) {
  const isLocalhost = (host || '').startsWith('localhost');
  const flags = [
    'session=',
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (!isLocalhost) flags.push('Secure');
  res.setHeader('Set-Cookie', flags.join('; '));
}

function isAuthEnabled() {
  return !!(GOOGLE_CLIENT_ID && ALLOWED_EMAIL && SESSION_SECRET);
}

// Paths that don't require auth
const AUTH_WHITELIST = new Set(['/login.html', '/health', '/manifest.json', '/sw.js']);
function isAuthWhitelisted(pathname) {
  if (AUTH_WHITELIST.has(pathname)) return true;
  if (pathname.startsWith('/auth/')) return true;
  if (pathname.startsWith('/icons/')) return true;
  // Allow CSS/fonts for login page styling
  if (pathname === '/styles.css') return true;
  return false;
}

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
  const bodyHtml = autoLinkProducts(finalResponse);

  // Two paths converge here:
  //   - Inbound replies (the common case): post a reply to an existing Gorgias ticket.
  //   - Operator-initiated outbound drafts (created via create_outreach_ticket
  //     in the standalone operator console): no Gorgias ticket exists yet —
  //     create the outbound ticket now, which dispatches the email, and
  //     back-fill gorgias_ticket_id on both cs_ai_drafts and cs_tickets so all
  //     downstream lookups by gorgias_ticket_id continue to work.
  let replyResult;
  const isOutboundInitiated = !draft.gorgias_ticket_id;
  if (isOutboundInitiated) {
    const subject = draft.structured_output?.subject || '(no subject)';
    const newTicket = await gorgias.createOutboundTicket({
      customerEmail: draft.customer_email,
      customerName: draft.customer_name || '',
      subject,
      bodyHtml,
      bodyText: finalResponse,
    });
    const messages = await gorgias.getTicketMessages(newTicket.id);
    const outbound = messages.find(m => m.from_agent === true);
    replyResult = { id: outbound?.id };
    draft.gorgias_ticket_id = newTicket.id;
    draft.gorgias_message_id = outbound?.id || null;
    if (draft.ticket_id) {
      await supabase.from('cs_tickets').update({
        gorgias_ticket_id: newTicket.id,
        gorgias_status: 'open',
        gorgias_updated_at: new Date().toISOString(),
      }).eq('id', draft.ticket_id);
    }
  } else {
    replyResult = await gorgias.createTicketReply(draft.gorgias_ticket_id, {
      body_html: bodyHtml,
      body_text: finalResponse,
      attachments: body.attachments,
    });
  }

  const wasEdited = (draft.draft_response || '').trim() !== finalResponse.trim();

  // Update draft
  const draftUpdate = {
    status: 'sent',
    sent_response: finalResponse,
    feedback_notes: notes,
    reviewed_at: new Date().toISOString(),
    sent_at: new Date().toISOString(),
    gorgias_reply_message_id: replyResult?.id || null,
  };
  if (isOutboundInitiated) {
    draftUpdate.gorgias_ticket_id = draft.gorgias_ticket_id;
    draftUpdate.gorgias_message_id = draft.gorgias_message_id;
  }
  if (body.focus_time_seconds != null) draftUpdate.focus_time_seconds = Math.round(body.focus_time_seconds);
  await supabase.from('cs_ai_drafts').update(draftUpdate).eq('id', id);

  // Post-send action: snooze (default) or close
  const afterAction = body.after || 'snooze';

  // Log feedback — original_response should be the FIRST draft for this ticket
  // (pre-steer), not the active draft, so Haiku comparison captures the full delta
  let originalResponse = draft.draft_response;
  if (draft.ticket_id) {
    const { data: firstDraft } = await supabase
      .from('cs_ai_drafts')
      .select('draft_response')
      .eq('ticket_id', draft.ticket_id)
      .is('operator_steer', null)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (firstDraft?.draft_response) originalResponse = firstDraft.draft_response;
  }

  const baseAction = wasEdited || originalResponse !== draft.draft_response ? 'edited' : 'sent';
  await supabase.from('cs_ai_feedback_log').insert({
    draft_id: id,
    gorgias_ticket_id: draft.gorgias_ticket_id,
    action: `${baseAction}_${afterAction}`,
    original_response: originalResponse,
    final_response: finalResponse,
    feedback_notes: notes,
    advisor_status: draft.advisor_status,
    confidence: draft.confidence,
    message_type: draft.message_type,
    turn_number: draft.turn_number,
  });
  // Append reply to conversation history BEFORE Gorgias snooze/close
  // (the snooze triggers a webhook that can race and overwrite history)
  const { data: ticketRow } = await supabase
    .from('cs_tickets')
    .select('conversation_history')
    .eq('gorgias_ticket_id', draft.gorgias_ticket_id)
    .single();
  const history = ticketRow?.conversation_history || [];
  history.push({
    id: replyResult?.id,
    sender: 'agent',
    is_bot: false,
    body: finalResponse,
    body_html: bodyHtml,
    created_at: new Date().toISOString(),
    channel: 'email',
  });

  // Save conversation history FIRST (Gorgias webhook can race and overwrite)
  await supabase.from('cs_tickets').update({
    conversation_history: history,
    updated_at: new Date().toISOString(),
  }).eq('gorgias_ticket_id', draft.gorgias_ticket_id);

  // Update Gorgias SECOND — if this fails, status stays unchanged and the error propagates
  if (afterAction === 'close') {
    await gorgias.closeTicket(draft.gorgias_ticket_id);
    await gorgias.assignTicket(draft.gorgias_ticket_id, null);
    await gorgias.addTicketTag(draft.gorgias_ticket_id, 'ai-resolved');
  } else {
    const snoozeDays = body.testSnooze ? 0.004 : 3; // ~5 min for testing, 3 days for production
    await gorgias.snoozeTicket(draft.gorgias_ticket_id, snoozeDays);
  }

  // Update DB status LAST — only after Gorgias succeeded
  const extraFields = { has_agent_reply: true };
  if (body.testSnooze) extraFields.test_snooze = true;
  await updateTicketStatus(supabase, draft.gorgias_ticket_id, afterAction === 'close' ? 'closed' : 'snoozed', extraFields);

  // Donation audit log + counter increment. Runs once per ticket: only the
  // first send that contains a donation routing decision counts; later sends
  // on the same ticket (re-sends, follow-ups) do NOT double-count. Failures
  // here must NOT roll back the send — log and continue.
  try {
    const donation = draft.structured_output?.prescription?.donation;
    if (donation?.type && donation.type !== 'skip_defect') {
      const { count } = await supabase
        .from('donation_routings')
        .select('id', { count: 'exact', head: true })
        .eq('customer_email', draft.customer_email)
        .eq('order_number', String(draft.order_number || '').replace('#', '') || null);
      if (!count) {
        const { logDonationRouting } = require('../lib/donationRouting');
        await logDonationRouting({
          customer_email: draft.customer_email,
          order_number: String(draft.order_number || '').replace('#', '') || null,
          partner_id: donation.partner_id || null,
          items_count: donation.items_count || 1,
          routing_type: donation.type,
        });
      }
    }
  } catch (err) {
    console.warn(`[donation-routing] log failed for draft ${id}: ${err.message}`);
  }

  return { success: true, gorgias_message_id: replyResult?.id, after: afterAction };
}

async function apiCloseDraft(id, body) {
  const supabase = getSupabaseClient();

  const { data: draft, error: fetchErr } = await supabase
    .from('cs_ai_drafts')
    .select('gorgias_ticket_id')
    .eq('id', id)
    .single();
  if (fetchErr) throw fetchErr;

  // Close in Gorgias FIRST — if this fails, operation fails and ticket stays open
  await gorgias.closeTicket(draft.gorgias_ticket_id);
  await gorgias.assignTicket(draft.gorgias_ticket_id, null);

  // Update DB only after Gorgias succeeded
  const draftUpdate = {
    status: 'sent',
    feedback_notes: body.notes || 'Closed without reply',
    reviewed_at: new Date().toISOString(),
    sent_at: new Date().toISOString(),
  };
  if (body.focus_time_seconds != null) draftUpdate.focus_time_seconds = Math.round(body.focus_time_seconds);
  await supabase.from('cs_ai_drafts').update(draftUpdate).eq('id', id);

  await supabase.from('cs_ai_feedback_log').insert({
    draft_id: id,
    gorgias_ticket_id: draft.gorgias_ticket_id,
    action: 'closed_no_reply',
    feedback_notes: body.notes || null,
  });

  await updateTicketStatus(supabase, draft.gorgias_ticket_id, 'closed');

  return { success: true };
}


async function apiRefreshDraft(id, { steer, onStream } = {}) {
  const warnings = [];
  const _emit = onStream || (() => {});
  const supabase = getSupabaseClient();
  const gorgiasClient = require('../import/gorgiasClient');

  const { data: draft, error: fetchErr } = await supabase
    .from('cs_ai_drafts')
    .select('*')
    .eq('id', id)
    .single();
  if (fetchErr) throw fetchErr;

  // Re-fetch messages + ticket from Gorgias and re-run advisor
  const [messages, gorgiasTicket] = await Promise.all([
    gorgiasClient.getTicketMessages(draft.gorgias_ticket_id),
    gorgiasClient.getTicket(draft.gorgias_ticket_id).catch(() => null),
  ]);
  const lastCustomer = [...messages].reverse().find(m => m.from_agent === false);
  if (!lastCustomer) throw new Error('No customer message found');
  const senderName = [gorgiasTicket?.customer?.firstname, gorgiasTicket?.customer?.lastname]
    .filter(Boolean)
    .join(' ')
    .trim() || gorgiasTicket?.customer?.name || null;

  const { extractCleanBody, buildConversationContext } = require('../intake/processGorgiasTickets');
  const messageText = extractCleanBody(lastCustomer).text;
  let contextParts = [];
  if (typeof buildConversationContext === 'function') {
    const ctx = buildConversationContext(messages, lastCustomer.id);
    if (ctx) contextParts.push(`[CONVERSATION HISTORY]\n${ctx}`);
  }
  contextParts.push(`[LATEST CUSTOMER MESSAGE]\n${messageText}`);
  const issueDescription = contextParts.join('\n\n');

  // Build context up front so we can update cs_tickets with the resolved
  // customer/order (sidebar card), and pass it to the advisor as preContext.
  const { buildContext } = require('../lib/contextBuilder');
  let preContext = null;
  try {
    preContext = await buildContext({
      customer_email: draft.customer_email,
      customer_name: senderName,
      issue_description: issueDescription,
      current_gorgias_ticket_id: draft.gorgias_ticket_id,
    });
  } catch (err) {
    console.warn(`[refresh] buildContext failed: ${err.message}`);
  }

  _emit({ type: 'status', text: 'Generating draft...' });

  // Run hybrid advisor (same as intake path)
  const { aiAdvisor } = require('../lib/aiAdvisor');
  const result = await aiAdvisor({
    customer_email: draft.customer_email,
    customer_name: senderName,
    issue_description: issueDescription,
    intake: draft.intake_state || undefined,
    preContext,
    operatorSteer: steer || undefined,
    onStream: onStream ? (event) => _emit(event) : undefined,
    ticket_id: draft.gorgias_ticket_id,
    draft_id: draft.id,
  });

  const _tPost = Date.now();
  const s = result._structured;
  const newDraft = s?._composedResponse || result?.draft || '[No response composed]';

  // Update the draft in Supabase
  const updates = {
    draft_response: newDraft,
    structured_output: s,
    audit_trail: s?.audit || [],
    advisor_status: s?.status,
    confidence: (s?.status === 'ready' || s?.status === 'action_needed') ? 'high' : s?.status === 'needs_info' ? 'medium' : 'low',
    action_type: s?.action_type || null,
    message_type: canonicalMessageType(s?.message_type, `draft ${id}`),
    order_number: s?.order?.name || s?.intake?.order_number ? `#${(s?.order?.name || s?.intake?.order_number).toString().replace('#', '')}` : undefined,
  };
  if (steer) updates.operator_steer = steer;

  // On re-draft: keep action chat history (don't lose operator work) but clear
  // execution state so the action panel reflects the new draft's recommendation.
  // Action is "completed" if the legacy execute path filed `phase='completed'`
  // OR a chat-path completion was filed into `actions[]` (the canonical timeline log).
  const actionCompleted = draft.action_result?.phase === 'completed'
    || (Array.isArray(draft.actions) && draft.actions.length > 0);
  if (!actionCompleted) {
    const prevChat = draft.action_result;
    if (prevChat?.chat_history?.length) {
      updates.action_result = {
        chat_history: prevChat.chat_history,
        chat_tool_results: prevChat.chat_tool_results,
        chat_response: prevChat.chat_response,
        chat_links: prevChat.chat_links,
      };
    } else {
      updates.action_result = null;
    }
    updates.action_executed_at = null;
  }

  // Diagnostic: capture the prior draft on the draft_history array before we
  // overwrite. Lets us study advisor drift across regenerations (whether the
  // same draft is produced repeatedly, varies wildly, or drifts toward a
  // particular pattern). Skip when there's no prior draft (initial fill).
  if (draft.draft_response && draft.draft_response.trim()) {
    const prevHistory = Array.isArray(draft.draft_history) ? draft.draft_history : [];
    updates.draft_history = [
      ...prevHistory,
      {
        regenerated_at: new Date().toISOString(),
        draft_response: draft.draft_response,
        structured_output: draft.structured_output,
        operator_steer: draft.operator_steer || null,
      },
    ];
  }

  const _tWrite1 = Date.now();
  await supabase.from('cs_ai_drafts').update(updates).eq('id', id);
  const _tWrite1Done = Date.now();

  // Also update ticket row with latest classification
  if (draft.ticket_id) {
    const ticketUpdates = { updated_at: new Date().toISOString() };
    if (s?.message_type) ticketUpdates.message_type = canonicalMessageType(s.message_type, `ticket ${draft.ticket_id}`);
    if (s?.customer_sentiment) ticketUpdates.customer_sentiment = s.customer_sentiment;
    if (s?.confidence) ticketUpdates.confidence = s.confidence;
    if (s?.status) ticketUpdates.advisor_status = s.status;
    const resolvedOrderName = s?.order?.name || preContext?.targetOrder?.name || null;
    if (resolvedOrderName) {
      ticketUpdates.order_number = resolvedOrderName.toString().startsWith('#')
        ? resolvedOrderName
        : `#${resolvedOrderName}`;
    }
    if (s?.order) ticketUpdates.order_context = s.order;
    if (preContext?.customerCountry) ticketUpdates.customer_country = preContext.customerCountry;
    if (preContext?.resolvedByName && preContext?.customer?.email) {
      ticketUpdates.customer_email = preContext.customer.email;
    }
    const { error: ticketErr } = await supabase.from('cs_tickets').update(ticketUpdates).eq('id', draft.ticket_id);
    if (ticketErr) {
      console.error(`[refresh] ticket ${draft.ticket_id} update failed:`, ticketErr);
      warnings.push(`Ticket update failed: ${ticketErr.message}`);
      _emit({ type: 'warning', message: `Ticket update failed: ${ticketErr.message}` });
    }
  }
  const _tDone = Date.now();
  console.log(`[refresh] post-advisor: ${_tDone - _tPost}ms total (parse: ${_tWrite1 - _tPost}ms, draft write: ${_tWrite1Done - _tWrite1}ms, ticket write: ${_tDone - _tWrite1Done}ms) | advisor: ${s?._timing?.total_ms || '?'}ms`);

  return { draft_response: newDraft, draft_id: id, structured: s, warnings };
}

async function apiReleaseDraft(id, body) {
  const supabase = getSupabaseClient();

  const { data: draft, error: fetchErr } = await supabase
    .from('cs_ai_drafts')
    .select('gorgias_ticket_id')
    .eq('id', id)
    .single();
  if (fetchErr) throw fetchErr;

  // Unassign from AI Bot in Gorgias FIRST — if this fails, operation fails
  await gorgias.assignTicket(draft.gorgias_ticket_id, null);

  // Update draft
  const draftUpdate = {
    status: 'released',
    feedback_notes: body.notes || 'Released to Gorgias',
    reviewed_at: new Date().toISOString(),
  };
  if (body.focus_time_seconds != null) draftUpdate.focus_time_seconds = Math.round(body.focus_time_seconds);
  await supabase.from('cs_ai_drafts').update(draftUpdate).eq('id', id);

  // Log feedback
  await supabase.from('cs_ai_feedback_log').insert({
    draft_id: id,
    gorgias_ticket_id: draft.gorgias_ticket_id,
    action: 'released',
    feedback_notes: body.notes || null,
  });

  // Mark as released (NOT closed — the ticket is still open in Gorgias for manual handling)
  await updateTicketStatus(supabase, draft.gorgias_ticket_id, 'released');

  return { success: true };
}

async function apiDeleteDraft(id, body = {}) {
  const supabase = getSupabaseClient();

  const { data: draft, error: fetchErr } = await supabase
    .from('cs_ai_drafts')
    .select('ticket_id, gorgias_ticket_id, message_type, confidence, advisor_status')
    .eq('id', id)
    .maybeSingle();
  if (fetchErr) throw fetchErr;
  if (!draft) return { success: true };

  // Close in Gorgias FIRST — if this fails, operation fails and ticket stays open
  if (draft.gorgias_ticket_id) {
    await gorgias.closeTicket(draft.gorgias_ticket_id);
    await gorgias.assignTicket(draft.gorgias_ticket_id, null);
  }

  // Update DB only after Gorgias succeeded
  const draftUpdate = {
    status: 'deleted',
    reviewed_at: new Date().toISOString(),
  };
  if (body.focus_time_seconds != null) draftUpdate.focus_time_seconds = Math.round(body.focus_time_seconds);
  await supabase.from('cs_ai_drafts').update(draftUpdate).eq('id', id);

  // Log feedback (filtered — excluded from quality rates)
  await supabase.from('cs_ai_feedback_log').insert({
    draft_id: id,
    gorgias_ticket_id: draft.gorgias_ticket_id,
    action: 'deleted',
    message_type: draft.message_type,
    confidence: draft.confidence,
    advisor_status: draft.advisor_status,
  });

  // Close the ticket. updateTicketStatus matches on gorgias_ticket_id; for
  // proactive-outreach drafts with no Gorgias ticket yet (created via
  // create_outreach_ticket), close the cs_tickets row directly by id so it
  // doesn't linger in the queue pointing at a deleted draft.
  if (draft.gorgias_ticket_id) {
    await updateTicketStatus(supabase, draft.gorgias_ticket_id, 'closed');
  } else if (draft.ticket_id) {
    const now = new Date().toISOString();
    await supabase.from('cs_tickets')
      .update({ status: 'closed', updated_at: now, closed_at: now, active_draft_id: null })
      .eq('id', draft.ticket_id);
  }

  return { success: true };
}

async function apiMarkSpam(id, body = {}) {
  const supabase = getSupabaseClient();

  const { data: draft, error: fetchErr } = await supabase
    .from('cs_ai_drafts')
    .select('gorgias_ticket_id, message_type, confidence, advisor_status')
    .eq('id', id)
    .maybeSingle();
  if (fetchErr) throw fetchErr;
  if (!draft) return { success: true };

  // Close in Gorgias FIRST — if this fails, operation fails and ticket stays open
  if (draft.gorgias_ticket_id) {
    await gorgias.addTicketTag(draft.gorgias_ticket_id, 'spam');
    await gorgias.closeTicket(draft.gorgias_ticket_id);
    await gorgias.assignTicket(draft.gorgias_ticket_id, null);
  }

  // Update DB only after Gorgias succeeded
  const draftUpdate = {
    status: 'spam',
    reviewed_at: new Date().toISOString(),
  };
  if (body.focus_time_seconds != null) draftUpdate.focus_time_seconds = Math.round(body.focus_time_seconds);
  await supabase.from('cs_ai_drafts').update(draftUpdate).eq('id', id);

  // Log feedback (filtered — excluded from quality rates)
  await supabase.from('cs_ai_feedback_log').insert({
    draft_id: id,
    gorgias_ticket_id: draft.gorgias_ticket_id,
    action: 'spam',
    message_type: draft.message_type,
    confidence: draft.confidence,
    advisor_status: draft.advisor_status,
  });

  if (draft.gorgias_ticket_id) {
    await updateTicketStatus(supabase, draft.gorgias_ticket_id, 'closed');
  }

  return { success: true };
}

/**
 * Return a misclassified ticket to the Gmail inbox with the correct classification.
 * Deletes the Gorgias ticket, closes the CS ticket, swaps Gmail labels, and records
 * the reclassification on email_messages for training data.
 */
async function apiReturnToInbox(ticketId, body) {
  const newClassification = body?.classification;
  if (!newClassification) throw new Error('classification is required');

  const { BUSINESS_AREAS, CLASSIFICATION_LABELS: CL_LABELS } = require('../../gmail-management/config');
  if (!BUSINESS_AREAS[newClassification]) throw new Error(`Unknown classification: ${newClassification}`);

  const supabase = getSupabaseClient();

  // Look up the CS ticket
  const { data: ticket, error: tErr } = await supabase.from('cs_tickets')
    .select('id, gorgias_ticket_id, customer_email, active_draft_id, source')
    .eq('id', ticketId)
    .single();
  if (tErr || !ticket) throw new Error('Ticket not found');

  // Find linked email_messages (gmail-import tickets)
  const { data: emails } = await supabase.from('email_messages')
    .select('gmail_message_id, classification')
    .eq('gorgias_ticket_id', ticket.gorgias_ticket_id);

  const now = new Date().toISOString();
  const oldClassification = emails?.[0]?.classification || 'customer_support';

  // 1. Delete Gorgias ticket FIRST — if this fails, nothing else changes
  if (ticket.gorgias_ticket_id) {
    await gorgias.deleteTicket(ticket.gorgias_ticket_id);
  }

  // 2. Swap Gmail labels (remove old, add new)
  if (emails?.length) {
    const { getGmail, getOrCreateLabel, labelMessage, removeLabelFromMessage } = require('../../gmail-management/lib/gmailClient');
    const gmail = await getGmail();

    const { CLASSIFICATION_LABELS } = require('../intake/processGmailCs');
    const oldLabelName = CLASSIFICATION_LABELS[oldClassification];
    const newLabelName = CLASSIFICATION_LABELS[newClassification];

    const oldLabelId = oldLabelName ? await getOrCreateLabel(gmail, oldLabelName) : null;
    const newLabelId = newLabelName ? await getOrCreateLabel(gmail, newLabelName) : null;

    for (const email of emails) {
      if (oldLabelId) await removeLabelFromMessage(gmail, email.gmail_message_id, oldLabelId);
      // Add new label + restore to INBOX (may have been archived during CS routing)
      const addLabels = [];
      if (newLabelId) addLabels.push(newLabelId);
      addLabels.push('INBOX');
      await gmail.users.messages.modify({
        userId: 'me',
        id: email.gmail_message_id,
        requestBody: { addLabelIds: addLabels },
      });
    }
  }

  // 3. Update email_messages — reclassify + mark returned
  if (emails?.length) {
    const gmailIds = emails.map(e => e.gmail_message_id);
    await supabase.from('email_messages').update({
      classification: newClassification,
      reclassified_from: oldClassification,
      reclassified_at: now,
      returned_to_inbox_at: now,
      forwarded_to_gorgias_at: null,
      gorgias_ticket_id: null,
    }).in('gmail_message_id', gmailIds);
  }

  // 4. Mark draft as returned + log feedback
  if (ticket.active_draft_id) {
    await supabase.from('cs_ai_drafts').update({
      status: 'returned',
      reviewed_at: now,
    }).eq('id', ticket.active_draft_id);

    const { data: draft } = await supabase.from('cs_ai_drafts')
      .select('message_type, confidence, advisor_status')
      .eq('id', ticket.active_draft_id)
      .single();

    await supabase.from('cs_ai_feedback_log').insert({
      draft_id: ticket.active_draft_id,
      gorgias_ticket_id: ticket.gorgias_ticket_id,
      action: 'returned_to_inbox',
      message_type: draft?.message_type,
      confidence: draft?.confidence,
      advisor_status: draft?.advisor_status,
      feedback_notes: `Reclassified: ${oldClassification} → ${newClassification}`,
    });
  }

  // 5. Close CS ticket in Supabase
  await updateTicketStatus(supabase, ticket.gorgias_ticket_id, 'closed');

  return { success: true, reclassified: { from: oldClassification, to: newClassification } };
}

async function apiGetStats() {
  const supabase = getSupabaseClient();

  const { data: recentFeedback } = await supabase
    .from('cs_ai_feedback_log')
    .select('action, confidence, message_type, created_at')
    .gte('created_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString())
    .order('created_at', { ascending: false });

  const { count: pendingCount } = await supabase
    .from('cs_ai_drafts')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'pending');

  const feedback = recentFeedback || [];
  const total = feedback.length;
  const sent = feedback.filter(f => f.action?.startsWith('sent_')).length;
  const edited = feedback.filter(f => f.action?.startsWith('edited_')).length;
  const released = feedback.filter(f => f.action === 'released').length;
  const bypassed = feedback.filter(f => f.action === 'bypassed').length;

  return {
    pending: pendingCount || 0,
    last30Days: { total, sent, edited, released, bypassed },
    acceptanceRate: total > 0 ? ((sent / total) * 100).toFixed(1) + '%' : 'N/A',
  };
}

// ---------------------------------------------------------------------------
// Performance analytics endpoints
// ---------------------------------------------------------------------------

const { dayBounds: _dayBounds, classifyFeedback: _classifyFeedback, pct: _pct, classifyOutcome: _classifyOutcome } = require('../lib/statsHelpers');

async function _queryDayStats(supabase, dateStr) {
  const { start, end, date } = _dayBounds(dateStr);

  // Feedback log for the day
  const { data: feedback } = await supabase
    .from('cs_ai_feedback_log')
    .select('id, action, original_response, final_response, message_type, confidence, draft_id, haiku_score, created_at')
    .gte('created_at', start).lte('created_at', end)
    .order('created_at', { ascending: true });

  const rows = feedback || [];
  const { noEdit, edited, released, closedNoReply, spam, deleted } = _classifyFeedback(rows);
  const handled = noEdit + edited + released; // tickets with a resolution action (quality-rated)
  const filtered = spam + deleted; // excluded from quality rates

  // Redirects: drafts created today with operator_steer set
  const { data: steeredDrafts } = await supabase
    .from('cs_ai_drafts')
    .select('ticket_id')
    .not('operator_steer', 'is', null)
    .gte('created_at', start).lte('created_at', end);

  const redirectTickets = new Set((steeredDrafts || []).map(d => d.ticket_id));
  const redirectCount = redirectTickets.size;

  // Focus time: from drafts that were sent today
  const draftIds = rows.filter(r => r.draft_id).map(r => r.draft_id);
  let avgFocusTime = null;
  let totalFocusTime = null;
  if (draftIds.length > 0) {
    const { data: draftsWithFocus } = await supabase
      .from('cs_ai_drafts')
      .select('focus_time_seconds')
      .in('id', draftIds)
      .gt('focus_time_seconds', 0);
    const focusTimes = (draftsWithFocus || []).map(d => d.focus_time_seconds);
    if (focusTimes.length > 0) {
      avgFocusTime = Math.round(focusTimes.reduce((a, b) => a + b, 0) / focusTimes.length);
      totalFocusTime = focusTimes.reduce((a, b) => a + b, 0);
    }
  }

  // By message_type breakdown
  const byType = {};
  for (const r of rows) {
    const mt = r.message_type || 'uncategorized';
    if (!byType[mt]) byType[mt] = { total: 0, noEdit: 0, edited: 0, released: 0 };
    byType[mt].total++;
    if (r.action === 'released') byType[mt].released++;
    else if (r.action?.startsWith('edited_')) byType[mt].edited++;
    else if (r.action?.startsWith('sent_')) byType[mt].noEdit++;
  }

  // Quality score: no-edit sends = 10, edited tickets use haiku_score
  const scores = [];
  const steerScores = [];
  for (const r of rows) {
    if (r.action?.startsWith('sent_')) scores.push(10);
    else if (r.haiku_score != null) scores.push(r.haiku_score);
    if (r.haiku_score_post_steer != null) steerScores.push(r.haiku_score_post_steer);
  }
  const avgQualityScore = scores.length > 0
    ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length * 10) / 10 : null;
  const avgSteerAccuracy = steerScores.length > 0
    ? Math.round(steerScores.reduce((a, b) => a + b, 0) / steerScores.length * 10) / 10 : null;

  return {
    date,
    tickets_handled: handled,
    no_edit_count: noEdit,
    edited_count: edited,
    redirect_count: redirectCount,
    released_count: released,
    closed_no_reply_count: closedNoReply,
    filtered_count: filtered,
    spam_count: spam,
    deleted_count: deleted,
    no_edit_rate: _pct(noEdit, handled),
    edit_rate: _pct(edited, handled),
    redirect_rate: _pct(redirectCount, handled),
    released_rate: _pct(released, handled),
    avg_focus_time_seconds: avgFocusTime,
    total_focus_time_seconds: totalFocusTime,
    avg_quality_score: avgQualityScore,
    avg_steer_accuracy: avgSteerAccuracy,
    by_message_type: byType,
  };
}

async function apiGetStatsDaily(query) {
  const supabase = getSupabaseClient();
  return _queryDayStats(supabase, query.get('date'));
}

async function apiGetStatsRange(query) {
  const supabase = getSupabaseClient();
  const startDate = query.get('start');
  const endDate = query.get('end');
  if (!startDate || !endDate) throw new Error('start and end query params required');

  // Bulk-fetch all feedback and steered drafts for the full date range in 2 queries
  // instead of 31 sequential per-day queries (was ~9s, now ~0.3s)
  const rangeStart = `${startDate}T00:00:00Z`;
  const rangeEnd = `${endDate}T23:59:59.999Z`;

  const [{ data: allFeedback }, { data: allSteered }, { data: allDrafts }] = await Promise.all([
    supabase.from('cs_ai_feedback_log')
      .select('id, action, message_type, confidence, draft_id, haiku_score, haiku_score_post_steer, created_at')
      .gte('created_at', rangeStart).lte('created_at', rangeEnd)
      .order('created_at', { ascending: true }),
    supabase.from('cs_ai_drafts')
      .select('ticket_id, created_at')
      .not('operator_steer', 'is', null)
      .gte('created_at', rangeStart).lte('created_at', rangeEnd),
    supabase.from('cs_ai_drafts')
      .select('id, focus_time_seconds')
      .gt('focus_time_seconds', 0)
      .gte('created_at', rangeStart).lte('created_at', rangeEnd),
  ]);

  const feedbackRows = allFeedback || [];
  const steeredRows = allSteered || [];
  const draftFocusMap = {};
  for (const d of (allDrafts || [])) draftFocusMap[d.id] = d.focus_time_seconds;

  // Group feedback by date (UTC date from created_at)
  const feedbackByDate = {};
  for (const r of feedbackRows) {
    const d = r.created_at.slice(0, 10);
    if (!feedbackByDate[d]) feedbackByDate[d] = [];
    feedbackByDate[d].push(r);
  }

  // Group steered drafts by date → unique ticket IDs per day
  const redirectsByDate = {};
  for (const s of steeredRows) {
    const d = s.created_at.slice(0, 10);
    if (!redirectsByDate[d]) redirectsByDate[d] = new Set();
    redirectsByDate[d].add(s.ticket_id);
  }

  // Generate date range
  const dates = [];
  const cur = new Date(startDate);
  const last = new Date(endDate);
  while (cur <= last) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setDate(cur.getDate() + 1);
  }

  const dailyBreakdown = [];
  let totalHandled = 0, totalNoEdit = 0, totalEdited = 0, totalRedirect = 0, totalReleased = 0;
  const focusTimes = [];
  let rangeTotalFocusTime = 0;

  for (const date of dates) {
    const rows = feedbackByDate[date] || [];
    const { noEdit, edited, released, closedNoReply, spam, deleted } = _classifyFeedback(rows);
    const handled = noEdit + edited + released;
    const filtered = spam + deleted;

    const dayDraftIds = rows.filter(r => r.draft_id).map(r => r.draft_id);
    const redirectCount = redirectsByDate[date] ? redirectsByDate[date].size : 0;

    // Focus times for this day
    const dayFocusTimes = dayDraftIds.map(id => draftFocusMap[id]).filter(Boolean);
    const avgFocusTime = dayFocusTimes.length > 0
      ? Math.round(dayFocusTimes.reduce((a, b) => a + b, 0) / dayFocusTimes.length) : null;
    const dayTotalFocusTime = dayFocusTimes.length > 0
      ? dayFocusTimes.reduce((a, b) => a + b, 0) : null;
    if (dayTotalFocusTime != null) rangeTotalFocusTime += dayTotalFocusTime;

    // Quality scores
    const scores = [];
    const steerScores = [];
    for (const r of rows) {
      if (r.action?.startsWith('sent_')) scores.push(10);
      else if (r.haiku_score != null) scores.push(r.haiku_score);
      if (r.haiku_score_post_steer != null) steerScores.push(r.haiku_score_post_steer);
    }
    const avgQualityScore = scores.length > 0
      ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length * 10) / 10 : null;
    const avgSteerAccuracy = steerScores.length > 0
      ? Math.round(steerScores.reduce((a, b) => a + b, 0) / steerScores.length * 10) / 10 : null;

    const day = {
      date,
      tickets_handled: handled,
      no_edit_count: noEdit,
      edited_count: edited,
      redirect_count: redirectCount,
      released_count: released,
      closed_no_reply_count: closedNoReply,
      filtered_count: filtered,
      no_edit_rate: _pct(noEdit, handled),
      edit_rate: _pct(edited, handled),
      redirect_rate: _pct(redirectCount, handled),
      released_rate: _pct(released, handled),
      avg_focus_time_seconds: avgFocusTime,
      total_focus_time_seconds: dayTotalFocusTime,
      avg_quality_score: avgQualityScore,
      avg_steer_accuracy: avgSteerAccuracy,
    };

    dailyBreakdown.push(day);
    totalHandled += handled;
    totalNoEdit += noEdit;
    totalEdited += edited;
    totalRedirect += redirectCount;
    totalReleased += released;
    if (avgFocusTime != null) focusTimes.push(avgFocusTime);
  }

  return {
    start: startDate,
    end: endDate,
    tickets_handled: totalHandled,
    no_edit_count: totalNoEdit,
    edited_count: totalEdited,
    redirect_count: totalRedirect,
    released_count: totalReleased,
    no_edit_rate: _pct(totalNoEdit, totalHandled),
    edit_rate: _pct(totalEdited, totalHandled),
    redirect_rate: _pct(totalRedirect, totalHandled),
    released_rate: _pct(totalReleased, totalHandled),
    avg_focus_time_seconds: focusTimes.length > 0
      ? Math.round(focusTimes.reduce((a, b) => a + b, 0) / focusTimes.length) : null,
    total_focus_time_seconds: rangeTotalFocusTime > 0 ? rangeTotalFocusTime : null,
    daily_breakdown: dailyBreakdown,
  };
}

async function apiGetStatsTickets(query) {
  const supabase = getSupabaseClient();
  const { start, end } = _dayBounds(query.get('date'));

  // Get feedback rows for the day with draft details
  const { data: feedback } = await supabase
    .from('cs_ai_feedback_log')
    .select('id, draft_id, gorgias_ticket_id, action, message_type, confidence, haiku_category, haiku_summary, haiku_score, haiku_score_post_steer, created_at')
    .gte('created_at', start).lte('created_at', end)
    .order('created_at', { ascending: true });

  const rows = feedback || [];
  if (rows.length === 0) return { date: _dayBounds(query.get('date')).date, tickets: [] };

  // Get focus times and redirect counts for these drafts
  const draftIds = rows.filter(r => r.draft_id).map(r => r.draft_id);
  const { data: drafts } = await supabase
    .from('cs_ai_drafts')
    .select('id, ticket_id, focus_time_seconds, operator_steer')
    .in('id', draftIds);

  const draftMap = {};
  for (const d of (drafts || [])) draftMap[d.id] = d;

  // Count redirects per ticket + sum focus time across all drafts on each ticket
  const ticketIds = [...new Set((drafts || []).map(d => d.ticket_id).filter(Boolean))];
  let redirectsByTicket = {};
  let totalFocusByTicket = {};
  if (ticketIds.length > 0) {
    const { data: ticketDrafts } = await supabase
      .from('cs_ai_drafts')
      .select('ticket_id, focus_time_seconds, operator_steer')
      .in('ticket_id', ticketIds);
    for (const d of (ticketDrafts || [])) {
      if (d.operator_steer) {
        redirectsByTicket[d.ticket_id] = (redirectsByTicket[d.ticket_id] || 0) + 1;
      }
      if (d.focus_time_seconds) {
        totalFocusByTicket[d.ticket_id] = (totalFocusByTicket[d.ticket_id] || 0) + d.focus_time_seconds;
      }
    }
  }

  const tickets = rows.map(r => {
    const draft = draftMap[r.draft_id] || {};
    const outcome = _classifyOutcome(r.action, redirectsByTicket[draft.ticket_id] || 0);
    return {
      gorgias_ticket_id: r.gorgias_ticket_id,
      ticket_id: draft.ticket_id,
      message_type: r.message_type,
      confidence: r.confidence,
      outcome,
      focus_time_seconds: draft.focus_time_seconds || null,
      total_focus_time_seconds: totalFocusByTicket[draft.ticket_id] || null,
      redirect_count: redirectsByTicket[draft.ticket_id] || 0,
      haiku_category: r.haiku_category || null,
      haiku_summary: r.haiku_summary || null,
      haiku_score: r.haiku_score || null,
      haiku_score_post_steer: r.haiku_score_post_steer || null,
      created_at: r.created_at,
    };
  });

  return { date: _dayBounds(query.get('date')).date, tickets };
}

async function apiGetStatsCategories(query) {
  const supabase = getSupabaseClient();
  const startDate = query.get('start');
  const endDate = query.get('end');
  if (!startDate || !endDate) throw new Error('start and end query params required');

  const { data } = await supabase
    .from('cs_ai_feedback_log')
    .select('haiku_category, haiku_summary')
    .not('haiku_category', 'is', null)
    .gte('created_at', `${startDate}T00:00:00Z`)
    .lte('created_at', `${endDate}T23:59:59.999Z`);

  const rows = data || [];
  const counts = {};
  for (const r of rows) {
    counts[r.haiku_category] = (counts[r.haiku_category] || 0) + 1;
  }

  const total = rows.length;
  const categories = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([category, count]) => ({ category, count, pct: _pct(count, total) }));

  return { start: startDate, end: endDate, total, categories };
}


async function apiGetHistory(query) {
  const supabase = getSupabaseClient();
  const limit = parseInt(query.get('limit') || '50', 10);

  const { data, error } = await supabase
    .from('cs_ai_drafts')
    .select('id, gorgias_ticket_id, customer_email, customer_name, order_number, draft_response, sent_response, feedback_notes, confidence, advisor_status, message_type, status, sent_at, created_at')
    .neq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data;
}

// ---------------------------------------------------------------------------
// Two-phase execute endpoints
// ---------------------------------------------------------------------------

// Build a canonical actions[] entry from a legacy phase-2 tool result so the
// completed action shows up in the inline ticket timeline (same shape as the
// chat-path entries built at apiActionChat). Use after legacy execute endpoints.
function buildLegacyActionEntry(actionType, toolResult, executedAt) {
  const resultText = toolResult?.content?.[0]?.text
    || (typeof toolResult === 'string' ? toolResult : '');
  return {
    executed_at: executedAt,
    action_type: actionType,
    summary: resultText,
    links: extractActionLinks([{ tool: '', result: resultText }]),
  };
}

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

    const now = new Date().toISOString();
    const entry = buildLegacyActionEntry('exchange', result, now);
    await supabase.from('cs_ai_drafts').update({
      action_result: { ...prevResult, phase: 'completed', phase2: result },
      action_executed_at: now,
      actions: [...(Array.isArray(draft.actions) ? draft.actions : []), entry],
    }).eq('id', id);

    return result;
  }

  // Phase 1: create draft order preview
  const { searchCustomers } = require('../lib/shopify');
  const customers = await searchCustomers(draft.customer_email);
  const customer = customers?.[0];
  if (!customer) throw new Error(`Customer not found: ${draft.customer_email}`);

  const structured = draft.structured_output || {};
  let items = (structured.intake?.items || []).filter(i => i.resolved_size);
  // Fallback: if intake items lack resolved_size (multi-turn carry-forward bug), pull from prescription
  if (!items.length) {
    const intakeItems = structured.intake?.items || [];
    const rxItems = (structured.prescription?.items || [])
      .filter(i => i.state === 'CONFIRMED' && i.recommendation?.size);
    items = rxItems.map(rx => {
      const intake = intakeItems.find(ii => ii.product === rx.product) || {};
      return { ...intake, product: rx.product, resolved_size: rx.recommendation.size };
    });
  }
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

    const now = new Date().toISOString();
    const entry = buildLegacyActionEntry('refund', result, now);
    await supabase.from('cs_ai_drafts').update({
      action_result: { ...prevResult, phase: 'completed', phase2: result },
      action_executed_at: now,
      actions: [...(Array.isArray(draft.actions) ? draft.actions : []), entry],
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
    const now = new Date().toISOString();
    const entry = buildLegacyActionEntry('order_modification', result, now);
    await supabase.from('cs_ai_drafts').update({
      action_result: { ...prevResult, phase: 'completed', phase2: result },
      action_executed_at: now,
      actions: [...(Array.isArray(draft.actions) ? draft.actions : []), entry],
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

// Tools that write/modify Shopify state. Used by the completing-tool detector
// to decide whether a tool result counts as a completed action worth filing in
// the timeline. Read-only tools (lookup_customer, search_products, etc.) are
// intentionally absent — they never complete an action by themselves.
const WRITE_TOOLS = new Set([
  'create_exchange_order',
  'create_invoice_order',
  'create_order',
  'create_order_complete',
  'create_wholesale_order',
  'refund_order',
  'edit_order',
  'cancel_order',
  'warehouse_hold',
  'release_warehouse_hold',
  'release_address_hold',
  'add_order_note',
  'create_discount_code',
  'update_customer',
  'split_shipment',
  'consolidate_orders',
  'send_draft_order_invoice',
  'delete_draft_order',
  'set_product_prices',
]);

function extractActionLinks(toolResults) {
  const links = [];
  for (const tr of (toolResults || [])) {
    const text = typeof tr.result === 'string' ? tr.result : '';
    // Shopify order links (exclude draft_orders — matched separately below)
    const orderMatches = text.matchAll(/https:\/\/admin\.shopify\.com\/store\/[^\s)]+orders\/(\d+)/g);
    for (const m of orderMatches) {
      if (m[0].includes('draft_orders/')) continue; // handled by draft regex below
      const orderNum = text.match(/#(\d{4,6})/);
      links.push({ type: 'order', label: `Order ${orderNum ? orderNum[0] : ''}`, url: m[0] });
    }
    // Shopify draft order links
    const draftMatches = text.matchAll(/https:\/\/admin\.shopify\.com\/store\/[^\s)]+draft_orders\/(\d+)/g);
    for (const m of draftMatches) {
      const draftNum = text.match(/#D(\d+)/);
      links.push({ type: 'draft', label: `Draft ${draftNum ? draftNum[0] : ''}`, url: m[0] });
    }
    // Shopify discount code links — code string is on a separate line in tool output
    const discountMatches = text.matchAll(/https:\/\/admin\.shopify\.com\/store\/[^\s)]+\/discounts\/(\d+)/g);
    for (const m of discountMatches) {
      const codeMatch = text.match(/`([A-F0-9]{10})`/i);
      links.push({ type: 'discount', label: codeMatch ? `Code ${codeMatch[1]}` : 'Discount code', url: m[0] });
    }
  }
  // Dedupe by URL
  return dedupeLinks(links);
}

function dedupeLinks(links) {
  const seen = new Set();
  return (links || []).filter(l => { if (seen.has(l.url)) return false; seen.add(l.url); return true; });
}

async function apiActionChat(draftId, body, { onStream } = {}) {
  const { operatorAgent } = require('../lib/operatorAgent');
  const supabase = getSupabaseClient();
  const { data: draft, error: fetchErr } = await supabase
    .from('cs_ai_drafts').select('*').eq('id', draftId).single();
  if (fetchErr) throw fetchErr;

  const userMessage = body.message;
  const history = body.history || [];
  const structured = draft.structured_output || {};

  // Also pull ticket-level order context as fallback (richer than draft alone)
  let ticketOrderCtx = {};
  if (draft.ticket_id) {
    const { data: t } = await supabase.from('cs_tickets')
      .select('order_context').eq('id', draft.ticket_id).single();
    ticketOrderCtx = t?.order_context || {};
  }

  const context = {
    draft,
    customer_email: draft.customer_email,
    order_number: (draft.order_number || '').replace('#', ''),
    order_items: structured.order?.items || ticketOrderCtx.items || [],
    fulfillment_status: structured.order?.fulfillment_status || ticketOrderCtx.fulfillment_status || null,
    intake: structured.intake || null,
    gorgias_ticket_id: draft.gorgias_ticket_id,
    draft_id: draft.id,
  };

  const result = await operatorAgent(userMessage, context, history, onStream);

  // Extract Shopify admin links from tool results before saving
  result.links = extractActionLinks(result.tool_results);

  // Update draft with in-progress action chat (the bottom panel renders this
  // until the action completes; on completion we file the entry into `actions`
  // and clear this scratchpad so the panel returns to idle).
  const prevResult = draft.action_result || {};
  const updates = {
    action_result: {
      ...prevResult,
      chat_tool_results: result.tool_results,
      chat_history: result.history,
      chat_response: result.response,
      chat_links: dedupeLinks([...(prevResult.chat_links || []), ...result.links]),
    },
  };

  // Detect if a completing action was performed.
  // CRITICAL: phase-1 previews include words like "Created" (e.g. "**Exchange Draft
  // Order Created — Awaiting Confirmation**") so we must exclude any tool result
  // still flagged as awaiting confirmation, otherwise the dashboard locks the panel
  // into "executed" mode and the Yes/No confirm buttons never render.
  //
  // Rule: if the tool is a known write tool AND its result doesn't say
  // "awaiting confirmation," it's a completion. Two-phase tools' phase 1
  // previews always emit "awaiting confirmation"; phase 2 (with confirmed=true)
  // does not. One-phase write tools just complete on first call.
  const completingTool = result.tool_results.find(tr => {
    if (!WRITE_TOOLS.has(tr.tool)) return false;
    if (typeof tr.result === 'string' && /awaiting confirmation/i.test(tr.result)) return false;
    // warehouse_hold and release_*_hold on an already-(un)held order are no-ops.
    // Treat them as non-completing so they don't clear chat_history mid-flow and
    // strand a pending Phase 1 draft_order_id on the next turn. Tool output uses
    // markdown bold (`**warehouse hold**`) so the regex allows arbitrary chars
    // between the action verb and the object.
    if ((tr.tool === 'warehouse_hold' || tr.tool === 'release_warehouse_hold' || tr.tool === 'release_address_hold')
        && typeof tr.result === 'string'
        && /already has[^.]*warehouse hold|does not have[^.]*(warehouse|address) hold/i.test(tr.result)) {
      return false;
    }
    return true;
  });
  if (completingTool) {
    const now = new Date().toISOString();
    const entry = {
      executed_at: now,
      // File under what the tool actually did, never under what the draft
      // *intended*. Falling back to `draft.action_type` lets unrelated writes
      // (e.g. `add_order_note`) masquerade as completing the proposed action —
      // which is how a missed `warehouse_hold` could show up in the timeline
      // as a successful hold.
      action_type: actionTypeFromTool(completingTool.tool, draft.action_type) || completingTool.tool,
      summary:     result.response || '',
      links:       result.links || [],
    };
    updates.actions = [...(Array.isArray(draft.actions) ? draft.actions : []), entry];
    // Clear the in-progress chat scratchpad — the action is now filed in the
    // timeline and the bottom panel should return to idle for the next action.
    updates.action_result = null;
    if (!draft.action_executed_at) {
      updates.action_executed_at = now;
      updates.advisor_status = 'ready';
    }
  }

  await supabase.from('cs_ai_drafts').update(updates).eq('id', draftId);

  return result;
}

function actionTypeFromTool(toolName, draftActionType) {
  switch (toolName) {
    case 'create_exchange_order': return draftActionType === 'free_order' ? 'free_order' : 'exchange';
    case 'refund_order':          return 'refund';
    case 'edit_order':            return 'order_modification';
    case 'warehouse_hold':        return 'warehouse_hold';
    case 'cancel_order':          return 'cancellation';
    case 'update_customer':       return 'customer_profile_update';
    case 'create_discount_code':  return 'discount_code';
    case 'split_shipment':        return 'split_shipment';
    case 'consolidate_orders':    return 'order_consolidation';
    case 'create_invoice_order':  return 'invoice_kept_items';
    default:                      return null;
  }
}

// ---------------------------------------------------------------------------
// Ad Hoc — standalone operator console (no ticket context)
// ---------------------------------------------------------------------------

async function apiConsoleChat(body, { onStream } = {}) {
  const { operatorAgentStandalone } = require('../lib/operatorAgentStandalone');
  const message = body.message;
  const history = body.history || [];
  const images = Array.isArray(body.images) ? body.images : [];
  const pdfs = Array.isArray(body.pdfs) ? body.pdfs : [];
  if (!message || typeof message !== 'string') {
    throw new Error('message is required');
  }
  const result = await operatorAgentStandalone(message, history, onStream, { images, pdfs });
  const links = extractActionLinks(result.tool_results);
  return {
    response: result.response,
    tool_results: result.tool_results,
    history: result.history,
    links,
  };
}

// Extract a PDF for the ad hoc console. Returns plain text when the PDF has
// embedded text (cheap path, ~tokens-per-char); falls back to passing the
// base64 back so the caller can attach it as a native Anthropic document
// block when extraction yields nothing useful (e.g. scanned/image-only PDFs).
const PDF_EXTRACT_MAX_BYTES = 5 * 1024 * 1024;
const PDF_EXTRACT_MIN_TEXT = 200;
const PDF_EXTRACT_MAX_PAGES_NATIVE = 20;

async function apiConsoleExtractPdf(body) {
  const name = typeof body.name === 'string' ? body.name : 'document.pdf';
  const data = typeof body.data === 'string' ? body.data : '';
  if (!data) throw new Error('data (base64) is required');

  const buf = Buffer.from(data, 'base64');
  if (buf.length === 0) throw new Error('empty PDF');
  if (buf.length > PDF_EXTRACT_MAX_BYTES) {
    throw new Error(`PDF exceeds ${Math.round(PDF_EXTRACT_MAX_BYTES / 1024 / 1024)} MB limit`);
  }

  let text = '';
  let pages = 0;
  try {
    const { PDFParse } = require('pdf-parse');
    const parser = new PDFParse({ data: buf });
    const parsed = await parser.getText();
    await parser.destroy();
    text = (parsed.text || '').trim();
    pages = parsed.total || 0;
  } catch (err) {
    throw new Error(`PDF parse failed: ${err.message || err}`);
  }

  if (text.length >= PDF_EXTRACT_MIN_TEXT) {
    return { kind: 'text', name, pages, text };
  }

  // Insufficient embedded text — fall back to native PDF block.
  if (pages > PDF_EXTRACT_MAX_PAGES_NATIVE) {
    throw new Error(
      `PDF has ${pages} pages with no extractable text; native fallback capped at ${PDF_EXTRACT_MAX_PAGES_NATIVE} pages.`
    );
  }
  return {
    kind: 'pdf',
    name,
    pages,
    media_type: 'application/pdf',
    data,
    reason: 'no_extractable_text',
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractTrackingInfo(fulfillments) {
  if (!fulfillments || !Array.isArray(fulfillments)) return null;
  for (const f of fulfillments) {
    // Support both camelCase (from our sync) and snake_case (from Shopify REST) field names
    const url = f.trackingUrl || f.tracking_url || f.tracking_urls?.[0] || f.trackingInfo?.[0]?.url || null;
    const number = f.trackingNumber || f.tracking_number || f.tracking_numbers?.[0] || f.trackingInfo?.[0]?.number || null;
    const company = f.trackingCompany || f.tracking_company || f.trackingInfo?.[0]?.company || null;
    const deliveredAt = f.deliveredAt || f.delivered_at || null;
    const shippedAt = f.createdAt || f.created_at || null;
    if (url || number) return { url, number, company, deliveredAt, shippedAt };
  }
  return null;
}

function extractTrackingUrl(fulfillments) {
  const info = extractTrackingInfo(fulfillments);
  return info?.url || null;
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
      .select('shopify_order_id, order_number, created_at, fulfillment_status, financial_status, total_price, current_total_price, subtotal_price, total_discounts, total_refunded, total_shipping, total_tax, shipping_method, shop_currency, shipping_address, note, tags, fulfillments, discount_applications, discount_codes')
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
    // Try matching from customer's orders first, then fall back to direct order lookup
    // (handles cases where customer contacts from a different email than what's on the order)
    let matchedOrder = allOrders.find(o => o.order_number === orderNum);
    if (!matchedOrder) {
      const { data: directOrder } = await supabase
        .from('orders')
        .select('shopify_order_id, order_number, created_at, fulfillment_status, financial_status, total_price, current_total_price, subtotal_price, total_discounts, total_refunded, total_shipping, total_tax, shipping_method, shop_currency, shipping_address, note, tags, fulfillments, discount_applications, discount_codes')
        .eq('order_number', orderNum)
        .maybeSingle();
      if (directOrder) matchedOrder = directOrder;
    }
    if (matchedOrder) {
      // Fetch line items for this specific order. We pull refunded_quantity
      // (drives the strikethrough treatment in the order card) and try
      // custom_attributes (pre-order target dates). The custom_attributes
      // column was added in the 2026-05-01 line-item-attributes migration —
      // if it hasn't been run yet, the query fails with a known error code.
      // Fall back to the same select without the column so the rest of the
      // card still renders.
      let items, itemsErr;
      ({ data: items, error: itemsErr } = await supabase
        .from('order_line_items')
        .select('title, variant_title, sku, quantity, unit_price, unit_price_currency, refunded_quantity, custom_attributes')
        .eq('shopify_order_id', matchedOrder.shopify_order_id));
      if (itemsErr && /custom_attributes/.test(itemsErr.message || '')) {
        ({ data: items } = await supabase
          .from('order_line_items')
          .select('title, variant_title, sku, quantity, unit_price, unit_price_currency, refunded_quantity')
          .eq('shopify_order_id', matchedOrder.shopify_order_id));
      }

      const trackingInfo = extractTrackingInfo(matchedOrder.fulfillments);

      // Enrich with tracking_snapshots data (from Passport scraper)
      let trackingSnapshot = null;
      if (trackingInfo?.number) {
        const { data: snap } = await supabase
          .from('tracking_snapshots')
          .select('current_status, estimated_delivery, last_location, local_carrier, summary, scraped_at')
          .eq('tracking_number', trackingInfo.number)
          .maybeSingle();
        if (snap) trackingSnapshot = snap;
      }

      // Fallback: when order_line_items has no rows for this order (sync gap
      // or pre-migration legacy nulls were cleaned up), reach into the
      // ticket's stored order_context. The advisor captured items + variants
      // at intake; better than rendering an empty items table.
      let resolvedItems = items || [];
      let itemsSource = 'order_line_items';
      if (resolvedItems.length === 0) {
        const { data: ctxRow } = await supabase
          .from('cs_tickets')
          .select('order_context')
          .eq('customer_email', email)
          .eq('order_number', `#${orderNum}`)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        const ctxItems = ctxRow?.order_context?.items;
        if (Array.isArray(ctxItems) && ctxItems.length) {
          resolvedItems = ctxItems.map(it => ({
            title: it.title,
            variant_title: it.variant,
            sku: it.sku,
            quantity: it.quantity,
            unit_price: null,
            unit_price_currency: matchedOrder.shop_currency,
            refunded_quantity: 0,
            custom_attributes: null,
          }));
          itemsSource = 'cs_tickets.order_context';
        }
      }

      ticketOrder = {
        order_number: matchedOrder.order_number,
        created_at: matchedOrder.created_at,
        total: matchedOrder.current_total_price || matchedOrder.total_price,
        original_total: matchedOrder.total_price,
        total_refunded: matchedOrder.total_refunded,
        subtotal: matchedOrder.subtotal_price,
        total_discounts: matchedOrder.total_discounts,
        total_tax: matchedOrder.total_tax,
        tags: matchedOrder.tags || [],
        discount_applications: matchedOrder.discount_applications || [],
        discount_codes: matchedOrder.discount_codes || [],
        note: matchedOrder.note || null,
        shipping: matchedOrder.total_shipping || 0,
        shipping_method: matchedOrder.shipping_method || null,
        currency: matchedOrder.shop_currency,
        fulfillment_status: matchedOrder.fulfillment_status,
        financial_status: matchedOrder.financial_status,
        shopify_order_id: matchedOrder.shopify_order_id,
        shipping_address: matchedOrder.shipping_address,
        warehance_url: warehanceRes ? warehanceOrderUrl(warehanceRes) : null,
        tracking_url: trackingInfo?.url || null,
        tracking_company: trackingSnapshot?.local_carrier || trackingInfo?.company || null,
        tracking_number: trackingInfo?.number || null,
        tracking_shipped_at: trackingInfo?.shippedAt || null,
        tracking_delivered_at: trackingInfo?.deliveredAt || null,
        tracking_status: trackingSnapshot?.current_status || null,
        tracking_estimated_delivery: trackingSnapshot?.estimated_delivery || null,
        tracking_last_location: trackingSnapshot?.last_location || null,
        tracking_summary: trackingSnapshot?.summary || null,
        items_source: itemsSource,
        items: resolvedItems.map(i => ({
          title: i.title,
          variant: i.variant_title,
          sku: i.sku,
          quantity: i.quantity,
          refunded_quantity: i.refunded_quantity || 0,
          custom_attributes: i.custom_attributes || null,
          price: i.unit_price,
          currency: i.unit_price_currency,
        })),
      };
    }
  }

  // Build all orders list (sorted by date, includes ticket's order)
  const otherOrdersRaw = allOrders;

  // Batch-fetch line items for other orders (first 10). Same custom_attributes
  // fallback as the ticket-order query above — pre-migration deploys
  // gracefully drop to the smaller column set.
  let otherLineItems = {};
  if (otherOrdersRaw.length) {
    const otherIds = otherOrdersRaw.slice(0, 10).map(o => o.shopify_order_id);
    let allItems, allItemsErr;
    ({ data: allItems, error: allItemsErr } = await supabase
      .from('order_line_items')
      .select('shopify_order_id, title, variant_title, sku, quantity, unit_price, unit_price_currency, refunded_quantity, custom_attributes')
      .in('shopify_order_id', otherIds));
    if (allItemsErr && /custom_attributes/.test(allItemsErr.message || '')) {
      ({ data: allItems } = await supabase
        .from('order_line_items')
        .select('shopify_order_id, title, variant_title, sku, quantity, unit_price, unit_price_currency, refunded_quantity')
        .in('shopify_order_id', otherIds));
    }
    for (const item of (allItems || [])) {
      if (!otherLineItems[item.shopify_order_id]) otherLineItems[item.shopify_order_id] = [];
      otherLineItems[item.shopify_order_id].push(item);
    }
  }

  const otherOrders = otherOrdersRaw.map(o => ({
    order_number: o.order_number,
    created_at: o.created_at,
    total: o.current_total_price || o.total_price,
    original_total: o.total_price,
    total_refunded: o.total_refunded,
    subtotal: o.subtotal_price,
    total_discounts: o.total_discounts,
    total_tax: o.total_tax,
    shipping: o.total_shipping || 0,
    shipping_method: o.shipping_method || null,
    tags: o.tags || [],
    discount_applications: o.discount_applications || [],
    discount_codes: o.discount_codes || [],
    note: o.note || null,
    currency: o.shop_currency,
    fulfillment_status: o.fulfillment_status,
    financial_status: o.financial_status,
    shopify_order_id: o.shopify_order_id,
    shipping_address: o.shipping_address,
    tracking_url: extractTrackingUrl(o.fulfillments),
    tracking_company: extractTrackingInfo(o.fulfillments)?.company || null,
    tracking_number: extractTrackingInfo(o.fulfillments)?.number || null,
    items: (otherLineItems[o.shopify_order_id] || []).map(i => ({
      title: i.title,
      variant: i.variant_title,
      sku: i.sku,
      quantity: i.quantity,
      refunded_quantity: i.refunded_quantity || 0,
      custom_attributes: i.custom_attributes || null,
      price: i.unit_price,
    })),
  }));

  // Build past tickets with AI-processed flag.
  // For AI-processed tickets, enrich with the advisor's summary + message_type
  // from cs_tickets (the new ticket-centric store) — the cs_conversations
  // subject/summary is from the older import and may lag the advisor output.
  const aiTicketIds = new Set((aiDraftsRes.data || []).map(d => String(d.gorgias_ticket_id)));
  const csTicketSourceIds = (ticketsRes.data || []).map(t => t.source_id).filter(Boolean);
  let csTicketEnrichment = {};
  if (csTicketSourceIds.length) {
    const { data: csTicketRows } = await supabase
      .from('cs_tickets')
      .select('gorgias_ticket_id, summary, message_type')
      .in('gorgias_ticket_id', csTicketSourceIds);
    for (const row of csTicketRows || []) {
      csTicketEnrichment[String(row.gorgias_ticket_id)] = row;
    }
  }
  const pastTickets = (ticketsRes.data || []).map(t => {
    const enriched = csTicketEnrichment[String(t.source_id)];
    return {
      id: t.id,
      gorgias_ticket_id: t.source_id,
      created_at: t.created_at,
      resolved_at: t.resolved_at,
      category: enriched?.message_type || t.category,
      subject: t.subject,
      // Prefer advisor summary from cs_tickets when available (6-8 word tag).
      summary: enriched?.summary || t.summary,
      resolution_successful: t.resolution_successful,
      resolution_type: t.resolution_type,
      message_count: t.message_count,
      ai_processed: aiTicketIds.has(String(t.source_id)),
    };
  });

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
  if (status === 'parked') updates.parked_at = now;
  if (status === 'closed') updates.closed_at = now;
  if (status === 'snoozed' || status === 'closed' || status === 'parked') updates.active_draft_id = null;

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
    .select('id, gorgias_ticket_id, customer_email, customer_name, customer_country, order_number, message_type, confidence, advisor_status, has_agent_reply, message_count, status, active_draft_id, updated_at, created_at, parked_at, snoozed_at, source, summary, viewed_at, last_customer_message_at, auto_close_path')
    .order(tab === 'parked' ? 'parked_at' : 'updated_at', { ascending: tab === 'parked' })
    .limit(limit);

  switch (tab) {
    case 'new':
      q = q.eq('status', 'open').eq('has_agent_reply', false);
      break;
    case 'followup':
      q = q.eq('status', 'open').eq('has_agent_reply', true);
      break;
    case 'parked':
      q = q.eq('status', 'parked');
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

  const [newResult, followupResult, parkedResult, snoozedResult] = await Promise.all([
    supabase.from('cs_tickets').select('id', { count: 'exact', head: true })
      .eq('status', 'open').eq('has_agent_reply', false),
    supabase.from('cs_tickets').select('id', { count: 'exact', head: true })
      .eq('status', 'open').eq('has_agent_reply', true),
    supabase.from('cs_tickets').select('id', { count: 'exact', head: true })
      .eq('status', 'parked'),
    supabase.from('cs_tickets').select('id', { count: 'exact', head: true })
      .eq('status', 'snoozed'),
  ]);

  return {
    new: newResult.count || 0,
    followup: followupResult.count || 0,
    parked: parkedResult.count || 0,
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
    .select('id, draft_response, sent_response, feedback_notes, confidence, advisor_status, message_type, action_type, action_result, action_executed_at, actions, order_number, status, turn_number, sent_at, created_at')
    .eq('ticket_id', id)
    .order('created_at', { ascending: true });

  // Related ticket: the single most-recent closed exchange/refund/defect ticket
  // for this customer within 60 days that has a populated history_summary.
  // Matches exactly what the advisor injects via its [PRIOR TICKET] block —
  // what the operator sees here is what the advisor sees. Legacy tickets from
  // before the advisor reliably emitted history_summary are intentionally
  // excluded; they still appear in the Past Tickets panel below.
  let priorTickets = [];
  if (ticket.customer_email) {
    const cutoff = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    const { data: priors } = await supabase
      .from('cs_tickets')
      .select('id, gorgias_ticket_id, message_type, order_number, closed_at, history_summary, summary')
      .eq('customer_email', ticket.customer_email)
      .eq('status', 'closed')
      .in('message_type', ['exchange', 'refund', 'defect'])
      .gte('closed_at', cutoff)
      .not('history_summary', 'is', null)
      .neq('id', id)
      .order('closed_at', { ascending: false })
      .limit(1);
    priorTickets = priors || [];
  }

  // Mark ticket as viewed (for unread indicator in queue)
  await supabase.from('cs_tickets')
    .update({ viewed_at: new Date().toISOString() })
    .eq('id', id);

  return { ...ticket, active_draft: activeDraft, drafts: allDrafts || [], prior_tickets: priorTickets };
}

async function apiSendTicketMessage(ticketId, body) {
  const supabase = getSupabaseClient();

  const { data: ticket, error } = await supabase
    .from('cs_tickets')
    .select('gorgias_ticket_id, conversation_history, customer_email, order_number, active_draft_id')
    .eq('id', ticketId)
    .single();
  if (error) throw error;

  const message = body.message;
  if (!message?.trim()) throw new Error('Message is required');

  // Send to Gorgias
  const bodyHtml = autoLinkProducts(message);
  const replyResult = await gorgias.createTicketReply(ticket.gorgias_ticket_id, {
    body_html: bodyHtml,
    body_text: message,
    attachments: body.attachments,
  });

  // Append to conversation history
  const history = ticket.conversation_history || [];
  const sentAt = new Date().toISOString();
  history.push({
    id: replyResult?.id,
    sender: 'agent',
    is_bot: false,
    body: message,
    body_html: bodyHtml,
    created_at: sentAt,
    channel: 'email',
  });

  // Post-send action
  const afterAction = body.after || 'snooze';
  const updates = { conversation_history: history, updated_at: sentAt };

  // Update Gorgias FIRST — if this fails, operation fails and ticket stays open
  if (afterAction === 'close') {
    await gorgias.closeTicket(ticket.gorgias_ticket_id);
    await gorgias.assignTicket(ticket.gorgias_ticket_id, null);
    updates.status = 'closed';
    updates.closed_at = sentAt;
  } else {
    await gorgias.snoozeTicket(ticket.gorgias_ticket_id, 3);
    updates.status = 'snoozed';
    updates.snoozed_at = sentAt;
  }

  // Update DB only after Gorgias succeeded
  await supabase.from('cs_tickets').update(updates).eq('id', ticketId);

  // Anchor focus_time_seconds on a draft row. Use the active draft if one exists;
  // otherwise insert a lightweight manual_send draft so this operator-time isn't
  // silently dropped (mirrors the outbound-staging pattern).
  const focusSeconds = body.focus_time_seconds != null ? Math.round(body.focus_time_seconds) : null;
  if (focusSeconds != null) {
    if (ticket.active_draft_id) {
      await supabase.from('cs_ai_drafts')
        .update({ focus_time_seconds: focusSeconds })
        .eq('id', ticket.active_draft_id);
    } else {
      await supabase.from('cs_ai_drafts').insert({
        ticket_id: ticketId,
        gorgias_ticket_id: ticket.gorgias_ticket_id,
        gorgias_message_id: replyResult?.id || null,
        customer_email: ticket.customer_email,
        order_number: ticket.order_number,
        draft_response: '',
        sent_response: message,
        structured_output: {},
        confidence: 'low',
        status: 'sent',
        draft_kind: 'manual_send',
        sent_at: sentAt,
        reviewed_at: sentAt,
        focus_time_seconds: focusSeconds,
      });
    }
  }

  return { success: true, gorgias_message_id: replyResult?.id, after: afterAction };
}

async function apiReopenTicket(ticketId) {
  const supabase = getSupabaseClient();

  const { data: t, error } = await supabase.from('cs_tickets')
    .select('gorgias_ticket_id')
    .eq('id', ticketId)
    .single();
  if (error) throw error;
  if (!t?.gorgias_ticket_id) throw new Error('Ticket not found');

  // Gorgias first — if this fails, Supabase stays consistent with Gorgias
  await gorgias.reopenTicket(t.gorgias_ticket_id);

  await supabase.from('cs_tickets').update({
    status: 'open',
    closed_at: null,
    snoozed_at: null,
    updated_at: new Date().toISOString(),
  }).eq('id', ticketId);

  return { success: true };
}

async function apiForwardTicket(ticketId, body) {
  const supabase = getSupabaseClient();

  const { data: ticket, error } = await supabase
    .from('cs_tickets')
    .select('gorgias_ticket_id, customer_email, customer_name')
    .eq('id', ticketId)
    .single();
  if (error) throw error;
  if (!ticket.gorgias_ticket_id) throw new Error('No Gorgias ticket linked');

  // Fetch full conversation from Gorgias
  const messages = await gorgias.getTicketMessages(ticket.gorgias_ticket_id);
  if (!messages?.length) throw new Error('No messages found');

  // Get ticket subject
  const gorgiasTicket = await gorgias.getTicket(ticket.gorgias_ticket_id);
  const subject = gorgiasTicket?.subject || `Ticket #${ticket.gorgias_ticket_id}`;

  // Compose HTML email from conversation
  const gorgiasUrl = `https://rubies.gorgias.com/app/ticket/${ticket.gorgias_ticket_id}`;
  let html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:700px;margin:0 auto">
      <div style="padding:16px 20px;background:#f5f0eb;border-radius:8px;margin-bottom:16px">
        <div style="font-size:14px;font-weight:600;margin-bottom:4px">${subject}</div>
        <div style="font-size:12px;color:#666">
          Customer: ${ticket.customer_name || ''} &lt;${ticket.customer_email}&gt;
          &nbsp;&middot;&nbsp; <a href="${gorgiasUrl}" style="color:#1a7f64">View in Gorgias</a>
        </div>
      </div>`;

  for (const m of messages) {
    if (m.channel === 'internal-note') continue;
    const isCustomer = m.from_agent === false || m.from_agent === 'False';
    const borderColor = isCustomer ? '#1a7f64' : '#ccc';
    const senderLabel = isCustomer ? (ticket.customer_name || ticket.customer_email) : 'Agent';
    const timestamp = m.created_datetime ? new Date(m.created_datetime).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : '';
    const bodyHtml = m.body_html || m.stripped_html || (m.body_text || '').replace(/\n/g, '<br>');

    // Render inline attachment thumbnails
    const attachmentHtml = (m.attachments || []).map(a => {
      const isImage = (a.content_type || '').startsWith('image/');
      return isImage
        ? `<div style="margin-top:8px"><a href="${a.url}" target="_blank"><img src="${a.url}" alt="${a.name || 'attachment'}" style="max-width:300px;max-height:200px;border-radius:4px;border:1px solid #e7e5e4"></a></div>`
        : `<div style="margin-top:8px"><a href="${a.url}" target="_blank" style="color:#1a7f64;font-size:13px">${a.name || 'attachment'}</a></div>`;
    }).join('');

    html += `
      <div style="border-left:3px solid ${borderColor};padding:12px 16px;margin-bottom:12px;background:#fff;border-radius:0 6px 6px 0">
        <div style="font-size:11px;color:#888;margin-bottom:6px">${senderLabel} &middot; ${timestamp}</div>
        <div style="font-size:14px;line-height:1.5">${bodyHtml}</div>
        ${attachmentHtml}
      </div>`;
  }

  html += '</div>';

  // Send via SendGrid
  const { getSendgridClient } = require('../../shared/sendgridClient');
  const sgMail = getSendgridClient();
  if (!sgMail) throw new Error('SendGrid not configured');

  const recipientEmail = body.to || 'jamie@rubyshines.com';
  await sgMail.send({
    to: recipientEmail,
    from: { name: 'RUBIES Customer Care', email: 'care@rubyshines.com' },
    subject: `[FWD] ${subject}`,
    html,
    trackingSettings: { clickTracking: { enable: false, enableText: false } },
  });

  return { success: true, forwarded_to: recipientEmail };
}

async function apiParkTicket(ticketId, body = {}) {
  const supabase = getSupabaseClient();
  const now = new Date().toISOString();

  // Capture focus time on the active draft (if any) before clearing the pointer
  if (body.focus_time_seconds != null) {
    const { data: t } = await supabase.from('cs_tickets')
      .select('active_draft_id')
      .eq('id', ticketId)
      .single();
    if (t?.active_draft_id) {
      await supabase.from('cs_ai_drafts')
        .update({ focus_time_seconds: Math.round(body.focus_time_seconds) })
        .eq('id', t.active_draft_id);
    }
  }

  await supabase.from('cs_tickets').update({
    status: 'parked',
    parked_at: now,
    updated_at: now,
    active_draft_id: null,
  }).eq('id', ticketId);

  return { success: true };
}

async function apiUnparkTicket(ticketId, body = {}) {
  const supabase = getSupabaseClient();
  const now = new Date().toISOString();

  if (body.focus_time_seconds != null) {
    const { data: t } = await supabase.from('cs_tickets')
      .select('active_draft_id')
      .eq('id', ticketId)
      .single();
    if (t?.active_draft_id) {
      await supabase.from('cs_ai_drafts')
        .update({ focus_time_seconds: Math.round(body.focus_time_seconds) })
        .eq('id', t.active_draft_id);
    }
  }

  await supabase.from('cs_tickets').update({
    status: 'open',
    parked_at: null,
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
  'GET /api/stats/daily': (req) => apiGetStatsDaily(new URL(req.url, 'http://localhost').searchParams),
  'GET /api/stats/range': (req) => apiGetStatsRange(new URL(req.url, 'http://localhost').searchParams),
  'GET /api/stats/tickets': (req) => apiGetStatsTickets(new URL(req.url, 'http://localhost').searchParams),
  'GET /api/stats/categories': (req) => apiGetStatsCategories(new URL(req.url, 'http://localhost').searchParams),
  'GET /api/history': (req) => apiGetHistory(new URL(req.url, 'http://localhost').searchParams),
  'GET /api/tickets': (req) => apiGetTickets(new URL(req.url, 'http://localhost').searchParams),
  'GET /api/tickets/stats': () => apiGetTicketStats(),
  'GET /api/classifications': () => {
    const { BUSINESS_AREAS } = require('../../gmail-management/config');
    const exclude = new Set(['customer_support', 'spam', 'auto_reply', 'newsletter', 'skip', 'pipeline', 'internal']);
    const options = Object.entries(BUSINESS_AREAS)
      .filter(([key]) => !exclude.has(key))
      .map(([key, val]) => ({ value: key, label: val.label }));
    return options;
  },
};

// Routes with path params
const paramRoutes = [
  { method: 'GET', pattern: /^\/api\/customer\/([^/]+)\/context$/, handler: (_, email, req) => {
    const url = new URL(req.url, 'http://localhost');
    return apiGetCustomerContext(decodeURIComponent(email), url.searchParams.get('order'));
  }},
  { method: 'GET', pattern: /^\/api\/drafts\/(\d+)$/, handler: (_, id) => apiGetDraft(parseInt(id)) },
  { method: 'POST', pattern: /^\/api\/drafts\/(\d+)\/send$/, handler: (body, id) => apiSendDraft(parseInt(id), body) },
  { method: 'POST', pattern: /^\/api\/drafts\/(\d+)\/execute\/exchange$/, handler: (body, id) => apiExecuteExchange(parseInt(id), body) },
  { method: 'POST', pattern: /^\/api\/drafts\/(\d+)\/execute\/refund$/, handler: (body, id) => apiExecuteRefund(parseInt(id), body) },
  { method: 'POST', pattern: /^\/api\/drafts\/(\d+)\/execute\/edit$/, handler: (body, id) => apiExecuteEdit(parseInt(id), body) },
  { method: 'POST', pattern: /^\/api\/drafts\/(\d+)\/action-chat$/, handler: (body, id) => apiActionChat(parseInt(id), body) },
  { method: 'POST', pattern: /^\/api\/console\/chat$/, handler: (body) => apiConsoleChat(body) },
  { method: 'POST', pattern: /^\/api\/console\/extract-pdf$/, handler: (body) => apiConsoleExtractPdf(body) },
  { method: 'POST', pattern: /^\/api\/drafts\/(\d+)\/close$/, handler: (body, id) => apiCloseDraft(parseInt(id), body) },
  { method: 'POST', pattern: /^\/api\/drafts\/(\d+)\/refresh$/, handler: (_, id) => apiRefreshDraft(parseInt(id)) },
  { method: 'POST', pattern: /^\/api\/drafts\/(\d+)\/release$/, handler: (body, id) => apiReleaseDraft(parseInt(id), body) },
  { method: 'POST', pattern: /^\/api\/drafts\/(\d+)\/delete$/, handler: (_, id) => apiDeleteDraft(parseInt(id)) },
  { method: 'POST', pattern: /^\/api\/drafts\/(\d+)\/spam$/, handler: (_, id) => apiMarkSpam(parseInt(id)) },
  // Ticket-centric routes
  { method: 'GET', pattern: /^\/api\/tickets\/by-gorgias\/(\d+)$/, handler: async (_, gorgiasId) => {
    const supabase = getSupabaseClient();
    const { data } = await supabase.from('cs_tickets')
      .select('id')
      .eq('gorgias_ticket_id', parseInt(gorgiasId))
      .single();
    return data || { id: null };
  }},
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
  { method: 'POST', pattern: /^\/api\/tickets\/(\d+)\/close$/, handler: async (body, id) => {
    const supabase = getSupabaseClient();
    const { data: t } = await supabase.from('cs_tickets').select('active_draft_id, gorgias_ticket_id').eq('id', parseInt(id)).single();
    if (t?.active_draft_id) return apiCloseDraft(t.active_draft_id, body);
    // No active draft (e.g. snoozed ticket) — close directly
    if (!t?.gorgias_ticket_id) throw new Error('Ticket not found');
    // Close in Gorgias FIRST — if this fails, operation fails and ticket stays open
    await gorgias.closeTicket(t.gorgias_ticket_id);
    await gorgias.assignTicket(t.gorgias_ticket_id, null);
    await updateTicketStatus(supabase, t.gorgias_ticket_id, 'closed');
    return { success: true };
  }},
  { method: 'POST', pattern: /^\/api\/tickets\/(\d+)\/snooze$/, handler: async (body, id) => {
    const supabase = getSupabaseClient();
    const { data: t } = await supabase.from('cs_tickets').select('gorgias_ticket_id, active_draft_id').eq('id', parseInt(id)).single();
    if (!t?.gorgias_ticket_id) throw new Error('Ticket not found');
    await gorgias.snoozeTicket(t.gorgias_ticket_id, 3);
    await updateTicketStatus(supabase, t.gorgias_ticket_id, 'snoozed');
    if (body?.focus_time_seconds != null && t.active_draft_id) {
      await supabase.from('cs_ai_drafts')
        .update({ focus_time_seconds: Math.round(body.focus_time_seconds) })
        .eq('id', t.active_draft_id);
    }
    return { success: true };
  }},
  { method: 'POST', pattern: /^\/api\/tickets\/(\d+)\/refresh$/, handler: async (body, id) => {
    const supabase = getSupabaseClient();
    const steer = (body?.steer || '').trim();
    const { data: t } = await supabase.from('cs_tickets')
      .select('active_draft_id, gorgias_ticket_id, customer_email, order_number')
      .eq('id', parseInt(id)).single();
    // Has an active draft — update it in place (with optional steer)
    if (t?.active_draft_id) return apiRefreshDraft(t.active_draft_id, { steer: steer || undefined });

    // No active draft — check for an existing draft on this ticket (e.g. already sent/closed)
    if (!t?.active_draft_id && t?.gorgias_ticket_id) {
      const { data: existingDraft } = await supabase.from('cs_ai_drafts')
        .select('id')
        .eq('ticket_id', parseInt(id))
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (existingDraft) return apiRefreshDraft(existingDraft.id, { steer: steer || undefined });
    }

    // No draft at all — create a new one by running the advisor on the latest customer message
    if (!t?.gorgias_ticket_id) throw new Error('Ticket not found');
    const gorgiasClient = require('../import/gorgiasClient');
    const { buildConversationContext, extractCleanBody } = require('../intake/processGorgiasTickets');
    const { aiAdvisor } = require('../lib/aiAdvisor');

    const [messages, gorgiasTicket] = await Promise.all([
      gorgiasClient.getTicketMessages(t.gorgias_ticket_id),
      gorgiasClient.getTicket(t.gorgias_ticket_id).catch(() => null),
    ]);
    const lastCustomer = [...messages].reverse().find(m => m.from_agent === false);
    if (!lastCustomer) throw new Error('No customer message found');

    const senderName = [gorgiasTicket?.customer?.firstname, gorgiasTicket?.customer?.lastname]
      .filter(Boolean)
      .join(' ')
      .trim() || gorgiasTicket?.customer?.name || null;

    const messageText = extractCleanBody(lastCustomer).text;
    let contextParts = [];
    if (typeof buildConversationContext === 'function') {
      const ctx = buildConversationContext(messages, lastCustomer.id);
      if (ctx) contextParts.push(`[CONVERSATION HISTORY]\n${ctx}`);
    }
    const attachments = lastCustomer.attachments || [];
    const attachmentNote = attachments.length
      ? `\n[ATTACHMENTS: ${attachments.map(a => `${a.name || 'file'} (${a.content_type || 'unknown type'})`).join(', ')}]`
      : '';
    contextParts.push(`[LATEST CUSTOMER MESSAGE]\n${messageText}${attachmentNote}`);

    const result = await aiAdvisor({
      customer_email: t.customer_email,
      customer_name: senderName,
      issue_description: contextParts.join('\n\n'),
      operatorSteer: steer || undefined,
      ticket_id: t.gorgias_ticket_id,
    });

    const s = result._structured;
    const newDraft = s?._composedResponse || '';
    const confidence = (s?.status === 'ready' || s?.status === 'action_needed') ? 'high' : s?.status === 'needs_info' ? 'medium' : 'low';

    const { data: newDraftRow, error: insertErr } = await supabase.from('cs_ai_drafts').insert({
      ticket_id: parseInt(id),
      gorgias_ticket_id: t.gorgias_ticket_id,
      gorgias_message_id: lastCustomer.id,
      customer_email: t.customer_email,
      order_number: t.order_number,
      draft_response: newDraft,
      structured_output: s,
      audit_trail: s?.audit || [],
      confidence,
      advisor_status: s?.status,
      message_type: canonicalMessageType(s?.message_type, `operator-redraft ticket ${id}`),
      operator_steer: steer || null,
    }).select('id').single();

    if (insertErr) {
      console.error(`[refresh] Failed to insert draft for ticket ${id}:`, insertErr);
      throw new Error(`Draft save failed: ${insertErr.message}`);
    }

    await supabase.from('cs_tickets').update({ active_draft_id: newDraftRow.id }).eq('id', parseInt(id));

    return { draft_response: newDraft, draft_id: newDraftRow.id, structured: s };
  }},
  { method: 'POST', pattern: /^\/api\/tickets\/(\d+)\/release$/, handler: (body, id) => {
    const supabase = getSupabaseClient();
    return supabase.from('cs_tickets').select('active_draft_id').eq('id', parseInt(id)).single()
      .then(({ data: t }) => {
        if (!t?.active_draft_id) throw new Error('No active draft for this ticket');
        return apiReleaseDraft(t.active_draft_id, body);
      });
  }},
  { method: 'POST', pattern: /^\/api\/tickets\/(\d+)\/spam$/, handler: (body, id) => {
    const supabase = getSupabaseClient();
    return supabase.from('cs_tickets').select('active_draft_id').eq('id', parseInt(id)).single()
      .then(({ data: t }) => {
        if (!t?.active_draft_id) throw new Error('No active draft for this ticket');
        return apiMarkSpam(t.active_draft_id, body);
      });
  }},
  { method: 'POST', pattern: /^\/api\/tickets\/(\d+)\/return$/, handler: (body, id) => apiReturnToInbox(parseInt(id), body) },
  { method: 'POST', pattern: /^\/api\/tickets\/(\d+)\/delete$/, handler: (body, id) => {
    const supabase = getSupabaseClient();
    return supabase.from('cs_tickets').select('active_draft_id').eq('id', parseInt(id)).single()
      .then(({ data: t }) => {
        if (!t?.active_draft_id) throw new Error('No active draft for this ticket');
        return apiDeleteDraft(t.active_draft_id, body);
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
  { method: 'POST', pattern: /^\/api\/tickets\/(\d+)\/action-chat$/, handler: async (body, id) => {
    const supabase = getSupabaseClient();
    const { data: t } = await supabase.from('cs_tickets')
      .select('active_draft_id, customer_email, order_number, order_context, gorgias_ticket_id')
      .eq('id', parseInt(id)).single();
    if (t?.active_draft_id) return apiActionChat(t.active_draft_id, body);

    // No active draft — run action chat with ticket context directly
    const { operatorAgent } = require('../lib/operatorAgent');
    const orderCtx = t?.order_context || {};
    const context = {
      customer_email: t?.customer_email,
      order_number: (t?.order_number || '').replace('#', ''),
      order_items: orderCtx.items || [],
      fulfillment_status: orderCtx.fulfillment_status || null,
      intake: null,
      gorgias_ticket_id: t?.gorgias_ticket_id,
    };
    try {
      const result = await operatorAgent(body.message, context, body.history || []);
      result.links = extractActionLinks(result.tool_results);
      return result;
    } catch (err) {
      console.error(`[action-chat] No-draft fallback error:`, err.message, err.stack);
      throw err;
    }
  }},
  { method: 'POST', pattern: /^\/api\/tickets\/(\d+)\/message$/, handler: (body, id) => apiSendTicketMessage(parseInt(id), body) },
  { method: 'POST', pattern: /^\/api\/tickets\/(\d+)\/reopen$/, handler: (_, id) => apiReopenTicket(parseInt(id)) },
  { method: 'POST', pattern: /^\/api\/tickets\/(\d+)\/park$/, handler: (body, id) => apiParkTicket(parseInt(id), body) },
  { method: 'POST', pattern: /^\/api\/tickets\/(\d+)\/unpark$/, handler: (body, id) => apiUnparkTicket(parseInt(id), body) },
  { method: 'POST', pattern: /^\/api\/tickets\/(\d+)\/forward$/, handler: (body, id) => apiForwardTicket(parseInt(id), body) },
];

async function handleRequest(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;
  const host = req.headers.host || '';

  // ── Health check + version ──
  if (pathname === '/health' || pathname === '/api/version') {
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'ok', version: GIT_VERSION }));
    return;
  }

  // ── Auth endpoints ──
  if (pathname.startsWith('/auth/')) {
    res.setHeader('Content-Type', 'application/json');

    if (pathname === '/auth/google' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        if (!body.credential) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Missing credential' }));
          return;
        }
        const payload = await verifyGoogleToken(body.credential);
        if (payload.email !== ALLOWED_EMAIL) {
          console.warn(`[auth] Rejected login from ${payload.email} (allowed: ${ALLOWED_EMAIL})`);
          res.writeHead(403);
          res.end(JSON.stringify({ error: 'Unauthorized email' }));
          return;
        }
        const token = signSession(payload.email);
        setSessionCookie(res, token, host);
        console.log(`[auth] Login: ${payload.email}`);
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, email: payload.email }));
      } catch (err) {
        console.error('[auth] Google token verification failed:', err.message);
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'Invalid token' }));
      }
      return;
    }

    if (pathname === '/auth/logout' && req.method === 'POST') {
      clearSessionCookie(res, host);
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (pathname === '/auth/status' && req.method === 'GET') {
      const cookies = parseCookies(req);
      const session = verifySession(cookies.session);
      if (session) {
        res.writeHead(200);
        res.end(JSON.stringify({ authenticated: true, email: session.email }));
      } else {
        res.writeHead(200);
        res.end(JSON.stringify({ authenticated: false }));
      }
      return;
    }

    if (pathname === '/auth/client-id' && req.method === 'GET') {
      res.writeHead(200);
      res.end(JSON.stringify({ clientId: GOOGLE_CLIENT_ID || null }));
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  // ── Auth middleware (check session for protected routes) ──
  if (isAuthEnabled() && !isAuthWhitelisted(pathname)) {
    const cookies = parseCookies(req);
    const session = verifySession(cookies.session);
    const bearerOk = !session && pathname.startsWith('/api/') && verifyBearerToken(req);
    if (!session && !bearerOk) {
      if (pathname.startsWith('/api/')) {
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      // Serve login page for HTML requests
      try {
        const loginPath = path.join(STATIC_DIR, 'login.html');
        const content = fs.readFileSync(loginPath);
        res.setHeader('Content-Type', 'text/html');
        res.writeHead(200);
        res.end(content);
      } catch {
        res.writeHead(401);
        res.end('Unauthorized — login.html not found');
      }
      return;
    }
  }

  // Attachment proxy — fetches a signed URL from Gorgias and redirects
  if (pathname.startsWith('/api/attachment/')) {
    const fileId = pathname.replace('/api/attachment/', '');
    try {
      const domain = process.env.GORGIAS_DOMAIN;
      const apiKey = process.env.GORGIAS_API_KEY;
      const email = process.env.GORGIAS_EMAIL;
      const resp = await fetch(`https://${domain}.gorgias.com/api/attachment/download/${fileId}`, {
        headers: { 'Authorization': 'Basic ' + Buffer.from(`${email}:${apiKey}`).toString('base64') },
        redirect: 'manual',
      });
      const location = resp.headers.get('location');
      if (location) {
        res.writeHead(302, { Location: location });
        res.end();
      } else {
        res.writeHead(resp.status);
        res.end('Attachment not found');
      }
    } catch (err) {
      res.writeHead(500);
      res.end('Attachment proxy error');
    }
    return;
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

      // ---------------------------------------------------------------
      // SSE streaming endpoints — handled before param routes so we can
      // write directly to res instead of going through the JSON wrapper.
      // ---------------------------------------------------------------

      // Stream advisor redraft — thin SSE wrapper around apiRefreshDraft
      const refreshStreamMatch = pathname.match(/^\/api\/tickets\/(\d+)\/refresh-stream$/);
      if (req.method === 'POST' && refreshStreamMatch) {
        const ticketId = parseInt(refreshStreamMatch[1]);
        const body = await readBody(req);
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });
        const sendEvent = (data) => {
          res.write(`data: ${JSON.stringify(data)}\n\n`);
        };
        try {
          const supabase = getSupabaseClient();
          const steer = (body?.steer || '').trim();
          const { data: t } = await supabase.from('cs_tickets')
            .select('active_draft_id')
            .eq('id', ticketId).single();
          const draftId = t?.active_draft_id;
          if (!draftId) throw new Error('No active draft for this ticket');

          const result = await apiRefreshDraft(draftId, { steer: steer || undefined, onStream: sendEvent });
          sendEvent({ type: 'complete', draft_response: result.draft_response, draft_id: result.draft_id, structured: result.structured });
        } catch (err) {
          console.error(`[refresh-stream] error:`, err.message || err);
          sendEvent({ type: 'error', message: err.message || String(err) });
        }
        res.end();
        return;
      }

      // Stream operator action-chat — thin SSE wrapper around apiActionChat
      const actionStreamMatch = pathname.match(/^\/api\/tickets\/(\d+)\/action-chat-stream$/);
      if (req.method === 'POST' && actionStreamMatch) {
        const ticketId = parseInt(actionStreamMatch[1]);
        const body = await readBody(req);
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });
        const sendEvent = (data) => {
          res.write(`data: ${JSON.stringify(data)}\n\n`);
        };
        try {
          const supabase = getSupabaseClient();
          const { data: t } = await supabase.from('cs_tickets')
            .select('active_draft_id')
            .eq('id', ticketId).single();
          if (!t?.active_draft_id) throw new Error('No active draft for this ticket');

          const result = await apiActionChat(t.active_draft_id, body, { onStream: sendEvent });
          sendEvent({ type: 'complete', response: result.response, tool_results: result.tool_results, links: result.links, history: result.history });
        } catch (err) {
          sendEvent({ type: 'error', message: err.message });
        }
        res.end();
        return;
      }

      // Stream ad hoc console chat — thin SSE wrapper around apiConsoleChat
      if (req.method === 'POST' && pathname === '/api/console/chat-stream') {
        const body = await readBody(req);
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });
        const sendEvent = (data) => {
          res.write(`data: ${JSON.stringify(data)}\n\n`);
        };
        try {
          const result = await apiConsoleChat(body, { onStream: sendEvent });
          sendEvent({ type: 'complete', response: result.response, tool_results: result.tool_results, links: result.links, history: result.history });
        } catch (err) {
          console.error(`[console/chat-stream] error:`, err.message || err);
          sendEvent({ type: 'error', message: err.message || String(err) });
        }
        res.end();
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
      console.error(`[dashboard] API error: ${err.message}\n${err.stack}`);
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Static files
  let filePath = pathname === '/' ? '/index.html' : pathname === '/stats' ? '/stats.html' : pathname;
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
// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

// Only bind a port when run directly (npm run dashboard). When required from a
// test, skip startup so handlers like apiSendDraft can be exercised in isolation.
if (require.main === module) {
  const server = http.createServer(handleRequest);
  server.listen(PORT, async () => {
    console.log(`\n  RUBIES Care running at http://localhost:${PORT}\n`);
    await loadProductConfig();
    // Load product cache + decision tree config for the action router
    const { loadFromSupabase } = require('../lib/productCache');
    const { initCsConfig } = require('../lib/sizingEngine');
    await loadFromSupabase(getSupabaseClient());
    await initCsConfig();
  });
}

module.exports = { apiSendDraft };
