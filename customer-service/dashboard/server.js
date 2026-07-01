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

// Build identity, captured at startup. Two independent fingerprints:
//   - commit: which git commit this server is running. Railway's runtime
//     container has NO .git directory, so `git rev-parse` throws there (that's
//     why this used to report "unknown" in production). Railway injects the SHA
//     as an env var instead — prefer that, fall back to git for local dev.
//   - assetHash: a content hash of the actual frontend files this server is
//     serving. Git-independent, changes iff the bytes change. This is the TRUE
//     "is the frontend fresh" signal — it's injected into index.html and the
//     served asset URLs so a stale PWA self-busts and the client can compare
//     what it loaded against what the server now has on disk.
function computeBuildInfo() {
  let hash = process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT_SHA || null;
  let message = process.env.RAILWAY_GIT_COMMIT_MESSAGE || '';
  let date = '';
  if (!hash) {
    try {
      hash = execSync('git rev-parse HEAD', { cwd: __dirname, encoding: 'utf8' }).trim();
      date = execSync('git log -1 --format=%ci', { cwd: __dirname, encoding: 'utf8' }).trim();
      if (!message) message = execSync('git log -1 --format=%s', { cwd: __dirname, encoding: 'utf8' }).trim();
    } catch { /* no git in this environment */ }
  }
  // Hash the bytes of every file the browser actually runs.
  const publicDir = path.join(__dirname, 'public');
  const assetFiles = ['index.html', 'app.js', 'styles.css', 'voiceInput.js', 'sw.js'];
  const h = crypto.createHash('sha256');
  for (const f of assetFiles) {
    try { h.update(fs.readFileSync(path.join(publicDir, f))); } catch { /* file optional */ }
  }
  const assetHash = h.digest('hex').slice(0, 8);
  const short = hash ? hash.slice(0, 7) : 'nogit';
  return {
    hash: hash || 'unknown',
    short,
    message: (message || '').split('\n')[0].slice(0, 120),
    date,
    assetHash,
    deploymentId: process.env.RAILWAY_DEPLOYMENT_ID || '',
    started: new Date().toISOString(),
  };
}
const GIT_VERSION = computeBuildInfo();

const { getSupabaseClient } = require('../../shared/supabaseClient');
const { uploadOperatorBase64 } = require('../../shared/operatorUploads');
const gorgias = require('../import/gorgiasClient');
const { fetchOrderByNumber, warehanceOrderUrl } = require('../../reports/lib/warehanceClient');
const { autoLinkProducts } = require('../lib/autoLinker');
const { canonicalMessageType } = require('../lib/messageTypes');
const { markOutreachSent, resolveOnTicketClose } = require('../lib/noteLifecycle');
const { buildSendFeedbackRow, buildManualSendFeedbackRow } = require('../lib/feedbackSignals');
const { fetchAutosendConfig, validateAutosendFlagKey } = require('../lib/autosendConfig');
const { fetchAutoactionConfig, validateAutoactionFlagKey } = require('../lib/autoactionConfig');
const { setFlag } = require('../../shared/systemFlags');

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
    .select('id, gorgias_ticket_id, gorgias_message_id, customer_email, customer_name, customer_country, order_number, draft_response, confidence, advisor_status, message_type, action_type, turn_number, status, created_at, action_result')
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

// Upload base64 attachments to Supabase storage and return resolved { url, name, content_type, size }
// objects that Gorgias's API accepts. Failures are logged and skipped — they don't block the send.
async function resolveAttachmentsForGorgias(attachments) {
  if (!attachments || !attachments.length) return [];
  const resolved = [];
  for (const att of attachments) {
    if (!att.base64) continue;
    try {
      const { url } = await uploadOperatorBase64(att.base64, { filename: att.name, mimeType: att.content_type });
      resolved.push({ url, name: att.name, content_type: att.content_type, size: Math.ceil((att.base64.length * 3) / 4) });
    } catch (e) {
      console.warn('[dashboard] attachment upload failed, skipping:', att.name, e.message);
    }
  }
  return resolved;
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
  if (draft.status !== 'pending') {
    // Operator is sending a follow-up on an already-sent draft (e.g. pending_operator / On Me flow).
    if (draft.status === 'sent' && draft.ticket_id) {
      // Idempotency guard 1: if a newer active draft already exists for this ticket
      // (created by a prior send attempt), route to it rather than creating another.
      const { data: ticket } = await supabase.from('cs_tickets')
        .select('active_draft_id').eq('id', draft.ticket_id).single();
      if (ticket?.active_draft_id && ticket.active_draft_id !== id) {
        return apiSendDraft(ticket.active_draft_id, body);
      }
      // Idempotency guard 2: if this draft was sent in the last 60s it's a duplicate retry.
      if (draft.sent_at && (Date.now() - new Date(draft.sent_at).getTime()) < 60000) {
        throw new Error(`Draft ${id} was already sent moments ago — looks like a duplicate`);
      }
      // Create a fresh pending draft row and send it.
      const { data: freshDraft, error: freshErr } = await supabase.from('cs_ai_drafts').insert({
        ticket_id: draft.ticket_id,
        gorgias_ticket_id: draft.gorgias_ticket_id,
        customer_email: draft.customer_email,
        order_number: draft.order_number,
        draft_response: body.response || '',
        source: 'operator_reply',
        structured_output: {},
      }).select('id').single();
      if (freshErr) throw freshErr;
      await supabase.from('cs_tickets').update({ active_draft_id: freshDraft.id }).eq('id', draft.ticket_id);
      return apiSendDraft(freshDraft.id, body);
    }
    throw new Error(`Draft ${id} is not pending (status: ${draft.status})`);
  }

  // Send-time guard: draft.action_type is a *proposal* — executions live in
  // actions[]. Advisor drafts confirm the action in past tense ("I've updated
  // your address"), so sending while the proposal never executed tells the
  // customer something happened that didn't. Block unless the operator
  // explicitly overrides (the client confirms and retries with the flag).
  if (draft.action_type && !body.force_unexecuted_action) {
    const executedTypes = await fetchExecutedActionTypes(supabase, draft);
    const missing = draft.action_type.split('+')
      .map(t => t.trim())
      .filter(t => t && !executedTypes.has(t));
    if (missing.length) {
      const err = new Error(
        `Draft proposes "${draft.action_type}" but no matching action has been executed on this ticket — the email may claim something that hasn't happened.`
      );
      err.code = 'unexecuted_action';
      err.statusCode = 409;
      throw err;
    }
  }

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
    const resolvedAttachments = await resolveAttachmentsForGorgias(body.attachments);
    replyResult = await gorgias.createTicketReply(draft.gorgias_ticket_id, {
      body_html: bodyHtml,
      body_text: finalResponse,
      attachments: resolvedAttachments,
    });
  }

  // Update draft. Sending is a terminal event for the action-chat scratchpad:
  // completed work is already filed in `actions[]`, and an un-executed phase-1
  // preview is dead once the reply goes out (its draft order goes stale). Leaving
  // the scratchpad behind replays the old chat — with live-looking Yes/No confirm
  // buttons — when this draft row is reused on a reopened ticket.
  const draftUpdate = {
    status: 'sent',
    sent_response: finalResponse,
    feedback_notes: notes,
    reviewed_at: new Date().toISOString(),
    sent_at: new Date().toISOString(),
    gorgias_reply_message_id: replyResult?.id || null,
    action_result: null,
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

  await supabase.from('cs_ai_feedback_log').insert(
    buildSendFeedbackRow(draft, finalResponse, { originalResponse, afterAction, notes })
  );
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
    await gorgias.snoozeTicket(draft.gorgias_ticket_id, 3);
  }

  // Update DB status LAST — only after Gorgias succeeded
  // 'onme' snoozes Gorgias (keeps it tidy) but sets our status to pending_operator
  // so the auto-follow-up is suppressed and the ticket stays in the On Me tab.
  const dbStatus = afterAction === 'close' ? 'closed' : afterAction === 'onme' ? 'pending_operator' : 'snoozed';
  await updateTicketStatus(supabase, draft.gorgias_ticket_id, dbStatus, { has_agent_reply: true });

  // Note lifecycle: an outreach draft going out supersedes the order's
  // "drafted — pending review" note so the daily report moves the order to
  // Waiting on Response. No-op for ordinary inbound replies. Fail-soft —
  // never roll back a successful send over report bookkeeping.
  try {
    if (draft.order_number) {
      await markOutreachSent({ supabase, orderNumber: draft.order_number, csTicketId: draft.ticket_id });
    }
  } catch (err) {
    console.warn(`[noteLifecycle] send hook failed for order ${draft.order_number}: ${err.message}`);
  }

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


