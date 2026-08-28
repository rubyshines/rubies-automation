const { test } = require('node:test');
const assert = require('node:assert');
const {
  nextActionDateAfterSend, businessDaysSince, seasonalWindow,
  companyEligible, evaluateDue,
} = require('../../b2b-outreach/lib/cadence');

const NOW = new Date('2026-06-10T12:00:00Z'); // Wednesday, pride window

function retailer(over = {}) {
  return { relationship_type: 'wholesale', relationship_state: 'active', program_flags: {}, ...over };
}
function org(over = {}) {
  return { relationship_type: 'lgbtq_org', relationship_state: 'active', program_flags: {}, ...over };
}

test('nextActionDateAfterSend uses per-type table', () => {
  assert.equal(nextActionDateAfterSend('reorder_nudge', new Date('2026-06-10T12:00:00Z')), '2026-09-08');
  assert.equal(nextActionDateAfterSend('intro_pitch', new Date('2026-06-10T12:00:00Z')), '2026-06-17');
});

test('businessDaysSince skips weekends', () => {
  // Fri Jun 5 → Wed Jun 10 = Mon, Tue, Wed = 3 business days
  assert.equal(businessDaysSince(new Date('2026-06-05T00:00:00Z'), NOW), 3);
});

test('partner check-ins happen once a year, in October', () => {
  // Was three windows (Pride, back-to-school, year-end) on a rolling per-org
  // date. Pride is when these orgs are least able to reply and summer is when
  // student-run ones are empty, so two of the three were badly chosen; and a
  // rolling date scatters twenty check-ins across the year at one every few
  // weeks, which is the shape of work that never gets done.
  assert.equal(seasonalWindow(new Date('2026-10-05T00:00:00Z')), 'annual_checkin');
  assert.equal(seasonalWindow(new Date('2026-10-31T00:00:00Z')), 'annual_checkin');
  ['2026-06-10', '2026-08-20', '2026-09-30', '2026-11-01'].forEach((d) => {
    assert.equal(seasonalWindow(new Date(d + 'T00:00:00Z')), null, d);
  });
});

test('gates: lost, snoozed, contact_unknown, pending draft all block', () => {
  assert.equal(companyEligible(retailer({ relationship_state: 'lost' }), {}, NOW), false);
  assert.equal(companyEligible(retailer({ snoozed_until: '2026-07-01' }), {}, NOW), false);
  assert.equal(companyEligible(retailer({ contact_unknown: true }), {}, NOW), false);
  assert.equal(companyEligible(retailer(), { hasPendingDraft: true }, NOW), false);
  assert.equal(companyEligible(retailer({ snoozed_until: '2026-06-01' }), {}, NOW), true); // lapsed snooze re-enters
});

test('post_samples_checkin: 5 business days after delivery, once', () => {
  const c = retailer({ relationship_state: 'in_contact', samples_delivered_at: '2026-06-02T00:00:00Z' });
  const due = evaluateDue(c, { sentTypes: new Set() }, NOW);
  assert.equal(due.message_type, 'post_samples_checkin');
  const again = evaluateDue(c, { sentTypes: new Set(['post_samples_checkin']) }, NOW);
  assert.equal(again, null);
});

test('post_samples_checkin fallback: 10 calendar days after ship with no delivery event', () => {
  const c = retailer({ relationship_state: 'in_contact', samples_shipped_at: '2026-05-25T00:00:00Z' });
  const due = evaluateDue(c, { sentTypes: new Set() }, NOW);
  assert.equal(due.message_type, 'post_samples_checkin');
  assert.match(due.reason, /assumed delivered/);
});

test('reorder_nudge at 90d for repeat-order active retailers only', () => {
  const c = retailer();
  const due = evaluateDue(c, { sentTypes: new Set(), lastOrderAt: '2026-03-01T00:00:00Z', orderCount: 3 }, NOW);
  assert.equal(due.message_type, 'reorder_nudge');
  const firstOrderOnly = evaluateDue(c, { sentTypes: new Set(), lastOrderAt: '2026-03-01T00:00:00Z', orderCount: 1 }, NOW);
  assert.notEqual(firstOrderOnly?.message_type, 'reorder_nudge');
});

test('first_order_checkin in the 21-45d window, never repeats', () => {
  const ctx = { sentTypes: new Set(), orderCount: 1, firstOrderFulfilledAt: '2026-05-15T00:00:00Z' };
  const due = evaluateDue(retailer(), ctx, NOW);
  assert.equal(due.message_type, 'first_order_checkin');
  ctx.sentTypes = new Set(['first_order_checkin']);
  assert.equal(evaluateDue(retailer(), ctx, NOW), null);
});

