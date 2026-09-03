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
  // After a second unanswered follow-up the ladder ENDS — see exhaustedDecision,
  // which retires a lead or hands a live relationship to the operator. This 180d
  // is only the backstop for the window between that send and the next draft
  // pass, and for the case where the pass has not run at all: it keeps the
  // company on the books at Tier 5 rather than dropping it silently.
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
  community_checkin: 365,
  affiliate_invite: 60,
  content_prompt: 30,
  performance_checkin: 30,
  reactivation: 180,
  affiliate_reactivation: 180,
  event_donation_response: 7,
  post_call_followup: 14,
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

/**
 * Is `now` on a later Eastern-Time calendar day than `then`? PURE.
 *
 * The post-call follow-up is due "the next morning", not the moment the call
 * ends — writing the wrap-up an hour after hanging up reads eager in the wrong
 * way, and the operator was probably ON the call. en-CA renders YYYY-MM-DD, so
 * string comparison is date comparison.
 */
function laterEasternDay(then, now = new Date()) {
  if (!then) return false;
  const day = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'America/Toronto' });
  return day(now) > day(then);
}

/**
 * A follow-up after a held call stops being "great talking with you" at some
 * point — past this the moment is missed and whatever outreach makes sense is
 * an operator judgment (the relationship summary still names the call), not a
 * standing Tier-1 nag.
 */
const POST_CALL_MAX_AGE_DAYS = 30;

/**
 * The wrap-up after a call that happened: due from the next ET morning until
 * anything at all goes out to them. Returns a due entry or null. PURE.
 *
 * Deliberately NOT an initiating type — no AI draft is ever generated for it.
 * The call is the strongest case of the initiate-vs-continue rule: the facts
 * that matter happened in a conversation no model was on, so the entry opens
 * the composer (with the partner-onboarding template preselected in the
 * panel). ANY outbound after the meeting ends clears it, including a manual
 * Gmail send the reconcile imports — the operator following up by hand is the
 * job being done, not a different job.
 */
function postCallFollowupDue(ctx, now = new Date()) {
  const meeting = ctx?.lastHeldMeeting;
  if (!meeting) return null;
  const ended = meeting.ends_at || meeting.starts_at;
  if (!ended) return null;
  if (ctx.lastOutboundAt && new Date(ctx.lastOutboundAt) > new Date(ended)) return null;
  const age = daysSince(ended, now);
  if (age > POST_CALL_MAX_AGE_DAYS) return null;
  if (!laterEasternDay(ended, now)) return null;
  return {
    message_type: 'post_call_followup',
    reason: `call held ${age <= 1 ? 'yesterday' : `${age}d ago`}, nothing sent since — write the follow-up`,
    thread_id: meeting.thread_id || null,
    waiting_since: ended,
    meeting_id: meeting.id || null,
  };
}

/** Seasonal windows for community_checkin (locked catalog entry). */
/**
 * Partner check-ins happen once a year, in October, as one sitting.
 *
 * The old three-window calendar (Pride, back-to-school, year-end) paired with a
 * 180-day threshold produced roughly two check-ins a year on a rolling per-org
 * date. Two things were wrong with that. Pride is when these orgs are least
 * able to reply, and summer is when student-run ones are empty — so two of the
 * three windows were poorly chosen. And a rolling date scatters twenty
 * check-ins across the year at one every few weeks, which is the shape of work
 * that never gets done; a single annual sitting does.
 *
 * October clears Pride, the summer, and the start of the school year.
 */
function seasonalWindow(now = new Date()) {
  return now.getUTCMonth() + 1 === 10 ? 'annual_checkin' : null;
}

/**
 * The opening message of a relationship, whichever channel it went out on.
 * The follow-up ladder hangs off whichever of these was sent.
 */
const FIRST_TOUCH_TYPES = ['intro_pitch', 'intro_outreach', 'affiliate_intro', 're_approach'];

