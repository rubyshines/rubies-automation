/**
 * resolveWebsite.js — look behind a shortener or link-in-bio page for the real
 * website, so domain matching has something to match on.
 *
 * emailDomains.js already knows that `bit.ly` and `linktr.ee` identify nobody,
 * and every join in the B2B stores correctly refuses to use one. What nothing
 * did was go and look: a row whose `website` is a shortener is invisible to
 * partner matching, inbound correlation and duplicate detection forever, even
 * though the real domain is one HTTP request away. McMinnville Trans Network is
 * an active donation partner whose company row could not be joined to its
 * partner row for exactly this reason (2026-09-11).
 *
 * Two shapes, both handled:
 *
 *   a redirect      bit.ly/xyz  →  301  →  theirsite.org
 *   a link-in-bio   bit.ly/m/x  →  200 on a Bitly-hosted page listing links
 *
 * The second is why following redirects alone is not enough: Bitly's own
 * "link in bio" pages answer 200 at the shortener's domain and hold the real
 * links in the body. (They also answer 405 to HEAD, so this uses GET.)
 *
 * The rule that keeps this safe: it may return a real domain or nothing, never
 * a guess. A page whose only outbound links are social profiles resolves to
 * NOTHING and says so — that org genuinely has no website, and writing
 * `instagram.com` into the website column would fuse every such org into one
 * "company", which is the failure the denylist exists to prevent.
 */
const { identifyingDomain, isGenericDomain } = require('./emailDomains');

/**
 * The only values worth following. NOT every unusable website value: `gmx.net`
 * in a website column is a free-mail provider somebody pasted, and following it
 * lands on a webmail homepage whose markup offers w3.org and a CDN as
 * "candidates" (caught by the first dry run of the sweep, 2026-09-11). A
 * shortener or a link-in-bio page is the only kind of junk with a real site
 * deliberately behind it.
 */
const FOLLOWABLE = new Set([
  'bit.ly', 'tinyurl.com', 't.co', 'ow.ly', 'buff.ly', 'rb.gy', 'shorturl.at',
  'linktr.ee', 'lnk.bio', 'beacons.ai', 'linkin.bio', 'campsite.bio',
  'solo.to', 'bio.link', 'msha.ke', 'allmylinks.com', 'flowcode.com',
]);

/**
 * Never a company's own site, whatever a page links to. Every pattern is
 * anchored to match the BARE host too: hosts arrive here with `www.` stripped,
 * so a `/\.w3\.org$/` that only matches a subdomain let `www.w3.org` — the XML
 * namespace URL in a doctype — through as a candidate website.
 */
const ASSET_HOSTS = [
  /(^|\.)cloudfront\.net$/, /(^|\.)akamaihd\.net$/, /(^|\.)amazonaws\.com$/,
  /(^|\.)gstatic\.com$/, /(^|\.)googleapis\.com$/, /(^|\.)googletagmanager\.com$/,
  /(^|\.)google-analytics\.com$/, /(^|\.)doubleclick\.net$/,
  /(^|\.)w3\.org$/, /(^|\.)schema\.org$/, /(^|\.)purl\.org$/, /(^|\.)ogp\.me$/,
  /(^|\.)bitly\.com$/, /(^|\.)bit\.ly$/,
  /(^|\.)typekit\.net$/, /(^|\.)fontawesome\.com$/, /(^|\.)jsdelivr\.net$/,
  /(^|\.)unpkg\.com$/, /(^|\.)cloudflare\.com$/, /(^|\.)cdn\./, /^cdn\./,
];

/** Tracking, policy and app-store links a bio page carries about itself. */
const BOILERPLATE = [
  /^(www\.)?(apple|play\.google|apps\.apple)\./, /privacy|terms|cookie|support\./,
  /^(www\.)?(paypal|venmo|cash\.app|gofundme|donorbox|givebutter|classy\.org|networkforgood)\./,
  /^(www\.)?(eventbrite|calendly|mailchi|lu\.ma)\./,
];

const DEFAULT_TIMEOUT_MS = 8000;

/**
 * Is this a value with a real site deliberately behind it? Pure.
 *
 * Deliberately narrower than "fails every domain join". Plenty of stored
 * websites are unusable (a free-mail domain, a bare social profile) and have
 * nothing behind them to find; following those wastes a request and invites a
 * junk candidate. Only shorteners and link-in-bio pages qualify.
 */