test('first_order_checkin needs the fulfillment date the sync now supplies', () => {
  // Regression: the branch gated on ctx.firstOrderDeliveredAt, which
  // buildContexts never set — so it was unreachable for the engine's whole life.
  const ctx = { sentTypes: new Set(), orderCount: 1, firstOrderFulfilledAt: null };
  assert.equal(evaluateDue(retailer(), ctx, NOW), null);
});

test('reactivation only when no new_collection intervened', () => {
  const c = retailer({ relationship_state: 'dormant' });
  assert.equal(evaluateDue(c, { sentTypes: new Set(), newCollectionSinceDormant: false }, NOW).message_type, 'reactivation');
  assert.equal(evaluateDue(c, { sentTypes: new Set(), newCollectionSinceDormant: true }, NOW), null);
});

test('community_checkin: October, and only ~10 months since we last wrote', () => {
  const OCT = new Date('2026-10-08T00:00:00Z');
  const partner = org({ program_flags: { donation_closet: true } });

  const due = evaluateDue(partner, { sentTypes: new Set(), lastOutboundAt: '2025-10-01T00:00:00Z' }, OCT);
  assert.equal(due.message_type, 'community_checkin');
  assert.match(due.reason, /annual_checkin/);

  // Contacted in the August sweep: nowhere near due, and must not fire in the
  // very next window. This is the case that decides whether the annual rhythm
  // actually holds.
  assert.equal(evaluateDue(partner, { sentTypes: new Set(), lastOutboundAt: '2026-08-20T00:00:00Z' }, OCT), null);

  // Long overdue, but it is not October: wait for the sitting.
  assert.equal(evaluateDue(partner, { sentTypes: new Set(), lastOutboundAt: '2025-01-01T00:00:00Z' },
    new Date('2026-06-10T00:00:00Z')), null);

  // The threshold no longer depends on which programmes they are in.
  const giveawayOnly = org({ program_flags: {} });
  assert.equal(evaluateDue(giveawayOnly, { sentTypes: new Set(), lastOutboundAt: '2025-10-01T00:00:00Z' }, OCT).message_type,
    'community_checkin');
});

test('removed branches stay removed — they never had context to fire on', () => {
  // purchase_pitch (both forms), affiliate_invite and affiliate_reactivation
  // gated on ctx fields buildContexts never set. Deleted 2026-07-29; this test
  // exists so reinstating one without its context fails loudly.
  const at = '2026-05-01T00:00:00Z';
  // Deliberately NOT October: this test is about branches that can never fire,
  // and October is now the partner check-in window, which fires legitimately.
  const now = new Date('2026-07-10T00:00:00Z');
  assert.equal(evaluateDue(org(), { sentTypes: new Set(), purchaseSignalAt: at }, now), null);
  assert.equal(evaluateDue(org(), { sentTypes: new Set(), lastPurchaseAt: '2025-07-01T00:00:00Z' }, now), null);
  assert.equal(evaluateDue(org({ relationship_state: 'active' }),
    { sentTypes: new Set(), activeSince: '2025-01-01T00:00:00Z', lastOutboundAt: at }, now), null);
  const dormantAff = { relationship_type: 'affiliate', relationship_state: 'dormant', program_flags: {} };
  assert.equal(evaluateDue(dormantAff, { sentTypes: new Set(), lastTypeSentAt: () => null, daysSinceLastAttribution: 120 }, NOW), null);
});

test('affiliate content_prompt is monthly', () => {
  const aff = { relationship_type: 'affiliate', relationship_state: 'active', program_flags: {} };
  assert.equal(evaluateDue(aff, { sentTypes: new Set(), lastTypeSentAt: () => null }, NOW).message_type, 'content_prompt');
  assert.equal(evaluateDue(aff, { sentTypes: new Set(), lastTypeSentAt: () => '2026-06-01T00:00:00Z' }, NOW), null);
});

test('org with affiliate program flag gets affiliate cadence too', () => {
  const orgAff = org({ program_flags: { affiliate: true } });
  const due = evaluateDue(orgAff, { sentTypes: new Set(), lastTypeSentAt: () => null, lastOutboundAt: '2026-06-01T00:00:00Z' }, new Date('2026-10-05T00:00:00Z'));
  // outside seasonal window, affiliate prompt picks up
  assert.equal(due.message_type, 'content_prompt');
});

