const { test } = require('node:test');
const assert = require('node:assert');
const { selectCompaniesForDiscovery } = require('../../b2b-outreach/lib/manualSendReconcile');

const NOW = new Date('2026-08-19T12:00:00Z');
const STALE = new Date(NOW.getTime() - 30 * 864e5); // 2026-07-20

const co = (id, over = {}) => ({ id, relationship_state: 'prospect', threads_discovered_at: null, ...over });

const select = (companies, { withMessages = [], emails = null, staleBefore = STALE } = {}) =>
  selectCompaniesForDiscovery({
    companies,
    companiesWithMessages: withMessages,
    // Default: every company has one address to search with.
    emailsByCompany: emails || Object.fromEntries(companies.map(c => [c.id, [`x@${c.id}.org`]])),
    staleBefore,
  }).map(c => c.id);

test('a company that already has messages is left alone', () => {
  const got = select([co('has-history'), co('empty')], { withMessages: ['has-history'] });
  assert.deepEqual(got, ['empty']);
});

// A company with nothing to search Gmail WITH cannot be discovered, and burning a
// list call on it every month teaches us nothing.
test('a company with no address on file is skipped', () => {
  const got = select([co('no-address'), co('has-address')], {
    emails: { 'has-address': ['hi@has-address.org'] },
  });
  assert.deepEqual(got, ['has-address']);
});

test('an empty address array counts as no address', () => {
  const got = select([co('a'), co('b')], { emails: { a: [], b: ['hi@b.org'] } });
  assert.deepEqual(got, ['b']);
});

// The stamp is what stops the ~120 genuinely-empty companies being re-searched
// against Gmail every single night.
test('a company searched recently is not searched again', () => {
  const got = select([
    co('searched-yesterday', { threads_discovered_at: '2026-08-18T00:00:00Z' }),
    co('never-searched'),
  ]);
  assert.deepEqual(got, ['never-searched']);
});

test('a company searched long enough ago comes back round', () => {
  const got = select([co('searched-in-may', { threads_discovered_at: '2026-05-01T00:00:00Z' })]);
  assert.deepEqual(got, ['searched-in-may'], 'a stale search should be retried');
});

// Ordering is the whole safety property of the limit: 'prospect' means never
// approached, so an empty record is expected. Any other state claims a
// relationship the messages do not show, and THAT is what produces a wrong tier.
test('companies claiming a relationship are searched before untouched prospects', () => {
  const got = select([
    co('p1'),
    co('in-contact', { relationship_state: 'in_contact' }),
    co('p2'),
    co('active', { relationship_state: 'active' }),
    co('lost', { relationship_state: 'lost' }),
  ]);
  assert.deepEqual(got.slice(0, 3).sort(), ['active', 'in-contact', 'lost'],
    'the three with a claimed relationship come first');
  assert.deepEqual(got.slice(3), ['p1', 'p2']);
});

test('a null relationship_state is treated as a prospect, not as urgent', () => {
  const got = select([co('nullstate', { relationship_state: null }), co('in-contact', { relationship_state: 'in_contact' })]);
  assert.deepEqual(got, ['in-contact', 'nullstate']);
});

// Within a rank, oldest-searched first, so a truncating limit rotates through the
// backlog instead of re-running the same head of the list every night.
test('within a rank the longest-unsearched goes first', () => {
  const got = select([
    co('b', { relationship_state: 'in_contact', threads_discovered_at: '2026-06-01T00:00:00Z' }),
    co('a', { relationship_state: 'in_contact', threads_discovered_at: null }),
    co('c', { relationship_state: 'in_contact', threads_discovered_at: '2026-01-01T00:00:00Z' }),
  ]);
  assert.deepEqual(got, ['a', 'c', 'b'], 'never-searched, then oldest, then most recent');
});

test('the order is total, so two identical companies never swap between runs', () => {
  const mk = () => [
    co('zzz', { relationship_state: 'in_contact' }),
    co('aaa', { relationship_state: 'in_contact' }),
  ];
  assert.deepEqual(select(mk()), ['aaa', 'zzz']);
  assert.deepEqual(select(mk().reverse()), ['aaa', 'zzz'], 'input order must not matter');
});
