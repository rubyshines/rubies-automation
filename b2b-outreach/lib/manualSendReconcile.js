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
const { NON_REPLY_INBOUND_TYPES } = require('./replyCorrelation');

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

/** Does this message carry a calendar part? The protocol-level tell. */
function hasCalendarPart(payload) {
  if (!payload) return false;
  if (/^text\/calendar\b/i.test(payload.mimeType || '')) return true;
  return (payload.parts || []).some(hasCalendarPart);
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
  const { detectAutoReply, detectCalendarNotice } = require('./replyCorrelation');
  const rows = [];
  for (const m of gmailMessages || []) {
    const labels = m.labelIds || [];
    if (labels.includes('DRAFT')) continue;           // the historical poison — never ingest
    if (knownIds.has(m.id)) continue;
    // Another correspondent's message that Gmail merged in on a shared subject.
    if (!messageInvolves(m, companyEmails)) continue;
    const outbound = labels.includes('SENT');
    const subject = header(m, 'Subject');
    const body = extractPlainText(m.payload) || m.snippet || null;
    // Auto-responders: protocol headers first (Auto-Submitted / X-Autoreply /
    // Precedence), content fallback second. Labeled, kept in history, never
    // a Tier-1 signal.
    const autoSubmitted = (header(m, 'Auto-Submitted') || '').toLowerCase();
    const isAuto = !outbound && (
      (autoSubmitted && autoSubmitted !== 'no')
      || !!header(m, 'X-Autoreply') || !!header(m, 'X-Autorespond')
      || /^auto[_-]?repl/i.test(header(m, 'Precedence') || '')
      || detectAutoReply({ subject, body })
    );
    // Calendar notifications, same treatment for the same reason: they come
    // from the contact's own address and read as a reply to everything above.
    // Here (unlike the Pub/Sub path) the MIME structure is available, so the
    // subject only has to agree with a text/calendar part rather than carry the
    // decision alone.
    const isCalendar = !outbound && (
      (hasCalendarPart(m.payload) && /^\s*(accepted|declined|tentative|invitation|updated invitation|new event|updated event|cancell?ed event|canceled event):\s+\S/i.test(subject || ''))
      || detectCalendarNotice({ subject, body })
    );
    rows.push({
      direction: outbound ? 'outbound' : 'inbound',
      message_type: isCalendar ? 'calendar_notice' : isAuto ? 'auto_reply' : null,
      gmail_message_id: m.id,
      gmail_thread_id: m.threadId,
      from_email: addressesIn(header(m, 'From'))[0] || null,
      to_email: addressesIn(header(m, 'To')).join(', ') || null,
      cc_email: addressesIn(header(m, 'Cc')).join(', ') || null,
      body_text: body,
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
 *
 * An auto-responder or a calendar notification is not a person waiting, so it
 * closes the thread on the same reasoning as an outbound. Without this an
 * imported thread whose newest message is an RSVP opens, which is the whole
 * defect one layer up.
 */
function discoveredThreadStatus(lastMsg, now = new Date(), staleDays = 30) {
  if (!lastMsg) return 'closed';
  if (lastMsg.direction === 'outbound') return 'closed';
  if (NON_REPLY_INBOUND_TYPES.has(lastMsg.message_type)) return 'closed';
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
    // Marked, not bare. A bare `{ discovered: 0 }` is indistinguishable from
    // "looked, found nothing" — the same self-certifying silence the `failed`
    // counter below exists to prevent. It matters more now than it did: the
    // auto-send reply guard treats this call as evidence that nobody has
    // written back, and evidence that could not be gathered must never read as
    // evidence of absence.
    return { discovered: 0, error: 'list_failed' };
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
  let failed = 0;
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
      // Insert, then recover from a lost race — NOT an upsert. The uniqueness we
      // want is (company_id, gmail_thread_id), but that index is partial
      // (`WHERE gmail_thread_id IS NOT NULL`, so a thread can sit uncorrelated
      // with a NULL id), and ON CONFLICT cannot infer a partial index: it fails
      // with "no unique or exclusion constraint matching the ON CONFLICT
      // specification" for every row. Same shape as replyCorrelation's create.
      const { data: thread, error: tErr } = await sb.from('b2b_threads')
        .insert({
          company_id: companyId, thread_type: 'other', subject,
          gmail_thread_id: t.id, status: discoveredThreadStatus(last),
          last_message_at: last.sent_at,
        })
        .select('id').single();
      if (tErr) {
        // A concurrent discovery got there first: adopt its row rather than
        // dropping this company's messages on the floor. Scoped to THIS company —
        // another org legitimately holds its own row for the same Gmail thread.
        const { data: again } = await sb.from('b2b_threads')
          .select('id').eq('company_id', companyId).eq('gmail_thread_id', t.id).maybeSingle();
        if (!again) {
          console.error(`[discover] thread insert ${t.id}: ${tErr.message}`);
          failed++;
          continue;
        }
        threadId = again.id;
      } else {
        threadId = thread.id;
      }
    }

    const { error: mErr } = await sb.from('b2b_messages')
      .upsert(rows.map(r => ({ ...r, thread_id: threadId, company_id: companyId })),
        { onConflict: 'gmail_message_id', ignoreDuplicates: true });
    if (mErr) { console.error(`[discover] messages ${t.id}: ${mErr.message}`); failed++; continue; }
    if (existingThread) repaired++; else discovered++;
  }
  // `failed` is not cosmetic: the nightly sweep stamps a company as searched,
  // and a run whose writes all failed would otherwise mark itself done and not
  // be retried for a month. Silent failure that records itself as success is
  // exactly how this subsystem has gone wrong before.
  return { discovered, repaired, failed };
}

// ---------------------------------------------------------------------------
// Nightly discovery sweep — companies the engine has never looked for
// ---------------------------------------------------------------------------

/**
 * Decide which companies the sweep should search, and in what order. PURE.
 *
 * `discoverCompanyThreads` only ever ran from the per-company detail pane, so a
 * company nobody had clicked held zero b2b_messages and the cadence reasoned from
 * an empty record. That is not a missing-data problem, it is a WRONG-ANSWER
 * problem: `lastOutboundAt IS NULL` reads as "never contacted", so an org that
 * wrote to us last month can sit at Tier 3 "no prior outbound" instead of Tier 1
 * "waiting on us". Trans Closet of the Hudson Valley did exactly that, and a
 * hand-run discovery flipped it to Tier 1 with 12 messages going back a year.
 *
 * Ordering matters more than it looks. Most empty companies are `prospect` —
 * never approached, so there is genuinely nothing in Gmail to find. The ones that
 * carry evidence of a relationship but no messages are the ones producing wrong
 * tiers today, so they go first and a truncating limit can only ever defer the
 * quiet cases.
 *
 * @returns {object[]} companies to search, most consequential first
 */
function selectCompaniesForDiscovery({ companies, companiesWithMessages, emailsByCompany, staleBefore }) {
  const withMessages = new Set(companiesWithMessages);
  // 'prospect' means never approached, so an empty record is expected rather than
  // suspicious. Everything else claims a relationship the messages do not show.
  const rank = (c) => (c.relationship_state && c.relationship_state !== 'prospect' ? 0 : 1);

  return companies
    .filter(c => !withMessages.has(c.id))
    .filter(c => (emailsByCompany[c.id] || []).length > 0)
    .filter(c => !c.threads_discovered_at || new Date(c.threads_discovered_at) < staleBefore)
    .sort((a, b) => rank(a) - rank(b)
      || String(a.threads_discovered_at || '').localeCompare(String(b.threads_discovered_at || ''))
      || a.id.localeCompare(b.id));
}

const DISCOVERY_RETRY_DAYS = 30;
// Higher than the per-pane default: this is a company's FIRST look, so the cap is
// the whole relationship rather than a top-up on an already-imported thread list.
const SWEEP_MAX_THREADS = 20;

/**
 * Search Gmail for history on companies that have none on file.
 *
 * Runs nightly, before the relationship-summary sweep, so anything imported here
 * gets summarized the same night. Bounded per run and stamped per company, so the
 * companies that genuinely have nothing are not re-searched every night forever.
 */
async function sweepEmptyCompanies(sb, { limit = 60, now = new Date(), retryDays = DISCOVERY_RETRY_DAYS } = {}) {
  const companies = await fetchAllPaginated(() => sb.from('b2b_companies')
    .select('id, relationship_state, general_email, threads_discovered_at'));
  const messages = await fetchAllPaginated(() => sb.from('b2b_messages').select('company_id'));
  const contacts = await fetchAllPaginated(() => sb.from('b2b_contacts')
    .select('company_id, email').eq('is_active', true));

  const emailsByCompany = {};
  for (const c of contacts) {
    if (c.email) (emailsByCompany[c.company_id] ||= []).push(c.email.toLowerCase());
  }
  for (const c of companies) {
    if (c.general_email) (emailsByCompany[c.id] ||= []).push(c.general_email.toLowerCase());
  }

  const staleBefore = new Date(now.getTime() - retryDays * 864e5);
  const candidates = selectCompaniesForDiscovery({
    companies, companiesWithMessages: messages.map(m => m.company_id), emailsByCompany, staleBefore,
  });

  const results = { candidates: candidates.length, searched: 0, withHistory: 0, threadsImported: 0, failed: 0 };
  for (const c of candidates.slice(0, limit)) {
    try {
      const r = await discoverCompanyThreads(sb, {
        companyId: c.id, emails: [...new Set(emailsByCompany[c.id])],
        maxThreads: SWEEP_MAX_THREADS, force: true,
      });
      results.searched += 1;
      if (r.discovered) { results.withHistory += 1; results.threadsImported += r.discovered; }
      // Stamped only when the search actually completed. "We looked and there was
      // nothing" is what stops us looking again tomorrow — but a run whose writes
      // all failed would record itself as that same result and go unretried for a
      // month. Leave the stamp off and let the next sweep pick it up.
      if (!r.failed) {
        await sb.from('b2b_companies')
          .update({ threads_discovered_at: now.toISOString() }).eq('id', c.id);
      } else {
        results.failed += 1;
      }
    } catch (err) {
      results.failed += 1;
      console.error(`[discoverySweep] ${c.id}: ${err.message}`);
    }
  }

  if (candidates.length > limit) {
    results.deferred = candidates.length - limit;
    console.log(`[discoverySweep] ${results.deferred} companies deferred to the next run (limit ${limit})`);
  }
  return results;
}

/** daily-sync-all entry point. */
async function runDiscoverySweep() {
  const { getSupabaseClient } = require('../../shared/supabaseClient');
  const r = await sweepEmptyCompanies(getSupabaseClient(), {});
  console.log(`Thread Discovery — searched ${r.searched} of ${r.candidates} empty companies, `
    + `${r.withHistory} had history (${r.threadsImported} threads imported)`
    + `${r.deferred ? `, ${r.deferred} deferred` : ''}${r.failed ? `, ${r.failed} failed` : ''}`);
  return {
    sources: {
      b2b_thread_discovery: {
        success: r.failed === 0, rowsWritten: r.threadsImported,
        error: r.failed ? `${r.failed} companies failed` : null,
      },
    },
    status: r.failed ? 'error' : 'success',
  };
}

module.exports = {
  reconcileThreads, discoverCompanyThreads, discoveredThreadStatus, partitionThreadMessages,
  messageInvolves, addressesIn, extractPlainText,
  selectCompaniesForDiscovery, sweepEmptyCompanies, runDiscoverySweep,
  DISCOVERY_RETRY_DAYS, SWEEP_MAX_THREADS,
};
