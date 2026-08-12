/**
 * emailDomains.js — which email/website domains identify a COMPANY, and which
 * are shared infrastructure that identifies nobody.
 *
 * Domain is the only identity key we trust across donation_partners,
 * b2b_companies and Gmail (name matching fused two unrelated orgs once already).
 * That only holds for domains a single organisation controls. Free mail and
 * link shorteners are shared by thousands, so treating one as identity would
 * fuse every org that happens to use it into a single "company" — the exact
 * failure the domain rule exists to prevent.
 *
 * Both lists are real observations, not hypotheticals: the imports produced
 * company rows whose `website` was `gmx.net` (a German mail provider) and
 * `bit.ly` (a shortener), and grouped unrelated individuals under `gmail.com`.
 */

// Consumer mailbox providers. A person at one of these is an individual, never
// evidence of which organisation they belong to.
const FREE_MAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'yahoo.co.nz', 'yahoo.ca',
  'ymail.com', 'hotmail.com', 'hotmail.co.uk', 'outlook.com', 'live.com', 'msn.com',
  'icloud.com', 'me.com', 'mac.com', 'aol.com', 'gmx.net', 'gmx.com', 'gmx.de',
  'web.de', 'mail.com', 'zoho.com', 'yandex.com', 'pm.me', 'proton.me',
  'protonmail.com', 'protonmail.ch', 'tutanota.com', 'fastmail.com', 'hey.com',
  'comcast.net', 'verizon.net', 'sbcglobal.net', 'bellsouth.net', 'cox.net',
  'shaw.ca', 'rogers.com', 'sympatico.ca', 'telus.net', 'btinternet.com',
  'mozmail.com', 'duck.com', 'anonaddy.me', 'simplelogin.com',
]);

// Shorteners, social profiles and page builders. These show up in the `website`
// column because an importer took whatever link the org published, and a bare
// one of these is shared by everybody who used the service.
const NON_IDENTIFYING_DOMAINS = new Set([
  'bit.ly', 'tinyurl.com', 't.co', 'linktr.ee', 'lnk.bio', 'beacons.ai',
  'facebook.com', 'm.facebook.com', 'fb.me', 'instagram.com', 'twitter.com',
  'x.com', 'linkedin.com', 'tiktok.com', 'youtube.com',
  'sites.google.com', 'docs.google.com', 'drive.google.com', 'forms.gle',
  'wordpress.com', 'wixsite.com', 'squarespace.com', 'weebly.com',
  'godaddysites.com', 'blogspot.com', 'notion.site', 'carrd.co',
]);

/** "Name <A@Foo.ORG>" → "foo.org". Null when there is no usable domain. Pure. */
function emailDomain(address) {
  const raw = String(address || '').toLowerCase().replace(/^.*</, '').replace(/>.*$/, '').trim();
  const at = raw.lastIndexOf('@');
  if (at < 0) return null;
  const domain = raw.slice(at + 1).trim();
  return domain.includes('.') ? domain : null;
}

/**
 * Is this domain shared infrastructure rather than one organisation's identity?
 * `wordpress.com` is listed, but `thprojekt.wordpress.com` is NOT generic: the
 * subdomain belongs to one org, so only an exact match counts.
 */
function isGenericDomain(domain) {
  const d = String(domain || '').toLowerCase().replace(/^www\./, '');
  if (!d) return true;
  return FREE_MAIL_DOMAINS.has(d) || NON_IDENTIFYING_DOMAINS.has(d);
}

/** The domain to identify a company by, or null when it identifies nobody. Pure. */
function identifyingDomain(addressOrUrl) {
  if (!addressOrUrl) return null;
  const s = String(addressOrUrl).trim();
  let domain;
  if (s.includes('@')) {
    domain = emailDomain(s);
  } else {
    const m = s.toLowerCase().match(/^(?:https?:\/\/)?(?:www\.)?([^/:?#\s]+)/);
    domain = m && m[1].includes('.') ? m[1] : null;
  }
  if (!domain) return null;
  return isGenericDomain(domain) ? null : domain.replace(/^www\./, '');
}

module.exports = {
  FREE_MAIL_DOMAINS, NON_IDENTIFYING_DOMAINS,
  emailDomain, isGenericDomain, identifyingDomain,
};
