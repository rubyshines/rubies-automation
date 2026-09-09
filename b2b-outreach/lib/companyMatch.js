/**
 * companyMatch.js — which company does an email address belong to?
 *
 * One answer for every caller. The inbound correlator (replyCorrelation.js)
 * and the calendar meeting sync (meetingSync.js) both have to turn an address
 * into a company, and two matchers over the same question WILL disagree
 * (domain Key Decision, 2026-08-28) — so the resolution lives here and both
 * call it.
 *
 * Order, most specific first:
 *   1. an exact b2b_contacts row
 *   2. a company's general_email
 *   3. the address's IDENTIFYING domain (emailDomains.js: free mail and
 *      shorteners identify nobody) against company websites, then against
 *      other contacts on file at that domain
 *
 * No match means no facts: the caller decides what to do with null, and it
 * is never a guess.
 */
const { identifyingDomain, emailDomain } = require('./emailDomains');

/** "Name <A@Foo.ORG>" → "a@foo.org". Pure. */
function normalizeAddress(address) {
  return String(address || '').toLowerCase().replace(/^.*</, '').replace(/>.*$/, '').trim();
}

/**
 * @returns {Promise<{company_id: string|null, matched_by: 'contact'|'general_email'|'domain_website'|'domain_peer'|null, address: string}>}
 */
async function resolveCompanyForAddress(sb, address) {
  const sender = normalizeAddress(address);
  if (!sender || !sender.includes('@')) return { company_id: null, matched_by: null, address: sender };

  const { data: contact } = await sb.from('b2b_contacts')
    .select('company_id').eq('email', sender).maybeSingle();
  if (contact?.company_id) return { company_id: contact.company_id, matched_by: 'contact', address: sender };

  const { data: byGeneral } = await sb.from('b2b_companies')
    .select('id').eq('general_email', sender).maybeSingle();
  if (byGeneral?.id) return { company_id: byGeneral.id, matched_by: 'general_email', address: sender };

  // Domain fallback. Exact-address matching alone silently drops mail from a
  // colleague of the person we have on file, and that is not an edge case: 16
  // of 45 uncorrelated threads were companies we already knew. Only an
  // identifying domain counts — a gmail.com sender would otherwise attach to
  // whichever company happened to have a gmail contact.
  const domain = identifyingDomain(sender);
  if (!domain) return { company_id: null, matched_by: null, address: sender };

  const { data: byWebsite } = await sb.from('b2b_companies')
    .select('id, website, relationship_state').ilike('website', `%${domain}%`);
  const site = (byWebsite || []).find(c => identifyingDomain(c.website) === domain
    && c.relationship_state !== 'lost');
  if (site) return { company_id: site.id, matched_by: 'domain_website', address: sender };

  const { data: peers } = await sb.from('b2b_contacts')
    .select('company_id, email').ilike('email', `%@${domain}`);
  const peer = (peers || []).find(c => emailDomain(c.email) === domain && c.company_id);
  if (peer) return { company_id: peer.company_id, matched_by: 'domain_peer', address: sender };

  return { company_id: null, matched_by: null, address: sender };
}

module.exports = { resolveCompanyForAddress, normalizeAddress };
