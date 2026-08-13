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
/** Every email address in a header value (To/Cc can hold several). Pure. */
function addressesIn(headerValue) {
  return (String(headerValue || '').match(/[\w.+-]+@[\w.-]+\.\w+/g) || []).map(a => a.toLowerCase());
}

/**
 * Is this company actually a party to this message?
 *
 * Gmail threads on subject, so two unrelated conversations that happen to share
 * one merge into a single thread. Jamie sent "agreement and next steps" to both
 * Trans Closet of the Hudson Valley and Transformation Closet (Nova Scotia), and
 * Gmail filed them together — importing the thread wholesale put nine of another
 * org's messages onto Trans Closet's record, which the advisor then drafted from.
 *
 * So membership is decided per MESSAGE, not per thread. With no known addresses
 * we keep everything rather than silently dropping history. Pure.
 */
function messageInvolves(m, companyEmails) {
  if (!companyEmails || !companyEmails.size) return true;
  const parties = ['From', 'To', 'Cc', 'Bcc', 'Reply-To', 'Delivered-To']
    .flatMap(h => addressesIn(header(m, h)));
  return parties.some(a => companyEmails.has(a));
}

function partitionThreadMessages(gmailMessages, knownIds, companyEmails = null) {
  const { detectAutoReply } = require('./replyCorrelation');
  const rows = [];
  for (const m of gmailMessages || []) {
    const labels = m.labelIds || [];
    if (labels.includes('DRAFT')) continue;           // the historical poison — never ingest
    if (knownIds.has(m.id)) continue;
    // Another correspondent's message that Gmail merged in on a shared subject.
    if (!messageInvolves(m, companyEmails)) continue;
    const outbound = labels.includes('SENT');
    // Auto-responders: protocol headers first (Auto-Submitted / X-Autoreply /
    // Precedence), content fallback second. Labeled, kept in history, never
    // a Tier-1 signal.
    const autoSubmitted = (header(m, 'Auto-Submitted') || '').toLowerCase();
    const isAuto = !outbound && (
      (autoSubmitted && autoSubmitted !== 'no')
      || !!header(m, 'X-Autoreply') || !!header(m, 'X-Autorespond')
      || /^auto[_-]?repl/i.test(header(m, 'Precedence') || '')
      || detectAutoReply({ subject: header(m, 'Subject'), body: extractPlainText(m.payload) || m.snippet })
    );
    rows.push({
      direction: outbound ? 'outbound' : 'inbound',
      message_type: isAuto ? 'auto_reply' : null,
      gmail_message_id: m.id,
      gmail_thread_id: m.threadId,
      from_email: addressesIn(header(m, 'From'))[0] || null,
      to_email: addressesIn(header(m, 'To')).join(', ') || null,
      body_text: extractPlainText(m.payload) || m.snippet || null,
      sent_at: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : null,
      source: outbound ? 'manual_send' : 'gmail_backfill',
    });
  }
  return rows;
}

/**
 * Reconcile Gmail-correlated threads for a set of companies (or all).
 * Fail-soft by design: any Gmail/API error logs and moves on — the queue must
 * render even when Gmail is unreachable.
 *
 * `includeClosed` decides which half of the job this call is doing:
 *   false (default) — the queue-wide sweep. Only open threads matter there:
 *     a concluded conversation cannot change what is due, and re-fetching every
 *     closed thread on every queue load would be a Gmail call per thread.
 *   true — a targeted, one-company sync behind the panel's detail view. There
 *     the goal is a COMPLETE conversation, and status says nothing about
 *     completeness. Closed threads were silently unrepairable before this:
 *     a thread created from an inbound email is closed by
 *     discoveredThreadStatus as soon as it goes stale, and from then on the
 *     operator's own replies could never be imported into it.
 */
