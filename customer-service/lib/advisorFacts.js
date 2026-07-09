/**
 * advisorFacts.js — operator-knowledge facts CRUD (the knowledge loop).
 *
 * Facts flow: judge proposes (lib/judgeDaily.js) or seed/manual add →
 * status 'pending' → Jamie approves (optionally editing text/category/expiry)
 * or rejects in the dashboard → 'active' facts are injected verbatim into the
 * advisor's static prompt (aiAdvisor.buildFactsBlock).
 *
 * All logic lives here so dashboard endpoints and any future MCP tool call
 * the same functions (tools own operations; interfaces stay thin).
 */

const CATEGORIES = ['product', 'shipping', 'returns_donations', 'programs', 'process', 'general'];
const DECISIONS = ['approve', 'reject'];

/** Panel payload: pending queue + active list + recently decided. */
async function listFacts(sb) {
  const { data, error } = await sb.from('advisor_facts')
    .select('id, fact, category, status, expires_at, source, source_draft_id, source_rationale, created_at, decided_at')
    .order('created_at', { ascending: false })
    .limit(500);
  if (error) throw new Error(`advisor_facts list failed: ${error.message}`);
  const rows = data || [];
  const now = Date.now();
  return {
    pending: rows.filter(r => r.status === 'pending'),
    active: rows.filter(r => r.status === 'active' && (!r.expires_at || Date.parse(r.expires_at) > now)),
    expired: rows.filter(r => r.status === 'active' && r.expires_at && Date.parse(r.expires_at) <= now),
    recently_decided: rows.filter(r => ['rejected'].includes(r.status)).slice(0, 20),
    categories: CATEGORIES,
  };
}

/**
 * Decide a pending fact (or retire an active one).
 * action 'approve': optionally override fact text / category / expires_at, → active.
 * action 'reject': → rejected (kept for dedupe so it never re-queues).
 * Retiring an active fact = reject it.
 */
async function decideFact(sb, id, { action, fact, category, expires_at } = {}) {
  if (!Number.isInteger(id)) throw badRequest('fact id required');
  if (!DECISIONS.includes(action)) throw badRequest(`action must be one of ${DECISIONS.join('|')}`);

  const update = { decided_at: new Date().toISOString() };
  if (action === 'reject') {
    update.status = 'rejected';
  } else {
    update.status = 'active';
    if (fact != null) {
      const text = String(fact).trim();
      if (!text) throw badRequest('fact text cannot be empty');
      update.fact = text.slice(0, 500);
    }
    if (category != null) {
      if (!CATEGORIES.includes(category)) throw badRequest(`category must be one of ${CATEGORIES.join('|')}`);
      update.category = category;
    }
    if (expires_at !== undefined) {
      if (expires_at === null || expires_at === '') update.expires_at = null;
      else {
        const t = Date.parse(expires_at);
        if (Number.isNaN(t)) throw badRequest('expires_at must be an ISO date or empty');
        update.expires_at = new Date(t).toISOString();
      }
    }
  }

  const { data, error } = await sb.from('advisor_facts')
    .update(update).eq('id', id).select('id, fact, category, status, expires_at').single();
  if (error) throw new Error(`advisor_facts decide failed: ${error.message}`);
  return data;
}

/** Manual add from the dashboard — Jamie typed it, so it goes straight active. */
async function addFact(sb, { fact, category = 'general', expires_at = null } = {}) {
  const text = String(fact || '').trim();
  if (!text) throw badRequest('fact text required');
  if (!CATEGORIES.includes(category)) throw badRequest(`category must be one of ${CATEGORIES.join('|')}`);
  const row = {
    fact: text.slice(0, 500), category, status: 'active', source: 'manual',
    decided_at: new Date().toISOString(),
  };
  if (expires_at) {
    const t = Date.parse(expires_at);
    if (Number.isNaN(t)) throw badRequest('expires_at must be an ISO date');
    row.expires_at = new Date(t).toISOString();
  }
  const { data, error } = await sb.from('advisor_facts').insert(row).select('id, fact, category, status').single();
  if (error) throw new Error(`advisor_facts add failed: ${error.message}`);
  return data;
}

function badRequest(msg) {
  const err = new Error(msg);
  err.statusCode = 400;
  return err;
}

module.exports = { listFacts, decideFact, addFact, CATEGORIES };
