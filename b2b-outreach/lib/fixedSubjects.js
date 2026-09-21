/**
 * fixedSubjects.js — the A/B subject lines for initiating messages.
 *
 * The model never writes the subject of an initiating message that is under
 * test: the A/B read is only clean if the strings are byte-identical across
 * sends, so the assigned variant is rendered here and overrides whatever the
 * model returned (outreachAdvisor) or is the only subject there ever was
 * (messageTemplates, for the zero-model retailer re-approach). One table for
 * every channel so the report (reply within 14 days by variant, bounces
 * excluded) reads the same way for orgs and retailers.
 *
 * A retired variant keeps its entry so the report can still print what a
 * finished round said; `variantsFor` is what rotation reads, and it skips
 * them.
 *
 * Every pair varies ONE thing. Org intro: statement to the org vs question to
 * its community. Retailer intro: about us vs about their customers. Retailer
 * re-approach after samples: whether the samples are mentioned at all — both
 * say what RUBIES makes, because ten months on the kit may have gone to
 * whoever handled the inbox that week, and a subject that assumes they
 * remember it reads as spam to anyone who does not (Jamie, 2026-09-08).
 *
 * No dependencies on purpose: both the advisor and the templates module
 * require this, and either requiring the other would cycle.
 */

const FIXED_SUBJECTS = {
  intro_outreach: {
    subject_a: (name) => `Gender-affirming clothing donations for ${name}`,
    subject_b: () => 'Could your community use gender-affirming clothing donations?',
  },
  // Round 2, 2026-09-21. The pair now varies exactly one thing: whether the
  // line is described by who WEARS it or by who BUYS it for them. Round 1's
  // pitch_a confounded that question with the word "wholesale" and the brand
  // name; "wholesale" made a cold email read as a sales blast in the first two
  // seconds, so it is gone from both arms (Jamie, 2026-09-21). "A free sample
  // kit for <store>" was an earlier B and read as junk mail (2026-09-09).
  intro_pitch: {
    pitch_wearer: () => 'Gender-affirming underwear and swimwear for trans women and girls',
    pitch_customers: () => 'Gender-affirming underwear and swimwear for your trans customers',
    pitch_a: () => 'Gender-affirming underwear and swimwear for trans women and girls, wholesale from RUBIES',
    pitch_b: () => 'Gender-affirming underwear and swimwear for your trans customers',
  },
  // Only the sampled-retailer template carries these; an org re_approach is an
  // Opus draft with a model-written subject (queueService.assignVariant gates).
  re_approach: {
    samples_a: () => 'Gender-affirming underwear and swimwear for trans women and girls, wholesale from RUBIES',
    samples_b: (name, { when = 'last fall' } = {}) => `The gender-affirming underwear samples we sent ${name} ${when}`,
  },
};

/**
 * Variants that no longer get assigned but must still RENDER: the A/B report
 * reads a subject for every variant_id it finds on a sent message, and those
 * rows are the history of the round that has already gone out. Retiring by
 * deletion would leave the report unable to say what the old arm actually
 * said, which is the one thing a finished round is for.
 */
const RETIRED_VARIANTS = {
  intro_pitch: new Set(['pitch_a', 'pitch_b']), // round 1, retired 2026-09-21
};

/** Whether a variant is still in rotation. Pure. */
function isRetired(message_type, variant_id) {
  return Boolean(RETIRED_VARIANTS[message_type]?.has(variant_id));
}

/** The variant ids a message type rotates through, in rotation order. Pure. */
function variantsFor(message_type) {
  return Object.keys(FIXED_SUBJECTS[message_type] || {})
    .filter(v => !isRetired(message_type, v));
}

/** The fixed subject for a type + variant, or null when the pair is unknown. Pure. */
function fixedSubjectFor(message_type, variant_id, name, opts = {}) {
  const render = FIXED_SUBJECTS[message_type]?.[variant_id];
  return render ? render(name, opts) : null;
}

/**
 * Which variant the next draft of a type gets: whichever has been used least,
 * first in rotation order on a tie. Drafts of every status count — a dismissed
 * or superseded intro already spent its slot, and counting only sends would let
 * regenerations pile onto one arm. Pure.
 */
function pickVariant(message_type, counts = {}) {
  const variants = variantsFor(message_type);
  if (!variants.length) return null;
  return variants.reduce((best, v) => ((counts[v] || 0) < (counts[best] || 0) ? v : best), variants[0]);
}

module.exports = { FIXED_SUBJECTS, RETIRED_VARIANTS, isRetired, variantsFor, fixedSubjectFor, pickVariant };
