/**
 * queueService.js — shared operations behind the two outreach surfaces
 * (the MCP console tools and the dashboard Outreach panel). Both surfaces
 * are thin wrappers over these functions so they can never drift apart.
 *
 *   fetchOutreachQueue       — companies → contexts → assembleQueue
 *   attachDrafts             — pure: join pending-draft id/snippet onto entries
 *   fetchQueueWithDrafts     — the dashboard queue payload
 *   generateDraftForCompany  — queue-entry resolution + generateDraft
 *   sendDraftById            — load a pending draft → sendB2bEmail (two-phase,
 *                              gate pass-through); marks the draft sent
 */
const { assembleQueue } = require('./queue');
const { buildContexts } = require('./queueContext');
const { reconcileThreads, discoverCompanyThreads } = require('./manualSendReconcile');
const { generateDraft } = require('./outreachAdvisor');
const { sendB2bEmail, resolveRecipient, SEND_FLAG } = require('./sendB2bEmail');
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

/** Queue + pending-draft id/snippet per company — the dashboard payload. */
async function fetchQueueWithDrafts(sb, { channel } = {}) {
  const companies = await fetchCompanies(sb, { channel });
  // Absorb any manual Gmail replies before computing "waiting on us" — the
  // queue must reflect what actually happened in the inbox, not just what the
  // send tool wrote. Fail-soft + per-thread cooldown inside.
  try {
    await reconcileThreads(sb, { companyIds: companies.map(c => c.id) });
  } catch (err) {
    console.error(`[queueService] reconcile skipped: ${err.message}`);
  }
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
  return attachDrafts(merged, drafts);
}

/**
 * Resolve the company's current queue entry and generate (or regenerate with
 * steer) its draft. Falls back to a forced message_type when nothing is due.
 * Returns generateDraft's result, or null when nothing is due and no
 * message_type was forced.
 */
async function generateDraftForCompany(sb, { company_id, steer, message_type } = {}) {
  const { data: company, error } = await sb.from('b2b_companies').select('*').eq('id', company_id).maybeSingle();
  if (error || !company) throw new Error(error?.message || `company '${company_id}' not found`);

  const contexts = await buildContexts(sb, [company]);
  let [entry] = assembleQueue([{ company, ctx: { ...contexts.get(company.id), hasPendingDraft: false } }]);
  if (!entry && message_type) {
    entry = { tier: 3, message_type, reason: 'operator-requested draft', company_id: company.id };
  }
  if (!entry) return null;

  return generateDraft({ company_id: company.id, queueEntry: entry, steer });
}

/**
 * Two-phase send of a stored draft. Phase 1 returns sendB2bEmail's preview
 * plus `gate_enabled` (the b2b_send_enabled flag state, so the UI can show
 * the gate plainly before confirming). Phase 2 passes through preview/
 * blocked/sent; on 'sent' the draft row is marked sent.
 *
 * `body` optionally overrides the stored draft body (the operator edited it
 * in the panel). The AI's original stays in b2b_drafts.body — the sent text
 * lives on the b2b_messages row — and operator_edited is set when they
 * differ, which is the edit-rate training signal.
 */
async function sendDraftById(sb, { draft_id, confirmed, body } = {}) {
  if (!draft_id) throw new Error('draft_id required');
  const { data: draft, error } = await sb.from('b2b_drafts').select('*').eq('id', draft_id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!draft) throw new Error(`draft #${draft_id} not found`);
  if (draft.status !== 'pending') throw new Error(`draft #${draft_id} is '${draft.status}' — only pending drafts can be sent`);

  const sendBody = (typeof body === 'string' && body.trim()) ? body : draft.body;
  const edited = sendBody !== draft.body;

  const res = await sendB2bEmail({
    company_id: draft.company_id,
    thread_id: draft.thread_id || undefined,
    message_type: draft.message_type,
    variant_id: draft.variant_id || undefined,
    subject: draft.subject || undefined,
    body: sendBody,
    confirmed: !!confirmed,
  });

  if (res.phase === 'preview') {
    res.gate_enabled = await isFlagEnabled(SEND_FLAG);
  }
  if (res.phase === 'sent') {
    const { error: uErr } = await sb.from('b2b_drafts')
      .update({ status: 'sent', sent_at: res.sent_at, operator_edited: edited })
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
      await reconcileThreads(sb, { companyIds: [companyId] });
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
  const [emails, threadsRes, companyRes, recipient] = await Promise.all([
    getCompanyEmails(sb, companyId).catch(err => {
      console.error(`[queueService] emails lookup failed: ${err.message}`);
      return [];
    }),
    sb.from('b2b_threads')
      .select('id, thread_type, subject, status, gmail_thread_id, created_at, last_message_at')
      .eq('company_id', companyId)
      .order('last_message_at', { ascending: false, nullsFirst: false }),
    sb.from('b2b_companies')
      .select('order_count, total_sales, last_order_date').eq('id', companyId).maybeSingle(),
    resolveRecipient(sb, companyId).catch(() => null),
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

  return {
    threads: [...byThread.values()],
    orders: ordersRes.data || [],
    company: companyRes.data || null,
    recipient,
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
  sendDraftById,
  mergeFactVerification,
  setFactVerified,
};
