const test = require('node:test');
const assert = require('node:assert');

const {
  resolveWebsite, needsResolving, candidateDomainsFromHtml, socialLinksFromHtml,
} = require('../../b2b-outreach/lib/resolveWebsite');

// A stub fetch: no network in tests, and the picking rules are what matter.
function stubFetch({ finalUrl, body = '', throws = null }) {
  return async () => {
    if (throws) throw new Error(throws);
    return { url: finalUrl, text: async () => body };
  };
}

// ---------------------------------------------------------------------------
// What is worth following
// ---------------------------------------------------------------------------

test('a real domain is never followed — no request, no risk', async () => {
  assert.equal(needsResolving('https://www.lgbtcenterofraleigh.com'), false);
  const r = await resolveWebsite('https://www.lgbtcenterofraleigh.com', {
    fetchImpl: () => { throw new Error('must not fetch'); },
  });
  assert.equal(r.via, 'direct');
  assert.equal(r.domain, 'lgbtcenterofraleigh.com');
});

test('only shorteners and bio pages are followed, not every unusable value', () => {
  assert.equal(needsResolving('https://bit.ly/m/mactrans'), true);
  assert.equal(needsResolving('linktr.ee/someorg'), true);
  // The sweep's first dry run followed a free-mail domain sitting in a website
  // column and reported w3.org as the org's website. Free mail has nothing
  // deliberately behind it.
  assert.equal(needsResolving('gmx.net'), false);
  assert.equal(needsResolving('gmail.com'), false);
  // A bare social profile is junk, but following it is not how you fix it.
  assert.equal(needsResolving('facebook.com'), false);
  assert.equal(needsResolving(null), false);
});

// ---------------------------------------------------------------------------
// Following
// ---------------------------------------------------------------------------

test('a shortener that redirects to a real site resolves to it', async () => {
  const r = await resolveWebsite('https://bit.ly/xyz', {
    fetchImpl: stubFetch({ finalUrl: 'https://transponder.community/closet' }),
  });
  assert.equal(r.via, 'redirect');
  assert.equal(r.domain, 'transponder.community');
});

test('a link-in-bio page is read for the real site behind it', async () => {
  // Bitly bio pages answer 200 AT the shortener's own domain, so following
  // redirects alone finds nothing. (They also 405 on HEAD, which is why the
  // implementation uses GET.)
  const r = await resolveWebsite('https://bit.ly/m/someorg', {
    fetchImpl: stubFetch({
      finalUrl: 'https://bit.ly/m/someorg',
      body: `<a href="https://d1ayxb9.cloudfront.net/app.css">css</a>
             <a href="https://someorg.org/closet">Our closet</a>
             <a href="https://instagram.com/someorg">Instagram</a>`,
    }),
  });
  assert.equal(r.via, 'link_page');
  assert.equal(r.domain, 'someorg.org');
});

test('a bio page with only social links resolves to nothing, and says what is there', async () => {
  // Writing instagram.com into a website column would fuse every such org into
  // one "company" — the exact failure the denylist exists to prevent.
  const r = await resolveWebsite('https://bit.ly/m/mactrans', {
    fetchImpl: stubFetch({
      finalUrl: 'https://bit.ly/m/mactrans',
      body: '<a href="http://instagram.com/mactransnetwork">IG</a>',
    }),
  });
  assert.equal(r.via, 'none');
  assert.equal(r.domain, null);
  assert.deepEqual(r.socials, ['http://instagram.com/mactransnetwork']);
});

test('a lookup failure is distinct from finding nothing', async () => {
  // A timeout treated as "no website" would quietly blank real rows.
  const r = await resolveWebsite('https://bit.ly/xyz', { fetchImpl: stubFetch({ throws: 'network down' }) });
  assert.equal(r.via, 'error');
  assert.equal(r.domain, null);
  assert.match(r.error, /network down/);
});

// ---------------------------------------------------------------------------
// What counts as a candidate (pure)
// ---------------------------------------------------------------------------

test('standards and CDN hosts are never a candidate, bare or subdomained', () => {
  // `www.w3.org` arrives with www stripped, so a pattern anchored on a leading
  // dot let the doctype namespace through as an org's website.
  const html = `<html xmlns="http://www.w3.org/1999/xhtml">
    <link href="https://d1ayxb9ooonjts.cloudfront.net/a.css">
    <script src="https://cdn.jsdelivr.net/x.js"></script>
    <a href="https://schema.org/Organization">schema</a>
    <a href="https://realorg.org">Home</a>`;
  assert.deepEqual(candidateDomainsFromHtml(html), ['realorg.org']);
});

test('payment, ticketing and app-store links are not the org website', () => {
  const html = `<a href="https://gofundme.com/f/bins">Donate</a>
    <a href="https://apps.apple.com/app/id1">App</a>
    <a href="https://eventbrite.com/e/1">Tickets</a>
    <a href="https://theirsite.ca">Site</a>`;
  assert.deepEqual(candidateDomainsFromHtml(html), ['theirsite.ca']);
});

test('the page never nominates itself', () => {
  const html = '<a href="https://bit.ly/m/other">More</a><a href="https://real.org">Site</a>';
  assert.deepEqual(candidateDomainsFromHtml(html, { sourceHost: 'bit.ly' }), ['real.org']);
});

test('social links are collected for reporting but never as identity', () => {
  const html = '<a href="https://instagram.com/org">IG</a><a href="https://real.org">Site</a>';
  assert.deepEqual(socialLinksFromHtml(html), ['https://instagram.com/org']);
  assert.ok(!candidateDomainsFromHtml(html).includes('instagram.com'));
});

test('an empty or garbage page yields no candidates rather than throwing', () => {
  assert.deepEqual(candidateDomainsFromHtml(''), []);
  assert.deepEqual(candidateDomainsFromHtml(null), []);
  assert.deepEqual(candidateDomainsFromHtml('<a href="notaurl">x</a>'), []);
});