// Recompose an outbound (operator-initiated) draft when there is no customer
// reply yet. Called by apiRefreshDraft and createFreshDraftForTicket when the
// Gorgias thread has only agent messages. Returns { draft_response, draft_id, structured }.
// Pass draftId + existingDraft to update an existing row; omit both and pass ticketId
// to insert a fresh row (createFreshDraftForTicket path).
async function recomposeOutboundDraft({ ticketId, draftId, existingDraft, customerEmail, orderNumber, gorgiasTicketId, gorgiasTicket, steer, emit = () => {} }) {
  const supabase = getSupabaseClient();
  const { buildContext } = require('../lib/contextBuilder');
  const { composeOutboundDraft } = require('../lib/composeOutboundDraft');

  const senderName = [gorgiasTicket?.customer?.firstname, gorgiasTicket?.customer?.lastname]
    .filter(Boolean).join(' ').trim() || gorgiasTicket?.customer?.name || null;

  const orderNum = orderNumber ? String(orderNumber).replace(/^#/, '') : null;
  if (!orderNum) throw new Error('Cannot recompose outbound draft — no order number on ticket.');

  let preContext = null;
  try {
    preContext = await buildContext({
      customer_email: customerEmail,
      customer_name: senderName,
      issue_description: steer,
      current_gorgias_ticket_id: gorgiasTicketId,
    });
  } catch (err) {
    console.warn(`[refresh-outbound] buildContext failed: ${err.message}`);
  }

  emit({ type: 'status', text: 'Generating draft...' });
  const composed = await composeOutboundDraft({ context: preContext, orderNumber: orderNum, steer });

  const structured = {
    ...(existingDraft?.structured_output || {}),
    status: 'outbound_draft',
    source: 'operator_outreach',
    subject: composed.subject,
    recipient_email: customerEmail,
    operator_steer: steer,
  };

  if (draftId && existingDraft) {
    // Update the existing draft row in place
    const updates = {
      draft_response: composed.plain_body,
      status: 'pending',
      operator_steer: steer,
      structured_output: structured,
      audit_trail: [
        ...(Array.isArray(existingDraft.audit_trail) ? existingDraft.audit_trail : []),
        `[Outbound draft recomposed] Steer: ${steer}`,
      ],
    };
    if (existingDraft.draft_response?.trim()) {
      const prevHistory = Array.isArray(existingDraft.draft_history) ? existingDraft.draft_history : [];
      updates.draft_history = [
        ...prevHistory,
        { regenerated_at: new Date().toISOString(), draft_response: existingDraft.draft_response, operator_steer: existingDraft.operator_steer || null },
      ];
    }
    await supabase.from('cs_ai_drafts').update(updates).eq('id', draftId);
    const resolvedTicketId = existingDraft.ticket_id || ticketId;
    if (resolvedTicketId) {
      await supabase.from('cs_tickets').update({ active_draft_id: draftId }).eq('id', resolvedTicketId);
    }
    return { draft_response: composed.plain_body, draft_id: draftId, structured };
  }

  // No existing draft row — insert a new one (createFreshDraftForTicket path)
  const { data: newRow, error: insertErr } = await supabase.from('cs_ai_drafts').insert({
    ticket_id: ticketId,
    gorgias_ticket_id: gorgiasTicketId,
    gorgias_message_id: null,
    customer_email: customerEmail,
    order_number: orderNum,
    draft_response: composed.plain_body,
    structured_output: structured,
    audit_trail: [`[Outbound draft] Composed from operator steer: ${steer}`],
    confidence: 'high',
    advisor_status: 'ready',
    message_type: 'proactive_outreach',
    draft_kind: 'advisor_draft',
    status: 'pending',
    operator_steer: steer,
  }).select('id').single();

  if (insertErr) throw new Error(`Draft save failed: ${insertErr.message}`);
  await supabase.from('cs_tickets').update({ active_draft_id: newRow.id }).eq('id', ticketId);
  return { draft_response: composed.plain_body, draft_id: newRow.id, structured };
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
  if (!lastCustomer) {
    // No customer reply yet — operator-initiated outbound ticket.
    if (!steer) throw new Error('No customer message yet. Add a steer to update the outbound draft.');
    return recomposeOutboundDraft({
      draftId: id,
      existingDraft: draft,
      customerEmail: draft.customer_email,
      orderNumber: draft.order_number,
      gorgiasTicketId: draft.gorgias_ticket_id,
      gorgiasTicket,
      steer,
      emit: _emit,
    });
  }
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
    // A regenerated draft is always something the operator intends to review/send,
    // so it must be pending. This re-opens an already-sent draft when the operator
    // regenerates on a reopened ticket (customer replied after we sent/closed); the
    // UNIQUE(gorgias_ticket_id, gorgias_message_id) constraint means there's exactly
    // one draft per message, so we reuse it rather than inserting a second row.
    status: 'pending',
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
    // Re-link this draft as the ticket's active draft. No-op when it already is
    // (normal pending-draft refresh); for a reopened/snoozed ticket (active_draft_id
    // nulled on send/snooze/close) this points the ticket back at the refreshed
    // draft so it renders, survives reload, shows in the queue, and is sendable.
    const ticketUpdates = { updated_at: new Date().toISOString(), active_draft_id: id };
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

  // Update draft (terminal — clear the action-chat scratchpad, see apiSendDraft)
  const draftUpdate = {
    status: 'released',
    feedback_notes: body.notes || 'Released to Gorgias',
    reviewed_at: new Date().toISOString(),
    action_result: null,
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

  // Update DB only after Gorgias succeeded (terminal — clear the action-chat
  // scratchpad, see apiSendDraft)
  const draftUpdate = {
    status: 'deleted',
    reviewed_at: new Date().toISOString(),
    action_result: null,
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
    // Same note-lifecycle hook as updateTicketStatus — this branch closes
    // never-sent outbound tickets directly by id. Fail-soft.
    try {
      const { data: t } = await supabase.from('cs_tickets')
        .select('id, order_number').eq('id', draft.ticket_id).maybeSingle();
      if (t?.order_number) {
        await resolveOnTicketClose({ supabase, orderNumber: t.order_number, csTicketId: t.id });
      }
    } catch (err) {
      console.warn(`[noteLifecycle] close hook failed for ticket ${draft.ticket_id}: ${err.message}`);
    }
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

  // Update DB only after Gorgias succeeded (terminal — clear the action-chat
  // scratchpad, see apiSendDraft)
  const draftUpdate = {
    status: 'spam',
    reviewed_at: new Date().toISOString(),
    action_result: null,
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
// Action Chat — Claude-powered tool execution via chat
// ---------------------------------------------------------------------------

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
  'update_shipping_speed',
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

// Union completed operator actions across all of a ticket's drafts, oldest
// first. Each customer reply creates a fresh draft row with empty actions[],
// so any single draft is blind to prior turns' executed work — the agent's
// "what has already been done" view must aggregate across drafts, exactly like
// the dashboard timeline does. Pure; exported for tests.
function unionTicketActions(drafts) {
  return (drafts || [])
    .flatMap(d => (Array.isArray(d?.actions) ? d.actions : []))
    .filter(Boolean)
    .sort((x, y) => new Date(x.executed_at || 0) - new Date(y.executed_at || 0));
}

// Executed action_types across ALL the ticket's drafts (same ticket-level
// union rule as unionTicketActions — completed work is filed on whichever
// draft row was active when it executed). Falls back to the draft's own
// actions[] for drafts without a ticket row.
async function fetchExecutedActionTypes(supabase, draft) {
  let drafts = [draft];
  if (draft.ticket_id) {
    const { data: siblings } = await supabase
      .from('cs_ai_drafts')
      .select('actions')
      .eq('ticket_id', draft.ticket_id);
    if (siblings?.length) drafts = siblings;
  }
  return new Set(unionTicketActions(drafts).map(a => a.action_type).filter(Boolean));
}

async function apiActionChat(draftId, body, { onStream, signal } = {}) {
  const _t0 = Date.now();
  console.log(`[apiActionChat] START draftId=${draftId}`);
  const { operatorAgent } = require('../lib/operatorAgent');
  const supabase = getSupabaseClient();
  const { data: draft, error: fetchErr } = await supabase
    .from('cs_ai_drafts').select('*').eq('id', draftId).single();
  console.log(`[apiActionChat] draft fetched elapsed=${Date.now()-_t0}ms`);
  if (fetchErr) throw fetchErr;

  const userMessage = body.message;
  const history = body.history || [];
  const structured = draft.structured_output || {};

  // Also pull ticket-level order context as fallback (richer than draft alone),
  // and the completed actions across ALL the ticket's drafts so the agent knows
  // what prior turns already executed (the current draft's actions[] only
  // covers the current turn).
  let ticketOrderCtx = {};
  let completedActions = Array.isArray(draft.actions) ? draft.actions : [];
  if (draft.ticket_id) {
    const [{ data: t }, { data: siblingDrafts }] = await Promise.all([
      supabase.from('cs_tickets')
        .select('order_context').eq('id', draft.ticket_id).single(),
      supabase.from('cs_ai_drafts')
        .select('actions').eq('ticket_id', draft.ticket_id),
    ]);
    ticketOrderCtx = t?.order_context || {};
    if (siblingDrafts?.length) completedActions = unionTicketActions(siblingDrafts);
  }
  console.log(`[apiActionChat] context ready elapsed=${Date.now()-_t0}ms, calling operatorAgent`);

  // The operator agent grades divergence ("⚠️ Note" + AUTO_CONFIRM HOLD) against
  // draft.draft_response. Operator edits to the AI Draft box are NOT persisted to
  // draft_response (they live in the textarea/localStorage and are sent as
  // body.response at send time), so without this the flag is evaluated against the
  // stale original draft — flagging a mismatch the operator already fixed. When the
  // caller passes the in-flight edited text, evaluate against that instead. Same
  // pattern as apiSendDraft's `body.response || draft.draft_response`.
  const evalDraft = typeof body.current_draft === 'string' && body.current_draft.trim()
    ? { ...draft, draft_response: body.current_draft }
    : draft;

  const context = {
    draft: evalDraft,
    customer_email: draft.customer_email,
    order_number: (draft.order_number || '').replace('#', ''),
    order_items: structured.order?.items || ticketOrderCtx.items || [],
    fulfillment_status: structured.order?.fulfillment_status || ticketOrderCtx.fulfillment_status || null,
    intake: structured.intake || null,
    completed_actions: completedActions,
    gorgias_ticket_id: draft.gorgias_ticket_id,
    draft_id: draft.id,
  };

  const result = await operatorAgent(userMessage, context, history, onStream, signal);

  // Extract Shopify admin links from tool results before saving
  result.links = extractActionLinks(result.tool_results);

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

  // Single source of truth for the dashboard's Yes/No confirm buttons. The two
  // client render paths (live stream finalize, panel re-render from scratchpad)
  // used to apply separate regex heuristics over different snapshots and could
  // disagree — buttons appearing on the stream then vanishing on the reload.
  const { execute_send: _staleBadge, ...prevResult } = draft.action_result || {};
  const pendingPreview = resolveChatPendingPreview({
    toolResults: result.tool_results,
    completing: !!completingTool,
    userMessage,
    prevPending: prevResult.chat_pending_preview === true,
  });
  result.pending_preview = pendingPreview;

  // Update draft with in-progress action chat (the bottom panel renders this
  // until the action completes; on completion we file the entry into `actions`
  // and clear this scratchpad so the panel returns to idle).
  // Drop any stale execute_send badge — the operator is now engaging the ticket
  // manually, so the "needs review" flag from a held one-click run no longer applies.
  const updates = {
    action_result: {
      ...prevResult,
      chat_tool_results: result.tool_results,
      chat_history: result.history,
      chat_response: result.response,
      chat_links: dedupeLinks([...(prevResult.chat_links || []), ...result.links]),
      chat_pending_preview: pendingPreview,
    },
  };

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
    // EXCEPT when the same turn ALSO staged a new awaiting-confirmation preview
    // (e.g. add_order_note alongside an exchange preview): wiping then would
    // strand the pending phase 1 and make the confirm buttons vanish on reload.
    if (!pendingPreview) updates.action_result = null;
    if (!draft.action_executed_at) {
      updates.action_executed_at = now;
      updates.advisor_status = 'ready';
    }
  }

  await supabase.from('cs_ai_drafts').update(updates).eq('id', draftId);

  return result;
}

// Decide whether the action chat is awaiting a Yes/No confirmation after this
// turn. Pure; exported for tests.
// - A write-tool preview saying "awaiting confirmation" this turn → pending,
//   even if another write completed in the same turn.
// - A completing write (phase 2 ran) or an explicit cancel click (the quick-reply
//   button sends the literal "no, cancel") settles the preview → not pending.
// - Otherwise (lookups, Q&A prose) the previous state carries over, so asking a
//   clarifying question mid-preview doesn't make the confirm buttons vanish.
function resolveChatPendingPreview({ toolResults, completing, userMessage, prevPending }) {
  const previewedThisTurn = (toolResults || []).some(tr =>
    WRITE_TOOLS.has(tr.tool) && typeof tr.result === 'string' && /awaiting confirmation/i.test(tr.result));
  if (previewedThisTurn) return true;
  if (completing) return false;
  if (/^no,?\s*cancel/i.test((userMessage || '').trim())) return false;
  return prevPending === true;
}

// Resolve the draft an operator action should anchor onto. Prefer the ticket's
// active draft; for reopened/snoozed tickets (active_draft_id is nulled on
// send/snooze/close, then the ticket flips back to open via the Gorgias
// ticket-updated webhook without relinking) fall back to the most recent draft so
// the action still runs with full context and is filed into the inline timeline.
// Returns null only when the ticket has no drafts at all.
async function resolveActionAnchorDraftId(ticketId) {
  const supabase = getSupabaseClient();
  const { data: t } = await supabase.from('cs_tickets')
    .select('active_draft_id').eq('id', ticketId).single();
  if (t?.active_draft_id) return t.active_draft_id;
  const { data: latest } = await supabase.from('cs_ai_drafts')
    .select('id').eq('ticket_id', ticketId)
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  return latest?.id || null;
}

// Run the operator agent with ticket-level context only — used when a ticket has
// no drafts to anchor onto (rare; e.g. a manually created ticket). The executed
// action is not filed into a draft's actions[] since there's no draft to hold it.
async function apiActionChatNoDraft(ticketId, body, { onStream } = {}) {
  const { operatorAgent } = require('../lib/operatorAgent');
  const supabase = getSupabaseClient();
  const { data: t } = await supabase.from('cs_tickets')
    .select('customer_email, order_number, order_context, gorgias_ticket_id')
    .eq('id', ticketId).single();
  const orderCtx = t?.order_context || {};
  const context = {
    customer_email: t?.customer_email,
    order_number: (t?.order_number || '').replace('#', ''),
    order_items: orderCtx.items || [],
    fulfillment_status: orderCtx.fulfillment_status || null,
    intake: null,
    gorgias_ticket_id: t?.gorgias_ticket_id,
  };
  const result = await operatorAgent(body.message, context, body.history || [], onStream);
  result.links = extractActionLinks(result.tool_results);
  // No draft row to persist pending state on — compute it for this turn only so
  // the client's confirm buttons still key off the same server-side signal.
  result.pending_preview = resolveChatPendingPreview({
    toolResults: result.tool_results, completing: false,
    userMessage: body.message, prevPending: false,
  });
  return result;
}

// Create a brand-new advisor draft for a ticket with no active draft to refresh —
// i.e. a reopened/snoozed ticket whose prior draft was already sent (active_draft_id
// nulled), or a manually created ticket with no drafts. Runs the advisor on the
// latest customer message, inserts a fresh `pending` cs_ai_drafts row, and links it
// as the ticket's active draft so it renders, survives reload, and is sendable.
// Mutating the old sent draft in place is wrong — it isn't sendable (status='sent')
// and leaves active_draft_id null. Streams via onStream when provided. Returns the
// same shape as apiRefreshDraft: { draft_response, draft_id, structured }.
async function createFreshDraftForTicket(ticketId, { steer, onStream } = {}) {
  const supabase = getSupabaseClient();
  const { data: t } = await supabase.from('cs_tickets')
    .select('gorgias_ticket_id, customer_email, order_number')
    .eq('id', ticketId).single();
  if (!t?.gorgias_ticket_id) throw new Error('Ticket not found');

  const gorgiasClient = require('../import/gorgiasClient');
  const { buildConversationContext, extractCleanBody } = require('../intake/processGorgiasTickets');
  const { aiAdvisor } = require('../lib/aiAdvisor');

  if (onStream) onStream({ type: 'status', text: 'Generating draft...' });

  const [messages, gorgiasTicket] = await Promise.all([
    gorgiasClient.getTicketMessages(t.gorgias_ticket_id),
    gorgiasClient.getTicket(t.gorgias_ticket_id).catch(() => null),
  ]);
  const lastCustomer = [...messages].reverse().find(m => m.from_agent === false);
  if (!lastCustomer) {
    // No customer reply yet — operator-initiated outbound ticket.
    if (!steer) throw new Error('No customer message yet. Add a steer to update the outbound draft.');
    return recomposeOutboundDraft({
      ticketId,
      customerEmail: t.customer_email,
      orderNumber: t.order_number,
      gorgiasTicketId: t.gorgias_ticket_id,
      gorgiasTicket,
      steer,
      emit: onStream || (() => {}),
    });
  }

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
    onStream: onStream ? (event) => onStream(event) : undefined,
    ticket_id: t.gorgias_ticket_id,
  });

  const s = result._structured;
  const newDraft = s?._composedResponse || '';
  const confidence = (s?.status === 'ready' || s?.status === 'action_needed') ? 'high' : s?.status === 'needs_info' ? 'medium' : 'low';

  const { data: newDraftRow, error: insertErr } = await supabase.from('cs_ai_drafts').insert({
    ticket_id: ticketId,
    gorgias_ticket_id: t.gorgias_ticket_id,
    gorgias_message_id: lastCustomer.id,
    customer_email: t.customer_email,
    order_number: t.order_number,
    draft_response: newDraft,
    structured_output: s,
    audit_trail: s?.audit || [],
    confidence,
    advisor_status: s?.status,
    message_type: canonicalMessageType(s?.message_type, `operator-redraft ticket ${ticketId}`),
    operator_steer: steer || null,
  }).select('id').single();

  if (insertErr) {
    console.error(`[refresh] Failed to insert draft for ticket ${ticketId}:`, insertErr);
    throw new Error(`Draft save failed: ${insertErr.message}`);
  }

  await supabase.from('cs_tickets').update({ active_draft_id: newDraftRow.id }).eq('id', ticketId);

  return { draft_response: newDraft, draft_id: newDraftRow.id, structured: s };
}

// ---------------------------------------------------------------------------
// Execute & Send — one-click background: phase 1 → gate → phase 2 → send.
// Reuses apiActionChat (both phases) and apiSendDraft. Auto-confirms ONLY when
// the operator agent returned AUTO_CONFIRM: SAFE AND exactly one clean
// awaiting-confirmation write preview (mechanical backstop). Any HOLD, question,
// error, or multi-write leaves the ticket at phase 1 for manual handling,
// flagged with a reason badge. Nothing irreversible happens on a HOLD.
// ---------------------------------------------------------------------------

/** Pure gate decision over a phase-1 operatorAgent result. Exported for tests. */
function evaluateExecuteSendGate(phase1Result) {
  const previews = (phase1Result?.tool_results || []).filter(
    tr => WRITE_TOOLS.has(tr.tool) && typeof tr.result === 'string' && /awaiting confirmation/i.test(tr.result)
  );
  if (phase1Result?.auto_confirm?.safe !== true) {
    return { safe: false, reason: phase1Result?.auto_confirm?.reason || 'Flagged for review.' };
  }
  if (previews.length === 0) return { safe: false, reason: 'No clean action preview — needs review.' };
  if (previews.length > 1) return { safe: false, reason: 'Multiple actions previewed — needs review.' };
  return { safe: true, reason: null };
}

async function setExecuteSendOutcome(supabase, draftId, status, reason) {
  const { data } = await supabase.from('cs_ai_drafts').select('action_result').eq('id', draftId).maybeSingle();
  const ar = data?.action_result || {};
  await supabase.from('cs_ai_drafts').update({
    action_result: { ...ar, execute_send: { status, reason: reason || null, at: new Date().toISOString() } },
  }).eq('id', draftId);
}

/**
 * Pure orchestration of the execute-and-send sequence over injected IO, so the
 * risk-critical ordering is testable without network: phase 1 → gate → phase 2
 * → send. Guarantees: a HOLD runs no phase 2 and no send; a phase-2 failure
 * sends no email; a send failure after a completed action returns 'half'.
 * Exported for tests.
 */
async function orchestrateExecuteAndSend({ command, runPhase1, runPhase2, sendDraft, recordOutcome }) {
  if (!command) return { outcome: 'error', reason: 'No operator action to execute on this draft.' };

  let r1;
  try { r1 = await runPhase1(); }
  catch (err) { await recordOutcome('error', `Phase 1 failed: ${err.message}`); return { outcome: 'error', reason: err.message }; }

  const gate = evaluateExecuteSendGate(r1);
  if (!gate.safe) {
    await recordOutcome('hold', gate.reason);
    return { outcome: 'hold', reason: gate.reason, response: r1.response };
  }

  let r2;
  try { r2 = await runPhase2(r1); }
  catch (err) { await recordOutcome('error', `Action failed: ${err.message}`); return { outcome: 'error', reason: err.message }; }

  const executed = (r2.tool_results || []).find(
    tr => WRITE_TOOLS.has(tr.tool) && !tr.error && typeof tr.result === 'string'
      && !/awaiting confirmation/i.test(tr.result)
  );
  if (!executed) {
    const reason = (r2.tool_results || []).find(tr => tr.error)?.error || 'Action did not complete on confirmation.';
    await recordOutcome('error', reason);
    return { outcome: 'error', reason, response: r2.response };
  }

  try { await sendDraft(); }
  catch (err) {
    await recordOutcome('half', `Action done, send failed: ${err.message}`);
    return { outcome: 'half', reason: err.message, action_summary: r2.response };
  }
  return { outcome: 'sent', action_summary: r2.response };
}

async function apiExecuteAndSend(draftId, body = {}) {
  const supabase = getSupabaseClient();
  const { data: draft, error: fetchErr } = await supabase
    .from('cs_ai_drafts').select('*').eq('id', draftId).single();
  if (fetchErr) throw fetchErr;

  // The operator-edited action box wins; fall back to the advisor's summary.
  const command = (body.command || draft.structured_output?.operator_action_summary || '').trim();

  return orchestrateExecuteAndSend({
    command,
    // apiActionChat persists the phase-1 chat scratchpad, so a HOLD leaves the
    // operator a preview + quick-reply buttons when they reopen.
    // Pass the operator-edited box (body.response) so phase-1 grades divergence
    // against what the operator actually has, not the stale stored draft.
    runPhase1: () => apiActionChat(draftId, { message: command, history: [], current_draft: body.response }),
    runPhase2: (r1) => apiActionChat(draftId, { message: 'yes confirm', history: r1.history }),
    sendDraft: () => apiSendDraft(draftId, {
      response: body.response,
      after: body.after || 'snooze',
      focus_time_seconds: body.focus_time_seconds,
      attachments: body.attachments,
      notes: body.notes,
    }),
    recordOutcome: (status, reason) => setExecuteSendOutcome(supabase, draftId, status, reason),
  });
}

function actionTypeFromTool(toolName, draftActionType) {
  switch (toolName) {
    case 'create_exchange_order': return draftActionType === 'free_order' ? 'free_order' : 'exchange';
    case 'refund_order':          return 'refund';
    case 'edit_order':            return 'order_modification';
    case 'update_shipping_speed': return 'order_modification';
    case 'warehouse_hold':        return 'warehouse_hold';
    case 'cancel_order':          return 'cancellation';
    case 'update_customer':       return 'customer_profile_update';
    case 'create_discount_code':  return 'discount_code';
    case 'split_shipment':        return 'split_shipment';
    case 'consolidate_orders':    return 'order_consolidation';
    // create_invoice_order backs both kept-items invoices AND price-difference
    // exchanges (exchange_items/return_credit). Respect the draft's own type so
    // an exchange reads as "Exchange", not "Invoice Kept Items".
    case 'create_invoice_order':  return (draftActionType === 'exchange' || draftActionType === 'exchange+refund') ? draftActionType : 'invoice_kept_items';
    default:                      return null;
  }
}

// ---------------------------------------------------------------------------
// Ad Hoc — standalone operator console (no ticket context)
// ---------------------------------------------------------------------------

async function apiConsoleChat(body, { onStream } = {}) {
  const { operatorAgentStandalone } = require('../lib/operatorAgentStandalone');
  let message = body.message;
  const history = body.history || [];
  const images = Array.isArray(body.images) ? body.images : [];
  const pdfs = Array.isArray(body.pdfs) ? body.pdfs : [];
  if (!message || typeof message !== 'string') {
    throw new Error('message is required');
  }

  // Stash any attached images to Supabase Storage and append the public URLs
  // to the prompt text. The operator's Claude still gets the images as vision
  // input (so it can see + describe them), but now ALSO has stable URLs it can
  // pass to MCP tools that take a `logo_url` (or similar URL field).
  const uploadedUrls = [];
  for (const img of images) {
    if (!img?.data) continue;
    try {
      const { url } = await uploadOperatorBase64(img.data, {
        filename: img.name || 'attachment',
        mimeType: img.media_type,
      });
      uploadedUrls.push({ name: img.name || 'attachment', url });
    } catch (e) {
      console.warn('[adhoc-operator] image upload failed:', e.message);
    }
  }
  if (uploadedUrls.length) {
    const note = uploadedUrls
      .map(u => `- ${u.name}: ${u.url}`)
      .join('\n');
    message = `${message}\n\n[Files attached this turn — use these URLs when a tool needs the file:\n${note}\n]`;
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
  // pending_operator keeps the active draft so it's visible when Jamie returns
  if (status === 'snoozed' || status === 'closed' || status === 'parked') updates.active_draft_id = null;

  await supabase
    .from('cs_tickets')
    .update(updates)
    .eq('gorgias_ticket_id', gorgiasTicketId);

  // Note lifecycle: closing the conversation resolves the order's open
  // outreach note (the conversation ending IS the resolution). Operator
  // judgment notes are left alone. Fail-soft — never block a close.
  if (status === 'closed') {
    try {
      const { data: t } = await supabase
        .from('cs_tickets')
        .select('id, order_number')
        .eq('gorgias_ticket_id', gorgiasTicketId)
        .maybeSingle();
      if (t?.order_number) {
        await resolveOnTicketClose({ supabase, orderNumber: t.order_number, csTicketId: t.id });
      }
    } catch (err) {
      console.warn(`[noteLifecycle] close hook failed for gorgias ticket ${gorgiasTicketId}: ${err.message}`);
    }
  }
}

// cs_ai_drafts.auto_close_path values that mean "this draft went out (or would
// have gone out, in shadow) without operator review".
const AUTO_SEND_PATHS = ['autosend', 'autosend_shadow'];

async function apiGetTickets(query) {
  const supabase = getSupabaseClient();
  const tab = query.get('tab') || 'new';
  const limit = parseInt(query.get('limit') || '50', 10);
  const autoOnly = tab === 'closed' && query.get('auto') === '1';

  // Ordering: the active work queues (new/followup/onme/snoozed) sort
  // oldest-first so the longest-waiting item sits at the top and normal
  // top-down cycling clears them FIFO. Parked keeps its parked_at oldest-first
  // ordering. Closed is a history log, so it stays newest-first — oldest-first
  // there would bury today's closures under years-old ones.
  const orderCol = tab === 'parked' ? 'parked_at' : 'updated_at';
  const orderAsc = tab !== 'closed';

  let q = supabase
    .from('cs_tickets')
    .select('id, gorgias_ticket_id, customer_email, customer_name, customer_country, order_number, message_type, confidence, advisor_status, has_agent_reply, message_count, status, active_draft_id, updated_at, created_at, parked_at, snoozed_at, source, summary, viewed_at, last_customer_message_at, auto_close_path')
    .order(orderCol, { ascending: orderAsc })
    .limit(limit);

  switch (tab) {
    case 'new':
      q = q.eq('status', 'open').eq('has_agent_reply', false);
      break;
    case 'followup':
      q = q.eq('status', 'open').eq('has_agent_reply', true);
      break;
    case 'onme':
      q = q.eq('status', 'pending_operator');
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

  // "AUTO only" filter: scope the closed tab to tickets whose draft was (or
  // would have been, in shadow) auto-sent. Two-step because the mark lives on
  // cs_ai_drafts, not cs_tickets.
  if (autoOnly) {
    const { data: autoDrafts, error: adErr } = await supabase
      .from('cs_ai_drafts')
      .select('ticket_id')
      .in('auto_close_path', AUTO_SEND_PATHS)
      .not('ticket_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(500);
    if (adErr) throw adErr;
    const ids = [...new Set(autoDrafts.map(d => d.ticket_id))];
    if (!ids.length) return [];
    q = q.in('id', ids);
  }

  const { data, error } = await q;
  if (error) throw error;

  // Closed tab: attach the auto-send mark so the queue card can badge it.
  // A live 'autosend' wins over 'autosend_shadow' if a ticket has both.
  if (tab === 'closed' && data.length) {
    const { data: marks } = await supabase
      .from('cs_ai_drafts')
      .select('ticket_id, auto_close_path')
      .in('ticket_id', data.map(t => t.id))
      .in('auto_close_path', AUTO_SEND_PATHS);
    const markByTicket = new Map();
    for (const m of marks || []) {
      const prev = markByTicket.get(m.ticket_id);
      if (!prev || m.auto_close_path === 'autosend') markByTicket.set(m.ticket_id, m.auto_close_path);
    }
    for (const t of data) {
      const mark = markByTicket.get(t.id);
      if (mark) t.draft_auto_close_path = mark;
    }
  }

  // Attach the Execute & Send outcome badge (hold/error/half) from the active
  // draft's action_result, so a bounced-back one-click run is flagged in queue.
  const draftIds = data.map(t => t.active_draft_id).filter(Boolean);
  if (draftIds.length) {
    const { data: drafts } = await supabase
      .from('cs_ai_drafts').select('id, action_result').in('id', draftIds);
    const byId = new Map((drafts || []).map(d => [d.id, d.action_result?.execute_send || null]));
    for (const t of data) {
      const es = byId.get(t.active_draft_id);
      if (es) t.execute_send = es;
    }
  }
  return data;
}

// Search tickets across ALL statuses (not tab-scoped) by customer name, email,
// order number, or summary. Returns the same row shape as apiGetTickets so the
// dashboard can render results with the existing queue-item card renderer.
async function apiSearchTickets(query) {
  const supabase = getSupabaseClient();
  const raw = (query.get('q') || '').trim();
  const limit = parseInt(query.get('limit') || '50', 10);
  if (raw.length < 2) return [];

  // Sanitize for PostgREST's .or() grammar: commas separate filters and
  // parens group them, so a term containing either would corrupt the filter.
  // Strip those plus the ilike wildcards we add ourselves.
  const term = raw.replace(/[,()%*\\]/g, ' ').trim();
  if (!term) return [];
  const pat = `%${term}%`;

  const { data, error } = await supabase
    .from('cs_tickets')
    .select('id, gorgias_ticket_id, customer_email, customer_name, customer_country, order_number, message_type, confidence, advisor_status, has_agent_reply, message_count, status, active_draft_id, updated_at, created_at, parked_at, snoozed_at, source, summary, viewed_at, last_customer_message_at, auto_close_path')
    .or(`customer_name.ilike.${pat},customer_email.ilike.${pat},order_number.ilike.${pat},summary.ilike.${pat}`)
    .order('updated_at', { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data;
}

async function apiGetTicketStats() {
  const supabase = getSupabaseClient();

  const [newResult, followupResult, onmeResult, parkedResult, snoozedResult] = await Promise.all([
    supabase.from('cs_tickets').select('id', { count: 'exact', head: true })
      .eq('status', 'open').eq('has_agent_reply', false),
    supabase.from('cs_tickets').select('id', { count: 'exact', head: true })
      .eq('status', 'open').eq('has_agent_reply', true),
    supabase.from('cs_tickets').select('id', { count: 'exact', head: true })
      .eq('status', 'pending_operator'),
    supabase.from('cs_tickets').select('id', { count: 'exact', head: true })
      .eq('status', 'parked'),
    supabase.from('cs_tickets').select('id', { count: 'exact', head: true })
      .eq('status', 'snoozed'),
  ]);

  return {
    new: newResult.count || 0,
    followup: followupResult.count || 0,
    onme: onmeResult.count || 0,
    parked: parkedResult.count || 0,
    snoozed: snoozedResult.count || 0,
  };
}

// ---------------------------------------------------------------------------
// Auto-send allowlist (#4) — master shadow flag + per-category flags, with
// judge quality stats per category. Assembly lives in lib/autosendConfig.js.
// ---------------------------------------------------------------------------

async function apiGetAutosendConfig() {
  return fetchAutosendConfig(getSupabaseClient());
}

async function apiSetAutosendConfig(body = {}) {
  const { key, enabled } = body;
  const check = validateAutosendFlagKey(key);
  if (!check.ok) {
    const err = new Error(check.error);
    err.statusCode = 400;
    throw err;
  }
  await setFlag(key, !!enabled, 'dashboard auto-send panel');
  console.log(`[dashboard] auto-send flag ${key} → ${!!enabled}`);
  return { success: true, key, enabled: !!enabled };
}

// ---------------------------------------------------------------------------
// Auto-action kill-switches — master + per-kind flags, plus a recent feed of
// actions the system executed on its own. Assembly lives in
// lib/autoactionConfig.js. No shadow phase: these run live, the toggles are
// kill switches (default-ON).
// ---------------------------------------------------------------------------

async function apiGetAutoactionConfig() {
  return fetchAutoactionConfig(getSupabaseClient());
}

async function apiSetAutoactionConfig(body = {}) {
  const { key, enabled } = body;
  const check = validateAutoactionFlagKey(key);
  if (!check.ok) {
    const err = new Error(check.error);
    err.statusCode = 400;
    throw err;
  }
  await setFlag(key, !!enabled, 'dashboard auto-action panel');
  console.log(`[dashboard] auto-action flag ${key} → ${!!enabled}`);
  return { success: true, key, enabled: !!enabled };
}

// ---------------------------------------------------------------------------
// B2B Outreach panel (Design #4 V1.1) — thin wrappers over the b2b-outreach
// libs. Shared logic lives in b2b-outreach/lib/queueService.js so these
// endpoints and the MCP console tools (lib/tools/b2bOutreach.js) never drift.
// ---------------------------------------------------------------------------

const b2bQueueService = require('../../b2b-outreach/lib/queueService');

async function apiB2bQueue(query) {
  const channel = query.get('channel') || null;
  return b2bQueueService.fetchQueueWithDrafts(getSupabaseClient(), { channel });
}

async function apiB2bGetDraft(id) {
  const { data, error } = await getSupabaseClient()
    .from('b2b_drafts').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) {
    const err = new Error(`Draft #${id} not found`);
    err.statusCode = 404;
    throw err;
  }
  return data;
}

// Regenerate the draft for the company behind draft :id (supersedes the
// pending draft; the old draft's message_type is the fallback when the queue
// no longer has the company due). Returns the full new draft row.
async function apiB2bRegenerateDraft(id, body = {}) {
  const sb = getSupabaseClient();
  const old = await apiB2bGetDraft(id);
  const steer = (body.steer || '').trim() || undefined;
  const result = await b2bQueueService.generateDraftForCompany(sb, {
    company_id: old.company_id,
    steer,
    message_type: old.message_type,
  });
  return apiB2bGetDraft(result.draft_id);
}

// Generate a draft for a queue row that doesn't have one yet (the queue
// computes what's due; the row click is the trigger). Same shared lib path
// as the b2b_draft console tool.
async function apiB2bGenerateDraft(companyId, body = {}) {
  const sb = getSupabaseClient();
  const steer = (body.steer || '').trim() || undefined;
  const result = await b2bQueueService.generateDraftForCompany(sb, {
    company_id: companyId,
    steer,
    message_type: body.message_type || undefined,
  });
  if (!result) {
    const err = new Error(`${companyId} has nothing due — nothing to draft`);
    err.statusCode = 400;
    throw err;
  }
  return apiB2bGetDraft(result.draft_id);
}

async function apiB2bDismissDraft(id) {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('b2b_drafts').update({ status: 'dismissed' })
    .eq('id', id).eq('status', 'pending').select('id');
  if (error) throw new Error(error.message);
  if (!data?.length) {
    const err = new Error(`Draft #${id} is not pending — nothing to dismiss`);
    err.statusCode = 400;
    throw err;
  }
  return { success: true };
}

// Two-phase send of a stored draft. Phase 1 (no confirmed) returns the
// preview + gate_enabled; phase 2 passes through blocked/sent from
// sendB2bEmail (HARD-GATED on b2b_send_enabled).
async function apiB2bSend(body = {}) {
  if (!body.draft_id) {
    const err = new Error('draft_id required');
    err.statusCode = 400;
    throw err;
  }
  return b2bQueueService.sendDraftById(getSupabaseClient(), {
    draft_id: parseInt(body.draft_id),
    confirmed: !!body.confirmed,
  });
}

// --- Free Swimwear panel (delegates to the free_swimwear_* MCP tools so logic
// lives in one place) ---
const freeSwimwearTools = require('../lib/tools/freeSwimwear');
const freeSwimwearToolMap = Object.fromEntries(freeSwimwearTools.map(t => [t.name, t]));

async function callSwimwearTool(name, input) {
  const tool = freeSwimwearToolMap[name];
  const res = await tool.handler(input);
  return res;
}

async function apiSwimwearQueue(searchParams) {
  const status = searchParams.get('status') || 'new';
  const limit = parseInt(searchParams.get('limit') || '100', 10);
  const res = await callSwimwearTool('free_swimwear_list_requests', { status, limit });
  return res._structured?.requests || [];
}

async function apiSwimwearGet(id) {
  const res = await callSwimwearTool('free_swimwear_get_request', { id });
  if (res.isError) { const e = new Error(res.content[0].text); e.statusCode = 404; throw e; }
  return res._structured.request;
}

async function apiSwimwearApprove(id, body = {}) {
  const res = await callSwimwearTool('free_swimwear_approve', { id, confirmed: true, operator: body.operator || null });
  return res.isError ? { error: res.content[0].text } : { ok: true, message: res.content[0].text, ...res._structured };
}

async function apiSwimwearReject(id, body = {}) {
  const res = await callSwimwearTool('free_swimwear_reject', { id, reason: body.reason || null, operator: body.operator || null });
  return res.isError ? { error: res.content[0].text } : { ok: true, message: res.content[0].text, ...res._structured };
}

async function apiSwimwearResend(id) {
  const res = await callSwimwearTool('free_swimwear_resend', { id });
  return res.isError ? { error: res.content[0].text } : { ok: true, message: res.content[0].text, ...res._structured };
}

async function apiSwimwearSummary(id) {
  const res = await callSwimwearTool('free_swimwear_summary', { id });
  return res.isError ? { error: res.content[0].text } : { ok: true, message: res.content[0].text };
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
  const resolvedAttachments = await resolveAttachmentsForGorgias(body.attachments);
  const replyResult = await gorgias.createTicketReply(ticket.gorgias_ticket_id, {
    body_html: bodyHtml,
    body_text: message,
    attachments: resolvedAttachments,
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
    updates.status = afterAction === 'onme' ? 'pending_operator' : 'snoozed';
    if (afterAction !== 'onme') updates.snoozed_at = sentAt;
  }

  // Update DB only after Gorgias succeeded
  await supabase.from('cs_tickets').update(updates).eq('id', ticketId);

  // Training-signal capture: a manual send is either a BYPASS of an existing
  // draft (the operator ignored the AI entirely — the strongest negative
  // signal) or a pure manual reply with no draft. Both get a feedback_log row;
  // a lightweight manual_send draft row anchors the no-draft case so the sent
  // text and operator time are never silently dropped.
  const focusSeconds = body.focus_time_seconds != null ? Math.round(body.focus_time_seconds) : null;
  let activeDraft = null;
  let manualDraftId = null;
  if (ticket.active_draft_id) {
    const { data: ad } = await supabase.from('cs_ai_drafts')
      .select('id, draft_response, advisor_status, confidence, message_type, turn_number, operator_steer, draft_history, status')
      .eq('id', ticket.active_draft_id)
      .maybeSingle();
    // Only a pending draft counts as bypassed — an already-sent draft means
    // this manual message is a follow-up, not a rejection of the draft.
    if (ad && ad.status === 'pending') activeDraft = ad;
    if (focusSeconds != null) {
      await supabase.from('cs_ai_drafts')
        .update({ focus_time_seconds: focusSeconds })
        .eq('id', ticket.active_draft_id);
    }
  }
  if (!activeDraft) {
    const { data: manualRow } = await supabase.from('cs_ai_drafts').insert({
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
      ...(focusSeconds != null && !ticket.active_draft_id ? { focus_time_seconds: focusSeconds } : {}),
    }).select('id').maybeSingle();
    manualDraftId = manualRow?.id || null;
  }
  await supabase.from('cs_ai_feedback_log').insert(
    buildManualSendFeedbackRow({
      activeDraft,
      manualDraftId,
      gorgiasTicketId: ticket.gorgias_ticket_id,
      message,
      afterAction,
    })
  );

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

async function apiPendTicket(ticketId, body = {}) {
  const supabase = getSupabaseClient();
  const now = new Date().toISOString();
  if (body.focus_time_seconds != null) {
    const { data: t } = await supabase.from('cs_tickets').select('active_draft_id').eq('id', ticketId).single();
    if (t?.active_draft_id) {
      await supabase.from('cs_ai_drafts').update({ focus_time_seconds: Math.round(body.focus_time_seconds) }).eq('id', t.active_draft_id);
    }
  }
  // Keep active_draft_id so the draft is visible when Jamie returns
  await supabase.from('cs_tickets').update({ status: 'pending_operator', updated_at: now }).eq('id', ticketId);
  return { success: true };
}

async function apiUnpendTicket(ticketId, body = {}) {
  const supabase = getSupabaseClient();
  const now = new Date().toISOString();
  if (body.focus_time_seconds != null) {
    const { data: t } = await supabase.from('cs_tickets').select('active_draft_id').eq('id', ticketId).single();
    if (t?.active_draft_id) {
      await supabase.from('cs_ai_drafts').update({ focus_time_seconds: Math.round(body.focus_time_seconds) }).eq('id', t.active_draft_id);
    }
  }
  await supabase.from('cs_tickets').update({ status: 'open', updated_at: now }).eq('id', ticketId);
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
  'GET /api/tickets/search': (req) => apiSearchTickets(new URL(req.url, 'http://localhost').searchParams),
  'GET /api/tickets/stats': () => apiGetTicketStats(),
  'GET /api/autosend-config': () => apiGetAutosendConfig(),
  'GET /api/autoaction-config': () => apiGetAutoactionConfig(),
  'GET /api/b2b/queue': (req) => apiB2bQueue(new URL(req.url, 'http://localhost').searchParams),
  'GET /api/swimwear/queue': (req) => apiSwimwearQueue(new URL(req.url, 'http://localhost').searchParams),
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
  { method: 'POST', pattern: /^\/api\/drafts\/(\d+)\/action-chat$/, handler: (body, id) => apiActionChat(parseInt(id), body) },
  { method: 'POST', pattern: /^\/api\/drafts\/(\d+)\/execute-and-send$/, handler: (body, id) => apiExecuteAndSend(parseInt(id), body) },
  { method: 'POST', pattern: /^\/api\/console\/chat$/, handler: (body) => apiConsoleChat(body) },
  { method: 'POST', pattern: /^\/api\/autosend-config$/, handler: (body) => apiSetAutosendConfig(body) },
  { method: 'POST', pattern: /^\/api\/autoaction-config$/, handler: (body) => apiSetAutoactionConfig(body) },
  // B2B Outreach panel
  { method: 'GET', pattern: /^\/api\/b2b\/drafts\/(\d+)$/, handler: (_, id) => apiB2bGetDraft(parseInt(id)) },
  { method: 'POST', pattern: /^\/api\/b2b\/drafts\/(\d+)\/regenerate$/, handler: (body, id) => apiB2bRegenerateDraft(parseInt(id), body) },
  { method: 'POST', pattern: /^\/api\/b2b\/drafts\/(\d+)\/dismiss$/, handler: (_, id) => apiB2bDismissDraft(parseInt(id)) },
  { method: 'POST', pattern: /^\/api\/b2b\/companies\/([^/]+)\/draft$/, handler: (body, id) => apiB2bGenerateDraft(decodeURIComponent(id), body) },
  { method: 'POST', pattern: /^\/api\/b2b\/send$/, handler: (body) => apiB2bSend(body) },
  // Free Swimwear panel
  { method: 'GET', pattern: /^\/api\/swimwear\/(\d+)$/, handler: (_, id) => apiSwimwearGet(parseInt(id)) },
  { method: 'POST', pattern: /^\/api\/swimwear\/(\d+)\/approve$/, handler: (body, id) => apiSwimwearApprove(parseInt(id), body) },
  { method: 'POST', pattern: /^\/api\/swimwear\/(\d+)\/reject$/, handler: (body, id) => apiSwimwearReject(parseInt(id), body) },
  { method: 'POST', pattern: /^\/api\/swimwear\/(\d+)\/resend$/, handler: (_, id) => apiSwimwearResend(parseInt(id)) },
  { method: 'POST', pattern: /^\/api\/swimwear\/(\d+)\/summary$/, handler: (_, id) => apiSwimwearSummary(parseInt(id)) },
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
    const ticketId = parseInt(id);
    const steer = (body?.steer || '').trim() || undefined;
    // Refresh the active draft, or the most recent draft for reopened/snoozed
    // tickets (active_draft_id nulled on send/snooze/close). apiRefreshDraft resets
    // it to pending and re-links active_draft_id. Only when the ticket has no drafts
    // at all do we create one (no UNIQUE(ticket,message) conflict in that case).
    const draftId = await resolveActionAnchorDraftId(ticketId);
    return draftId
      ? apiRefreshDraft(draftId, { steer })
      : createFreshDraftForTicket(ticketId, { steer });
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
  { method: 'POST', pattern: /^\/api\/tickets\/(\d+)\/action-chat$/, handler: async (body, id) => {
    const ticketId = parseInt(id);
    // Anchor on the active draft, or the most recent draft for reopened/snoozed
    // tickets; fall back to ticket-only context when the ticket has no drafts.
    const draftId = await resolveActionAnchorDraftId(ticketId);
    try {
      return draftId ? await apiActionChat(draftId, body) : await apiActionChatNoDraft(ticketId, body);
    } catch (err) {
      console.error(`[action-chat] error:`, err.message, err.stack);
      throw err;
    }
  }},
  { method: 'POST', pattern: /^\/api\/tickets\/(\d+)\/message$/, handler: (body, id) => apiSendTicketMessage(parseInt(id), body) },
  { method: 'POST', pattern: /^\/api\/tickets\/(\d+)\/reopen$/, handler: (_, id) => apiReopenTicket(parseInt(id)) },
  { method: 'POST', pattern: /^\/api\/tickets\/(\d+)\/park$/, handler: (body, id) => apiParkTicket(parseInt(id), body) },
  { method: 'POST', pattern: /^\/api\/tickets\/(\d+)\/unpark$/, handler: (body, id) => apiUnparkTicket(parseInt(id), body) },
  { method: 'POST', pattern: /^\/api\/tickets\/(\d+)\/pend$/, handler: (body, id) => apiPendTicket(parseInt(id), body) },
  { method: 'POST', pattern: /^\/api\/tickets\/(\d+)\/unpend$/, handler: (body, id) => apiUnpendTicket(parseInt(id), body) },
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
          if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`);
        };
        const heartbeat = setInterval(() => sendEvent({ type: 'heartbeat' }), 8000);
        try {
          const steer = (body?.steer || '').trim() || undefined;
          // Refresh the active draft, or the most recent draft for reopened/snoozed
          // tickets (active_draft_id null but a prior draft exists). apiRefreshDraft
          // resets it to pending and re-links active_draft_id so it renders and is
          // sendable. Only create a draft when the ticket has none (no UNIQUE
          // (ticket,message) conflict in that case).
          const draftId = await resolveActionAnchorDraftId(ticketId);
          const result = draftId
            ? await apiRefreshDraft(draftId, { steer, onStream: sendEvent })
            : await createFreshDraftForTicket(ticketId, { steer, onStream: sendEvent });
          sendEvent({ type: 'complete', draft_response: result.draft_response, draft_id: result.draft_id, structured: result.structured });
        } catch (err) {
          console.error(`[refresh-stream] error:`, err.message || err);
          sendEvent({ type: 'error', message: err.message || String(err) });
        } finally {
          clearInterval(heartbeat);
          if (!res.writableEnded) res.end();
        }
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
          if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`);
        };
        // Cancel the Anthropic call when the client disconnects (timeout or navigation).
        // Without this, zombie Anthropic calls pile up and block the server.
        const abortCtrl = new AbortController();
        req.on('close', () => abortCtrl.abort());
        const heartbeat = setInterval(() => sendEvent({ type: 'heartbeat' }), 8000);
        const _streamStart = Date.now();
        console.log(`[action-chat-stream] START ticket=${ticketId} msg=${JSON.stringify((body?.message||'').slice(0,60))}`);
        try {
          // Anchor on the active draft, or the most recent draft for reopened/
          // snoozed tickets (active_draft_id is null but a prior draft exists).
          console.log(`[action-chat-stream] resolving draft for ticket=${ticketId}`);
          const draftId = await resolveActionAnchorDraftId(ticketId);
          console.log(`[action-chat-stream] draftId=${draftId} elapsed=${Date.now()-_streamStart}ms`);
          const result = draftId
            ? await apiActionChat(draftId, body, { onStream: sendEvent, signal: abortCtrl.signal })
            : await apiActionChatNoDraft(ticketId, body, { onStream: sendEvent, signal: abortCtrl.signal });
          console.log(`[action-chat-stream] DONE elapsed=${Date.now()-_streamStart}ms`);
          sendEvent({ type: 'complete', response: result.response, tool_results: result.tool_results, links: result.links, history: result.history, pending_preview: result.pending_preview });
        } catch (err) {
          console.error(`[action-chat-stream] ERROR elapsed=${Date.now()-_streamStart}ms`, err.message, err.stack);
          if (!abortCtrl.signal.aborted) sendEvent({ type: 'error', message: err.message });
        } finally {
          clearInterval(heartbeat);
          if (!res.writableEnded) res.end();
        }
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
          if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`);
        };
        const heartbeat = setInterval(() => sendEvent({ type: 'heartbeat' }), 8000);
        try {
          const result = await apiConsoleChat(body, { onStream: sendEvent });
          sendEvent({ type: 'complete', response: result.response, tool_results: result.tool_results, links: result.links, history: result.history });
        } catch (err) {
          console.error(`[console/chat-stream] error:`, err.message || err);
          sendEvent({ type: 'error', message: err.message || String(err) });
        } finally {
          clearInterval(heartbeat);
          if (!res.writableEnded) res.end();
        }
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
      // undici's "fetch failed" TypeError carries the real reason in err.cause
      // and often has no stack — log route + cause or the message is useless.
      const cause = err.cause ? ` — cause: ${err.cause.message || err.cause}` : '';
      console.error(`[dashboard] API error on ${req.method} ${pathname}: ${err.message}${cause}\n${err.stack || ''}`);
      if (!res.headersSent) {
        // Handlers may throw with err.statusCode for client errors (e.g. 400)
        res.writeHead(err.statusCode || 500);
        res.end(JSON.stringify({ error: err.message, ...(err.code && { code: err.code }) }));
      }
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
    const ext = path.extname(fullPath);
    res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
    // Without this, Safari heuristically reuses stale JS/CSS (no validators
    // are sent), and the service worker's fetch() reads that stale HTTP
    // cache — old app code survives deploys. Force revalidation.
    res.setHeader('Cache-Control', 'no-cache');

    if (ext === '.html') {
      // Stamp the build into the served HTML so the running frontend knows
      // exactly which bundle it loaded, and version the asset URLs with the
      // content hash so a new deploy busts any cached app.js/styles.css.
      const v = GIT_VERSION.assetHash;
      let html = fs.readFileSync(fullPath, 'utf8')
        .replace(/(href|src)="(\/(?:app|styles|voiceInput)\.(?:js|css))"/g, `$1="$2?v=${v}"`)
        .replace('</head>', `<script>window.__BUILD__=${JSON.stringify({
          commit: GIT_VERSION.short, assetHash: v, started: GIT_VERSION.started,
        })};</script>\n</head>`);
      res.writeHead(200);
      res.end(html);
      return;
    }

    res.writeHead(200);
    res.end(fs.readFileSync(fullPath));
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

module.exports = { apiSendDraft, evaluateExecuteSendGate, orchestrateExecuteAndSend, apiExecuteAndSend, unionTicketActions, resolveChatPendingPreview, actionTypeFromTool, WRITE_TOOLS };
