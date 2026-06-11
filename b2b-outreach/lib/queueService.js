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
const { generateDraft } = require('./outreachAdvisor');
const { sendB2bEmail, SEND_FLAG } = require('./sendB2bEmail');
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
 */
async function sendDraftById(sb, { draft_id, confirmed } = {}) {
  if (!draft_id) throw new Error('draft_id required');
  const { data: draft, error } = await sb.from('b2b_drafts').select('*').eq('id', draft_id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!draft) throw new Error(`draft #${draft_id} not found`);
  if (draft.status !== 'pending') throw new Error(`draft #${draft_id} is '${draft.status}' — only pending drafts can be sent`);

  const res = await sendB2bEmail({
    company_id: draft.company_id,
    thread_id: draft.thread_id || undefined,
    message_type: draft.message_type,
    variant_id: draft.variant_id || undefined,
    subject: draft.subject || undefined,
    body: draft.body,
    confirmed: !!confirmed,
  });

  if (res.phase === 'preview') {
    res.gate_enabled = await isFlagEnabled(SEND_FLAG);
  }
  if (res.phase === 'sent') {
    const { error: uErr } = await sb.from('b2b_drafts')
      .update({ status: 'sent', sent_at: res.sent_at })
      .eq('id', draft_id);
    if (uErr) console.error(`[queueService] draft #${draft_id} sent but status update failed: ${uErr.message}`);
  }
  return { ...res, draft_id };
}

module.exports = {
  draftSnippet,
  attachDrafts,
  mergePendingDraftEntries,
  fetchOutreachQueue,
  fetchQueueWithDrafts,
  generateDraftForCompany,
  sendDraftById,
};
