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

test('seasonalWindow maps the locked windows', () => {
  assert.equal(seasonalWindow(new Date('2026-06-10T00:00:00Z')), 'pride');
  assert.equal(seasonalWindow(new Date('2026-08-20T00:00:00Z')), 'back_to_school');
  assert.equal(seasonalWindow(new Date('2026-11-15T00:00:00Z')), 'year_end');
  assert.equal(seasonalWindow(new Date('2026-10-05T00:00:00Z')), null);
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
  const ctx = { sentTypes: new Set(), orderCount: 1, firstOrderDeliveredAt: '2026-05-15T00:00:00Z' };
  const due = evaluateDue(retailer(), ctx, NOW);
  assert.equal(due.message_type, 'first_order_checkin');
  ctx.sentTypes = new Set(['first_order_checkin']);
  assert.equal(evaluateDue(retailer(), ctx, NOW), null);
});

test('reactivation only when no new_collection intervened', () => {
  const c = retailer({ relationship_state: 'dormant' });
  assert.equal(evaluateDue(c, { sentTypes: new Set(), newCollectionSinceDormant: false }, NOW).message_type, 'reactivation');
  assert.equal(evaluateDue(c, { sentTypes: new Set(), newCollectionSinceDormant: true }, NOW), null);
});

test('community_checkin: seasonal window + 180d for program orgs, 330d for giveaway-only', () => {
  const programOrg = org({ program_flags: { donation_closet: true } });
  const due = evaluateDue(programOrg, { sentTypes: new Set(), lastOutboundAt: '2025-11-01T00:00:00Z' }, NOW);
  assert.equal(due.message_type, 'community_checkin');
  assert.match(due.reason, /pride/);
  // giveaway-only org, 200d since touch: not due (threshold 330)
  const giveawayOrg = org({ program_flags: {} });
  assert.equal(evaluateDue(giveawayOrg, { sentTypes: new Set(), lastOutboundAt: '2025-11-22T00:00:00Z' }, NOW), null);
});

test('purchase_pitch: 30d after unconverted signal, and annual cycle for past purchasers', () => {
  const signal = evaluateDue(org(), { sentTypes: new Set(), purchaseSignalAt: '2026-05-01T00:00:00Z' }, new Date('2026-10-10T00:00:00Z'));
  assert.equal(signal.message_type, 'purchase_pitch');
  const annual = evaluateDue(org(), { sentTypes: new Set(), lastPurchaseAt: '2025-07-01T00:00:00Z' }, new Date('2026-10-10T00:00:00Z'));
  assert.equal(annual.message_type, 'purchase_pitch');
  assert.match(annual.reason, /annual/);
});

test('affiliate content_prompt monthly; reactivation at 90d no attribution', () => {
  const aff = { relationship_type: 'affiliate', relationship_state: 'active', program_flags: {} };
  assert.equal(evaluateDue(aff, { sentTypes: new Set(), lastTypeSentAt: () => null }, NOW).message_type, 'content_prompt');
  assert.equal(evaluateDue(aff, { sentTypes: new Set(), lastTypeSentAt: () => '2026-06-01T00:00:00Z' }, NOW), null);
  const dormant = { ...aff, relationship_state: 'dormant' };
  assert.equal(evaluateDue(dormant, { sentTypes: new Set(), lastTypeSentAt: () => null, daysSinceLastAttribution: 120 }, NOW).message_type, 'affiliate_reactivation');
});

test('org with affiliate program flag gets affiliate cadence too', () => {
  const orgAff = org({ program_flags: { affiliate: true } });
  const due = evaluateDue(orgAff, { sentTypes: new Set(), lastTypeSentAt: () => null, lastOutboundAt: '2026-06-01T00:00:00Z' }, new Date('2026-10-05T00:00:00Z'));
  // outside seasonal window, affiliate prompt picks up
  assert.equal(due.message_type, 'content_prompt');
});
