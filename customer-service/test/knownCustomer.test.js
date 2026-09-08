/**
 * knownCustomer — the batch order-history lookup shared by the Gmail
 * classifier and the B2B inbound strip. Supabase is stubbed; what matters is
 * the shape of the map and that a failed read withholds the hint instead of
 * throwing into a classification pass.
 */
const { test } = require('node:test');
const assert = require('node:assert');

const { orderHistoryByEmail } = require('../lib/knownCustomer');

function stubSb(result) {
  const q = {
    _in: null,
    select() { return q; },
    in(_col, vals) { q._in = vals; return q; },
    order() { return q; },
    limit() { return Promise.resolve(typeof result === 'function' ? result(q) : result); },
  };
  return { from() { return q; }, q };
}

test('counts orders per address and keeps the newest order date', async () => {
  const sb = stubSb({ data: [
    { customer_email: 'liz@creativeoutdoor.com', created_at: '2025-05-11T15:08:13+00:00' },
    { customer_email: 'liz@creativeoutdoor.com', created_at: '2024-03-25T12:38:32+00:00' },
    { customer_email: 'other@x.com', created_at: '2023-01-01T00:00:00+00:00' },
  ] });
  const out = await orderHistoryByEmail(sb, ['Liz@CreativeOutdoor.com', 'other@x.com', 'nobody@y.com']);
  assert.deepEqual(out.get('liz@creativeoutdoor.com'), { orders: 2, last_order_at: '2025-05-11T15:08:13+00:00' });
  assert.deepEqual(out.get('other@x.com'), { orders: 1, last_order_at: '2023-01-01T00:00:00+00:00' });
  assert.equal(out.has('nobody@y.com'), false);
  assert.deepEqual(sb.q._in, ['liz@creativeoutdoor.com', 'other@x.com', 'nobody@y.com'], 'queried lowercased, deduped');
});

test('empty input never hits the database', async () => {
  let called = false;
  const sb = { from() { called = true; throw new Error('should not query'); } };
  const out = await orderHistoryByEmail(sb, [null, '', undefined]);
  assert.equal(out.size, 0);
  assert.equal(called, false);
});

test('a read error or a thrown client yields an empty map, not an exception', async () => {
  const errSb = stubSb({ data: null, error: { message: 'boom' } });
  assert.equal((await orderHistoryByEmail(errSb, ['a@b.com'])).size, 0);
  const throwSb = { from() { throw new Error('offline'); } };
  assert.equal((await orderHistoryByEmail(throwSb, ['a@b.com'])).size, 0);
});
