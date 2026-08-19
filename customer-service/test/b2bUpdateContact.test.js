const { test } = require('node:test');
const assert = require('node:assert');
const { planContactUpdate, normalizeEmail } = require('../../b2b-outreach/lib/updateContact');

const riley = { email: 'riley.walsh@fountainhouse.org', is_primary: true, is_active: true };
const info = { email: 'info@fountainhouse.org', is_primary: false, is_active: true };

test('the new contact becomes the only primary', () => {
  const p = planContactUpdate([riley, info], {
    email: 'matt.valdespino@fountainhouse.org', full_name: 'Matt Valdespino',
  });
  assert.equal(p.contact.is_primary, true);
  assert.equal(p.contact.is_active, true);
  assert.deepEqual(p.demote, ['riley.walsh@fountainhouse.org'],
    'the old primary must lose primary, or resolveRecipient picks by row order');
});

// Several people on file is normal; only the named one has left.
test('other contacts are kept active — only the named predecessor is retired', () => {
  const p = planContactUpdate([riley, info], {
    email: 'matt.valdespino@fountainhouse.org', replaces: 'riley.walsh@fountainhouse.org',
  });
  assert.deepEqual(p.deactivate, ['riley.walsh@fountainhouse.org']);
  assert.ok(!p.deactivate.includes('info@fountainhouse.org'), 'the general inbox stays reachable');
});

test('without `replaces` nobody is deactivated, just demoted', () => {
  const p = planContactUpdate([riley], { email: 'matt.valdespino@fountainhouse.org' });
  assert.deepEqual(p.deactivate, [], 'adding a person is not the same as saying someone left');
  assert.deepEqual(p.demote, ['riley.walsh@fountainhouse.org']);
});

test('updating the person already on file does not demote or retire them', () => {
  const p = planContactUpdate([riley], {
    email: 'Riley.Walsh@FountainHouse.org', full_name: 'Riley Walsh',
    replaces: 'riley.walsh@fountainhouse.org',
  });
  assert.deepEqual(p.demote, []);
  assert.deepEqual(p.deactivate, [], 'a rename must not deactivate the row it is renaming');
  assert.equal(p.contact.full_name, 'Riley Walsh');
});

test('addresses are normalised, because the id IS the email', () => {
  assert.equal(normalizeEmail('  Matt.Valdespino@FountainHouse.ORG '), 'matt.valdespino@fountainhouse.org');
  const p = planContactUpdate([], { email: ' MATT@X.ORG ' });
  assert.equal(p.contact.id, 'matt@x.org');
  assert.equal(p.contact.email, 'matt@x.org');
});

test('a non-address is refused rather than stored', () => {
  assert.throws(() => planContactUpdate([], { email: 'Matt Valdespino' }), /not an email address/);
  assert.throws(() => planContactUpdate([], { email: '' }), /email required/);
});

test('blank name and title are stored as null, not empty strings', () => {
  const p = planContactUpdate([], { email: 'a@b.org', full_name: '   ', title: '' });
  assert.equal(p.contact.full_name, null);
  assert.equal(p.contact.title, null);
});

test('an already-inactive predecessor is not deactivated twice', () => {
  const gone = { email: 'old@x.org', is_primary: false, is_active: false };
  const p = planContactUpdate([gone], { email: 'new@x.org', replaces: 'old@x.org' });
  assert.deepEqual(p.deactivate, []);
});
