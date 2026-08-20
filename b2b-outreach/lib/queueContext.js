/**
 * queueContext.js — shared context assembly for the outreach queue.
 * Used by sweep.js and the operator-console tools: fetches b2b_messages +
 * pending drafts for a set of companies and builds the ctx objects that
 * cadence.evaluateDue / queue.computeQueueEntry consume.
 */
const { fetchAllPaginated } = require('../../shared/supabaseClient');
const { deliveryMode } = require('./sendB2bEmail');
const { NON_REPLY_INBOUND_TYPES } = require('./replyCorrelation');
const { upcomingMeetingsByCompany } = require('./scheduleMeeting');

/** "https://www.foo.org/x" → "foo.org". Pure. */
function companyDomain(website) {
  if (!website) return null;
  const m = String(website).toLowerCase().match(/^(?:https?:\/\/)?(?:www\.)?([^/:?#\s]+)/);
  return m && m[1].includes('.') ? m[1] : null;
}

/**
 * Which of these companies have a SIBLING row on the same domain that already
 * has a relationship? The imports created duplicate rows per org — BAGLY exists
 * twice, once as an active donation partner and once as a bare CenterLink row
 * with a different address. Without this, Tier 4 would send a cold "let me
 * introduce RUBIES" to an org we already partner with, at their info@ address.
 *
 * Queried by domain rather than derived from the passed-in list, because
 * generateDraftForCompany builds context for a SINGLE company — a guard that
 * only worked on the full-queue path would be bypassed by the draft button.
 */
async function findEngagedSiblings(sb, companies) {
  const domains = [...new Set((companies || []).map(c => companyDomain(c.website)).filter(Boolean))];
  if (!domains.length) return new Set();

  const rows = [];
  for (let i = 0; i < domains.length; i += 100) {
    const chunk = domains.slice(i, i + 100);
    const ors = chunk.map(d => `website.ilike.%${d}%`).join(',');
    const { data, error } = await sb.from('b2b_companies')
      .select('id, website, relationship_state, last_outbound_at, order_count').or(ors);
    if (error) throw new Error(`sibling lookup: ${error.message}`);
    rows.push(...(data || []));
  }

  // A sibling counts as "engaged" if a relationship exists in any form.
  const engagedDomains = new Set();
  const byDomain = new Map();
  for (const r of rows) {
    const d = companyDomain(r.website);
    if (!d) continue;
    if (!byDomain.has(d)) byDomain.set(d, []);
    byDomain.get(d).push(r);
  }
  const withEngaged = new Set();
  for (const [d, group] of byDomain) {
    if (group.some(r => r.relationship_state === 'active' || r.last_outbound_at || (r.order_count || 0) > 0)) {
      engagedDomains.add(d);
    }
  }
  for (const c of companies || []) {
    const d = companyDomain(c.website);
    if (!d || !engagedDomains.has(d)) continue;
    // Only a DIFFERENT row's engagement suppresses this one; a company is not
    // its own sibling.
    const others = (byDomain.get(d) || []).filter(r => r.id !== c.id);
    if (others.some(r => r.relationship_state === 'active' || r.last_outbound_at || (r.order_count || 0) > 0)) {
      withEngaged.add(c.id);
    }
  }
  return withEngaged;
}

async function buildContexts(sb, companies) {
  const ids = (companies || []).map(c => c.id);
  const messages = ids.length ? await fetchAllPaginated(() =>
    sb.from('b2b_messages')
      .select('company_id, direction, message_type, sent_at, thread_id, undelivered_at')
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
  const engagedSiblings = await findEngagedSiblings(sb, companies);
  // Booked calls. cadence.companyEligible reads `upcomingMeetingAt`, so it MUST
  // be assembled here — seven branches once sat unreachable for months because
  // the cadence table was written to the design and the context to what Tier 1
  // happened to need.
  const upcomingMeetings = await upcomingMeetingsByCompany(sb, ids);

  // How each company is reachable, resolved in bulk. Same pure decision the
  // send path uses per-company, so the panel can never offer a Send button for
  // a company sendB2bEmail would refuse.
  const activeContactCompanies = new Set();
  if (ids.length) {
    const contactRows = await fetchAllPaginated(() => sb.from('b2b_contacts')
      .select('company_id').eq('is_active', true).in('company_id', ids));
    for (const c of contactRows) activeContactCompanies.add(c.company_id);
  }

  const byCompany = new Map();
  for (const c of companies || []) {
    byCompany.set(c.id, {
      hasPendingDraft: pendingSet.has(c.id),
      sentTypes: new Set(),
      lastInboundAt: null,
      lastInboundThreadId: null,
      // Newest send that came back undelivered. Null for almost every company.
      lastUndeliveredAt: null,
      lastOutboundAt: c.last_outbound_at || null,
      lastOrderAt: c.last_order_date || null,
      orderCount: c.order_count || 0,
      lastTypeSent: new Map(),
      // Written by syncB2bCompanyState from the orders mirror.
      firstOrderFulfilledAt: c.first_order_fulfilled_at || null,
      // Filled from message history below: the reply that opened the
      // sample-feedback window.
      postSamplesReplyAt: null,
      // A duplicate row for this same org already has a relationship — never
      // cold-intro them again on a second address.
      hasEngagedSibling: engagedSiblings.has(c.id),
      // The next booked call, if any. Read by cadence.companyEligible.
      upcomingMeetingAt: upcomingMeetings.get(c.id)?.starts_at || null,
      upcomingMeeting: upcomingMeetings.get(c.id) || null,
      // 'email' | 'form' | 'none' — how this company can be reached.
      delivery: deliveryMode({
        hasContact: activeContactCompanies.has(c.id),
        generalEmail: c.general_email,
        contactFormUrl: c.contact_form_url,
      }),
    });
  }
  // Messages are ordered oldest-first, so the newest outbound post_samples_checkin
  // is whatever the loop last recorded; an inbound after it is the reply that
  // opens the sample_feedback_request window.
  const lastCheckinAt = new Map();
  for (const m of messages) {
    const ctx = byCompany.get(m.company_id);
    if (!ctx) continue;
    // A message that bounced was not sent. It must not count as contact made
    // (lastOutboundAt) or as a message type already covered (sentTypes) — a
    // check-in nobody received still needs sending, and the whole point of the
    // bounce path is that the company comes BACK as work.
    if (m.direction === 'outbound' && m.undelivered_at) {
      // Remember it though: this is what the queue's "no working address" branch
      // sorts on, and what tells the operator how long we have been unable to
      // reach them rather than just that we cannot.
      ctx.lastUndeliveredAt = ctx.lastUndeliveredAt && ctx.lastUndeliveredAt > m.sent_at
        ? ctx.lastUndeliveredAt : m.sent_at;
      continue;
    }
    if (m.direction === 'inbound') {
      if (closedThreadIds.has(m.thread_id)) continue;
      // Auto-responders, calendar notifications and delivery failures are
      // history, not a human waiting on us.
      if (NON_REPLY_INBOUND_TYPES.has(m.message_type)) continue;
      const checkinAt = lastCheckinAt.get(m.company_id);
      if (checkinAt && new Date(m.sent_at) > new Date(checkinAt) && !ctx.postSamplesReplyAt) {
        ctx.postSamplesReplyAt = m.sent_at;
      }
      ctx.lastInboundAt = m.sent_at;
      // Carry the inbound's thread so Tier-1 reply drafts send IN the thread
      // (without it every reply went out as a brand-new email).
      ctx.lastInboundThreadId = m.thread_id || ctx.lastInboundThreadId;
    } else {
      ctx.lastOutboundAt = ctx.lastOutboundAt && ctx.lastOutboundAt > m.sent_at ? ctx.lastOutboundAt : m.sent_at;
      if (m.message_type) {
        ctx.sentTypes.add(m.message_type);
        ctx.lastTypeSent.set(m.message_type, m.sent_at);
        if (m.message_type === 'post_samples_checkin') lastCheckinAt.set(m.company_id, m.sent_at);
      }
    }
  }
  for (const ctx of byCompany.values()) {
    const map = ctx.lastTypeSent;
    ctx.lastTypeSentAt = (type) => map.get(type) || null;
  }
  return byCompany;
}

module.exports = { buildContexts, findEngagedSiblings, companyDomain };
