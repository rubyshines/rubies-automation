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
  re_approach: 7,
  followup_1: 14,
  // After a second unanswered follow-up we stop asking. 180d puts the company
  // back on the Tier-5 overdue list next season rather than dropping it
  // silently — quiet, but still on the books.
  followup_2: 180,
  // Replying to a decline. Without an entry this inherits the 30-day default
  // and Tier 5 resurfaces an org that just said no, a month later, as an
  // overdue follow-up. They answered and the answer was no: go quiet for a
  // season, keep them on the books.
  reply_close: 180,
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

function nextActionDateAfterSend(messageType, sentAt = new Date(), overrideDays = null) {
  // The advisor may recommend timing from thread context ("reach back in
  // September", a comeback after a rough patch). Bounded so a bad model value
  // can't schedule absurdly (1 week to 1 year); null = the per-type table.
  const days = Number.isInteger(overrideDays)
    ? Math.min(365, Math.max(7, overrideDays))
    : (NEXT_ACTION_DAYS[messageType] ?? DEFAULT_NEXT_ACTION_DAYS);
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
 * The opening message of a relationship, whichever channel it went out on.
 * The follow-up ladder hangs off whichever of these was sent.
 */
const FIRST_TOUCH_TYPES = ['intro_pitch', 'intro_outreach', 'affiliate_intro', 're_approach'];

/** The first-touch type for a company's channel. Pure. */
function firstTouchType(company) {
  if (company.relationship_type === 'lgbtq_org') return 'intro_outreach';
  if (company.relationship_type === 'affiliate' || company.program_flags?.affiliate) return 'affiliate_intro';
  return 'intro_pitch';
}

/**
 * A samples event only justifies a "how did they go?" for so long. Backfilling
 * samples_shipped_at from the Nov 2025 $0 sample orders would otherwise make 15
 * retailers due for a checkin nine months late; past this bound they belong in
 * a re_approach instead, which opens a new door rather than pretending the
 * samples just landed.
 */
const SAMPLES_CHECKIN_MAX_AGE_DAYS = 60;

/**
 * Gate conditions every cadence message shares (locked + drafted spec):
 * not lost, not deferred (snoozed / paused / on me), contact known,
 * no pending draft.
 */
function companyEligible(company, { hasPendingDraft } = {}, now = new Date()) {
  if (!company) return false;
  if (company.relationship_state === 'lost') return false;
  // Paused: we have decided not to work this relationship for now. Distinct from
  // `lost` (they went away) and from snooze (a date we are waiting for) — this is
  // indefinite and ours to reverse. It stops everything the engine would START:
  // cadence, follow-ups, first touch. It does NOT hide the company, its history,
  // or a reply that arrives after the pause (see computeQueueEntry).
  if (company.outreach_paused_at) return false;
  // On Me: Jamie has claimed this one. Same effect as pause on everything the
  // engine would START — the last thing a company you have personally picked up
  // needs is the cadence writing it a cheerful unrelated nudge underneath you.
  // Unlike pause it does not clear an existing draft (see triage.js).
  if (company.on_me_at) return false;
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
 * @param ctx      derived context buildContexts computes:
 *   hasPendingDraft, lastOrderAt, orderCount, lastOutboundAt, lastInboundAt,
 *   sentTypes: Set of message_types ever sent to this company,
 *   lastTypeSentAt: (type)=>date|null,
 *   firstOrderDeliveredAt (first_order_checkin),
 *   postSamplesReplyAt (inbound reply to post_samples_checkin, if any)
 *
 * Every field this function reads must be one buildContexts actually sets —
 * seven branches were silently unreachable for months because they gated on
 * context that was never assembled.
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
  const samplesAt = company.samples_delivered_at || company.samples_shipped_at;
  const samplesFresh = samplesAt && daysSince(samplesAt, now) <= SAMPLES_CHECKIN_MAX_AGE_DAYS;
  if (state === 'in_contact' && !sent.has('post_samples_checkin') && samplesFresh) {
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

  // --- first touch and the follow-up ladder --------------------------------
  // Everything here is about opening a relationship, so it outranks the
  // ongoing-relationship tracks below. An unanswered intro must never sit
  // behind a reorder nudge.
  const firstTouch = FIRST_TOUCH_TYPES.find(t => sent.has(t));
  const firstTouchAt = firstTouch ? lastSent(firstTouch) : null;
  // The ladder chases SILENCE, so any genuine human reply ever ends it — not
  // just one newer than our last send. The timestamp comparison this replaces
  // was wrong in the case that matters most: an org declines, we send a
  // graceful close, and our close is now newer than their reply, so the ladder
  // would resume and chase someone who already said no. (Made concrete when a
  // Tier-1 close came back labelled `intro_outreach` — a first-touch type —
  // which re-armed the whole sequence.) Auto-replies are already excluded from
  // lastInboundAt upstream, so a vacation responder still counts as silence.
  const answered = !!ctx.lastInboundAt;

  if (!firstTouch) {
    // The imports created duplicate rows per org (BAGLY exists twice: an active
    // donation partner AND a bare CenterLink row with a different address).
    // Introducing ourselves to an existing partner at their info@ is the worst
    // email we could send, so the cold OPENER is suppressed while a sibling row
    // on the same domain already has a relationship. Scoped to this branch on
    // purpose: falling through leaves the ongoing-relationship tracks below
    // intact, so an active partner still gets its seasonal community_checkin.
    if (!ctx.hasEngagedSibling) {
      // vetted_at is the admission gate: Tier 4 only surfaces prospects a human
      // has actually looked at, so enriched and unenriched imports don't arrive
      // in the panel together.
      if (state === 'prospect' && company.vetted_at) {
        return { message_type: firstTouchType(company), reason: 'vetted prospect, never contacted' };
      }
      // Previously worked outside the engine (sheet history, samples sent) and
      // re-admitted by the operator: a new door, not a third follow-up.
      if (state === 'in_contact' && company.vetted_at && !ctx.lastOutboundAt) {
        return { message_type: 're_approach', reason: 'prior relationship, re-admitted after review' };
      }
    }
  } else if (!answered) {
    if (!sent.has('followup_1') && businessDaysSince(firstTouchAt, now) >= 5) {
      return { message_type: 'followup_1', reason: `no reply ${daysSince(firstTouchAt, now)}d after ${firstTouch}` };
    }
    const f1At = lastSent('followup_1');
    if (sent.has('followup_1') && !sent.has('followup_2') && f1At && businessDaysSince(f1At, now) >= 10) {
      return { message_type: 'followup_2', reason: `no reply ${daysSince(f1At, now)}d after first follow-up` };
    }
  }

  // --- retailer track ------------------------------------------------------
  if (isRetailer) {
    if (state === 'active' && ctx.orderCount === 1 && !sent.has('first_order_checkin')) {
      // Fulfillment, not delivery: the orders mirror has no delivery event
      // (that lives in tracking), and shipped-plus-three-weeks is close enough
      // to "have you had a chance to see how it sells?".
      const d = daysSince(ctx.firstOrderFulfilledAt, now);
      if (d != null && d >= 21 && d <= 45) {
        return { message_type: 'first_order_checkin', reason: `first order shipped ${d}d ago` };
      }
    }
    // Frequency-aligned: per-company threshold from the daily sync (0.75 ×
    // their latest order interval, clamped 90-365d); 90d when unknown.
    const reorderThreshold = company.metadata?.reorder_threshold_days || 90;
    if (state === 'active' && ctx.lastOrderAt && daysSince(ctx.lastOrderAt, now) >= reorderThreshold && ctx.orderCount > 1) {
      const rhythm = reorderThreshold !== 90 ? ` (their rhythm: ~${reorderThreshold}d)` : '';
      return { message_type: 'reorder_nudge', reason: `${daysSince(ctx.lastOrderAt, now)}d since last order${rhythm}` };
    }
    // NOTE: 'dormant' is not written by anything today — syncB2bCompanyState
    // promotes but never demotes, and the "derived at queue time" dormancy the
    // design assumed was never built. This branch is therefore unreachable
    // until dormancy derivation lands (parked). Kept rather than deleted
    // because the revival behaviour is designed and wanted; do not read its
    // presence as evidence that reactivation currently fires.
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
    // REMOVED 2026-07-29: purchase_pitch (both forms) and affiliate_invite.
    // They read as live features but could never fire — they gated on
    // ctx.purchaseSignalAt / ctx.lastPurchaseAt / ctx.activeSince, none of
    // which buildContexts has ever set. Reinstate alongside the context that
    // feeds them, not before.
  }

  // --- affiliate track ------------------------------------------------------
  if (isAffiliate && state === 'active') {
    const lastPrompt = lastSent('content_prompt');
    if (!lastPrompt || daysSince(lastPrompt, now) >= 30) {
      return { message_type: 'content_prompt', reason: 'monthly content prompt due' };
    }
  }
  // REMOVED 2026-07-29: affiliate_reactivation — gated on
  // ctx.daysSinceLastAttribution, which buildContexts never set. There is no
  // affiliate attribution feed yet; bring the branch back with one.

  return null;
}

module.exports = {
  NEXT_ACTION_DAYS,
  SAMPLES_CHECKIN_MAX_AGE_DAYS,
  FIRST_TOUCH_TYPES,
  firstTouchType,
  nextActionDateAfterSend,
  businessDaysSince,
  daysSince,
  seasonalWindow,
  companyEligible,
  evaluateDue,
};