// The initiate-vs-continue line (2026-09-02): messages WE originate are
// AI-drafted automatically the night they become due and reviewed before send;
// anything continuing a live conversation (a Tier-1 reply, a reopened thread)
// is operator-written — the advisor kept asserting things it could not know
// ("Wednesday works") and the edits cost more than the drafting saved.
// intro_pitch (retailer cold intro) is deliberately absent until the locked
// template treatment reaches retailers.
const INITIATING_TYPES = ['intro_outreach', 'community_checkin', 're_approach', 'reorder_nudge'];

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
 * The follow-up ladder chases an ASK that went unanswered. These are the message
 * types that constitute one, mapped to how long we wait (in BUSINESS days)
 * before chasing.
 *
 * Two families, deliberately different beats. A cold opener is a lead being
 * worked and a week is already generous. A seasonal check-in to a partner we
 * ship donation boxes to is not a sales sequence — "how are things going?"
 * chased after five days reads as pestering, so relationship types wait twice as
 * long.
 *
 * Absent on purpose: `price_change_notice` and `new_collection` are notices
 * rather than questions, `content_prompt` already repeats monthly,
 * `event_donation_response` is us answering THEM, and `reply_close` is the
 * graceful end of a conversation they declined. Chasing that last one is the
 * exact failure the all-time `answered` flag was introduced to prevent, and
 * excluding it here is what lets that flag be narrowed back to something useful
 * (see followUpRung).
 */
const CHASE_AFTER_BUSINESS_DAYS = {
  intro_pitch: 5,
  intro_outreach: 5,
  affiliate_intro: 5,
  re_approach: 5,
  community_checkin: 10,
  donation_closet_pitch: 10,
  post_samples_checkin: 10,
  first_order_checkin: 10,
  reorder_nudge: 10,
  sample_feedback_request: 10,
  referral_ask: 10,
  // The post-call follow-up ASKS (sign the agreement, return the survey), and
  // an org going quiet right after a good call is the standing failure mode —
  // so the ladder chases it on the relationship beat.
  post_call_followup: 10,
};

/** Business days between rungs, and between the last rung and giving up. */
const FOLLOWUP_2_AFTER_BUSINESS_DAYS = 10;
const EXHAUSTED_AFTER_BUSINESS_DAYS = 10;

/**
 * How old the unanswered ask may be before chasing it stops making sense.
 *
 * Past this it is not a follow-up, it is a re-approach — a different message
 * that opens a new door rather than pretending the last one is still swinging.
 * Same reasoning as SAMPLES_CHECKIN_MAX_AGE_DAYS above. It is also the guard
 * that keeps the imported backlog out: threads whose last outbound is 189 or
 * 1575 days old are a case-by-case operator decision, not cadence work.
 */
const FOLLOWUP_MAX_AGE_DAYS = 90;

/**
 * Which outbound sources the ladder is willing to chase.
 *
 * A manual Gmail send reconciles in with `message_type` null and `source`
 * 'manual_send', so it carries no statement of what was asked — it could be an
 * intro, a shipping answer, or a goodbye. Chasing one means guessing, and the
 * cost of guessing wrong is "just following up!" landing on a conversation that
 * ended. Restricting the anchor to engine sends is what makes the rest of this
 * safe to run unattended. Widening it is a deliberate decision that needs the
 * manual sends classified first, not a config change.
 */
const CHASEABLE_SOURCES = new Set(['send_tool']);

/**
 * Gate conditions every cadence message shares (locked + drafted spec):
 * not lost, not deferred (snoozed / paused / on me), contact known,
 * no pending draft.
 */
