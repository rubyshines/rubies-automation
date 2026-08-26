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
