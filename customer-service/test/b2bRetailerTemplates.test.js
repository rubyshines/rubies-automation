/**
 * The retailer channel on locked templates (2026-09-09).
 *
 * The sampled-retailer re-approach is fixed text with three fills; the words
 * ARE the feature, so the body is asserted exactly. The A/B subject table is
 * shared by both channels and rotates on least-used; a referred company gets
 * no variant because the referral belongs in the subject.
 */
const { test } = require('node:test');
const assert = require('node:assert');

const {
  whenPhrase, fillRetailerReApproach, isRetailerSamplesReApproach,
} = require('../../b2b-outreach/lib/messageTemplates');
const { FIXED_SUBJECTS, variantsFor, fixedSubjectFor, pickVariant } = require('../../b2b-outreach/lib/fixedSubjects');
const { subjectFor, isReferred, introSubjectFor } = require('../../b2b-outreach/lib/outreachAdvisor');
const { INITIATING_TYPES } = require('../../b2b-outreach/lib/cadence');
const { SIGNATURE_BLOCK_MD } = require('../../customer-service/lib/signatures');

const NOW = new Date('2026-09-09T12:00:00Z');

test('whenPhrase says it the way a person would', () => {
  assert.equal(whenPhrase('2025-11-04T00:00:00Z', NOW), 'last fall');
  assert.equal(whenPhrase('2026-03-18T00:00:00Z', NOW), 'last spring');
  assert.equal(whenPhrase('2026-06-02T00:00:00Z', NOW), 'last summer');
  // The current season is not "last" anything.
  assert.equal(whenPhrase('2026-09-03T00:00:00Z', NOW), 'recently');
  // Winter spans the year boundary and is "last winter" until the next one is near.
  assert.equal(whenPhrase('2025-12-15T00:00:00Z', NOW), 'last winter');
  // Older than about a year names the month and year instead.
  assert.equal(whenPhrase('2025-04-08T00:00:00Z', NOW), 'in April 2025');
  assert.equal(whenPhrase('garbage', NOW), 'recently');
});

test('the sampled-retailer re-approach body is the locked text, exactly', () => {
  const { body, attachments } = fillRetailerReApproach({ firstName: 'Carmen', storeName: 'Grail Bra Specialists', when: 'last fall' });
  assert.equal(body,
    'Hi Carmen,\n\n'
    + "I'm Jamie, founder of RUBIES. We make gender-affirming underwear and swimwear for trans women and girls, "
    + 'designed to feel like regular clothing, no tucking or compression needed. '
    + 'The brand started with my own trans daughter, who could not find anything that worked.\n\n'
    + 'Last fall we sent Grail Bra Specialists a sample kit and I would love to hear what you thought of the items.\n\n'
    + 'Our wholesale terms are 50% off retail with free shipping. '
    + 'Let me know if you have any questions or if you would like to set up a quick conversation.\n\n'
    + `Talk soon,\n\n${SIGNATURE_BLOCK_MD}`);
  assert.deepEqual(attachments, []);
  // No em dashes anywhere in customer-facing text.
  assert.ok(!/[—–]/.test(body));
  // No name on file: the standard fallback greeting.
  assert.match(fillRetailerReApproach({ firstName: 'there', storeName: 'X', when: 'recently' }).body, /^Hi there,\n\nI'm Jamie/);
  assert.match(fillRetailerReApproach({ firstName: 'there', storeName: 'X', when: 'recently' }).body, /Recently we sent X a sample kit/);
});

test('only a retailer re_approach with a kit on record takes the template', () => {
  const entry = { message_type: 're_approach' };
  assert.equal(isRetailerSamplesReApproach({ relationship_type: 'wholesale', samples_shipped_at: '2025-11-04' }, entry), true);
  assert.equal(isRetailerSamplesReApproach({ relationship_type: 'wholesale', samples_shipped_at: null }, entry), false);
  assert.equal(isRetailerSamplesReApproach({ relationship_type: 'lgbtq_org', samples_shipped_at: '2025-11-04' }, entry), false);
  assert.equal(isRetailerSamplesReApproach({ relationship_type: 'wholesale', samples_shipped_at: '2025-11-04' }, { message_type: 'intro_pitch' }), false);
});

test('fixed subjects: one table, both channels, one variable per pair', () => {
  assert.deepEqual(variantsFor('intro_outreach'), ['subject_a', 'subject_b']);
  assert.deepEqual(variantsFor('intro_pitch'), ['pitch_a', 'pitch_b']);
  assert.deepEqual(variantsFor('re_approach'), ['samples_a', 'samples_b']);
  assert.deepEqual(variantsFor('community_checkin'), []);
  assert.equal(fixedSubjectFor('intro_pitch', 'pitch_a', 'Babeland'),
    'Gender-affirming underwear and swimwear for trans women and girls, wholesale from RUBIES');
  assert.equal(fixedSubjectFor('intro_pitch', 'pitch_b', 'Babeland'), 'A free RUBIES sample kit for Babeland');
  assert.equal(fixedSubjectFor('re_approach', 'samples_b', 'Journelle', { when: 'last fall' }),
    'The gender-affirming underwear samples we sent Journelle last fall');
  assert.equal(fixedSubjectFor('re_approach', 'samples_a', 'Journelle'),
    fixedSubjectFor('intro_pitch', 'pitch_a', 'Journelle'), 'both A arms are the proven category line');
  assert.equal(fixedSubjectFor('intro_pitch', 'subject_a', 'Babeland'), null, 'variants do not cross types');
  // The org alias still answers the way it did.
  assert.equal(introSubjectFor('subject_a', 'Youth OUTright'), FIXED_SUBJECTS.intro_outreach.subject_a('Youth OUTright'));
  for (const type of Object.keys(FIXED_SUBJECTS)) for (const v of variantsFor(type)) {
    assert.ok(!/[—–]/.test(fixedSubjectFor(type, v, 'X')), `${type}/${v} has no em dash`);
  }
});

test('pickVariant takes the least-used arm, first in order on a tie', () => {
  assert.equal(pickVariant('intro_pitch', {}), 'pitch_a');
  assert.equal(pickVariant('intro_pitch', { pitch_a: 1 }), 'pitch_b');
  assert.equal(pickVariant('intro_pitch', { pitch_a: 3, pitch_b: 3 }), 'pitch_a');
  assert.equal(pickVariant('intro_pitch', { pitch_a: 4, pitch_b: 3 }), 'pitch_b');
  assert.equal(pickVariant('community_checkin', {}), null);
});

test('a referred company carries no fixed subject: the referral is the subject', () => {
  const referred = { name: 'Genderswap', metadata: { referred_by: 'AJ at TransActual' } };
  const cold = { name: 'Genderswap', metadata: {} };
  assert.equal(isReferred(referred), true);
  assert.equal(isReferred(cold), false);
  assert.equal(isReferred({ name: 'Sheet row', metadata: '{"referred_by":"someone"}' }), true, 'string metadata tolerated');
  assert.equal(subjectFor(referred, { message_type: 'intro_pitch', variant_id: 'pitch_a' }), null);
  assert.equal(subjectFor(cold, { message_type: 'intro_pitch', variant_id: 'pitch_a' }),
    'Gender-affirming underwear and swimwear for trans women and girls, wholesale from RUBIES');
  assert.equal(subjectFor(cold, { message_type: 'intro_pitch' }), null, 'no variant, model writes it');
});

test('intro_pitch is an initiating type: drafted nightly, reviewed before send', () => {
  assert.ok(INITIATING_TYPES.includes('intro_pitch'));
  assert.ok(INITIATING_TYPES.includes('re_approach'));
});
