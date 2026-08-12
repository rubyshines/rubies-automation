const test = require('node:test');
const assert = require('node:assert');

const {
  emailDomain, isGenericDomain, identifyingDomain,
} = require('../../b2b-outreach/lib/emailDomains');

test('emailDomain extracts and lowercases, tolerating a display name', () => {
  assert.strictEqual(emailDomain('Kori Hennessey <Kori@LGBTCenterOfRaleigh.com>'), 'lgbtcenterofraleigh.com');
  assert.strictEqual(emailDomain('rachel@socirc.ca'), 'socirc.ca');
  assert.strictEqual(emailDomain('not-an-address'), null);
  assert.strictEqual(emailDomain(''), null);
  assert.strictEqual(emailDomain(null), null);
});

test('free mail providers are generic, org domains are not', () => {
  for (const d of ['gmail.com', 'yahoo.co.nz', 'pm.me', 'gmx.net', 'icloud.com', 'mozmail.com']) {
    assert.ok(isGenericDomain(d), `${d} should be generic`);
  }
  for (const d of ['socirc.ca', 'onepeloton.com', 'lumenus.ca', 'bagly.org']) {
    assert.ok(!isGenericDomain(d), `${d} should identify a company`);
  }
});

// Both of these were real values in the website column, put there by importers
// that took whatever link the org published or fell back to the email domain.
test('shorteners and social profiles are generic', () => {
  for (const d of ['bit.ly', 'linktr.ee', 'facebook.com', 'sites.google.com', 'wordpress.com']) {
    assert.ok(isGenericDomain(d), `${d} should be generic`);
  }
});

test('a subdomain of a page builder DOES identify one org', () => {
  assert.ok(!isGenericDomain('thprojekt.wordpress.com'));
  assert.strictEqual(identifyingDomain('https://thprojekt.wordpress.com/thp-en/'), 'thprojekt.wordpress.com');
});

test('identifyingDomain handles both addresses and urls, and strips www', () => {
  assert.strictEqual(identifyingDomain('jess@unityconejo.org'), 'unityconejo.org');
  assert.strictEqual(identifyingDomain('https://www.transponderoregon.org'), 'transponderoregon.org');
  assert.strictEqual(identifyingDomain('skippingstone.ca'), 'skippingstone.ca');
});

test('identifyingDomain returns null for anything that identifies nobody', () => {
  assert.strictEqual(identifyingDomain('katie.mcmenamin@yahoo.co.nz'), null);
  assert.strictEqual(identifyingDomain('https://bit.ly/m/mactrans'), null);
  assert.strictEqual(identifyingDomain('https://gmx.net'), null);
  assert.strictEqual(identifyingDomain(null), null);
  assert.strictEqual(identifyingDomain(''), null);
});