function companyEligible(company, { hasPendingDraft, upcomingMeetingAt } = {}, now = new Date()) {
  if (!company) return false;
  if (company.relationship_state === 'lost') return false;
  // A call is booked. Nothing the cadence would START is appropriate underneath
  // a scheduled conversation — the relationship is not stalled, it is waiting
  // for a date. Same shape as On Me: it suppresses what the engine would begin,
  // and (per computeQueueEntry) never suppresses a reply that arrives meanwhile.
  if (upcomingMeetingAt && new Date(upcomingMeetingAt) > now) return false;
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
 * Has a human answered the ask we are about to chase? PURE.
 *
 * Scoped to the anchor, NOT to all of history. It used to be `!!lastInboundAt` —
 * any inbound ever — which silently disabled the ladder for every company we
 * have ever had a conversation with. P10 Qc last wrote in 2022, RISE @ LA in
 * 2025; both were sent a seasonal check-in in August 2026 and both were
 * permanently ineligible for a follow-up on the strength of those old replies.
 * The queue showed nothing, so it read as "nothing due" rather than as a bug.
 *
 * The all-time version existed to stop one real failure: an org declines, we
 * send a graceful close, our close is newer than their reply, and a timestamp
 * comparison re-arms the ladder to chase someone who already said no. That case
 * is now handled where it belongs — `reply_close` is not a chaseable anchor at
 * all — which lets the comparison be a comparison again.
 *
 * Auto-replies, calendar RSVPs and DSNs are already excluded from lastInboundAt
 * upstream, so a vacation responder still counts as silence.
 */
function answeredSince(ctx, anchorAt) {
  if (!anchorAt || !ctx?.lastInboundAt) return false;
  return new Date(ctx.lastInboundAt) > new Date(anchorAt);
}

/**
 * A live relationship is handed to the operator; a lead is retired. PURE.
 *
 * `active` is the line because it is the state that means a real relationship
 * exists — an org we ship donation boxes to, or a retailer who buys. Retiring
 * one of those because a seasonal check-in went unread would mute the engine on
 * exactly the relationship worth keeping.
 */
function isLiveRelationship(company) {
  return company?.relationship_state === 'active';
}

/**
 * The follow-up ladder: one rung per call, or null. PURE.
 *
 * Anchored on the last outbound MESSAGE rather than on "the first-touch type
 * ever sent". The old anchor meant the ladder only ever chased an intro, so
 * `community_checkin`, `donation_closet_pitch`, `reorder_nudge` and the rest got
 * no chase at all — the August 2026 partner round was booked for its next touch
 * in February 2027.
 *
 * Returns null (rather than the exhausted decision) once both rungs are spent;
 * see exhaustedDecision, which is an ACTION the draft pass takes and not queue
 * work to show an operator.
 */
function followUpRung(company, ctx, now = new Date()) {
  const type = ctx.lastOutboundType;
  const at = ctx.lastOutboundMessageAt;
  if (!type || !at) return null;
  if (!CHASEABLE_SOURCES.has(ctx.lastOutboundSource)) return null;
  if (daysSince(at, now) > FOLLOWUP_MAX_AGE_DAYS) return null;
  if (answeredSince(ctx, at)) return null;

  // Thread the chase. Without this the follow-up goes out as a brand-new email
  // and "just following up on my note below" arrives with no note below it.
  const thread_id = ctx.lastOutboundThreadId || null;
  const waited = daysSince(at, now);

  if (type === 'followup_2') return null; // exhausted — see exhaustedDecision
  if (type === 'followup_1') {
    if (businessDaysSince(at, now) < FOLLOWUP_2_AFTER_BUSINESS_DAYS) return null;
    return { message_type: 'followup_2', reason: `no reply ${waited}d after first follow-up`, thread_id };
  }
  const wait = CHASE_AFTER_BUSINESS_DAYS[type];
  if (!wait) return null;
  if (businessDaysSince(at, now) < wait) return null;
  return { message_type: 'followup_1', reason: `no reply ${waited}d after ${type}`, thread_id };
}

/**
 * Both rungs spent and still silent — what now? Returns
 * { decision: 'retire'|'hand_off', reason, note } or null. PURE.
 *
 * Deliberately NOT part of evaluateDue: neither outcome is a message, so neither
 * belongs in a queue of things to say. The draft pass applies it.
 *
 * `retire` writes an indefinite outreach pause, never `relationship_state`.
 * `lost` would claim they went away or said no, which is false for someone who
 * simply never replied, and it destroys the state we would need to resume.
 *
 * `hand_off` claims the company for the operator with a note. The note carries
 * only the durable fact — a count and a date, true forever — because what to DO
 * about it comes live from the relationship summary's next step, and a sentence
 * written once decays on the one list whose defining problem is age.
 */
function exhaustedDecision(company, ctx, now = new Date()) {
  if (ctx.lastOutboundType !== 'followup_2') return null;
  const at = ctx.lastOutboundMessageAt;
  if (!at) return null;
  if (!CHASEABLE_SOURCES.has(ctx.lastOutboundSource)) return null;
  if (answeredSince(ctx, at)) return null;
  if (businessDaysSince(at, now) < EXHAUSTED_AFTER_BUSINESS_DAYS) return null;

  const run = ctx.unansweredRun || 0;
  const since = ctx.unansweredRunSince || at;
  const when = new Date(since).toISOString().slice(0, 10);
  if (isLiveRelationship(company)) {
    return {
      decision: 'hand_off',
      reason: `${run} unanswered since ${when} — engine has nothing left to try`,
      // Points at the likely cause: for an org, a run of unanswered messages
      // usually means the person we had on file has moved on.
      note: `${run} unanswered since ${when}; contact may have moved on`,
    };
  }
  return {
    decision: 'retire',
    reason: `no reply to ${run} messages since ${when}`,
  };
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

  // --- post-call follow-up --------------------------------------------------
  // A call that just happened is the freshest signal in the book, so it
  // outranks every other cadence track. (A reply that landed after the call
  // never reaches here — computeQueueEntry returns Tier 1 first.)
  const postCall = postCallFollowupDue(ctx, now);
  if (postCall) return postCall;

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

  // Is an engine outreach sequence in flight (or just spent) on this company?
  //
  // `firstTouch` alone cannot answer that: it looks for a first-touch type in
  // sentTypes, and once the newest send is `followup_1`/`followup_2` — or a
  // seasonal check-in to a partner we never formally introduced ourselves to —
  // there may be no first-touch type there at all. Without this guard a company
  // mid-ladder falls into the branch below and gets a cold "let me introduce
  // RUBIES" underneath its own follow-up sequence.
  //
  // Keyed on the engine having sent it, so a prospect whose only history is an
  // old manual email still gets its first touch — that cohort is deliberately
  // out of the ladder's scope, not out of the queue.
  const ladderOwns = CHASEABLE_SOURCES.has(ctx.lastOutboundSource)
    && (ctx.lastOutboundType === 'followup_1'
      || ctx.lastOutboundType === 'followup_2'
      || !!CHASE_AFTER_BUSINESS_DAYS[ctx.lastOutboundType]);

  if (!firstTouch && !ladderOwns) {
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
  }

  // The ladder runs whether or not a typed first touch exists: what it chases is
  // the last unanswered ASK, and for a partner we have shipped boxes to for
  // years that is a seasonal check-in, not an introduction we never sent.
  const rung = followUpRung(company, ctx, now);
  if (rung) return rung;

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
      // ~10 months, so a partner checked in last October is due again this
      // October and one contacted since is not. Deliberately below 365 so the
      // window cannot be missed by a few days and slip a whole year.
      const threshold = 300;
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
  INITIATING_TYPES,
  CHASE_AFTER_BUSINESS_DAYS,
  CHASEABLE_SOURCES,
  FOLLOWUP_MAX_AGE_DAYS,
  FOLLOWUP_2_AFTER_BUSINESS_DAYS,
  EXHAUSTED_AFTER_BUSINESS_DAYS,
  POST_CALL_MAX_AGE_DAYS,
  laterEasternDay,
  postCallFollowupDue,
  firstTouchType,
  nextActionDateAfterSend,
  businessDaysSince,
  daysSince,
  seasonalWindow,
  companyEligible,
  answeredSince,
  isLiveRelationship,
  followUpRung,
  exhaustedDecision,
  evaluateDue,
};
