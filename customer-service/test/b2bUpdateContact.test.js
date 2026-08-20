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

// ── promote / retire someone already on file ────────────────────────────────
const { setPrimaryContact, removeCompanyContact } = require('../../b2b-outreach/lib/updateContact');

function sbWith(rows, company = { general_email: null }) {
  const state = { updates: [] };
  const client = {
    from(table) {
      const q = {
        _f: {}, _in: null,
        select() { return q; },
        eq(c, v) { q._f[c] = v; return q; },
        in(c, v) { q._in = v; return q; },
        maybeSingle() { return Promise.resolve({ data: table === 'b2b_companies' ? company : null, error: null }); },
        update(patch) { state.updates.push({ table, patch, email: q._f.email || q._in }); return q; },
        then(r) { return r({ data: table === 'b2b_contacts' ? rows : [], error: null }); },
      };
      return q;
    },
  };
  return { client, state };
}

const dj = { email: 'programs@masstpc.org', is_primary: true, is_active: true };
const charly = { email: 'charly@masstpc.org', is_primary: false, is_active: true };

test('making someone primary demotes the previous one', async () => {
  const { client, state } = sbWith([dj, charly]);
  const r = await setPrimaryContact(client, { company_id: 'mtpc', email: 'charly@masstpc.org' });
  assert.equal(r.email, 'charly@masstpc.org');
  assert.deepEqual(r.demoted, ['programs@masstpc.org']);
  const promote = state.updates.find(u => u.patch.is_primary === true);
  assert.ok(promote, 'the new primary is set');
  assert.equal(promote.patch.is_active, true, 'promoting someone reactivates them');
});

test('promoting an address that is not on the company is refused', async () => {
  const { client } = sbWith([dj]);
  await assert.rejects(() => setPrimaryContact(client, { company_id: 'mtpc', email: 'stranger@x.org' }),
    /is not a contact on/);
});

test('removing a contact deactivates rather than deletes', async () => {
  const { client, state } = sbWith([dj, charly]);
  const r = await removeCompanyContact(client, { company_id: 'mtpc', email: 'charly@masstpc.org' });
  assert.equal(r.removed, 'charly@masstpc.org');
  const del = state.updates.find(u => u.patch.is_active === false);
  assert.ok(del, 'deactivated, so their messages still resolve to this company');
});

test('removing the primary promotes someone else rather than leaving nobody', async () => {
  const { client } = sbWith([dj, charly]);
  const r = await removeCompanyContact(client, { company_id: 'mtpc', email: 'programs@masstpc.org' });
  assert.equal(r.promoted, 'charly@masstpc.org',
    'without this resolveRecipient falls back to row order');
});

test('the last way to reach a company cannot be removed', async () => {
  const { client } = sbWith([dj], { general_email: null });
  await assert.rejects(() => removeCompanyContact(client, { company_id: 'mtpc', email: 'programs@masstpc.org' }),
    /only way to reach this company/);
});

test('the last contact CAN go when a general inbox exists', async () => {
  const { client } = sbWith([dj], { general_email: 'info@masstpc.org' });
  const r = await removeCompanyContact(client, { company_id: 'mtpc', email: 'programs@masstpc.org' });
  assert.equal(r.removed, 'programs@masstpc.org');
  assert.equal(r.promoted, null);
});

const { restoreCompanyContact } = require('../../b2b-outreach/lib/updateContact');

test('restoring a retired contact reactivates them', async () => {
  const gone = { email: 'programs@masstpc.org', is_primary: false, is_active: false };
  const { client, state } = sbWith([gone, charly]);
  const r = await restoreCompanyContact(client, { company_id: 'mtpc', email: 'programs@masstpc.org' });
  assert.equal(r.restored, 'programs@masstpc.org');
  assert.deepEqual(state.updates.map(u => u.patch), [{ is_active: true }]);
});

// Undoing a removal and choosing who to write to are different decisions.
test('restoring does not silently redirect mail to the restored person', async () => {
  const gone = { email: 'programs@masstpc.org', is_primary: false, is_active: false };
  const { client, state } = sbWith([gone, charly]);
  await restoreCompanyContact(client, { company_id: 'mtpc', email: 'programs@masstpc.org' });
  assert.ok(!state.updates.some(u => u.patch.is_primary === true), 'primary is untouched');
});
