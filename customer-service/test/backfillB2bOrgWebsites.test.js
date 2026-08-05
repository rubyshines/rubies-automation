const { test } = require('node:test');
const assert = require('node:assert');
const { deriveWebsiteFromEmail, chooseWebsite, parseMetadata } = require('../../scripts/backfillB2bOrgWebsites');

test('derives the org website from its own domain', () => {
  assert.equal(deriveWebsiteFromEmail('info@pacificcenter.org'), 'https://pacificcenter.org');
  assert.equal(deriveWebsiteFromEmail('hello@the519.org'), 'https://the519.org');
  assert.equal(deriveWebsiteFromEmail('kontakt@transammans.se'), 'https://transammans.se');
  assert.equal(deriveWebsiteFromEmail('a@b.org.au'), 'https://b.org.au');
});

test('free-mail domains never become a website', () => {
  for (const e of ['someone@gmail.com', 'x@yahoo.com', 'y@hotmail.co.uk', 'z@icloud.com']) {
    assert.equal(deriveWebsiteFromEmail(e), null, e);
  }
});

test('malformed addresses yield null rather than a junk URL', () => {
  assert.equal(deriveWebsiteFromEmail('no-at-sign'), null);
  assert.equal(deriveWebsiteFromEmail('@nolocal.org'), null);
  assert.equal(deriveWebsiteFromEmail('a@localhost'), null, 'no TLD');
  assert.equal(deriveWebsiteFromEmail('a@under_score.org'), null);
  assert.equal(deriveWebsiteFromEmail(null), null);
  assert.equal(deriveWebsiteFromEmail(''), null);
});

test('uppercase and trailing dots normalize', () => {
  assert.equal(deriveWebsiteFromEmail('Info@PacificCenter.ORG'), 'https://pacificcenter.org');
  assert.equal(deriveWebsiteFromEmail('info@pacificcenter.org.'), 'https://pacificcenter.org');
});

test('a plus-addressed contact still resolves', () => {
  assert.equal(deriveWebsiteFromEmail('info+news@lgbtlifecenter.org'), 'https://lgbtlifecenter.org');
});

// ── chooseWebsite ───────────────────────────────────────────────────────────

const co = (over = {}) => ({ id: 'x', name: 'Org', website: null, general_email: null, ...over });

test('an existing website is never overwritten', () => {
  assert.equal(chooseWebsite(co({ website: 'https://already.org' }), [{ email: 'a@other.org', is_active: true }]), null);
});

test('the primary contact wins over other active contacts', () => {
  const site = chooseWebsite(co(), [
    { email: 'volunteer@secondary.org', is_active: true, is_primary: false },
    { email: 'director@primary.org', is_active: true, is_primary: true },
  ]);
  assert.equal(site, 'https://primary.org');
});

test('falls past a free-mail primary to a usable active contact', () => {
  const site = chooseWebsite(co(), [
    { email: 'director@gmail.com', is_active: true, is_primary: true },
    { email: 'info@realorg.org', is_active: true, is_primary: false },
  ]);
  assert.equal(site, 'https://realorg.org');
});

test('inactive contacts are ignored', () => {
  assert.equal(chooseWebsite(co(), [{ email: 'old@gone.org', is_active: false }]), null);
});

test('general_email is the last resort', () => {
  assert.equal(chooseWebsite(co({ general_email: 'hello@frontdoor.org' }), []), 'https://frontdoor.org');
  assert.equal(chooseWebsite(co({ general_email: 'hello@frontdoor.org' }),
    [{ email: 'a@contact.org', is_active: true }]), 'https://contact.org', 'a contact outranks it');
});

test('no usable domain anywhere yields null', () => {
  assert.equal(chooseWebsite(co(), [{ email: 'a@gmail.com', is_active: true }]), null);
  assert.equal(chooseWebsite(co(), []), null);
  assert.equal(chooseWebsite(co(), undefined), null);
});

// ── parseMetadata ───────────────────────────────────────────────────────────

test('parseMetadata tolerates both storage forms so run order does not matter', () => {
  assert.deepEqual(parseMetadata('{"klaviyo_list":"centerlink"}'), { klaviyo_list: 'centerlink' });
  assert.deepEqual(parseMetadata({ klaviyo_list: 'centerlink' }), { klaviyo_list: 'centerlink' });
  assert.deepEqual(parseMetadata(null), {});
  assert.deepEqual(parseMetadata('garbage'), {});
  assert.deepEqual(parseMetadata('[1,2]'), {});
});