async function reconcileThreads(sb, { companyIds = null, force = false, includeClosed = false } = {}) {
  let q = sb.from('b2b_threads')
    .select('id, company_id, gmail_thread_id, last_message_at')
    .not('gmail_thread_id', 'is', null);
  if (!includeClosed) q = q.eq('status', 'open');
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

  // Every address we know for each company, so a message that Gmail merged in
  // from an unrelated correspondent can be recognised and skipped.
  const dueCompanyIds = [...new Set(due.map(t => t.company_id).filter(Boolean))];
  const emailsByCompany = new Map(dueCompanyIds.map(id => [id, new Set()]));
  if (dueCompanyIds.length) {
    const contactRows = await fetchAllPaginated(() => sb.from('b2b_contacts')
      .select('company_id, email').in('company_id', dueCompanyIds));
    for (const c of contactRows) {
      if (c.email) emailsByCompany.get(c.company_id)?.add(c.email.toLowerCase());
    }
    const { data: companyRows } = await sb.from('b2b_companies')
      .select('id, general_email').in('id', dueCompanyIds);
    for (const c of companyRows || []) {
      if (c.general_email) emailsByCompany.get(c.id)?.add(c.general_email.toLowerCase());
    }
  }

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
    const rows = partitionThreadMessages(resp.data?.messages, knownIds, emailsByCompany.get(t.company_id))
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

const discoveryCooldown = new Map(); // company_id -> epoch ms

/**
 * Decide a discovered thread's initial status. Pure.
 * History import must never resurrect ancient "waiting on us" rows: a thread
 * whose last message is outbound, or is older than `staleDays`, imports as
 * 'closed' (visible in history, invisible to Tier 1). Only a recent inbound
 * with no reply imports 'open' — that one genuinely IS waiting on us.
 */
function discoveredThreadStatus(lastMsg, now = new Date(), staleDays = 30) {
  if (!lastMsg) return 'closed';
  if (lastMsg.direction === 'outbound') return 'closed';
  const age = now - new Date(lastMsg.sent_at);
  return age > staleDays * 86400000 ? 'closed' : 'open';
}

/**
 * Find Gmail threads with a company's contacts that the engine has never seen
 * (relationships that predate the outreach build), create b2b_threads rows
 * for them, and import their messages. Caps at `maxThreads` most recent.
 * Fail-soft; per-company 15-min cooldown.
 */
async function discoverCompanyThreads(sb, { companyId, emails, maxThreads = 10, force = false } = {}) {
  if (!companyId || !emails?.length) return { discovered: 0 };
  const now = Date.now();
  if (!force && now - (discoveryCooldown.get(companyId) || 0) < COOLDOWN_MS) return { discovered: 0 };
  discoveryCooldown.set(companyId, now);

  const { getGmail } = require('../../gmail-management/lib/gmailClient');
  let gmail;
  try { gmail = await getGmail(); } catch (err) {
    console.error(`[discover] Gmail unavailable: ${err.message}`);
    return { discovered: 0, error: 'gmail_unavailable' };
  }

  // Gmail's search is thread-level and subject-driven, so a thread can come
  // back on a shared subject alone; the per-message filter below is what keeps
  // another org's replies off this company's record.
  const companyEmailSet = new Set(emails.map(e => String(e).toLowerCase()));
  const q = '{' + emails.map(e => `from:${e} to:${e}`).join(' ') + '}';
  let listing;
  try {
    listing = await gmail.users.threads.list({ userId: 'me', q, maxResults: maxThreads });
  } catch (err) {
    console.error(`[discover] ${companyId} thread list failed: ${err.message}`);
    return { discovered: 0 };
  }
  const found = listing.data?.threads || [];
  if (!found.length) return { discovered: 0 };

  // Scoped to THIS company. Unscoped, a Gmail thread shared with another org
  // resolved to their row, and every message this pass imported was written
  // against their relationship instead of a new row for ours.
  const { data: existing, error } = await sb.from('b2b_threads')
    .select('id, gmail_thread_id, status')
    .eq('company_id', companyId).in('gmail_thread_id', found.map(t => t.id));
  if (error) throw new Error(`existing threads: ${error.message}`);
  const known = new Map((existing || []).map(t => [t.gmail_thread_id, t]));

  let discovered = 0;
  let repaired = 0;
  for (const t of found) {
    // A known thread is NOT necessarily a complete one. Threads created by an
    // inbound pubsub event hold only the messages pubsub delivered — skipping
    // them here is what left the operator's own replies missing from the panel
    // for months. Re-read them and let the gmail_message_id upsert dedupe.
    const existingThread = known.get(t.id);
    let resp;
    try {
      resp = await gmail.users.threads.get({ userId: 'me', id: t.id, format: 'full' });
    } catch (err) {
      console.error(`[discover] thread ${t.id} fetch failed: ${err.message}`);
      continue;
    }
    const rows = partitionThreadMessages(resp.data?.messages, new Set(), companyEmailSet);
    if (!rows.length) continue;
    const last = rows[rows.length - 1];
    const subject = header(resp.data.messages?.[0] || {}, 'Subject') || '(no subject)';

    let threadId;
    if (existingThread) {
      // Repair only. Never re-derive status here: the operator may have just
      // closed or reopened this thread by hand, and discoveredThreadStatus
      // would silently overrule that.
      threadId = existingThread.id;
      if (last.sent_at) await sb.from('b2b_threads').update({ last_message_at: last.sent_at }).eq('id', threadId);
    } else {
      const { data: thread, error: tErr } = await sb.from('b2b_threads')
        .upsert({
          company_id: companyId, thread_type: 'other', subject,
          gmail_thread_id: t.id, status: discoveredThreadStatus(last),
          last_message_at: last.sent_at,
        // (company_id, gmail_thread_id), not gmail_thread_id alone. On the old
        // key, a company discovering a Gmail thread another org already had a row
        // for did not create its own — the upsert UPDATED theirs, rewriting
        // company_id and handing that org's entire conversation to this one.
        }, { onConflict: 'company_id,gmail_thread_id' })
        .select('id').single();
      if (tErr) { console.error(`[discover] thread insert ${t.id}: ${tErr.message}`); continue; }
      threadId = thread.id;
    }

    const { error: mErr } = await sb.from('b2b_messages')
      .upsert(rows.map(r => ({ ...r, thread_id: threadId, company_id: companyId })),
        { onConflict: 'gmail_message_id', ignoreDuplicates: true });
    if (mErr) { console.error(`[discover] messages ${t.id}: ${mErr.message}`); continue; }
    if (existingThread) repaired++; else discovered++;
  }
  return { discovered, repaired };
}

module.exports = { reconcileThreads, discoverCompanyThreads, discoveredThreadStatus, partitionThreadMessages, messageInvolves, addressesIn, extractPlainText };