function needsResolving(website) {
  if (!website) return false;
  if (identifyingDomain(website)) return false;
  const m = String(website).toLowerCase().match(/^(?:https?:\/\/)?(?:www\.)?([^/:?#\s]+)/);
  return !!(m && FOLLOWABLE.has(m[1]));
}

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; }
}

/**
 * The candidate domains a link-in-bio page offers, best first. PURE — takes
 * HTML, returns domains, touches no network, so the picking rules are testable
 * without pretending to be Bitly.
 *
 * "Best" is just first-seen order after the filters: a bio page lists the org's
 * own site above its socials, and inventing a ranking over two candidates would
 * be a rule with no evidence behind it.
 */
function candidateDomainsFromHtml(html, { sourceHost = null } = {}) {
  const out = [];
  const seen = new Set();
  for (const m of String(html || '').matchAll(/https?:\/\/[^\s"'<>\\)]+/g)) {
    const host = hostOf(m[0]);
    if (!host || seen.has(host)) continue;
    seen.add(host);
    if (host === sourceHost) continue;
    if (ASSET_HOSTS.some(r => r.test(host))) continue;
    if (BOILERPLATE.some(r => r.test(host))) continue;
    // isGenericDomain covers free mail, shorteners AND social profiles, which is
    // exactly the set that must never become a company's identity.
    if (isGenericDomain(host)) continue;
    out.push(host);
  }
  return out;
}

/**
 * The social profiles a page offers, for reporting. An org with no website but
 * a real Instagram is a fact worth showing an operator; it is just not identity.
 */
function socialLinksFromHtml(html) {
  const out = [];
  const seen = new Set();
  for (const m of String(html || '').matchAll(/https?:\/\/[^\s"'<>\\)]+/g)) {
    const host = hostOf(m[0]);
    if (!host || ASSET_HOSTS.some(r => r.test(host))) continue;
    if (!/^(m\.)?(facebook|instagram|twitter|x|tiktok|linkedin|youtube)\.com$/.test(host)) continue;
    const url = m[0].replace(/[.,)]+$/, '');
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

/**
 * Resolve a website value to a domain we can match on.
 *
 * Returns { domain, url, via, socials, error } where `via` is one of:
 *   direct     — it already identified an organisation; no request was made
 *   redirect   — the shortener redirected to a real site
 *   link_page  — a link-in-bio page listed one
 *   none       — followed it and there is no real site behind it
 *   error      — the lookup failed; the caller must leave the value alone
 *
 * `none` and `error` are deliberately different. `none` is a finding ("they
 * have no website"); `error` is an absence of one, and treating a timeout as
 * "no website" would quietly blank real rows.
 */
async function resolveWebsite(website, { fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const direct = identifyingDomain(website);
  if (direct) return { domain: direct, url: String(website), via: 'direct', socials: [] };
  if (!website) return { domain: null, url: null, via: 'none', socials: [] };

  const start = /^https?:\/\//i.test(website) ? String(website) : `https://${website}`;
  const sourceHost = hostOf(start);

  let res;
  let html = '';
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    // GET, not HEAD: Bitly's bio pages answer 405 to HEAD, and we need the body
    // anyway when the destination turns out to be a page rather than a redirect.
    res = await fetchImpl(start, {
      redirect: 'follow',
      signal: controller ? controller.signal : undefined,
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; RUBIES-link-check/1.0)' },
    });
    html = await res.text();
  } catch (e) {
    return { domain: null, url: null, via: 'error', socials: [], error: e.message };
  } finally {
    if (timer) clearTimeout(timer);
  }

  // Where the redirects landed. fetch reports the final URL on `res.url`.
  const landed = identifyingDomain(res.url || start);
  if (landed) return { domain: landed, url: res.url || start, via: 'redirect', socials: [] };

  const candidates = candidateDomainsFromHtml(html, { sourceHost: hostOf(res.url || start) });
  const socials = socialLinksFromHtml(html);
  if (candidates.length) {
    return { domain: candidates[0], url: `https://${candidates[0]}`, via: 'link_page', socials, candidates };
  }
  return { domain: null, url: null, via: 'none', socials };
}

module.exports = {
  resolveWebsite, needsResolving, candidateDomainsFromHtml, socialLinksFromHtml,
  FOLLOWABLE, ASSET_HOSTS, BOILERPLATE,
};
