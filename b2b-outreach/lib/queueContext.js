/**
 * queueContext.js — shared context assembly for the outreach queue.
 * Used by sweep.js and the operator-console tools: fetches b2b_messages +
 * pending drafts for a set of companies and builds the ctx objects that
 * cadence.evaluateDue / queue.computeQueueEntry consume.
 */
const { fetchAllPaginated } = require('../../shared/supabaseClient');

async function buildContexts(sb, companies) {
  const ids = (companies || []).map(c => c.id);
  const messages = ids.length ? await fetchAllPaginated(() =>
    sb.from('b2b_messages')
      .select('company_id, direction, message_type, sent_at, thread_id')
      .in('company_id', ids)
      .order('sent_at', { ascending: true })
  ) : [];
  // A closed thread is a concluded conversation: its inbound messages must not
  // put the company back in Tier 1 ("waiting on us"). Outbound history still
  // counts for cadence (sentTypes / lastOutboundAt) regardless of status.
  const threads = ids.length ? await fetchAllPaginated(() =>
    sb.from('b2b_threads').select('id, status').in('company_id', ids)
  ) : [];
  const closedThreadIds = new Set(threads.filter(t => t.status === 'closed').map(t => t.id));
  const drafts = ids.length ? await fetchAllPaginated(() =>
    sb.from('b2b_drafts').select('company_id').eq('status', 'pending').in('company_id', ids)
      .order('id', { ascending: true })
  ) : [];
  const pendingSet = new Set(drafts.map(d => d.company_id));

  const byCompany = new Map();
  for (const c of companies || []) {
    byCompany.set(c.id, {
      hasPendingDraft: pendingSet.has(c.id),
      sentTypes: new Set(),
      lastInboundAt: null,
      lastInboundThreadId: null,
      lastOutboundAt: c.last_outbound_at || null,
      lastOrderAt: c.last_order_date || null,
      orderCount: c.order_count || 0,
      lastTypeSent: new Map(),
    });
  }
  for (const m of messages) {
    const ctx = byCompany.get(m.company_id);
    if (!ctx) continue;
    if (m.direction === 'inbound') {
      if (closedThreadIds.has(m.thread_id)) continue;
      ctx.lastInboundAt = m.sent_at;
      // Carry the inbound's thread so Tier-1 reply drafts send IN the thread
      // (without it every reply went out as a brand-new email).
      ctx.lastInboundThreadId = m.thread_id || ctx.lastInboundThreadId;
    } else {
      ctx.lastOutboundAt = ctx.lastOutboundAt && ctx.lastOutboundAt > m.sent_at ? ctx.lastOutboundAt : m.sent_at;
      if (m.message_type) {
        ctx.sentTypes.add(m.message_type);
        ctx.lastTypeSent.set(m.message_type, m.sent_at);
      }
    }
  }
  for (const ctx of byCompany.values()) {
    const map = ctx.lastTypeSent;
    ctx.lastTypeSentAt = (type) => map.get(type) || null;
  }
  return byCompany;
}

module.exports = { buildContexts };