// ── Tier 4: first touch, admission gate, and the follow-up ladder ───────────

/** ctx defaults for a company with no message history at all. */
const freshCtx = (over = {}) => ({ sentTypes: new Set(), lastTypeSentAt: () => null, ...over });

/**
 * ctx for a company whose NEWEST message is an engine send of `type` at `at`,
 * unanswered since.
 *
 * The ladder anchors on the last outbound message, so these fields — not
 * `sentTypes` — are what arms it. The old anchor was "the first-touch type ever
 * sent", which is why a ctx carrying only sentTypes no longer chases.
 */
const afterSend = (type, at, over = {}) => freshCtx({
  sentTypes: new Set([type]),
  lastTypeSentAt: t => (t === type ? at : null),
  lastOutboundType: type,
  lastOutboundSource: 'send_tool',
  lastOutboundMessageAt: at,
  lastOutboundThreadId: 'th-1',
  lastOutboundAt: at,
  unansweredRun: 1,
  unansweredRunSince: at,
  ...over,
});

test('a vetted prospect gets the first touch for its channel', () => {
  assert.equal(evaluateDue(retailer({ relationship_state: 'prospect', vetted_at: '2026-06-01T00:00:00Z' }), freshCtx(), NOW).message_type, 'intro_pitch');
  assert.equal(evaluateDue(org({ relationship_state: 'prospect', vetted_at: '2026-06-01T00:00:00Z' }), freshCtx(), NOW).message_type, 'intro_outreach');
  const aff = { relationship_type: 'affiliate', relationship_state: 'prospect', program_flags: {}, vetted_at: '2026-06-01T00:00:00Z' };
  assert.equal(evaluateDue(aff, freshCtx(), NOW).message_type, 'affiliate_intro');
});

test('an unvetted prospect never surfaces — vetted_at is the admission gate', () => {
  // This is what keeps ~120 unenriched CenterLink rows out of the panel while
  // the 23 donation-form orgs go through.
  assert.equal(evaluateDue(org({ relationship_state: 'prospect', vetted_at: null }), freshCtx(), NOW), null);
});

test('a vetted prior relationship with no engine history gets re_approach, not an intro', () => {
  const c = retailer({ relationship_state: 'in_contact', vetted_at: '2026-06-01T00:00:00Z' });
  const due = evaluateDue(c, freshCtx({ lastOutboundAt: null }), NOW);
  assert.equal(due.message_type, 're_approach');
  // Once the engine has sent anything, it is no longer a re-approach candidate.
  assert.equal(evaluateDue(c, freshCtx({ lastOutboundAt: '2026-06-01T00:00:00Z' }), NOW), null);
});

test('follow-up 1 after 5 business days of silence, follow-up 2 after 10 more', () => {
  const c = retailer({ relationship_state: 'prospect', vetted_at: '2026-05-01T00:00:00Z' });
  // Intro sent Wed Jun 3 → Wed Jun 10 is 5 business days.
  assert.equal(evaluateDue(c, afterSend('intro_pitch', '2026-06-03T00:00:00Z'), NOW).message_type, 'followup_1');
  // Too soon: only 2 business days.
  assert.equal(evaluateDue(c, afterSend('intro_pitch', '2026-06-08T00:00:00Z'), NOW), null);
  // followup_1 sent Mon May 25 → Wed Jun 10 is 12 business days.
  assert.equal(evaluateDue(c, afterSend('followup_1', '2026-05-25T00:00:00Z'), NOW).message_type, 'followup_2');
});

test('the chase threads the message it chases', () => {
  // Without the thread the follow-up goes out as a brand-new email, so "just
  // following up on my note below" arrives with no note below it.
  const c = retailer({ relationship_state: 'prospect', vetted_at: '2026-05-01T00:00:00Z' });
  assert.equal(evaluateDue(c, afterSend('intro_pitch', '2026-06-03T00:00:00Z'), NOW).thread_id, 'th-1');
});

test('the ladder stops after followup_2 — we stop asking', () => {
  const c = retailer({ relationship_state: 'prospect', vetted_at: '2026-05-01T00:00:00Z' });
  assert.equal(evaluateDue(c, afterSend('followup_2', '2026-05-01T00:00:00Z'), NOW), null);
});

test('a reply stops the ladder — chasing someone who answered is wrong', () => {
  const c = retailer({ relationship_state: 'prospect', vetted_at: '2026-05-01T00:00:00Z' });
  // They replied; Tier 1 or a live thread owns this now.
  const answered = afterSend('intro_pitch', '2026-06-01T00:00:00Z', { lastInboundAt: '2026-06-02T00:00:00Z' });
  assert.equal(evaluateDue(c, answered, NOW), null);
});

