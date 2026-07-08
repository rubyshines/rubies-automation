/**
 * queue.js — the unified 6-tier outreach queue (locked decision #6).
 *
 * Signal-based priority; channel never hierarchically ranks. Pure functions:
 * the sweep/console fetch rows + context, this module decides tier and order.
 *
 * Tiers:
 *  1  they replied — waiting on us
 *  2  time-sensitive signal (samples landed, first-order window, sales spike,
 *     price-change deadline)
 *  3  healthy-relationship cadence due
 *  4  active prospect first-touch / warm follow-up due
 *  5  overdue follow-up (next_action_date past, nothing else triggered)
 *  6  cold revival / long-silent
 */
const { evaluateDue, companyEligible } = require('./cadence');

const TIER_BY_TYPE = {
  // Tier 2 — time-sensitive
  post_samples_checkin: 2,
  first_order_checkin: 2,
  performance_checkin: 2, // when signal-driven; cadence form maps to 3 below
  price_change_notice: 2,
  event_donation_response: 1, // inbound-triggered; normally surfaces via Tier 1 anyway
  // Tier 3 — healthy cadence
  reorder_nudge: 3,
  new_collection: 3,
  community_checkin: 3,
  donation_closet_pitch: 3,
  purchase_pitch: 3,
  affiliate_invite: 3,
  content_prompt: 3,
  sample_feedback_request: 3,
  referral_ask: 3,
  // Tier 4 — prospect first-touch
  intro_pitch: 4,
  intro_outreach: 4,
  affiliate_intro: 4,
  // Tier 6 — revival
  reactivation: 6,
  affiliate_reactivation: 6,
};

/**
 * computeQueueEntry — decide whether a company belongs in today's queue and at
 * what tier. Returns { tier, message_type|null, reason } or null.
 *
 * @param company b2b_companies row
 * @param ctx     same context shape as cadence.evaluateDue, plus:
 *   lastInboundAt, lastOutboundAt (thread-level latest), signalDue
 *   ({message_type, reason} from Trigger-4 detection, optional)
 */
function computeQueueEntry(company, ctx, now = new Date()) {
  if (!company || company.relationship_state === 'lost') return null;

  // Tier 1 — they replied, we haven't answered. Beats everything, even snooze.
  if (ctx.lastInboundAt && (!ctx.lastOutboundAt || new Date(ctx.lastInboundAt) > new Date(ctx.lastOutboundAt))) {
    return {
      tier: 1,
      message_type: null, // advisor reads the thread and decides
      reason: `replied ${Math.round((now - new Date(ctx.lastInboundAt)) / 3600000)}h ago — waiting on us`,
      waiting_since: ctx.lastInboundAt,
      // Thread the reply — without this the draft stored thread_id null and
      // sendB2bEmail sent the reply as a brand-new email outside the thread.
      thread_id: ctx.lastInboundThreadId || null,
    };
  }

  if (!companyEligible(company, ctx, now)) return null;

  // Tier 2 — explicit signal from Trigger 4 (events outrank cadence)
  if (ctx.signalDue) {
    return {
      tier: TIER_BY_TYPE[ctx.signalDue.message_type] ?? 2,
      message_type: ctx.signalDue.message_type,
      reason: ctx.signalDue.reason,
    };
  }

  // Tiers 2/3/4/6 — cadence engine
  const due = evaluateDue(company, ctx, now);
  if (due) {
    return {
      tier: TIER_BY_TYPE[due.message_type] ?? 3,
      message_type: due.message_type,
      reason: due.reason,
    };
  }

  // Tier 5 — next_action_date passed but no specific condition fired
  if (company.next_action_date && new Date(company.next_action_date) < now) {
    const overdueDays = Math.floor((now - new Date(company.next_action_date)) / 86400000);
    return { tier: 5, message_type: null, reason: `follow-up overdue ${overdueDays}d` };
  }

  return null;
}

/**
 * assembleQueue — entries sorted by tier asc, then by urgency within tier
 * (Tier 1: oldest unanswered first; others: most overdue first by reason
 * ordering proxy = stable input order).
 */
function assembleQueue(items, now = new Date()) {
  const out = [];
  for (const { company, ctx } of items) {
    const entry = computeQueueEntry(company, ctx, now);
    if (entry) out.push({ company_id: company.id, company_name: company.name, channel: company.relationship_type, ...entry });
  }
  return out.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    if (a.tier === 1) return new Date(a.waiting_since) - new Date(b.waiting_since);
    return 0;
  });
}

module.exports = { computeQueueEntry, assembleQueue, TIER_BY_TYPE };
