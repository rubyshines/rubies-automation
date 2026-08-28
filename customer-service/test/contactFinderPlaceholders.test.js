const test = require('node:test');
const assert = require('node:assert');

const { isPlaceholderEmail, extractEmails, pickBestEmail } = require('../../b2b-discovery/lib/contactFinder');

// A placeholder harvested from an unfilled site template is not merely a
// useless contact. Its local part ("user", "youremail") is not a generic
// prefix, so it classifies as personal, and pickBestEmail ranks personal above
// generic — meaning it outranks the org's real info@ address and becomes the
// address we would write to. The bounce lands on rubyshines.com, the sending
// domain Klaviyo uses to reach customers.

test('isPlaceholderEmail catches placeholder domains', () => {
  ['user@domain.com', 'info@yourdomain.com', 'hello@example.org', 'a@yoursite.com', 'x@domain.tld']
    .forEach((e) => assert.equal(isPlaceholderEmail(e), true, e));
});

test('isPlaceholderEmail catches placeholder local parts on a real domain', () => {
  // The half that a domain-only denylist misses.
  ['user@bravespacealliance.org', 'youremail@realorg.org', 'john.doe@realorg.org', 'name@realorg.org']
    .forEach((e) => assert.equal(isPlaceholderEmail(e), true, e));
});

test('isPlaceholderEmail leaves real addresses alone', () => {
  [
    'info@bravespacealliance.org',
    'courtney@bravespacealliance.org',
    'development@atticyouthcenter.org',
    'norcaloutreachproject@gmail.com',
    'care@rubyshines.com',
    // Real words that merely start with a placeholder token.
    'username-services@realorg.org',
    'testing.lab@university.edu',
    'nameless@realorg.org',
  ].forEach((e) => assert.equal(isPlaceholderEmail(e), false, e));
});

test('isPlaceholderEmail handles malformed input without throwing', () => {
  [null, undefined, '', 'not-an-email', '@domain.com', 'user@'].forEach((e) => {
    assert.equal(isPlaceholderEmail(e), false, String(e));
  });
});

test('extractEmails drops a placeholder from scraped HTML', () => {
  const html = `
    <p>Email us at <a href="mailto:info@bravespacealliance.org">info@bravespacealliance.org</a></p>
    <div class="theme-demo">Contact: <a href="mailto:user@domain.com">user@domain.com</a></div>
  `;
  const found = extractEmails(html).map((e) => e.email);
  assert.ok(found.includes('info@bravespacealliance.org'));
  assert.ok(!found.includes('user@domain.com'), 'placeholder must not survive extraction');
});

test('the real address wins once the placeholder is filtered', () => {
  // Regression for the live failure: before the filter, user@domain.com was
  // typed 'personal' and pickBestEmail returned it over the working info@.
  const html = `
    <a href="mailto:user@domain.com">user@domain.com</a>
    <a href="mailto:info@bravespacealliance.org">info@bravespacealliance.org</a>
  `;
  const best = pickBestEmail(extractEmails(html));
  assert.equal(best.email, 'info@bravespacealliance.org');
});

test('a page offering only a placeholder yields no email at all', () => {
  const html = '<a href="mailto:user@domain.com">Contact us</a>';
  assert.equal(pickBestEmail(extractEmails(html)), null, 'no contact is better than an unsendable one');
});
