/**
 * manualSendReconcile.js — make b2b_messages match what actually happened in
 * Gmail, so the queue and the history pane never lie.
 *
 * The engine's send tool is the only writer of *engine* outbound rows, but
 * Jamie also replies to B2B threads directly from Gmail (phone, flow, habit).
 * Those manual sends are invisible to the engine, which left threads stuck in
 * Tier 1 ("waiting on us") after they'd been answered. This module reads each
 * correlated Gmail thread and backfills any missing messages:
 *
 *   - SENT-labeled messages missing from b2b_messages → outbound rows with
 *     source='manual_send' (the placeholder rows Design #6 specified).
 *   - Other missing messages → inbound rows with source='gmail_backfill'
 *     (completes history for threads that predate reply correlation).
 *
 * Safety vs. the "never sync from the Sent folder" rule (Design #6): that rule
 * exists because Gmail auto-save DRAFT checkpoints masqueraded as sends and
 * poisoned reply-rate/A-B metrics. This module is safe on both counts:
 *   1. Messages carrying the DRAFT label are skipped entirely.
 *   2. Backfilled rows have message_type=null and source != 'send_tool', so
 *      metrics keyed on (message_type, variant_id, source='send_tool') never
 *      count them.
 *
 * Idempotent: upsert on the gmail_message_id unique key, ignoreDuplicates.
 * Cooldown: per-thread in-memory (default 15 min) so queue loads stay cheap.
 */
const { fetchAllPaginated } = require('../../shared/supabaseClient');

const COOLDOWN_MS = 15 * 60 * 1000;
const lastReconciled = new Map(); // gmail_thread_id -> epoch ms

/** Decode a Gmail base64url body chunk to utf8 text. Pure. */
function decodeBody(data) {
  if (!data) return null;
  try { return Buffer.from(data, 'base64url').toString('utf8'); } catch { return null; }
}

/** Walk a Gmail payload for the first text/plain part. Pure. */
function extractPlainText(payload) {
  if (!payload) return null;
  if (payload.mimeType === 'text/plain' && payload.body?.data) return decodeBody(payload.body.data);
  for (const part of payload.parts || []) {
    const found = extractPlainText(part);
    if (found) return found;
  }
  return null;
}

function header(msg, name) {
  const h = (msg.payload?.headers || []).find(x => x.name?.toLowerCase() === name.toLowerCase());
  return h?.value || null;
}

/**
 * Decide which Gmail messages are missing from b2b_messages and how to insert
 * them. Pure — the testable heart of the reconciler.
 *
 * @param gmailMessages messages from gmail.users.threads.get (format 'full')
 * @param knownIds      Set of gmail_message_id already in b2b_messages
 * @returns rows ready for upsert (minus thread_id/company_id, added by caller)
 */
function partitionThreadMessages(gmailMessages, knownIds) {
  const rows = [];
  for (const m of gmailMessages || []) {
    const labels = m.labelIds || [];
    if (labels.includes('DRAFT')) continue;           // the historical poison — never ingest
    if (knownIds.has(m.id)) continue;
    const outbound = labels.includes('SENT');
    rows.push({
      direction: outbound ? 'outbound' : 'inbound',
      message_type: null,
      gmail_message_id: m.id,
      gmail_thread_id: m.threadId,
      from_email: (header(m, 'From') || '').replace(/^.*<([^>]+)>.*$/, '$1') || null,
      to_email: (header(m, 'To') || '').replace(/^.*<([^>]+)>.*$/, '$1') || null,
      body_text: extractPlainText(m.payload) || m.snippet || null,
      sent_at: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : null,
      source: outbound ? 'manual_send' : 'gmail_backfill',
    });
  }
  return rows;
}

/**
 * Reconcile open, Gmail-correlated threads for a set of companies (or all).
 * Fail-soft by design: any Gmail/API error logs and moves on — the queue must
 * render even when Gmail is unreachable.
 */
async function reconcileThreads(sb, { companyIds = null, force = false } = {}) {
  let q = sb.from('b2b_threads')
    .select('id, company_id, gmail_thread_id, last_message_at')
    .eq('status', 'open')
    .not('gmail_thread_id', 'is', null);
  if (companyIds?.length) q = q.in('company_id', companyIds);
  const { data: threads, error } = await q;
  if (error) throw new Error(`thread fetch: ${error.message}`);

  const now = Date.now();
  const due = (threads || []).filter(t =>
    force || now - (lastReconciled.get(t.gmail_thread_id) || 0) > COOLDOWN_MS);
  if (!due.length) return { checked: 0, inserted: 0 };

  const { getGmail } = require('../../gmail-management/lib/gmailClient');
  let gmail;
  try { gmail = await getGmail(); } catch (err) {
    console.error(`[reconcile] Gmail unavailable: ${err.message}`);
    return { checked: 0, inserted: 0, error: 'gmail_unavailable' };
  }

  const knownRows = await fetchAllPaginated(() =>
    sb.from('b2b_messages').select('gmail_message_id, thread_id')
      .in('thread_id', due.map(t => t.id)));
  const knownIds = new Set(knownRows.map(r => r.gmail_message_id).filter(Boolean));

  let inserted = 0;
  for (const t of due) {
    lastReconciled.set(t.gmail_thread_id, now);
    let resp;
    try {
      resp = await gmail.users.threads.get({ userId: 'me', id: t.gmail_thread_id, format: 'full' });
    } catch (err) {
      console.error(`[reconcile] thread ${t.gmail_thread_id} fetch failed: ${err.message}`);
      continue;
    }
    const rows = partitionThreadMessages(resp.data?.messages, knownIds)
      .map(r => ({ ...r, thread_id: t.id, company_id: t.company_id }));
    if (!rows.length) continue;

    const { error: insErr } = await sb.from('b2b_messages')
      .upsert(rows, { onConflict: 'gmail_message_id', ignoreDuplicates: true });
    if (insErr) {
      console.error(`[reconcile] insert failed for thread ${t.id}: ${insErr.message}`);
      continue;
    }
    inserted += rows.length;

    const latest = rows.map(r => r.sent_at).filter(Boolean).sort().pop();
    if (latest && (!t.last_message_at || latest > t.last_message_at)) {
      await sb.from('b2b_threads').update({ last_message_at: latest }).eq('id', t.id);
    }
    const latestOut = rows.filter(r => r.direction === 'outbound')
      .map(r => r.sent_at).filter(Boolean).sort().pop();
    if (latestOut) {
      const { data: c } = await sb.from('b2b_companies')
        .select('last_outbound_at').eq('id', t.company_id).maybeSingle();
      if (!c?.last_outbound_at || latestOut > c.last_outbound_at) {
        await sb.from('b2b_companies').update({ last_outbound_at: latestOut }).eq('id', t.company_id);
      }
    }
  }
  return { checked: due.length, inserted };
}

module.exports = { reconcileThreads, partitionThreadMessages, extractPlainText };
