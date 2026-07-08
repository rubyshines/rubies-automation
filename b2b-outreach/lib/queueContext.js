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
      .select('company_id, direction, message_type, sent_at')
      .in('company_id', ids)
      .order('sent_at', { ascending: true })
  ) : [];
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
      ctx.lastInboundAt = m.sent_at;
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
