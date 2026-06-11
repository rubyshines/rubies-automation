/**
 * cadence.js — pure due-condition evaluators for the outreach daily sweep
 * (Trigger 3 of b2b-outreach-system.md, drafted spec 2026-06-10).
 *
 * Everything here is a deterministic function of (company row, derived
 * context, now) — no IO. The sweep job fetches rows, builds context, and asks
 * `evaluateDue` for the single highest-priority due message type per company.
 * One company → at most one draft (locked decision #3).
 */

// next_action_date written at send time, by message type (days from send).
const NEXT_ACTION_DAYS = {
  intro_pitch: 7,
  intro_outreach: 7,
  affiliate_intro: 7,
  purchase_pitch: 7,
  donation_closet_pitch: 7,
  price_change_notice: 7,
  post_samples_checkin: 14,
  sample_feedback_request: 30,
  first_order_checkin: 30,
  referral_ask: 180,
  reorder_nudge: 90,
  new_collection: 30,
  community_checkin: 180,
  affiliate_invite: 60,
  content_prompt: 30,
  performance_checkin: 30,
  reactivation: 180,
  affiliate_reactivation: 180,
  event_donation_response: 7,
};

const DEFAULT_NEXT_ACTION_DAYS = 30;

function nextActionDateAfterSend(messageType, sentAt = new Date()) {
  const days = NEXT_ACTION_DAYS[messageType] ?? DEFAULT_NEXT_ACTION_DAYS;
  const d = new Date(sentAt);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Whole business days (Mon-Fri) elapsed between two dates. */
function businessDaysSince(from, now = new Date()) {
  if (!from) return null;
  let count = 0;
  const cur = new Date(from);
  cur.setUTCHours(0, 0, 0, 0);
  const end = new Date(now);
  end.setUTCHours(0, 0, 0, 0);
  while (cur < end) {
    cur.setUTCDate(cur.getUTCDate() + 1);
    const dow = cur.getUTCDay();
    if (dow !== 0 && dow !== 6) count++;
  }
  return count;
}

function daysSince(from, now = new Date()) {
  if (!from) return null;
  return Math.floor((now - new Date(from)) / 86400000);
}

/** Seasonal windows for community_checkin (locked catalog entry). */
function seasonalWindow(now = new Date()) {
  const m = now.getUTCMonth() + 1; // 1-12
  const d = now.getUTCDate();
  if (m >= 3 && m <= 6) return 'pride';
  if ((m === 8) || (m === 9 && d <= 15)) return 'back_to_school';
  if (m >= 11) return 'year_end';
  return null;
}

/**
 * Gate conditions every cadence message shares (locked + drafted spec):
 * not lost, not snoozed, contact known, no pending draft.
 */
function companyEligible(company, { hasPendingDraft } = {}, now = new Date()) {
  if (!company) return false;
  if (company.relationship_state === 'lost') return false;
  if (company.contact_unknown) return false;
  if (hasPendingDraft) return false;
  if (company.snoozed_until && new Date(company.snoozed_until) > now) return false;
  return true;
}

/**
 * evaluateDue — the Trigger-3 table. Returns { message_type, reason } for the
 * highest-priority due condition, or null.
 *
 * @param company  b2b_companies row (relationship_state, relationship_type,
 *                 entity_type, program_flags, samples_*, snoozed_until, ...)
 * @param ctx      derived context the sweep computes:
 *   hasPendingDraft, lastOrderAt, orderCount, lastOutboundAt,
 *   lastInboundAt, daysSinceLastAttribution (affiliates),
 *   sentTypes: Set of message_types ever sent to this company,
 *   postSamplesReplyAt (inbound reply to post_samples_checkin, if any),
 *   purchaseSignalAt (org purchase-interest marker, if any),
 *   lastPurchaseAt (org), lastTypeSentAt: (type)=>date|null,
 *   newCollectionSinceDormant: boolean
 * @param now
 */
function evaluateDue(company, ctx, now = new Date()) {
  if (!companyEligible(company, ctx, now)) return null;
  const state = company.relationship_state;
  const rtype = company.relationship_type; // 'wholesale'/'retailer' | 'lgbtq_org' | 'affiliate'
  const isRetailer = rtype === 'wholesale' || rtype === 'retailer';
  const isOrg = rtype === 'lgbtq_org';
  const isAffiliate = rtype === 'affiliate' || (company.program_flags && company.program_flags.affiliate);
  const sent = ctx.sentTypes || new Set();
  const lastSent = ctx.lastTypeSentAt || (() => null);

  // --- samples flow (any track, in_contact) -------------------------------
  if (state === 'in_contact' && !sent.has('post_samples_checkin')) {
    if (company.samples_delivered_at && businessDaysSince(company.samples_delivered_at, now) >= 5) {
      return { message_type: 'post_samples_checkin', reason: `samples delivered ${daysSince(company.samples_delivered_at, now)}d ago` };
    }
    if (!company.samples_delivered_at && company.samples_shipped_at && daysSince(company.samples_shipped_at, now) >= 10) {
      return { message_type: 'post_samples_checkin', reason: 'samples shipped 10+ days ago (no delivery event — assumed delivered)' };
    }
  }
  if (state === 'in_contact' && !sent.has('sample_feedback_request')
      && ctx.postSamplesReplyAt && daysSince(ctx.postSamplesReplyAt, now) >= 21) {
    return { message_type: 'sample_feedback_request', reason: 'samples feedback window (replied to checkin, no order yet)' };
  }

  // --- retailer track ------------------------------------------------------
  if (isRetailer) {
    if (state === 'active' && ctx.orderCount === 1 && !sent.has('first_order_checkin')) {
      const d = daysSince(ctx.firstOrderDeliveredAt, now);
      if (d != null && d >= 21 && d <= 45) {
        return { message_type: 'first_order_checkin', reason: `first order delivered ${d}d ago` };
      }
    }
    if (state === 'active' && ctx.lastOrderAt && daysSince(ctx.lastOrderAt, now) >= 90 && ctx.orderCount > 1) {
      return { message_type: 'reorder_nudge', reason: `${daysSince(ctx.lastOrderAt, now)}d since last order` };
    }
    if (state === 'dormant' && !ctx.newCollectionSinceDormant) {
      return { message_type: 'reactivation', reason: 'dormant 180d+, no new-collection event intervened' };
    }
  }

  // --- org track ------------------------------------------------------------
  if (isOrg) {
    const window = seasonalWindow(now);
    if (state === 'active' && window) {
      const last = ctx.lastOutboundAt ? daysSince(ctx.lastOutboundAt, now) : Infinity;
      const hasProgram = company.program_flags && Object.values(company.program_flags).some(Boolean);
      const threshold = hasProgram ? 180 : 330;
      if (last >= threshold) {
        return { message_type: 'community_checkin', reason: `${window} window, ${last === Infinity ? 'no prior' : last + 'd since'} outbound` };
      }
    }
    if (ctx.purchaseSignalAt && daysSince(ctx.purchaseSignalAt, now) >= 30 && !ctx.lastPurchaseAt) {
      return { message_type: 'purchase_pitch', reason: 'purchase interest signalled 30d+ ago, no order' };
    }
    if (ctx.lastPurchaseAt && daysSince(ctx.lastPurchaseAt, now) >= 330) {
      return { message_type: 'purchase_pitch', reason: 'annual funding-cycle window (330d+ since last purchase)' };
    }
    if (state === 'active' && !(company.program_flags || {}).affiliate
        && ctx.activeSince && daysSince(ctx.activeSince, now) >= 60 && !sent.has('affiliate_invite')) {
      return { message_type: 'affiliate_invite', reason: 'active 60d+ in a program, affiliate not enrolled' };
    }
  }

  // --- affiliate track ------------------------------------------------------
  if (isAffiliate && state === 'active') {
    const lastPrompt = lastSent('content_prompt');
    if (!lastPrompt || daysSince(lastPrompt, now) >= 30) {
      return { message_type: 'content_prompt', reason: 'monthly content prompt due' };
    }
  }
  if (isAffiliate && state === 'dormant'
      && ctx.daysSinceLastAttribution != null && ctx.daysSinceLastAttribution >= 90) {
    return { message_type: 'affiliate_reactivation', reason: `${ctx.daysSinceLastAttribution}d since last attributed sale` };
  }

  return null;
}

module.exports = {
  NEXT_ACTION_DAYS,
  nextActionDateAfterSend,
  businessDaysSince,
  daysSince,
  seasonalWindow,
  companyEligible,
  evaluateDue,
};
