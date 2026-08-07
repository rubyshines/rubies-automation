/**
 * queueService.js — shared operations behind the two outreach surfaces
 * (the MCP console tools and the dashboard Outreach panel). Both surfaces
 * are thin wrappers over these functions so they can never drift apart.
 *
 * The panel asks three different questions, and each has a function here:
 *   "what needs action?"    → fetchQueueWithDrafts   (the 6-tier queue)
 *   "what just happened?"   → fetchActivity          (message-level feed)
 *   "where's that company?" → searchCompanies        (searchable directory)
 *
 *   fetchOutreachQueue       — companies → contexts → assembleQueue
 *   attachDrafts             — pure: join pending-draft id/snippet onto entries
 *   fetchQueueWithDrafts     — the dashboard queue payload
 *   searchCompanies          — directory search across name/email/subject
 *   fetchActivity            — reverse-chronological message feed
 *   setThreadStatus          — open ↔ closed
 *   reopenThread             — reopen a concluded thread + draft the follow-up
 *   generateDraftForCompany  — queue-entry resolution + generateDraft
 *   sendDraftById            — load a pending draft → sendB2bEmail (two-phase,
 *                              gate pass-through); marks the draft sent
 */
const { assembleQueue } = require('./queue');
const { buildContexts } = require('./queueContext');
const { reconcileThreads, discoverCompanyThreads } = require('./manualSendReconcile');
const { generateDraft } = require('./outreachAdvisor');
const { sendB2bEmail, resolveRecipient, resolveDelivery, SEND_FLAG } = require('./sendB2bEmail');
const { isFlagEnabled } = require('../../shared/systemFlags');

/** One-line preview of a draft body for queue rows. Pure. */
function draftSnippet(body, max = 140) {
  const flat = (body || '').replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return flat.slice(0, max - 1).trimEnd() + '…';
}

/**
 * Join pending drafts onto queue entries. Pure.
 * @param queue  assembleQueue output
 * @param drafts b2b_drafts rows ({ id, company_id, subject, body, generated_at })
 * @returns entries with `draft: { id, subject, snippet, generated_at } | null`
 */
function attachDrafts(queue, drafts) {
  const byCompany = new Map((drafts || []).map(d => [d.company_id, d]));
  return (queue || []).map(e => {
    const d = byCompany.get(e.company_id);
    return {
      ...e,
      draft: d ? { id: d.id, subject: d.subject, snippet: draftSnippet(d.body), generated_at: d.generated_at } : null,
    };
  });
}

async function fetchCompanies(sb, { channel } = {}) {
  let q = sb.from('b2b_companies').select('*');
  if (channel) q = q.eq('relationship_type', channel);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data || [];
}

/** Today's queue: fetch companies (optionally one channel), build contexts, assemble. */
async function fetchOutreachQueue(sb, { channel } = {}) {
  const companies = await fetchCompanies(sb, { channel });
  const contexts = await buildContexts(sb, companies);
  return assembleQueue(companies.map(c => ({ company: c, ctx: contexts.get(c.id) })));
}

/**
 * Companies with a pending draft are excluded from assembleQueue (the sweep
 * must never double-draft — companyEligible returns false). The dashboard
 * queue must still SHOW them: the pending draft is exactly what the operator
 * needs to review. Synthesize their entries from the draft's stored queue
 * fields (queue_tier/queue_reason captured at generation time) and merge in
 * tier order. Pure.
 */
function mergePendingDraftEntries(queue, drafts, companiesById) {
  const inQueue = new Set((queue || []).map(e => e.company_id));
  const synthetic = [];
  for (const d of drafts || []) {
    if (inQueue.has(d.company_id)) continue;
    const c = companiesById.get(d.company_id);
    if (!c) continue;
    synthetic.push({
      company_id: d.company_id,
      company_name: c.name,
      channel: c.relationship_type,
      tier: d.queue_tier || 3,
      message_type: d.message_type,
      reason: d.queue_reason || 'pending draft awaiting review',
    });
  }
  return [...(queue || []), ...synthetic].sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    if (a.tier === 1 && a.waiting_since && b.waiting_since) return new Date(a.waiting_since) - new Date(b.waiting_since);
    return 0;
  });
}

/**
 * Queue + pending-draft id/snippet per company — the dashboard payload.
 * Returns { entries, gmail_sync }: the queue renders at DB speed while the
 * manual-send reconcile (Gmail) runs in the background; when it was kicked
 * off, the client re-fetches once shortly after so any manual replies that
 * just landed clear their rows.
 */
