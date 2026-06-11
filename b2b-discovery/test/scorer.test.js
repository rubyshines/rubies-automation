const { test } = require('node:test');
const assert = require('node:assert');
const { scoreProspect, getStatus, routeStatus } = require('../lib/scorer');

test('routeStatus: community-org + LGBTQ mention → community-partner (not dismissed)', () => {
  const analysis = { subcategory: 'community-org', mentionsLGBTQ: true, isRelevant: false };
  assert.strictEqual(routeStatus(analysis, 1, 5), 'community-partner');
});

test('routeStatus: community-org + trans mention → community-partner even at low score', () => {
  const analysis = { subcategory: 'community-org', mentionsTransOrGenderAffirming: true, isRelevant: false };
  assert.strictEqual(routeStatus(analysis, 2, 5), 'community-partner');
});

test('routeStatus: community-org with NO LGBTQ/trans relevance follows score routing', () => {
  const analysis = { subcategory: 'community-org', mentionsLGBTQ: false, mentionsTransOrGenderAffirming: false, isRelevant: true };
  assert.strictEqual(routeStatus(analysis, 3, 5), 'dismissed');
  assert.strictEqual(routeStatus(analysis, 7, 5), 'qualified');
});

test('routeStatus: non-org LGBTQ-relevant store routes by score, not to community-partner', () => {
  const analysis = { subcategory: 'general-boutique', mentionsLGBTQ: true, isRelevant: true };
  assert.strictEqual(routeStatus(analysis, 6, 5), 'qualified');
  assert.strictEqual(routeStatus(analysis, 4, 5), 'dismissed');
});

test('routeStatus: not relevant → dismissed regardless of score', () => {
  const analysis = { subcategory: 'general-boutique', isRelevant: false };
  assert.strictEqual(routeStatus(analysis, 9, 5), 'dismissed');
});

test('routeStatus: defaults threshold to 5', () => {
  const analysis = { subcategory: 'intimates', isRelevant: true };
  assert.strictEqual(routeStatus(analysis, 5), 'qualified');
  assert.strictEqual(routeStatus(analysis, 4), 'dismissed');
});

test('getStatus unchanged: threshold routing for retail prospects', () => {
  assert.strictEqual(getStatus(5, true, 5), 'qualified');
  assert.strictEqual(getStatus(4, true, 5), 'dismissed');
  assert.strictEqual(getStatus(10, false, 5), 'dismissed');
});

test('scoreProspect: strong trans-relevant store scores high', () => {
  const { score } = scoreProspect(
    {
      mentionsTransOrGenderAffirming: true,
      mentionsLGBTQ: true,
      carriesGenderProducts: true,
      carriesUnderwearOrSwimwear: true,
      independentlyOwned: true,
      hasPhysicalStore: true,
      isRelevant: true,
      _hasWebsite: true,
    },
    { emailType: 'personal', contactMethod: 'email' }
  );
  assert.strictEqual(score, 10);
});

test('scoreProspect: clamps to minimum 1', () => {
  const { score } = scoreProspect(
    { independentlyOwned: false, isRelevant: false, _hasWebsite: false },
    { contactMethod: 'none' }
  );
  assert.strictEqual(score, 1);
});
