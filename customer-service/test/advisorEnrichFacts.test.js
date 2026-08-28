const test = require('node:test');
const assert = require('node:assert');

const { describeEnrichFacts } = require('../../b2b-outreach/lib/outreachAdvisor');

// These facts are read off an org's own website by an automated pass, usually
// for an org we have never spoken to. Rendered under the existing "Programs:"
// label they would read as a relationship we do not have, and a first touch
// would open as though a stranger were an established partner.

test('a clothing closet is described as THEIRS, not ours', () => {
  const line = describeEnrichFacts({ runs_clothing_program: true, serves_trans_community: true, site_appears_active: true });
  assert.match(line, /their OWN/, 'ownership of the programme must be unambiguous');
  assert.match(line, /not ours/);
  assert.match(line, /never verified/, 'the advisor must know this was not confirmed with them');
  assert.doesNotMatch(line, /^Programs:/);
});

test('an org with nothing notable produces no line at all', () => {
  // All-clear facts are the common case; narrating them wastes context and
  // invites the advisor to comment on them.
  assert.equal(describeEnrichFacts({ runs_clothing_program: false, serves_trans_community: true, site_appears_active: true }), null);
});

test('the negative signals are surfaced as cautions', () => {
  const notTrans = describeEnrichFacts({ serves_trans_community: false });
  assert.match(notTrans, /do not assume/);
  const dormant = describeEnrichFacts({ site_appears_active: false });
  assert.match(dormant, /dormant/);
  assert.match(dormant, /unconfirmed/);
});

test('describeEnrichFacts is silent on empty or malformed input', () => {
  [null, undefined, {}, 'nonsense', 42].forEach((v) => {
    assert.equal(describeEnrichFacts(v), null, String(v));
  });
});

// ── an absent record vs a record of absence ─────────────────────────────────
// Two matchers disagree about donation-partner status: syncB2bCompanyState
// sets program_flags.donation_closet by domain OR name, while the routing
// lookup is domain-only (a name match once fused a German org onto an American
// clinic). McMinnville has the flag, no website, and a partner row whose
// website is a bit.ly — so the flag said partner and the records said nothing.
// The advisor got silence and offered to START a programme that had already
// delivered 23 items across seven boxes.

const { renderDonationFacts } = require('../../b2b-outreach/lib/outreachAdvisor');

const partnerCo = { program_flags: { donation_closet: true } };

test('a partner whose shipment records did not load is flagged, not passed over', () => {
  const lines = renderDonationFacts(null, partnerCo).join('\n');
  assert.match(lines, /they ARE a partner/i);
  assert.match(lines, /NEVER offer to add them/);
  assert.match(lines, /never state or imply any count or date/i);
});

test('an org that is simply not a partner still gets nothing', () => {
  // A cold prospect must stay pitchable — the caution is only for the
  // ambiguous case, or it would suppress the donation-closet pitch entirely.
  assert.deepEqual(renderDonationFacts(null, { program_flags: {} }), []);
  assert.deepEqual(renderDonationFacts(null, {}), []);
  assert.deepEqual(renderDonationFacts(null, null), []);
});

test('real shipment records still win over the caution', () => {
  const lines = renderDonationFacts(
    { shipments: 7, items: 23, firstAt: '2026-06-03', lastAt: '2026-08-18' }, partnerCo).join('\n');
  assert.match(lines, /7 packages routed, 23 items/);
  assert.doesNotMatch(lines, /did not load/);
});
