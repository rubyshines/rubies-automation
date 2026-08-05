const { test } = require('node:test');
const assert = require('node:assert');
const { computeCompanyState, reorderThresholdDays, normalizeDomain, isSampleOrder } = require('../../b2b-outreach/sync/syncB2bCompanyState');

// ── reorderThresholdDays ────────────────────────────────────────────────────

test('threshold follows the latest interval at 0.75x (Transting case)', () => {
  const orders = [
    { created_at: '2024-10-06T00:00:00Z' }, { created_at: '2025-01-04T00:00:00Z' },
    { created_at: '2025-02-07T00:00:00Z' }, { created_at: '2025-03-17T00:00:00Z' },
    { created_at: '2026-04-23T00:00:00Z' }, // 402d gap → 0.75x ≈ 302
  ];
  assert.equal(reorderThresholdDays(orders), 302);
});

test('threshold floors at 90 for fast rhythms and caps at 365', () => {
  assert.equal(reorderThresholdDays([
    { created_at: '2026-06-01T00:00:00Z' }, { created_at: '2026-07-01T00:00:00Z' },
  ]), 90); // 30d interval → floor
  assert.equal(reorderThresholdDays([
    { created_at: '2023-01-01T00:00:00Z' }, { created_at: '2026-01-01T00:00:00Z' },
  ]), 365); // 3y gap → cap
});

test('threshold is null under 2 orders and skips cancelled', () => {
  assert.equal(reorderThresholdDays([{ created_at: '2026-01-01T00:00:00Z' }]), null);
  assert.equal(reorderThresholdDays([
    { created_at: '2026-01-01T00:00:00Z' },
    { created_at: '2026-06-01T00:00:00Z', cancelled_at: '2026-06-02T00:00:00Z' },
  ]), null);
});

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

// ── $0 sample orders are a samples event, not revenue ───────────────────────

const sampleOrder = (created_at, tags = ['sample kit reach out']) => ({ created_at, total_price: 0, cancelled_at: null, tags });

test('isSampleOrder needs both $0 and a sample tag', () => {
  assert.equal(isSampleOrder(sampleOrder('2025-11-04T00:00:00Z')), true);
  assert.equal(isSampleOrder(sampleOrder('2026-03-18T00:00:00Z', ['cs-mcp', 'she-bop', 'wholesale-samples'])), true);
  assert.equal(isSampleOrder({ total_price: 0, tags: 'sample kit reach out' }), true, 'comma-string tags');
  assert.equal(isSampleOrder({ total_price: 605, tags: ['wholesale-samples'] }), false, 'paid order is a purchase');
  assert.equal(isSampleOrder({ total_price: 0, tags: ['gift'] }), false, 'untagged $0 is not a samples event');
  assert.equal(isSampleOrder({ total_price: 0 }), false);
});

test('a $0 sample kit is not a purchase and never promotes to active', () => {
  const upd = computeCompanyState(retailer(), [sampleOrder('2025-11-04T00:00:00Z')], false);
  assert.equal(upd.order_count, undefined, 'stays 0 — no write');
  assert.equal(upd.total_sales, undefined, 'stays $0 — no write');
  assert.equal(upd.relationship_state, undefined, 'sample recipient is not a customer');
  assert.equal(upd.samples_shipped_at, '2025-11-04T00:00:00Z');
});

test('the 14 mis-promoted retailers correct to 0 orders on re-sync', () => {
  const upd = computeCompanyState(retailer({
    order_count: 1, total_sales: 0, last_order_date: '2025-11-04', relationship_state: 'active',
  }), [sampleOrder('2025-11-04T00:00:00Z')], false);
  assert.equal(upd.order_count, 0);
  assert.equal(upd.last_order_date, undefined, 'stale date is repairB2bSampleStates.js\'s job, not the sync\'s');
});

test('samples and purchases coexist — only the purchase counts', () => {
  const upd = computeCompanyState(retailer(), [
    sampleOrder('2025-11-04T00:00:00Z'),
    order('2026-05-15T04:00:47Z', 605),
  ], false);
  assert.equal(upd.order_count, 1);
  assert.equal(upd.total_sales, 605);
  assert.equal(upd.last_order_date, '2026-05-15');
  assert.equal(upd.relationship_state, 'active');
  assert.equal(upd.samples_shipped_at, '2025-11-04T00:00:00Z');
});

test('samples_shipped_at is never overwritten once set', () => {
  const upd = computeCompanyState(retailer({ samples_shipped_at: '2025-10-01T00:00:00Z' }), [sampleOrder('2025-11-04T00:00:00Z')], false);
  assert.equal(upd, null, 'real fulfillment data outranks the inference');
});

test('earliest sample order wins when several were sent', () => {
  const upd = computeCompanyState(retailer(), [
    sampleOrder('2026-03-18T00:00:00Z'), sampleOrder('2025-11-04T00:00:00Z'),
  ], false);
  assert.equal(upd.samples_shipped_at, '2025-11-04T00:00:00Z');
});

test('reorder threshold ignores $0 samples (two samples are not a rhythm)', () => {
  const upd = computeCompanyState(retailer(), [
    sampleOrder('2025-11-04T00:00:00Z'), sampleOrder('2026-03-18T00:00:00Z'),
  ], false);
  assert.equal(upd.metadata, undefined, 'no reorder_threshold_days from sample cadence');
});

test('org sent samples gets no purchases flag and no active promotion', () => {
  const upd = computeCompanyState(org(), [sampleOrder('2026-03-18T00:00:00Z')], false);
  assert.equal(upd.program_flags, undefined);
  assert.equal(upd.relationship_state, undefined);
});