let queueReconcileInFlight = false;
/**
 * Kick the manual-send reconcile in the background, at most one at a time.
 * Returns 'started' when this call launched it, 'recent' when one was already
 * running. Shared by the queue and the activity feed: BOTH surfaces claim to
 * show current reality, and most outbound mail is sent by hand from Gmail
 * (source='manual_send'), so a surface that doesn't kick this silently
 * under-reports the operator's own recent sends.
 */
function startReconcile(sb, companyIds) {
  if (queueReconcileInFlight) return 'recent';
  queueReconcileInFlight = true;
  reconcileThreads(sb, { companyIds })
    .catch(err => console.error(`[queueService] reconcile failed: ${err.message}`))
    .finally(() => { queueReconcileInFlight = false; });
  return 'started';
}

async function fetchQueueWithDrafts(sb, { channel } = {}) {
  const companies = await fetchCompanies(sb, { channel });
  const gmailSync = startReconcile(sb, companies.map(c => c.id));
  const contexts = await buildContexts(sb, companies);
  const queue = assembleQueue(companies.map(c => ({ company: c, ctx: contexts.get(c.id) })));

  let drafts = [];
  if (companies.length) {
    const { data, error } = await sb.from('b2b_drafts')
      .select('id, company_id, subject, body, generated_at, message_type, queue_tier, queue_reason')
      .eq('status', 'pending').in('company_id', companies.map(c => c.id));
    if (error) throw new Error(error.message);
    drafts = data || [];
  }
  const merged = mergePendingDraftEntries(queue, drafts, new Map(companies.map(c => [c.id, c])));
  return { entries: attachDrafts(merged, drafts), gmail_sync: gmailSync };
}

// ── Directory search ───────────────────────────────────────────────────────
// The queue only ever surfaces what is DUE. Everything else — the company you
// spoke to in March, the prospect you never wrote to — was unreachable from the
// panel. These functions are the browse half.

/**
 * Strip characters that would break a PostgREST `.or()` filter string. Pure.
 * Commas separate conditions and parens group them, so a raw search term
 * containing either corrupts the query rather than failing loudly. `*` is
 * PostgREST's ilike wildcard and `\`/`"` escape its values. None of these carry
 * meaning in a company name or an email address, so dropping them is lossless
 * in practice and keeps the filter injection-free.
 */
