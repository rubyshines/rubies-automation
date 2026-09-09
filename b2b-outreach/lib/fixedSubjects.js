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
  // A is about us, B is about their customers (Jamie's own February 2026
  // line). "A free sample kit for <store>" was the first B and read as junk
  // mail (Jamie, 2026-09-09).
  intro_pitch: {
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

/** The variant ids a message type rotates through, in rotation order. Pure. */
function variantsFor(message_type) {
  return Object.keys(FIXED_SUBJECTS[message_type] || {});
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

module.exports = { FIXED_SUBJECTS, variantsFor, fixedSubjectFor, pickVariant };
