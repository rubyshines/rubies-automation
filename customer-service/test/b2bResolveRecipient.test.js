const test = require('node:test');
const assert = require('node:assert');

const { resolveRecipient } = require('../../b2b-outreach/lib/sendB2bEmail');

// Records the order() calls so we can assert the tiebreakers survive, and
// returns rows already sorted the way Postgres would under that ordering.
function stubSb({ contacts = [], generalEmail = null } = {}) {
  const calls = [];
  const cmp = (a, b) => {
    for (const { col, asc } of calls) {
      const av = a[col] ?? null;
      const bv = b[col] ?? null;
      if (av === bv) continue;
      if (av === null) return 1;      // nullsFirst:false — nulls sort last
      if (bv === null) return -1;
      return (av < bv ? -1 : 1) * (asc ? 1 : -1);
    }
    return 0;
  };
  const builder = {
    _rows: contacts,
    select() { return this; },
    eq(col, val) { this._rows = this._rows.filter(r => r[col] === val); return this; },
    order(col, opts = {}) { calls.push({ col, asc: opts.ascending !== false }); return this; },
    limit(n) { return Promise.resolve({ data: [...this._rows].sort(cmp).slice(0, n), error: null }); },
    maybeSingle() { return Promise.resolve({ data: { general_email: generalEmail }, error: null }); },
  };
  return {
    orderCalls: calls,
    from(table) {
      if (table === 'b2b_contacts') return builder;
      if (table === 'b2b_companies') return { select: () => ({ eq: () => ({ maybeSingle: builder.maybeSingle }) }) };
      throw new Error(`unexpected table ${table}`);
    },
  };
}

const C = (email, over = {}) => ({
  email, full_name: null, is_primary: false, is_active: true,
  company_id: 'x', message_count: 0, last_seen_at: null, ...over,
});

test('a lone active primary is the recipient', async () => {
  const sb = stubSb({ contacts: [C('a@x.org', { is_primary: true, full_name: 'A' }), C('b@x.org')] });
  assert.deepStrictEqual(await resolveRecipient(sb, 'x'), { email: 'a@x.org', name: 'A', via: 'contact' });
});

test('inactive contacts are never chosen', async () => {
  const sb = stubSb({ contacts: [C('dead@x.org', { is_primary: true, is_active: false }), C('live@x.org')] });
  assert.strictEqual((await resolveRecipient(sb, 'x')).email, 'live@x.org');
});

// Twenty companies carry two active primaries. Without tiebreakers Postgres
// returns an arbitrary one, so the person who receives the email is row order.
test('two primaries resolve to the one we have actually corresponded with', async () => {
  const sb = stubSb({ contacts: [
    C('info@x.org', { is_primary: true }),
    C('real@x.org', { is_primary: true, message_count: 12, full_name: 'Real Person' }),
  ] });
  assert.strictEqual((await resolveRecipient(sb, 'x')).email, 'real@x.org');
});

test('with no correspondence either way, last_seen_at breaks the tie', async () => {
  const sb = stubSb({ contacts: [
    C('old@x.org', { is_primary: true, last_seen_at: '2025-01-01T00:00:00Z' }),
    C('recent@x.org', { is_primary: true, last_seen_at: '2026-07-01T00:00:00Z' }),
  ] });
  assert.strictEqual((await resolveRecipient(sb, 'x')).email, 'recent@x.org');
});

test('otherwise identical primaries resolve deterministically, not by row order', async () => {
  const rows = [C('zed@x.org', { is_primary: true }), C('amy@x.org', { is_primary: true })];
  const first = (await resolveRecipient(stubSb({ contacts: rows }), 'x')).email;
  const second = (await resolveRecipient(stubSb({ contacts: [...rows].reverse() }), 'x')).email;
  assert.strictEqual(first, second, 'same contacts in a different order must resolve the same');
  assert.strictEqual(first, 'amy@x.org');
});

test('the ordering actually asks the database for every tiebreaker', async () => {
  const sb = stubSb({ contacts: [C('a@x.org', { is_primary: true })] });
  await resolveRecipient(sb, 'x');
  assert.deepStrictEqual(sb.orderCalls.map(o => o.col),
    ['is_primary', 'message_count', 'last_seen_at', 'email']);
});

test('falls back to general_email when no active contact exists', async () => {
  const sb = stubSb({ contacts: [], generalEmail: 'hello@x.org' });
  assert.deepStrictEqual(await resolveRecipient(sb, 'x'), { email: 'hello@x.org', name: null, via: 'general_email' });
});

test('returns null when the company is unreachable', async () => {
  assert.strictEqual(await resolveRecipient(stubSb({ contacts: [] }), 'x'), null);
});