function sanitizeSearchTerm(q) {
  return String(q || '').replace(/[,()"\\*%]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Per-company thread rollup: counts + latest activity. Pure. */
function rollupThreads(threads) {
  const by = new Map();
  for (const t of threads || []) {
    const r = by.get(t.company_id) || { open: 0, closed: 0, last_message_at: null };
    if (t.status === 'closed') r.closed++; else r.open++;
    if (t.last_message_at && (!r.last_message_at || t.last_message_at > r.last_message_at)) {
      r.last_message_at = t.last_message_at;
    }
    by.set(t.company_id, r);
  }
  return by;
}

/**
 * The company's conversation state, which is what the directory filters on.
 * Pure. 'never' = no thread on record (a prospect we have not written to),
 * 'open' = at least one live thread, 'inactive' = every thread concluded.
 */
function companyThreadStatus(rollup) {
  if (!rollup || (!rollup.open && !rollup.closed)) return 'never';
  return rollup.open > 0 ? 'open' : 'inactive';
}

/**
 * Where a company sits in the relationship flow. Pure — and deliberately
 * INDEPENDENT of conversation state, which is its own filter.
 *
 * Folding the two together was a mistake worth recording: an active retailer
 * with thirteen concluded threads is both "an account" and "gone quiet", and
 * collapsing them into one chip hid it under `active` — exactly the company the
 * closed-thread view exists to surface. Kept separate, the two compose, and
 * "active accounts whose conversations have all ended" is one click.
 *
 * 'lead' covers in_contact and null. relationship_state cannot distinguish a
 * real lead from an untouched import — 180 companies carry 'in_contact' and 172
 * have never had a conversation — so as a RELATIONSHIP stage "lead" is the
 * honest label, and the conversation filter says whether anyone has written.
 *
 * Nothing ever writes 'dormant' (syncB2bCompanyState says so explicitly), so
 * there is no dormant stage — it would always be empty.
 */
function companyStage(company) {
  if (company.relationship_state === 'lost') return 'lost';
  if (company.relationship_state === 'active') return 'active';
  return 'lead';
}

const DIRECTORY_STAGES = ['all', 'active', 'lead', 'lost'];
const DIRECTORY_STATUSES = ['all', 'open', 'inactive', 'never'];

/**
 * Why this company matched the search — shown on the row. Pure.
 * Searching an email address is useless if the result only echoes the company
 * name back: the operator needs to see WHICH contact carried that address.
 */
function matchReason(company, contacts, threads, q) {
  const needle = (q || '').toLowerCase();
  if (!needle) return null;
  const has = (v) => v && String(v).toLowerCase().includes(needle);
  if (has(company.name)) return null; // the name is already the row title
  const contact = (contacts || []).find(c => has(c.email) || has(c.full_name));
  if (contact) return `contact: ${contact.full_name ? `${contact.full_name} <${contact.email}>` : contact.email}`;
  if (has(company.general_email)) return `email: ${company.general_email}`;
  if (has(company.website)) return `site: ${String(company.website).replace(/^https?:\/\/(www\.)?/, '')}`;
  const thread = (threads || []).find(t => has(t.subject));
  if (thread) return `thread: ${thread.subject}`;
  if (has(company.id)) return `id: ${company.id}`;
  return null;
}

/**
 * Framing for a draft the operator asked for out of the blue (a company picked
 * from the directory with nothing due). Without it the advisor falls back to
 * "they are waiting on a reply from us" — false here, and it shows in the copy.
 */
const OPERATOR_INITIATED_HINT = 'Jamie has picked this company out deliberately — nothing is due on the cadence. Read the relationship history and write the message that actually makes sense to send them right now. They are NOT waiting on a reply from us, so do not write as though they are.';

/**
 * Searchable company directory — the panel's "where's that company?" surface.
 *
 * `q` matches company name / id / website / general email, contact email and
 * name, and thread subject. Matching spans three tables, which PostgREST
 * cannot express as one OR, so the id sets are gathered in parallel and merged.
 *
 * `stage` (relationship: active/lead/lost) and `status` (conversation:
 * open/inactive/never) are independent and compose.
 *
 * Sorted by last activity (newest first, never-contacted last), so with no
 * query it reads as a recency-ordered archive. The default is deliberately
 * 'all': this surface exists for LOOKUP, and defaulting to a stage would mean
 * searching a cold prospect returns nothing while the company sits right
 * there. For the same reason the caller is expected to drop back to 'all' when
 * a search term is typed.
 */
async function searchCompanies(sb, { q, stage = 'all', status = 'all', channel, limit = 50 } = {}) {
  const term = sanitizeSearchTerm(q);
  const like = `%${term}%`;

  let matchedIds = null; // null = no query, take everything
  if (term) {
    const [companyRes, contactRes, threadRes] = await Promise.all([
      sb.from('b2b_companies').select('id')
        .or(`name.ilike.${like},id.ilike.${like},website.ilike.${like},general_email.ilike.${like}`),
      sb.from('b2b_contacts').select('company_id').or(`email.ilike.${like},full_name.ilike.${like}`),
      sb.from('b2b_threads').select('company_id').ilike('subject', like),
    ]);
    if (companyRes.error) throw new Error(companyRes.error.message);
    matchedIds = new Set([
      ...(companyRes.data || []).map(r => r.id),
      ...(contactRes.error ? [] : (contactRes.data || []).map(r => r.company_id)),
      ...(threadRes.error ? [] : (threadRes.data || []).map(r => r.company_id)),
    ]);
    if (!matchedIds.size) return { companies: [], total: 0, query: term };
  }

  let cq = sb.from('b2b_companies')
    .select('id, name, relationship_type, relationship_state, website, general_email, city, region, country, order_count, total_sales, last_order_date, next_action_date, snoozed_until');
  if (channel) cq = cq.eq('relationship_type', channel);
  if (matchedIds) cq = cq.in('id', [...matchedIds]);
  const { data: companies, error } = await cq;
  if (error) throw new Error(error.message);
  if (!companies?.length) return { companies: [], total: 0, query: term };

  const ids = companies.map(c => c.id);
  const [threadsRes, contactsRes, draftsRes] = await Promise.all([
    sb.from('b2b_threads').select('id, company_id, status, subject, last_message_at').in('company_id', ids),
    sb.from('b2b_contacts').select('company_id, email, full_name, is_primary').in('company_id', ids).eq('is_active', true),
    sb.from('b2b_drafts').select('id, company_id').eq('status', 'pending').in('company_id', ids),
  ]);
  const threads = threadsRes.error ? [] : (threadsRes.data || []);
  const contacts = contactsRes.error ? [] : (contactsRes.data || []);
  const pending = new Set(draftsRes.error ? [] : (draftsRes.data || []).map(d => d.company_id));

  const rollups = rollupThreads(threads);
  const contactsBy = new Map();
  for (const c of contacts) contactsBy.set(c.company_id, [...(contactsBy.get(c.company_id) || []), c]);
  const threadsBy = new Map();
  for (const t of threads) threadsBy.set(t.company_id, [...(threadsBy.get(t.company_id) || []), t]);

  let rows = companies.map(c => {
    const rollup = rollups.get(c.id) || { open: 0, closed: 0, last_message_at: null };
    return {
      ...c,
      stage: companyStage(c),
      thread_status: companyThreadStatus(rollup),
      threads_open: rollup.open,
      threads_closed: rollup.closed,
      last_message_at: rollup.last_message_at,
      has_pending_draft: pending.has(c.id),
      contact_count: (contactsBy.get(c.id) || []).length,
      matched_on: matchReason(c, contactsBy.get(c.id), threadsBy.get(c.id), term),
    };
  });

  // Two independent axes, composed: stage = the relationship, status = the
  // conversation. "active + inactive" is the live account that has gone quiet.
  if (stage && stage !== 'all') rows = rows.filter(r => r.stage === stage);
  if (status && status !== 'all') rows = rows.filter(r => r.thread_status === status);

  rows.sort((a, b) => {
    if (!a.last_message_at && !b.last_message_at) return (a.name || '').localeCompare(b.name || '');
    if (!a.last_message_at) return 1;
    if (!b.last_message_at) return -1;
    return b.last_message_at.localeCompare(a.last_message_at);
  });

  return { companies: rows.slice(0, limit), total: rows.length, query: term };
}

// ── Activity feed ──────────────────────────────────────────────────────────

/**
 * Reverse-chronological message feed across every company — "what went out
 * recently?", which the company directory answers badly (one row per company
 * collapses a day's sends, and hides which way each message went).
 *
 * `before` is a sent_at cursor for paging. Kicks the same background reconcile
 * as the queue, and reports it, so the feed can say it is still catching up
 * rather than presenting a stale tail as complete.
 */
async function fetchActivity(sb, { direction, channel, limit = 50, before } = {}) {
  let companyFilter = null;
  if (channel) {
    const { data, error } = await sb.from('b2b_companies').select('id').eq('relationship_type', channel);
    if (error) throw new Error(error.message);
    companyFilter = (data || []).map(c => c.id);
    if (!companyFilter.length) return { messages: [], gmail_sync: 'skipped' };
  }

  let q = sb.from('b2b_messages')
    // Messages carry no subject of their own — it lives on the thread.
    .select('id, company_id, thread_id, direction, message_type, source, body_text, from_email, to_email, sent_at')
    .order('sent_at', { ascending: false })
    .limit(Math.min(limit, 200));
  if (direction) q = q.eq('direction', direction);
  if (companyFilter) q = q.in('company_id', companyFilter);
  if (before) q = q.lt('sent_at', before);
  const { data: messages, error } = await q;
  if (error) throw new Error(error.message);
  if (!messages?.length) return { messages: [], gmail_sync: 'recent' };

  const ids = [...new Set(messages.map(m => m.company_id).filter(Boolean))];
  const [companiesRes, threadsRes] = await Promise.all([
    sb.from('b2b_companies').select('id, name, relationship_type, relationship_state').in('id', ids),
    sb.from('b2b_threads').select('id, subject, status').in('id', [...new Set(messages.map(m => m.thread_id).filter(Boolean))]),
  ]);
  const companyBy = new Map((companiesRes.error ? [] : companiesRes.data || []).map(c => [c.id, c]));
  const threadBy = new Map((threadsRes.error ? [] : threadsRes.data || []).map(t => [t.id, t]));

  const rows = messages.map(m => {
    const c = companyBy.get(m.company_id);
    const t = threadBy.get(m.thread_id);
    return {
      ...m,
      company_name: c?.name || m.company_id,
      channel: c?.relationship_type || null,
      thread_subject: t?.subject || null,
      thread_status: t?.status || null,
      snippet: draftSnippet(m.body_text, 160),
    };
  });

  return {
    messages: rows,
    next_before: rows.length >= Math.min(limit, 200) ? rows[rows.length - 1].sent_at : null,
    gmail_sync: startReconcile(sb, ids),
  };
}

// ── Thread status ──────────────────────────────────────────────────────────

/**
 * Flip a thread between 'open' and 'closed'.
 *
 * Status is load-bearing in exactly one place: queueContext ignores inbound
 * messages on CLOSED threads, so a closed conversation can never put its
 * company back in Tier 1. Closing is therefore how the operator says "this one
 * is concluded, stop counting it"; reopening puts it back in play.
 */
async function setThreadStatus(sb, { thread_id, status } = {}) {
  if (!thread_id) throw new Error('thread_id required');
  if (status !== 'open' && status !== 'closed') throw new Error(`status must be 'open' or 'closed' (got '${status}')`);
  const { data, error } = await sb.from('b2b_threads')
    .update({ status }).eq('id', thread_id)
    .select('id, company_id, subject, status, last_message_at').maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error(`thread #${thread_id} not found`);
  return data;
}

/**
 * Reopen a concluded thread and draft the follow-up on it.
 *
 * Threading matters: without the thread_id the follow-up leaves as a brand-new
 * email and the recipient loses the conversation it belongs to. The advisor is
 * told plainly that this is an operator-initiated revival — the default
 * no-message_type framing is "they are waiting on a reply from us", which is
 * false here and would produce a reply to a message that never came.
 *
 * Returns { thread, draft }. A company that already has a pending draft keeps
 * it (one-pending-per-company is a unique index) and `draft` comes back null
 * with `existing_draft_id` set, so the caller can just open it.
 */
async function reopenThread(sb, { thread_id, steer, message_type } = {}) {
  const thread = await setThreadStatus(sb, { thread_id, status: 'open' });

  const { data: existing, error } = await sb.from('b2b_drafts')
    .select('id').eq('company_id', thread.company_id).eq('status', 'pending').maybeSingle();
  if (error) throw new Error(error.message);
  if (existing) return { thread, draft: null, existing_draft_id: existing.id };

  const result = await generateDraftForCompany(sb, {
    company_id: thread.company_id,
    thread_id: thread.id,
    steer,
    message_type,
    task_hint: 'Jamie is reopening this concluded conversation to follow up. Read the thread, pick up whatever was actually left hanging (or the last real thing that happened), and draft a natural follow-up from him. They are NOT waiting on a reply from us, so do not write as though they are.',
    reason: `operator reopened "${thread.subject || 'thread'}" to follow up`,
  });
  return { thread, draft: result, existing_draft_id: null };
}

/**
 * Resolve the company's current queue entry and generate (or regenerate with
 * steer) its draft. Falls back to a forced message_type when nothing is due.
 * Returns generateDraft's result, or null when nothing is due and no
 * message_type was forced.
 *
 * `thread_id` / `task_hint` / `reason` / `force` are the operator-initiated
 * path (a reopened thread, a directory row with nothing due): they pin the
 * draft to an existing conversation and tell the advisor why it is being
 * asked. `task_hint` only reaches the prompt when there is no message_type —
 * a typed cadence message already carries its own locked framing.
 */
async function generateDraftForCompany(sb, { company_id, steer, message_type, thread_id, task_hint, reason, force } = {}) {
  const { data: company, error } = await sb.from('b2b_companies').select('*').eq('id', company_id).maybeSingle();
  if (error || !company) throw new Error(error?.message || `company '${company_id}' not found`);

  const contexts = await buildContexts(sb, [company]);
  let [entry] = assembleQueue([{ company, ctx: { ...contexts.get(company.id), hasPendingDraft: false } }]);
  // Nothing due is not a refusal when the operator asked: reopening a thread or
  // picking a company out of the directory IS the trigger. Cadence only decides
  // what we reach out about unprompted.
  if (!entry && (message_type || thread_id || task_hint || force)) {
    entry = {
      tier: 3,
      message_type: message_type || null,
      reason: reason || 'operator-requested draft',
      task_hint: task_hint || OPERATOR_INITIATED_HINT,
      company_id: company.id,
    };
  }
  if (!entry) return null;
  // The operator's explicit target wins over whatever cadence inferred.
  if (thread_id) entry = { ...entry, thread_id };
  if (task_hint) entry = { ...entry, task_hint };
  if (reason) entry = { ...entry, reason };
  // message_type was only ever a fallback for "nothing due", so forcing a type
  // on a company that DID have something due was silently ignored — and the
  // type is not cosmetic: it sets next_action_date and drives the follow-up
  // ladder. An explicit type is an instruction, not a suggestion.
  if (message_type) entry = { ...entry, message_type, forced_message_type: true };

  return generateDraft({ company_id: company.id, queueEntry: entry, steer });
}

/**
 * Store an email the OPERATOR wrote, as a pending draft, so it sends through
 * exactly the same path as an AI draft.
 *
 * The empty state is the panel's front door, not an edge case: drafts are
 * generated on demand, so every company starts with no draft and returns to
 * none after each send. Requiring a ~$0.07 Opus call before you can type a
 * two-line reply you already know the words to is backwards. This gives the
 * box something to attach to, and keeps ONE send path (thread bookkeeping,
 * cadence dates, b2b_messages) rather than a second one that would drift.
 *
 * `advisor: null` is the training signal that matters: it distinguishes "Jamie
 * wrote this himself" from "Jamie edited the AI's draft", which a bare
 * operator_edited boolean cannot.
 */
function composeDraftRow({ company_id, body, subject, message_type, thread_id, entry } = {}) {
  if (!company_id) throw new Error('company_id required');
  if (!body || !body.trim()) throw new Error('body required — nothing to send');
  return {
    company_id,
    // Inherit the thread so a hand-written reply lands in the conversation
    // rather than starting a detached one.
    thread_id: thread_id || entry?.thread_id || null,
    // Cadence keys off message_type for next_action_date and the follow-up
    // ladder, so a hand-written message adopts whatever the queue says is due
    // here. Neutral fallback when nothing is (reaching out unprompted).
    message_type: message_type || entry?.message_type || 'operator_message',
    subject: subject?.trim() || null,
    body: body.trim(),
    structured: {},
    queue_tier: entry?.tier || null,
    queue_reason: entry?.reason || 'written by the operator',
    // The training signal: null advisor means a human wrote it from scratch,
    // which a bare operator_edited boolean could never distinguish from an
    // edited AI draft.
    advisor: null,
    operator_steer: null,
  };
}

async function composeDraft(sb, { company_id, body, subject, message_type, thread_id } = {}) {
  if (!company_id) throw new Error('company_id required');
  if (!body || !body.trim()) throw new Error('body required — nothing to send');

  const { data: company, error: cErr } = await sb.from('b2b_companies')
    .select('*').eq('id', company_id).maybeSingle();
  if (cErr) throw new Error(cErr.message);
  if (!company) throw new Error(`company '${company_id}' not found`);

  const contexts = await buildContexts(sb, [company]);
  const [entry] = assembleQueue([{ company, ctx: { ...contexts.get(company.id), hasPendingDraft: false } }]);
  const draftRow = composeDraftRow({ company_id, body, subject, message_type, thread_id, entry });

  await sb.from('b2b_drafts').update({ status: 'superseded' })
    .eq('company_id', company_id).eq('status', 'pending');

  const { data: row, error } = await sb.from('b2b_drafts').insert(draftRow).select('id').single();
  if (error) throw new Error(`b2b_drafts insert: ${error.message}`);

  return { draft_id: row.id, company_id, message_type: draftRow.message_type };
}

/**
 * Two-phase send of a stored draft. Phase 1 returns sendB2bEmail's preview
 * plus `gate_enabled` (the b2b_send_enabled flag state, so the UI can show
 * the gate plainly before confirming). Phase 2 passes through preview/
 * blocked/sent; on 'sent' the draft row is marked sent.
 *
 * `body` and `subject` optionally override the stored draft (the operator
 * edited them in the panel). The AI's originals stay in b2b_drafts — the sent
 * text lives on the b2b_messages row — and operator_edited is set when either
 * differs, which is the edit-rate training signal.
 *
 * A blank subject override is NOT an empty subject: it falls back to the
 * draft's, and a reply whose draft subject is null still inherits the thread
 * subject downstream in sendB2bEmail.
 */
async function sendDraftById(sb, { draft_id, confirmed, body, subject } = {}) {
  if (!draft_id) throw new Error('draft_id required');
  const { data: draft, error } = await sb.from('b2b_drafts').select('*').eq('id', draft_id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!draft) throw new Error(`draft #${draft_id} not found`);
  if (draft.status !== 'pending') throw new Error(`draft #${draft_id} is '${draft.status}' — only pending drafts can be sent`);

  const sendBody = (typeof body === 'string' && body.trim()) ? body : draft.body;
  const sendSubject = (typeof subject === 'string' && subject.trim()) ? subject.trim() : draft.subject;
  const edited = sendBody !== draft.body || sendSubject !== draft.subject;

  // Resolved at SEND time, not when the operator attached it: generation is
  // deterministic, so a fresh render can never be stale, and a body promising
  // "I have attached the agreement" can never go out without one — an unknown
  // spec throws here rather than sending a broken promise.
  const { resolveDraftAttachments } = require('./draftAttachments');
  const attachments = await resolveDraftAttachments(sb, draft);

  const res = await sendB2bEmail({
    company_id: draft.company_id,
    thread_id: draft.thread_id || undefined,
    message_type: draft.message_type,
    variant_id: draft.variant_id || undefined,
    subject: sendSubject || undefined,
    body: sendBody,
    confirmed: !!confirmed,
    next_touch_days: draft.structured?.next_touch_days ?? null,
    attachments,
    cc: draft.structured?.cc ?? undefined,
    to_override: draft.structured?.to ?? undefined,
  });

  if (res.phase === 'preview') {
    res.gate_enabled = await isFlagEnabled(SEND_FLAG);
  }
  if (res.phase === 'sent') {
    // Store what actually went out alongside the AI's original. The boolean
    // says THAT it was edited; this pair says HOW, which is the only form a
    // later accuracy pass can learn from. sendSubject/sendBody are the
    // operator's text, deliberately pre-signature-normalization — that
    // transform is ours, and folding it in here would read as an operator
    // edit that never happened.
    const { error: uErr } = await sb.from('b2b_drafts')
      .update({
        status: 'sent', sent_at: res.sent_at, operator_edited: edited,
        sent_subject: sendSubject || null, sent_body: sendBody,
      })
      .eq('id', draft_id);
    if (uErr) console.error(`[queueService] draft #${draft_id} sent but status update failed: ${uErr.message}`);
  }
  return { ...res, draft_id };
}

/**
 * Merge a fact-verification toggle into a draft's structured payload. Pure.
 * structured.facts_verified is a sorted array of verified fact indices.
 */
function mergeFactVerification(structured, index, verified) {
  const s = structured || {};
  const set = new Set(Array.isArray(s.facts_verified) ? s.facts_verified : []);
  if (verified) set.add(index); else set.delete(index);
  return { ...s, facts_verified: [...set].sort((a, b) => a - b) };
}

/**
 * Persist edited recipients on a pending draft. Stored on `structured`
 * alongside the attachment specs, so the send path reads one place.
 * Empty string clears an override and falls back to the resolved contact.
 */
async function setDraftRecipients(sb, { draft_id, to, cc } = {}) {
  if (!draft_id) throw new Error('draft_id required');
  const { data: draft, error } = await sb.from('b2b_drafts')
    .select('id, structured, status').eq('id', draft_id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!draft) throw new Error(`draft #${draft_id} not found`);
  if (draft.status !== 'pending') throw new Error(`draft #${draft_id} is '${draft.status}' — only pending drafts can be changed`);

  const structured = { ...(draft.structured || {}) };
  if (to !== undefined) { if (String(to).trim()) structured.to = String(to).trim(); else delete structured.to; }
  if (cc !== undefined) { if (String(cc).trim()) structured.cc = String(cc).trim(); else delete structured.cc; }

  const { error: uErr } = await sb.from('b2b_drafts').update({ structured }).eq('id', draft_id);
  if (uErr) throw new Error(uErr.message);
  return { draft_id, to: structured.to || null, cc: structured.cc || null };
}

/** Persist a fact-verification toggle on a pending draft. */
async function setFactVerified(sb, { draft_id, index, verified } = {}) {
  if (!draft_id || !Number.isInteger(index) || index < 0) throw new Error('draft_id and a non-negative fact index are required');
  const { data: draft, error } = await sb.from('b2b_drafts')
    .select('id, structured, status').eq('id', draft_id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!draft) throw new Error(`draft #${draft_id} not found`);
  const structured = mergeFactVerification(draft.structured, index, !!verified);
  const { error: uErr } = await sb.from('b2b_drafts').update({ structured }).eq('id', draft_id);
  if (uErr) throw new Error(uErr.message);
  return { draft_id, facts_verified: structured.facts_verified };
}

/** All known emails for a company: active contacts + the general front door. */
async function getCompanyEmails(sb, companyId) {
  const { data: contacts, error } = await sb.from('b2b_contacts')
    .select('email').eq('company_id', companyId).eq('is_active', true);
  if (error) throw new Error(error.message);
  const { data: company, error: cErr } = await sb.from('b2b_companies')
    .select('general_email').eq('id', companyId).maybeSingle();
  if (cErr) throw new Error(cErr.message);
  const set = new Set((contacts || []).map(c => c.email.toLowerCase()));
  if (company?.general_email) set.add(company.general_email.toLowerCase());
  return [...set];
}

/**
 * Gmail sync (thread discovery + manual-send reconcile) runs in the
 * BACKGROUND so the detail payload returns at DB speed. Per-company in-flight
 * guard here; both steps carry their own 15-min cooldowns, so the client's
 * one follow-up re-fetch is cheap and can't loop.
 */
const gmailSyncInFlight = new Set();
function startCompanyGmailSync(sb, companyId, emails) {
  if (gmailSyncInFlight.has(companyId)) return 'in_flight';
  gmailSyncInFlight.add(companyId);
  (async () => {
    try {
      await discoverCompanyThreads(sb, { companyId, emails });
      // includeClosed: this is the one-company view, where the operator is
      // reading the actual conversation. A concluded thread still has to be
      // COMPLETE — the queue-wide sweep is the one that can afford to skip it.
      await reconcileThreads(sb, { companyIds: [companyId], includeClosed: true });
    } catch (err) {
      console.error(`[queueService] gmail sync (${companyId}) failed: ${err.message}`);
    } finally {
      gmailSyncInFlight.delete(companyId);
    }
  })();
  return 'started';
}

/**
 * Full context for one company — the dashboard detail payload:
 *   threads    newest-first, each with messages oldest-first
 *   orders     recent Shopify orders matched via the company's known emails
 *   company    order_count / total_sales / last_order_date summary
 *   recipient  where a send would go (primary contact, general_email fallback)
 *   gmail_sync 'started' when a background Gmail sync kicked off — the client
 *              re-fetches once shortly after to pick up newly-imported threads
 * Returns immediately from the DB; Gmail work never blocks the response.
 */
async function fetchCompanyThreads(sb, companyId) {
  // Round 1 — independent lookups in parallel.
  const [emails, threadsRes, companyRes, recipient, contactsRes, draftRes] = await Promise.all([
    getCompanyEmails(sb, companyId).catch(err => {
      console.error(`[queueService] emails lookup failed: ${err.message}`);
      return [];
    }),
    sb.from('b2b_threads')
      .select('id, thread_type, subject, status, gmail_thread_id, created_at, last_message_at')
      .eq('company_id', companyId)
      .order('last_message_at', { ascending: false, nullsFirst: false }),
    sb.from('b2b_companies').select('*').eq('id', companyId).maybeSingle(),
    resolveDelivery(sb, companyId).catch(() => null),
    sb.from('b2b_contacts')
      .select('email, full_name, role, title, is_primary, is_active')
      .eq('company_id', companyId).eq('is_active', true)
      .order('is_primary', { ascending: false }),
    // The queue payload carries pending drafts, but the directory and activity
    // feed reach companies the queue never listed — without this a company with
    // a draft waiting would open looking like it had none.
    sb.from('b2b_drafts').select('*').eq('company_id', companyId).eq('status', 'pending').maybeSingle(),
  ]);
  if (threadsRes.error) throw new Error(threadsRes.error.message);
  const threads = threadsRes.data || [];
  const gmailSync = emails.length ? startCompanyGmailSync(sb, companyId, emails) : 'skipped';

  // Round 2 — messages + orders in parallel (each depends on round 1).
  const [messagesRes, ordersRes] = await Promise.all([
    threads.length
      ? sb.from('b2b_messages')
        .select('thread_id, direction, message_type, from_email, to_email, body_text, sent_at, source')
        .in('thread_id', threads.map(t => t.id))
        .order('sent_at', { ascending: true })
      : Promise.resolve({ data: [] }),
    emails.length
      ? sb.from('orders')
        .select('shopify_order_id, order_number, created_at, total_price, shop_currency, financial_status, fulfillment_status, cancelled_at')
        .in('customer_email', emails)
        .order('created_at', { ascending: false })
        .limit(8)
      : Promise.resolve({ data: [] }),
  ]);
  if (messagesRes.error) throw new Error(messagesRes.error.message);
  if (ordersRes.error) console.error(`[queueService] orders lookup failed: ${ordersRes.error.message}`);

  const byThread = new Map(threads.map(t => [t.id, { ...t, messages: [] }]));
  for (const m of messagesRes.data || []) byThread.get(m.thread_id)?.messages.push(m);

  // Logo: store-locator logo if the company has one, else the donation
  // partner registry's logo when this org is a partner (domain/name match).
  const company = companyRes.data || null;
  let logoUrl = company?.locator_logo_url || null;
  if (!logoUrl && company?.relationship_type === 'lgbtq_org') {
    const domain = (company.website || '').toLowerCase().replace(/^https?:\/\/(www\.)?/, '').split('/')[0] || null;
    const { data: partners } = await sb.from('donation_partners')
      .select('name, website_url, logo_url').eq('active', true);
    const match = (partners || []).find(p =>
      (domain && (p.website_url || '').toLowerCase().includes(domain))
      || (p.name || '').toLowerCase().trim() === (company.name || '').toLowerCase().trim());
    logoUrl = match?.logo_url || null;
  }

  return {
    threads: [...byThread.values()],
    orders: ordersRes.data || [],
    company,
    contacts: contactsRes.error ? [] : (contactsRes.data || []),
    pending_draft: draftRes.error ? null : (draftRes.data || null),
    logo_url: logoUrl,
    // `recipient` keeps its old shape for email companies so nothing downstream
    // has to special-case the common path; `delivery` carries the mode so the
    // panel knows whether a Send button is even honest here.
    recipient: recipient?.mode === 'email' ? recipient : null,
    delivery: recipient || { mode: 'none' },
    gmail_sync: gmailSync,
  };
}

module.exports = {
  draftSnippet,
  attachDrafts,
  mergePendingDraftEntries,
  fetchOutreachQueue,
  fetchQueueWithDrafts,
  fetchCompanyThreads,
  generateDraftForCompany,
  composeDraft,
  composeDraftRow,
  sendDraftById,
  mergeFactVerification,
  setFactVerified,
  setDraftRecipients,
  // directory / activity / thread state
  sanitizeSearchTerm,
  rollupThreads,
  companyThreadStatus,
  companyStage,
  DIRECTORY_STAGES,
  matchReason,
  searchCompanies,
  fetchActivity,
  setThreadStatus,
  reopenThread,
  DIRECTORY_STATUSES,
};
