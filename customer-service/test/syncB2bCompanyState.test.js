const { test } = require('node:test');
const assert = require('node:assert');
const { computeCompanyState, normalizeDomain } = require('../../b2b-outreach/sync/syncB2bCompanyState');

// ── normalizeDomain ─────────────────────────────────────────────────────────

test('normalizeDomain strips scheme, www, and paths', () => {
  assert.equal(normalizeDomain('https://www.unitingpride.org/programs'), 'unitingpride.org');
  assert.equal(normalizeDomain('http://tgv.org.au'), 'tgv.org.au');
  assert.equal(normalizeDomain('sockdrawerheroes.com/shop?x=1'), 'sockdrawerheroes.com');
  assert.equal(normalizeDomain(null), null);
});

// ── computeCompanyState ─────────────────────────────────────────────────────

const retailer = (over = {}) => ({
  id: 'shop-a', relationship_type: 'wholesale', relationship_state: 'in_contact',
  program_flags: {}, order_count: 0, last_order_date: null, total_sales: 0, ...over,
});
const org = (over = {}) => ({
  id: 'org-a', relationship_type: 'lgbtq_org', relationship_state: 'in_contact',
  program_flags: {}, order_count: 0, last_order_date: null, total_sales: 0, ...over,
});
const order = (created_at, total_price, cancelled_at = null) => ({ created_at, total_price, cancelled_at });

test('retailer with orders gets counts, last date, total, and active state', () => {
  const upd = computeCompanyState(retailer(), [
    order('2026-03-24T23:00:09Z', 608),
    order('2026-05-15T04:00:47Z', 605),
  ], false);
  assert.equal(upd.order_count, 2);
  assert.equal(upd.last_order_date, '2026-05-15'); // DATE column — day granularity
  assert.equal(upd.total_sales, 1213);
  assert.equal(upd.relationship_state, 'active');
});

test('idempotent against a DATE-column read-back (no perpetual rewrite)', () => {
  const upd = computeCompanyState(retailer({
    order_count: 1, last_order_date: '2026-05-15', // as PostgREST returns a DATE
    total_sales: 605, relationship_state: 'active',
  }), [order('2026-05-15T04:00:47Z', 605)], false);
  assert.equal(upd, null);
});

test('cancelled orders are excluded', () => {
  const upd = computeCompanyState(retailer(), [
    order('2026-05-15T04:00:47Z', 605),
    order('2026-06-01T00:00:00Z', 999, '2026-06-02T00:00:00Z'),
  ], false);
  assert.equal(upd.order_count, 1);
  assert.equal(upd.total_sales, 605);
});

test('in-sync company returns null (no write)', () => {
  const upd = computeCompanyState(retailer({
    order_count: 1, last_order_date: '2026-05-15T04:00:47.000Z',
    total_sales: 605, relationship_state: 'active',
  }), [order('2026-05-15T04:00:47Z', 605)], false);
  assert.equal(upd, null);
});

test('lost is never promoted', () => {
  const upd = computeCompanyState(retailer({ relationship_state: 'lost', order_count: 1, last_order_date: '2026-05-15T04:00:47.000Z', total_sales: 605 }),
    [order('2026-05-15T04:00:47Z', 605)], false);
  assert.equal(upd, null);
});

test('donation-partner org gets donation_closet flag and active state', () => {
  const upd = computeCompanyState(org(), [], true);
  assert.deepEqual(upd.program_flags, { donation_closet: true });
  assert.equal(upd.relationship_state, 'active');
  assert.equal(upd.order_count, undefined); // no order fields touched
});

test('org with orders gets purchases flag', () => {
  const upd = computeCompanyState(org(), [order('2026-02-13T00:00:00Z', 890)], false);
  assert.equal(upd.program_flags.purchases, true);
  assert.equal(upd.relationship_state, 'active');
  assert.equal(upd.order_count, 1);
});

test('existing flags are preserved, not clobbered', () => {
  const upd = computeCompanyState(org({ program_flags: { affiliate: true } }), [], true);
  assert.deepEqual(upd.program_flags, { affiliate: true, donation_closet: true });
});

test('last_order_date never regresses to null when orders vanish from match set', () => {
  const upd = computeCompanyState(retailer({ order_count: 2, last_order_date: '2026-05-15T04:00:47.000Z', total_sales: 1213, relationship_state: 'active' }), [], false);
  // order_count/total_sales correct to 0 but the date is left alone
  assert.equal(upd.order_count, 0);
  assert.equal(upd.last_order_date, undefined);
});
