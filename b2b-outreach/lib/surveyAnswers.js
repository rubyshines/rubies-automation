/**
 * surveyAnswers.js — what a donation onboarding submission tells us about the
 * ORG, written onto their b2b_companies row.
 *
 * Three questions were added to the form on 2026-09-11. Two of them are facts
 * about the org that the outreach side wants and previously had no way to learn:
 *
 *   "How do people get gender affirming items from you?"  → program_profile,
 *      so a new partner self-classifies at intake and nobody has to read a
 *      call recording to find out whether there is an open door.
 *   "Do you make occasional purchases for gender affirming gear?" → a budget
 *      signal, which changes the conversation: an org that buys is a different
 *      email from an org that only receives.
 *   "Would you be interested in joining an affiliate program?" → recorded, and
 *      deliberately kept away from the advisor. See below.
 *
 * Two placements are deliberate and worth not undoing:
 *
 * NOT program_flags. That column says which RUBIES programme a company is IN,
 * and `PROGRAMME_FLAGS` (donation_closet / purchases / affiliate) is read by
 * computeCompanyState to promote relationship_state to 'active' — a promotion it
 * never reverses. Writing `affiliate: true` for somebody who ticked "I'd be
 * interested" would mark them an active member of a programme that does not
 * exist. Interest is not membership, and `purchases` there means orders we can
 * see in Shopify, not an intention someone stated on a form.
 *
 * Affiliate interest NEVER reaches the advisor. The affiliate programme does not
 * exist and must never be offered (2026-08-13, after the prompts went on
 * describing it as live for months). There is nothing for a draft to do with
 * this answer except mention something we cannot deliver, so it stays operator-
 * only: the panel and the submissions review show it, the advisor context does
 * not carry it at all. When the programme is built, this is the ready list.
 */
const { normalizeDomain } = require('../sync/syncB2bCompanyState');
const { programTypeFromDistribution } = require('../../customer-service/lib/donationPartnerSurvey');
const { setProgramProfile, normalizeName } = require('./programProfile');

/** Did they answer yes? Pure. Null when unanswered, so "no" and "not asked" differ. */
function isYes(answer) {
  if (!answer) return null;
  return /^\s*(yes|yep|yeah|sure|definitely|absolutely|interested|maybe)/i.test(String(answer));
}

/**
 * Their ticks, as the line the panel shows. PURE.
 *
 * Their own words, lightly joined — no model, and nothing added. A multi-select
 * answer arrives comma-joined from Google Forms, which is already a sentence
 * once the first letter is left alone and the separators are made readable.
 */
function lineFromDistribution(answer) {
  if (!answer) return null;
  const parts = String(answer).split(/\s*,\s*/).map(p => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  const joined = parts.length === 1
    ? parts[0]
    : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1].replace(/^./, c => c.toLowerCase())}`;
  const line = joined.replace(/\.$/, '');
  // The panel shows one line; a long "Other" answer is truncated rather than
  // rejected, because refusing to record a real answer is the worse failure.
  return line.length > 155 ? `${line.slice(0, 152)}...` : line;
}

/**
 * Find the b2b_companies row for a submission. Domain first, exactly as every
 * other join across these two stores; an exact name match only when the
 * submission carries no identifying domain, and only when it is unambiguous.
 */
async function findCompanyForSubmission(sb, row) {
  const { data: companies, error } = await sb.from('b2b_companies')
    .select('id, name, website, relationship_type, metadata, program_profile')
    .eq('relationship_type', 'lgbtq_org');
  if (error) throw new Error(`b2b_companies: ${error.message}`);

  const domain = normalizeDomain(row.website);
  if (domain) {
    const hit = (companies || []).find(c => normalizeDomain(c.website) === domain);
    return hit || null;
  }
  const name = normalizeName(row.name);
  const byName = (companies || []).filter(c => normalizeName(c.name) === name);
  return byName.length === 1 ? byName[0] : null;
}

/**
 * Write a submission's org-facts onto their company row.
 *
 * Fail-soft by contract: a submission that matches no company is a finding, not
 * an error — plenty of orgs fill in the donation form before the outreach book
 * has ever heard of them, and failing the ingest over it would block a partner
 * from being created for a reason that has nothing to do with donations.
 */
async function applySurveyAnswers(sb, row) {
  const company = await findCompanyForSubmission(sb, row);
  if (!company) {
    return { applied: false, reason: 'no matching company in the outreach book', company_id: null };
  }

  const applied = [];

  // The distribution answer IS the programme profile — self-classified, at
  // intake, with no reading step. An answer nobody recognises stores as unknown
  // with their words kept, never as a guess.
  const type = programTypeFromDistribution(row.distribution);
  if (type) {
    await setProgramProfile(company.id, {
      type,
      line: type === 'unknown' ? null : lineFromDistribution(row.distribution),
      sources: [{ kind: 'survey', at: row.timestamp || null, label: 'donation onboarding survey' }],
      evidence_through: row.timestamp ? new Date(row.timestamp).toISOString() : null,
      sb,
    });
    applied.push(`programme profile → ${type}`);
  }

  // Stated facts live on metadata beside the other things orgs have told us
  // (stated_next_touch, referred_by). Existing keys are preserved: this is one
  // submission's answers, not the whole of what we know about them.
  const meta = typeof company.metadata === 'string'
    ? (() => { try { return JSON.parse(company.metadata); } catch { return {}; } })()
    : (company.metadata || {});
  const onboarding = {
    ...(meta.onboarding || {}),
    ...(row.makes_purchases ? { makes_purchases: row.makes_purchases, buys_gear: isYes(row.makes_purchases) } : {}),
    ...(row.affiliate_interest ? { affiliate_interest: row.affiliate_interest, affiliate_yes: isYes(row.affiliate_interest) } : {}),
    ...(row.timestamp ? { answered_at: row.timestamp } : {}),
  };
  if (row.makes_purchases) applied.push(`buys gear: ${isYes(row.makes_purchases) ? 'yes' : 'no'}`);
  if (row.affiliate_interest) applied.push(`affiliate interest: ${isYes(row.affiliate_interest) ? 'yes' : 'no'} (recorded only — the programme does not exist)`);

  if (Object.keys(onboarding).length) {
    const { error } = await sb.from('b2b_companies')
      .update({ metadata: { ...meta, onboarding }, updated_at: new Date().toISOString() })
      .eq('id', company.id);
    if (error) throw new Error(`b2b_companies update: ${error.message}`);
  }

  return { applied: applied.length > 0, company_id: company.id, company_name: company.name, changes: applied };
}

module.exports = {
  applySurveyAnswers, findCompanyForSubmission, lineFromDistribution, isYes,
};