test('an OLD reply does not stop the ladder — the comparison is against the anchor', () => {
  // The regression this whole change exists for. `answered` used to be
  // `!!lastInboundAt` — any inbound EVER — so a partner who wrote to us in 2022
  // could never be chased about a check-in sent last week, and the queue showed
  // nothing rather than showing a bug.
  const partner = org({ relationship_state: 'active', program_flags: { donation_closet: true } });
  const ctx = afterSend('community_checkin', '2026-05-20T00:00:00Z', { lastInboundAt: '2022-05-12T00:00:00Z' });
  assert.equal(evaluateDue(partner, ctx, NOW).message_type, 'followup_1');
});

test('follow-up outranks the ongoing-relationship tracks', () => {
  // An unanswered intro must never sit behind a reorder nudge.
  const c = retailer({ relationship_state: 'active', vetted_at: '2026-05-01T00:00:00Z', metadata: {} });
  const ctx = afterSend('intro_pitch', '2026-06-03T00:00:00Z', {
    lastOrderAt: '2025-01-01T00:00:00Z', orderCount: 3, // reorder_nudge would otherwise fire
  });
  assert.equal(evaluateDue(c, ctx, NOW).message_type, 'followup_1');
});

// ── samples staleness bound ────────────────────────────────────────────────

test('post_samples_checkin fires on fresh samples but not stale ones', () => {
  const fresh = retailer({ relationship_state: 'in_contact', samples_shipped_at: '2026-05-20T00:00:00Z' });
  assert.equal(evaluateDue(fresh, freshCtx(), NOW).message_type, 'post_samples_checkin');
  // The Nov 2025 $0 sample orders: backfilled samples_shipped_at must NOT make
  // 15 retailers due for a "how did the samples go?" nine months late.
  const stale = retailer({ relationship_state: 'in_contact', samples_shipped_at: '2025-11-04T00:00:00Z' });
  assert.equal(evaluateDue(stale, freshCtx(), NOW), null);
});

test('a stale sample recipient becomes a re_approach candidate once vetted', () => {
  const stale = retailer({
    relationship_state: 'in_contact', samples_shipped_at: '2025-11-04T00:00:00Z',
    vetted_at: '2026-06-01T00:00:00Z',
  });
  assert.equal(evaluateDue(stale, freshCtx({ lastOutboundAt: null }), NOW).message_type, 're_approach');
});

test('fresh samples outrank re_approach — do not reopen a door that is still open', () => {
  const fresh = retailer({
    relationship_state: 'in_contact', samples_shipped_at: '2026-05-20T00:00:00Z',
    vetted_at: '2026-06-01T00:00:00Z',
  });
  assert.equal(evaluateDue(fresh, freshCtx({ lastOutboundAt: null }), NOW).message_type, 'post_samples_checkin');
});

test('new first-touch types have next_action_date entries', () => {
  const sentAt = new Date('2026-06-10T12:00:00Z');
  assert.equal(nextActionDateAfterSend('re_approach', sentAt), '2026-06-17');
  assert.equal(nextActionDateAfterSend('followup_1', sentAt), '2026-06-24');
  assert.equal(nextActionDateAfterSend('followup_2', sentAt), '2026-12-07', 'goes quiet for 180d, not forever');
});

// ── duplicate-org guard ─────────────────────────────────────────────────────

test('no cold intro when a duplicate row for the same org is already engaged', () => {
  // BAGLY exists twice: an active donation partner, and a bare CenterLink row
  // with a different address. The second must never get a cold introduction.
  const c = org({ relationship_state: 'prospect', vetted_at: '2026-06-01T00:00:00Z' });
  assert.equal(evaluateDue(c, freshCtx({ hasEngagedSibling: true }), NOW), null);
  assert.equal(evaluateDue(c, freshCtx({ hasEngagedSibling: false }), NOW).message_type, 'intro_outreach');
});

test('the sibling guard also blocks re_approach, not just intros', () => {
  const c = retailer({ relationship_state: 'in_contact', vetted_at: '2026-06-01T00:00:00Z' });
  assert.equal(evaluateDue(c, freshCtx({ lastOutboundAt: null, hasEngagedSibling: true }), NOW), null);
});

