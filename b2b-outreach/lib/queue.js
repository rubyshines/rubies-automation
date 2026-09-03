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

/** "5h" under two days, then "3d" — queue rows read in days, not raw hours. */
function humanAge(date, now = new Date()) {
  const hours = Math.round((now - new Date(date)) / 3600000);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

const TIER_BY_TYPE = {
  // Tier 2 — time-sensitive
  post_samples_checkin: 2,
  first_order_checkin: 2,
  performance_checkin: 2, // when signal-driven; cadence form maps to 3 below
  price_change_notice: 2,
  event_donation_response: 1, // inbound-triggered; normally surfaces via Tier 1 anyway
  inbound_inquiry_response: 1, // inbound-triggered (org/retailer wrote to us first)
  post_call_followup: 1, // a call just happened — they are waiting on the wrap-up
  // Tier 3 — healthy cadence
  reorder_nudge: 3,
  new_collection: 3,
  community_checkin: 3,
  donation_closet_pitch: 3,
  content_prompt: 3,
  sample_feedback_request: 3,
  referral_ask: 3,
  // Tier 4 — prospect first-touch and the follow-up ladder hanging off it.
  // Follow-ups share the tier: chasing a reply to an intro we already sent is
  // the same work as the intro, and must not sort below fresh first-touches.
  intro_pitch: 4,
  intro_outreach: 4,
  affiliate_intro: 4,
  re_approach: 4,
  followup_1: 4,
  followup_2: 4,
  // Tier 6 — revival
  reactivation: 6,
};

/**
 * When outreach to this company was last deliberately deferred, or null. PURE.
 *
 * Three flavours of one intent — "not from the queue, not right now" — differing
 * in how they end and in who holds the work:
 *   - snooze  — dated. `snoozed_until` lifts it automatically ("we just spoke,
 *               come back in six weeks").
 *   - pause   — indefinite. Only an explicit resume lifts it ("not working
 *               Canadian retailers this year").
 *   - on me   — indefinite, and the work is still LIVE: Jamie has claimed it
 *               rather than set it down. It lifts when he sends, puts it back,
 *               or they write again.
 * A lapsed snooze is not a deferral any more, so it stops suppressing.
 *
 * The LATEST stamp wins when more than one applies, because the only thing this
 * value does is judge whether an unanswered reply is stale (below), and the
 * operator's most recent decision is the one that saw the most mail.
 */
function deferredSince(company, now = new Date()) {
  if (!company) return null;
  const stamps = [company.outreach_paused_at, company.on_me_at];
  if (company.snoozed_until && new Date(company.snoozed_until) > now) {
    // Older rows were snoozed before set-time was recorded. Falling back to the
    // snooze END date would suppress a reply that arrived during the snooze, so
    // an unknown set-time suppresses nothing.
    stamps.push(company.snoozed_at || null);
  }
  const live = stamps.filter(Boolean).sort();
  return live.length ? live[live.length - 1] : null;
}

/**
 * Did they write to us after `stamp`? PURE.
 *
 * The single expression of the rule that governs every deferral: deciding not to
 * chase someone clears the mail that was already sitting there, and can never
 * silence a human who writes afterwards. Every caller reads it from here rather
 * than spelling out the comparison, because two copies of this rule is exactly
 * how one of them ends up hiding a reply.
 *
 * Note what it does NOT decide (2026-08-26): whether an On Me claim survives.
 * That was its second job, and it was the wrong one — see fetchOnMe. This
 * function only ever answers "is the mail newer than the decision", which is a
 * question about SUPPRESSION and nothing else.
 */
function replyLandedAfter(ctx, stamp) {
  if (!stamp || !ctx?.lastInboundAt) return false;
  return new Date(ctx.lastInboundAt) > new Date(stamp);
}

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

  // Tier 1 — they replied, we haven't answered.
  //
  // Deferring outreach is the only thing that can suppress it, and only for mail
  // that was already sitting there when the deferral was set. That is most of the
  // point: The Bra Room's 170-day-old reply is not outstanding once you have
  // decided not to work Canada, and Fenway's 72-day-old one is not outstanding
  // once you have spoken to them on the phone. Both were unclearable before,
  // because Tier 1 outranked everything.
  //
  // A message arriving AFTER the deferral always surfaces, whichever kind it is.
  // Deferring means "stop chasing them", never "stop telling me when a human
  // writes" — this system has already left four partners waiting, one for 332
  // days, and a control that could silence a live correspondent would rebuild
  // that failure deliberately. On Me is held to the same rule for the same
  // reason, and it is the deferral where breaking it would be easiest to excuse:
  // "I know, it's on my list" is precisely the sentiment that left them waiting.
  const deferredAt = deferredSince(company, now);
  const staleReply = !!deferredAt && !!ctx.lastInboundAt && !replyLandedAfter(ctx, deferredAt);

  if (!staleReply && ctx.lastInboundAt
    && (!ctx.lastOutboundAt || new Date(ctx.lastInboundAt) > new Date(ctx.lastOutboundAt))) {
    return {
      tier: 1,
      message_type: null, // advisor reads the thread and decides
      reason: `replied ${humanAge(ctx.lastInboundAt, now)} ago — waiting on us`,
      waiting_since: ctx.lastInboundAt,
      // Thread the reply — without this the draft stored thread_id null and
      // sendB2bEmail sent the reply as a brand-new email outside the thread.
      thread_id: ctx.lastInboundThreadId || null,
    };
  }

  // Tier 1 — we have no working address for them.
  //
  // ABOVE the eligibility gate on purpose, because the gate is what hides them:
  // `contact_unknown` makes companyEligible() false, and nothing else in the
  // panel renders the flag, so a company whose only contact bounced or resigned
  // dropped silently out of the system entirely. That is worse than the miss it
  // was meant to handle — the engine went quiet about a partner precisely when
  // it had learned something urgent about them.
  //
  // Deferral still wins (see above): deciding not to work a relationship covers
  // not chasing a dead address at it. The usual case never reaches here — a
  // bounce with an alternate on file revives its draft and returns through
  // mergePendingDraftEntries at the tier frozen on that row. This branch is for
  // when there is nothing left to revive: a manual send that bounced, or every
  // address exhausted.
  if (company.contact_unknown && !deferredAt) {
    const since = ctx.lastUndeliveredAt || ctx.lastOutboundAt || null;
    return {
      tier: 1,
      message_type: null,
      reason: since
        ? `no working address — last send bounced ${humanAge(since, now)} ago`
        : 'no working address — last contact bounced or left',
      waiting_since: since,
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
      // Follow-ups carry the thread of the message they chase. Dropping it here
      // is how a chase becomes a brand-new email that refers to one.
      ...(due.thread_id ? { thread_id: due.thread_id } : {}),
      // post_call_followup lands at Tier 1, whose within-tier sort reads
      // waiting_since; meeting_id is what the panel's "no follow-up needed"
      // dismiss acts on.
      ...(due.waiting_since ? { waiting_since: due.waiting_since } : {}),
      ...(due.meeting_id ? { meeting_id: due.meeting_id } : {}),
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
    if (entry) {
      out.push({
        company_id: company.id,
        company_name: company.name,
        channel: company.relationship_type,
        // Delivery channel never affects TIER — priority is signal-based, and
        // how we reach someone is not why they are urgent. It only breaks ties
        // within a tier (below) and tells the panel which controls to render.
        delivery: ctx.delivery || 'email',
        ...entry,
      });
    }
  }
  return out.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    // A real person waiting outranks tidiness: Tier 1 stays oldest-first.
    if (a.tier === 1) return new Date(a.waiting_since) - new Date(b.waiting_since);
    // Elsewhere, one-click sends first and form submissions last within the
    // tier. Same priority, but the manual ones cluster so they can be worked in
    // a single browser pass instead of breaking rhythm at random.
    const aManual = a.delivery === 'form' ? 1 : 0;
    const bManual = b.delivery === 'form' ? 1 : 0;
    return aManual - bManual;
  });
}

module.exports = {
  computeQueueEntry, assembleQueue, humanAge, deferredSince,
  replyLandedAfter, TIER_BY_TYPE,
};
