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

  // Log feedback
  await supabase.from('cs_ai_feedback_log').insert({
    draft_id: id,
    gorgias_ticket_id: draft.gorgias_ticket_id,
    action: editDist < 0.05 ? 'sent' : 'edited',
    original_response: draft.draft_response,
    final_response: finalResponse,
    edit_distance: editDist,
    feedback_notes: notes,
    advisor_status: draft.advisor_status,
    confidence: draft.confidence,
    message_type: draft.message_type,
    turn_number: draft.turn_number,
  });

  // Post-send action: snooze (default) or close
  const afterAction = body.after || 'snooze';
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

  return { success: true, edit_distance: editDist, gorgias_message_id: replyResult?.id, resolved: isResolved };
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

async function apiTriggerPoll() {
  const { run } = require('../poller/pollGorgiasDrafts');
  return run();
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
  { method: 'GET', pattern: /^\/api\/drafts\/(\d+)$/, handler: (_, id) => apiGetDraft(parseInt(id)) },
  { method: 'POST', pattern: /^\/api\/drafts\/(\d+)\/send$/, handler: (body, id) => apiSendDraft(parseInt(id), body) },
  { method: 'POST', pattern: /^\/api\/drafts\/(\d+)\/execute$/, handler: (body, id) => apiExecuteAction(parseInt(id)) },
  { method: 'POST', pattern: /^\/api\/drafts\/(\d+)\/release$/, handler: (body, id) => apiReleaseDraft(parseInt(id), body) },
];

async function handleRequest(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

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
          const result = await route.handler(body, match[1]);
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