test('the sibling guard never blocks an in-flight follow-up', () => {
  // Suppressing the OPENER is right; abandoning a sequence we already started
  // would leave a prospect hanging mid-conversation.
  const c = org({ relationship_state: 'prospect', vetted_at: '2026-05-01T00:00:00Z' });
  const ctx = afterSend('intro_outreach', '2026-06-03T00:00:00Z', { hasEngagedSibling: true });
  assert.equal(evaluateDue(c, ctx, NOW).message_type, 'followup_1');
});

test('the sibling guard suppresses only the opener, not ongoing cadence', () => {
  // Regression: an early `return null` also killed community_checkin for four
  // active partners that happen to have a duplicate row.
  const partner = org({
    relationship_state: 'active', program_flags: { donation_closet: true },
  });
  // In the October window, and last written to a year before it.
  const due = evaluateDue(partner, freshCtx({
    hasEngagedSibling: true, lastOutboundAt: '2025-10-01T00:00:00Z',
  }), new Date('2026-10-08T00:00:00Z'));
  assert.equal(due.message_type, 'community_checkin');
});

test('a decline ends the ladder even when our close is the newest message', () => {
  // TransActual: they declined, we sent a graceful close, and the advisor
  // labelled that close `intro_outreach` — a first-touch type. Under the old
  // timestamp comparison our close was newer than their reply, so the ladder
  // re-armed and would have chased an org that had just said no.
  const c = org({ relationship_state: 'prospect', vetted_at: '2026-05-01T00:00:00Z' });
  const ctx = freshCtx({
    sentTypes: new Set(['intro_outreach']),
    lastTypeSentAt: () => '2026-06-05T00:00:00Z', // our close, newer than their reply
    lastInboundAt: '2026-06-02T00:00:00Z',        // their decline
  });
  assert.equal(evaluateDue(c, ctx, NOW), null);
});

test('one human reply retires the ladder permanently', () => {
  const c = org({ relationship_state: 'prospect', vetted_at: '2026-05-01T00:00:00Z' });
  const replied = freshCtx({
    sentTypes: new Set(['intro_outreach', 'followup_1']),
    lastTypeSentAt: () => '2026-05-20T00:00:00Z',
    lastInboundAt: '2026-05-21T00:00:00Z',
  });
  assert.equal(evaluateDue(c, replied, NOW), null, 'followup_2 must not fire after they engaged');
});

// ── Booked calls ────────────────────────────────────────────────────────────
// A company with a call coming up is not stalled, it is waiting for a date, so
// nothing the cadence would START is appropriate underneath it.
test('an upcoming booked call suppresses the cadence', () => {
  const c = retailer({ relationship_state: 'in_contact', samples_delivered_at: '2026-06-02T00:00:00Z' });
  const ctx = { sentTypes: new Set() };
  // Without a meeting this company is due a post-samples checkin…
  assert.equal(evaluateDue(c, ctx, NOW).message_type, 'post_samples_checkin');
  // …and with one booked, it is not.
  assert.equal(evaluateDue(c, { ...ctx, upcomingMeetingAt: '2026-06-15T14:00:00Z' }, NOW), null);
  assert.equal(companyEligible(c, { upcomingMeetingAt: '2026-06-15T14:00:00Z' }, NOW), false);
});

test('a call already in the past does not suppress anything', () => {
  // The call happened; the relationship is live again and the cadence resumes.
  const c = retailer({ relationship_state: 'in_contact', samples_delivered_at: '2026-06-02T00:00:00Z' });
  assert.equal(companyEligible(c, { upcomingMeetingAt: '2026-06-01T14:00:00Z' }, NOW), true);
  assert.equal(
    evaluateDue(c, { sentTypes: new Set(), upcomingMeetingAt: '2026-06-01T14:00:00Z' }, NOW).message_type,
    'post_samples_checkin',
  );
});

test('no meeting field at all behaves exactly as before', () => {
  // The field is optional context; its absence must not change any decision.
  const c = retailer();
  assert.equal(companyEligible(c, {}, NOW), true);
  assert.equal(companyEligible(c, { upcomingMeetingAt: null }, NOW), true);
});

// Guard for the standing trap: cadence may only read context buildContexts sets.
test('buildContexts assembles every field companyEligible reads', () => {
  const src = require('fs').readFileSync(require.resolve('../../b2b-outreach/lib/queueContext.js'), 'utf8');
  for (const field of ['hasPendingDraft', 'upcomingMeetingAt']) {
    assert.ok(src.includes(field), `buildContexts must set ${field} — cadence reads it`);
  }
});
